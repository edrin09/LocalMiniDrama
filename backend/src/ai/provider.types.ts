// AI Provider 统一抽象（开发文档 §五）
// 所有平台（Agnes / OpenAI / DeepSeek / 即梦 / 可灵 / 火山 ...）按此接口接入，
// 上层业务只依赖接口与工厂，换平台零改动。

export type ProviderCapability = 'text' | 'image' | 'video' | 'tts';

export type TaskStatus = 'pending' | 'running' | 'success' | 'failed';

export interface GenerationRequest {
  /** 主提示词 */
  prompt: string;
  /** 覆盖默认模型 */
  model?: string;
  /** 平台相关扩展参数（如 images/video 的模式与素材） */
  options?: Record<string, any>;
}

export interface GenerationResult {
  status: TaskStatus;
  /** 文本结果（text） */
  text?: string;
  /** 图片/视频的远端地址 */
  url?: string;
  /** 图片 base64（无 url 时返回） */
  b64?: string;
  /** 异步任务 ID，用于 queryStatus 轮询 */
  taskId?: string;
  /** 0-100 */
  progress?: number;
  error?: string;
  raw?: any;
}

export interface AIProvider {
  readonly name: string;
  /** 单一能力平台写具体类型；多能力平台写 'aggregate' */
  readonly type: ProviderCapability | 'aggregate';
  /** 该平台是否支持某能力 */
  supports(cap: ProviderCapability): boolean;
  /** 当前是否可用（Key 已配置） */
  isReady(): boolean;
  generate(
    cap: ProviderCapability,
    req: GenerationRequest,
  ): Promise<GenerationResult>;
  queryStatus(cap: ProviderCapability, taskId: string): Promise<GenerationResult>;
  cancel?(cap: ProviderCapability, taskId: string): Promise<void>;
  healthCheck?(): Promise<boolean>;
}

/** 鉴权/配额类故障：不可重试，需熔断，防止盗刷额度 */
export class ProviderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAuthError';
  }
}

/** 可重试的瞬时故障（网络超时、429、5xx） */
export class ProviderTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderTransientError';
  }
}
