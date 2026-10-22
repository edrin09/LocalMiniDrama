import {
  AIProvider,
  GenerationRequest,
  GenerationResult,
  ProviderAuthError,
  ProviderCapability,
  ProviderTransientError,
} from './provider.types';

// Agnes 官方三件套（开发文档 §〇·附）
// text  : agnes-2.5-flash        POST {base}/chat/completions
// image : agnes-image-2.1-flash  POST {base}/images/generations
// video : agnes-video-2.5-flash  POST {base}/videos + GET {host}/agnesapi 轮询
const DEFAULT_BASE = 'https://api.agnes-ai.cn/v1';

const MODELS = {
  text: 'agnes-2.5-flash',
  image: 'agnes-image-2.1-flash',
  video: 'agnes-video-2.5-flash',
};

interface AgnesConfig {
  baseUrl: string;
  apiKey: string;
  /** 可在全局配置里更换的模型名（缺省回落到官方三件套） */
  models?: Partial<typeof MODELS>;
}

export class AgnesProvider implements AIProvider {
  readonly name = 'agnes';
  readonly type = 'aggregate' as const;

  private readonly config: AgnesConfig;
  /** 实际生效的模型（配置优先，其次官方默认） */
  private readonly models: typeof MODELS;

  constructor(config?: Partial<AgnesConfig>) {
    this.config = {
      baseUrl: config?.baseUrl || process.env.AGNES_BASE_URL || DEFAULT_BASE,
      // 配置里的 Key 优先于 .env：用户能在界面换 Key，正是为了不再改代码/重启
      apiKey: config?.apiKey || process.env.AGNES_API_KEY || '',
    };
    this.models = { ...MODELS, ...(config?.models ?? {}) };
  }

  /** 当前生效的模型名（供查询接口展示） */
  currentModels(): typeof MODELS {
    return { ...this.models };
  }

  supports(cap: ProviderCapability): boolean {
    return cap === 'text' || cap === 'image' || cap === 'video';
  }

  isReady(): boolean {
    return Boolean(this.config.apiKey);
  }

  async generate(
    cap: ProviderCapability,
    req: GenerationRequest,
  ): Promise<GenerationResult> {
    if (!this.isReady()) {
      throw new ProviderAuthError('未配置 AGNES_API_KEY，无法调用 Agnes 接口');
    }
    if (cap === 'text') return this.text(req);
    if (cap === 'image') return this.image(req);
    if (cap === 'video') return this.videoCreate(req);
    throw new Error(`Agnes 不支持 ${cap} 能力`);
  }

  async queryStatus(
    cap: ProviderCapability,
    taskId: string,
  ): Promise<GenerationResult> {
    if (cap !== 'video') {
      throw new Error(`Agnes ${cap} 为同步接口，无需查询任务状态`);
    }
    // 查询端点挂在域名根路径（不含 /v1）
    const host = this.config.baseUrl.replace(/\/v\d+\/?$/, '');
    const url =
      `${host}/agnesapi?video_id=${encodeURIComponent(taskId)}` +
      `&model_name=${encodeURIComponent(this.models.video)}`;
    const data = await this.request(url, {
      method: 'GET',
      timeoutMs: 30_000,
    });

    const status = String(data?.status ?? '');
    const progress = Number(data?.progress ?? 0);
    if (status === 'failed') {
      return {
        status: 'failed',
        progress: 100,
        error: data?.error?.message || '视频生成失败',
        raw: data,
      };
    }
    if (status === 'completed') {
      return {
        status: 'success',
        progress: 100,
        url:
          data?.url ?? data?.metadata?.url ?? data?.video_url ?? undefined,
        raw: data,
      };
    }
    return { status: 'running', progress, raw: data };
  }

  async healthCheck(): Promise<boolean> {
    return this.isReady();
  }

  // ==================== 各能力实现 ====================

  private async text(req: GenerationRequest): Promise<GenerationResult> {
    // options.images：图片理解/多模态输入（Data URI 或公开 URL），OpenAI 兼容格式
    const images = Array.isArray((req.options as any)?.images)
      ? ((req.options as any).images as string[])
      : undefined;
    const userContent: any =
      images && images.length > 0
        ? [
            { type: 'text', text: req.prompt },
            ...images.map((url) => ({
              type: 'image_url',
              image_url: { url },
            })),
          ]
        : req.prompt;
    const data = await this.request(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      body: {
        model: req.model || this.models.text,
        messages: [
          { role: 'system', content: '你是AI漫剧提示词优化助手，输出简洁中文。' },
          { role: 'user', content: userContent },
        ],
        temperature: req.options?.temperature ?? 0.7,
        max_tokens: req.options?.maxTokens ?? 1024,
      },
      timeoutMs: 120_000,
    });
    const content = data?.choices?.[0]?.message?.content ?? '';
    return { status: 'success', text: String(content).trim(), raw: data };
  }

  private async image(req: GenerationRequest): Promise<GenerationResult> {
    const {
      ratio = '9:16',
      size = '2K',
      images,
      model,
    } = (req.options ?? {}) as {
      ratio?: string;
      size?: string;
      images?: string[];
      model?: string;
    };

    const extraBody: Record<string, any> = { response_format: 'url' };
    // 图生图 / 多图合成：必须放在 extra_body.image（支持 URL 与 Data URI）。
    // 输出必须保持 url（不能用 b64_json）：远端 URL 是视频接口 keyframe 首尾帧
    // 控制的唯一可用媒体地址，改 b64 会导致视频全部退化为纯文生视频。
    if (Array.isArray(images) && images.length > 0) {
      extraBody.image = images;
    }

    const data = await this.request(
      `${this.config.baseUrl}/images/generations`,
      {
        method: 'POST',
        body: {
          model: model || this.models.image,
          prompt: req.prompt,
          size,
          ratio,
          extra_body: extraBody,
        },
        // 大分辨率生图耗时较长，按官方建议放宽到 300s
        timeoutMs: 300_000,
      },
    );

    const first = data?.data?.[0];
    if (!first) {
      throw new ProviderTransientError('Agnes 生图返回为空');
    }
    return {
      status: 'success',
      url: first.url ?? undefined,
      b64: first.b64_json ?? undefined,
      raw: data,
    };
  }

  private async videoCreate(req: GenerationRequest): Promise<GenerationResult> {
    const {
      mode = 'text',
      seconds = '5',
      size = '720P',
      aspectRatio = '9:16',
      firstFrame,
      lastFrame,
      images,
    } = (req.options ?? {}) as {
      mode?: 'text' | 'keyframe' | 'reference';
      seconds?: string;
      size?: string;
      aspectRatio?: string;
      firstFrame?: string;
      lastFrame?: string;
      images?: string[];
    };

    const body: Record<string, any> = {
      model: req.model || this.models.video,
      prompt: req.prompt,
      mode,
      seconds: String(seconds),
      size,
      aspect_ratio: aspectRatio,
      n: 1,
    };
    if (mode === 'keyframe') {
      if (!firstFrame && !lastFrame) {
        throw new Error('keyframe 模式必须提供 first_frame 或 last_frame');
      }
      if (firstFrame) body.first_frame = firstFrame;
      if (lastFrame) body.last_frame = lastFrame;
    }
    if (mode === 'reference') {
      if (!images?.length) throw new Error('reference 模式必须提供参考图');
      // Flash 最多 5 张
      body.images = images.slice(0, 5);
    }
    // 注意：Agnes 生图与视频接口均不支持 seed 参数（官方参数表未列出），
    // 因此不存在「传 seed 锁人物」这条路，角色一致性只能靠参考图 + 文字锚点。

    const data = await this.request(`${this.config.baseUrl}/videos`, {
      method: 'POST',
      body,
      timeoutMs: 60_000,
    });

    const videoId = data?.video_id || data?.id || data?.task_id;
    if (!videoId) {
      throw new ProviderTransientError('Agnes 创建视频任务未返回 video_id');
    }
    return {
      status: data?.status === 'completed' ? 'success' : 'running',
      taskId: String(videoId),
      progress: Number(data?.progress ?? 0),
      url: data?.url ?? data?.metadata?.url ?? undefined,
      raw: data,
    };
  }

  // ==================== 公共请求 ====================

  private async request(
    url: string,
    init: { method: string; body?: any; timeoutMs: number },
  ): Promise<any> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(init.timeoutMs),
      });
    } catch (e: any) {
      throw new ProviderTransientError(`Agnes 请求失败：${e?.message}`);
    }

    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (res.ok) return data ?? {};

    const detail =
      data?.detail || data?.error?.message || data?.message || text.slice(0, 300);

    // 鉴权/配额：熔断，不重试
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError(`Agnes 鉴权失败(${res.status})：${detail}`);
    }
    if (res.status === 402) {
      throw new ProviderAuthError(`Agnes 额度不足：${detail}`);
    }
    // 限频与服务端错误：退避重试
    if (res.status === 429 || res.status >= 500) {
      throw new ProviderTransientError(`Agnes ${res.status}：${detail}`);
    }
    throw new Error(`Agnes ${res.status}：${detail}`);
  }
}
