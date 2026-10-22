import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

// 配置持久化到一个 data 目录下的 JSON 文件，保证重启不丢失
const settingsDir = () => path.resolve(process.cwd(), '..', 'data');

const DEFAULT_SCHEDULER = {
  max_image_concurrency: 3,
  max_video_concurrency: 2,
  max_retries: 5,
  retry_initial_delay_ms: 1000,
  retry_max_delay_ms: 30000,
  // 视频接口限频：默认 60 秒 1 次（开发文档 §3.3）
  video_min_interval_ms: 60000,
};

const DEFAULT_AI = {
  defaultProvider: 'agnes',
  providers: {
    agnes: {
      name: 'Agnes',
      type: 'aggregate',
      baseUrl: 'https://api.agnes-ai.cn/v1',
      models: {
        text: 'agnes-2.5-flash',
        image: 'agnes-image-2.1-flash',
        video: 'agnes-video-2.5-flash',
      },
    },
    volcengine: {
      name: '火山引擎TTS',
      type: 'tts',
      models: {},
    },
  },
  /** 火山引擎 TTS 凭据（此前只能写 .env，无法在界面更换） */
  tts: { appId: '', token: '', cluster: 'volcano_tts', defaultVoice: '' },
};

/** 敏感字段：读接口一律脱敏，绝不把明文 Key 回传给前端 */
const SECRET_FIELDS = ['apiKey', 'appId', 'token', 'defaultVoice'];
const mask = (v: unknown) =>
  typeof v === 'string' && v.length > 0 ? `${v.slice(0, 4)}****${v.slice(-4)}` : '';

@Injectable()
export class AppConfigService {
  /**
   * 配置变更回调（AIModule 里的 provider 工厂注册进来）。
   * 用回调而非直接注入工厂，是为了避开 AppConfigModule ↔ AIModule 的循环依赖。
   */
  private listeners: Array<() => void> = [];

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  private notifyChange() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* 单个监听失败不应影响保存 */
      }
    }
  }

  private ensureDir() {
    const dir = settingsDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private readFile(name: string): Record<string, any> | null {
    const file = path.join(settingsDir(), name);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return null;
    }
  }

  private writeFile(name: string, data: Record<string, any>) {
    this.ensureDir();
    fs.writeFileSync(
      path.join(settingsDir(), name),
      JSON.stringify(data, null, 2),
      'utf-8',
    );
  }

  // ===== 调度配置 =====
  getScheduler() {
    return { ...DEFAULT_SCHEDULER, ...(this.readFile('scheduler-config.json') || {}) };
  }

  setScheduler(patch: Record<string, any>) {
    const next = { ...this.getScheduler(), ...patch };
    this.writeFile('scheduler-config.json', next);
    this.notifyChange();
    return next;
  }

  // ===== AI 配置 =====
  /** 含密钥的完整配置（仅供服务端内部使用，绝不直接回传前端） */
  getAiConfig() {
    const saved = this.readFile('ai-config.json') || {};
    const providers = { ...DEFAULT_AI.providers };
    for (const [k, v] of Object.entries(saved.providers ?? {})) {
      providers[k] = {
        ...((providers as any)[k] ?? {}),
        ...(v as any),
        // models 逐键合并，避免前端只提交 text 就把 image/video 丢掉
        models: { ...(((providers as any)[k]?.models) ?? {}), ...((v as any)?.models ?? {}) },
      };
    }
    return {
      ...DEFAULT_AI,
      ...saved,
      defaultProvider: saved.defaultProvider || DEFAULT_AI.defaultProvider,
      providers,
      tts: { ...DEFAULT_AI.tts, ...(saved.tts ?? {}) },
    };
  }

  setAiConfig(patch: Record<string, any>) {
    const next = { ...this.getAiConfig(), ...patch };
    this.writeFile('ai-config.json', next);
    // 换 Key/模型后必须重建 provider，否则仍用旧配置（界面显示保存成功但生图没变）
    this.notifyChange();
    return next;
  }

  /**
   * 前端展示用：密钥字段脱敏 + 标注「是否已配置」。
   * 前端据此渲染占位符（留空表示沿用已存值），保存时原样回传即可保持不变。
   */
  getAiConfigForDisplay() {
    const cfg = this.getAiConfig() as any;
    return {
      ...cfg,
      providers: Object.fromEntries(
        Object.entries(cfg.providers ?? {}).map(([k, v]: [string, any]) => [
          k,
          { ...v, apiKey: mask(v.apiKey), apiKeySet: Boolean(v.apiKey) },
        ]),
      ),
      tts: {
        ...cfg.tts,
        appId: mask(cfg.tts?.appId),
        token: mask(cfg.tts?.token),
        defaultVoice: mask(cfg.tts?.defaultVoice),
        appIdSet: Boolean(cfg.tts?.appId),
        tokenSet: Boolean(cfg.tts?.token),
        defaultVoiceSet: Boolean(cfg.tts?.defaultVoice),
      },
    };
  }

  /**
   * 保存前端回传的 AI 配置。
   * 脱敏串（形如 abcd****wxyz）视为「未修改」，保留库里原值 ——
   * 否则界面永远只能存脱敏后的假 Key，改一次配置就把真 Key 冲掉。
   */
  setAiConfigFromDisplay(patch: Record<string, any>) {
    const cur = this.getAiConfig() as any;
    const keep = ( incoming: unknown, original: unknown) => {
      if (typeof incoming !== 'string' || incoming.length === 0) return original;
      if (incoming.includes('****')) return original; // 未修改，沿用原值
      return incoming;
    };
    const providers: Record<string, any> = { ...cur.providers };
    for (const [k, v] of Object.entries((patch.providers ?? {}) as Record<string, any>)) {
      providers[k] = {
        ...(providers[k] ?? {}),
        ...v,
        models: { ...(providers[k]?.models ?? {}), ...(v?.models ?? {}) },
        apiKey: keep(v?.apiKey, providers[k]?.apiKey),
      };
    }
    return this.setAiConfig({
      ...patch,
      providers,
      tts: {
        ...(patch.tts ?? {}),
        appId: keep(patch.tts?.appId, cur.tts?.appId),
        token: keep(patch.tts?.token, cur.tts?.token),
        defaultVoice: keep(patch.tts?.defaultVoice, cur.tts?.defaultVoice),
      },
    });
  }
}