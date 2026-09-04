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
  },
  // 占位，敏感 Key 存 .env，不入此文件
  keys: {},
};

@Injectable()
export class AppConfigService {
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
    return next;
  }

  // ===== AI 配置 =====
  getAiConfig() {
    const saved = this.readFile('ai-config.json') || {};
    return {
      ...DEFAULT_AI,
      ...saved,
      defaultProvider: saved.defaultProvider || DEFAULT_AI.defaultProvider,
    };
  }

  setAiConfig(patch: Record<string, any>) {
    const next = { ...this.getAiConfig(), ...patch };
    this.writeFile('ai-config.json', next);
    return next;
  }
}