import {
  AIProvider,
  GenerationRequest,
  GenerationResult,
  ProviderAuthError,
  ProviderCapability,
  ProviderTransientError,
} from './provider.types';

// 火山引擎（Volcengine）语音合成 TTS Provider（开发文档 §五）
// 真实接入需要：
//   VOLC_TTS_APP_ID    应用 APP ID
//   VOLC_TTS_TOKEN     Resource Token（控制台获取，Bearer 鉴权）
//   VOLC_TTS_CLUSTER   集群，如 volcano_tts（可选，默认 volcano_tts）
//   VOLC_TTS_VOICE_TYPE 全局默认音色（可选，覆盖下方方言映射）
// 未配置密钥时 isReady()=false，上层 generate.service 走「模拟降级」：
// 不产生真实音轨，分镜保留 AI 原声（与 image/video 的无 Key 降级一致）。
const TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v1/tts';
const DEFAULT_CLUSTER = 'volcano_tts';

// 方言 KEY → 火山 voice_type（示例 ID，需在控制台核对；
// 实际可用音色以火山引擎「语音合成」控制台为准，可用 VOLC_TTS_VOICE_TYPE 全局覆盖）
const VOICE_BY_DIALECT: Record<string, string> = {
  standard: 'zh_female_qingxin',
  zh_xian: 'zh_female_xian',
  zh_dongbei: 'zh_male_dongbei',
  zh_yueyu: 'zh_female_guangdong',
  zh_chengdu: 'zh_female_sichuan',
  zh_shanghai: 'zh_female_shanghai',
};

interface VolcConfig {
  appId: string;
  token: string;
  cluster: string;
  defaultVoice: string;
}

export class VolcengineProvider implements AIProvider {
  readonly name = 'volcengine';
  readonly type = 'tts' as const;

  private readonly config: VolcConfig;

  constructor(config?: Partial<VolcConfig>) {
    this.config = {
      appId: config?.appId || process.env.VOLC_TTS_APP_ID || '',
      token: config?.token || process.env.VOLC_TTS_TOKEN || '',
      cluster: config?.cluster || process.env.VOLC_TTS_CLUSTER || DEFAULT_CLUSTER,
      defaultVoice:
        config?.defaultVoice || process.env.VOLC_TTS_VOICE_TYPE || 'zh_female_qingxin',
    };
  }

  supports(cap: ProviderCapability): boolean {
    return cap === 'tts';
  }

  isReady(): boolean {
    return Boolean(this.config.appId && this.config.token);
  }

  async generate(
    cap: ProviderCapability,
    req: GenerationRequest,
  ): Promise<GenerationResult> {
    if (cap !== 'tts') throw new Error(`Volcengine 不支持 ${cap} 能力`);
    if (!this.isReady()) {
      throw new ProviderAuthError(
        '未配置火山引擎 TTS 密钥（VOLC_TTS_APP_ID / VOLC_TTS_TOKEN），无法调用 TTS 接口',
      );
    }

    const text = (req.prompt || '').trim();
    if (!text) throw new ProviderTransientError('TTS 文本为空');

    const opts = (req.options ?? {}) as {
      dialect?: string;
      voiceType?: string;
      speed?: number;
    };
    const voiceType =
      opts.voiceType ||
      (opts.dialect && VOICE_BY_DIALECT[opts.dialect]) ||
      this.config.defaultVoice;
    const speed = Number(opts.speed ?? 1.0);

    const body = {
      app: {
        appid: this.config.appId,
        token: this.config.token,
        cluster: this.config.cluster,
      },
      user: { uid: 'lmd-user' },
      audio: { voice_type: voiceType, encoding: 'mp3', speed_ratio: speed },
      request: { reqid: crypto.randomUUID(), text, operation: 'query' },
    };

    let res: Response;
    try {
      res = await fetch(TTS_ENDPOINT, {
        method: 'POST',
        headers: {
          // 火山引擎 openspeech 鉴权：Bearer 与 token 之间用分号 `;` 分隔
          Authorization: `Bearer; ${this.config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e: any) {
      throw new ProviderTransientError(`火山 TTS 请求失败：${e?.message}`);
    }

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = (await res.json().catch(() => null)) as any;
      if (res.status === 401 || res.status === 403) {
        throw new ProviderAuthError(
          `火山 TTS 鉴权失败(${res.status})：${data?.message || res.statusText}`,
        );
      }
      if (res.status === 402) {
        throw new ProviderAuthError(
          `火山 TTS 额度不足：${data?.message || res.statusText}`,
        );
      }
      if (!res.ok) {
        throw new ProviderTransientError(
          `火山 TTS ${res.status}：${data?.message || data?.error || res.statusText}`,
        );
      }
      // 业务码：3000 为成功（部分错误也以 200 + 非 3000 码返回）
      if (data?.code !== undefined && data.code !== 3000) {
        throw new ProviderTransientError(
          `火山 TTS 业务错误(${data.code})：${data?.message || ''}`,
        );
      }
      const b64 = data?.data ?? data?.audio;
      if (!b64) throw new ProviderTransientError('火山 TTS 返回为空');
      return { status: 'success', b64: String(b64), raw: data };
    }

    // 非 JSON：直接为音频二进制（按官方社区示例兼容）
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new ProviderAuthError(`火山 TTS 鉴权失败(${res.status})`);
      }
      throw new ProviderTransientError(`火山 TTS ${res.status}：${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new ProviderTransientError('火山 TTS 返回为空');
    return { status: 'success', b64: buf.toString('base64'), raw: { bytes: buf.length } };
  }

  async queryStatus(): Promise<GenerationResult> {
    throw new Error('火山 TTS 为同步接口，无需查询任务状态');
  }

  async healthCheck(): Promise<boolean> {
    return this.isReady();
  }
}
