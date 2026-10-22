// 与后端 Prisma 模型 / demo 对齐的数据类型

export interface Drama {
  id: number;
  title: string;
  description?: string | null;
  dialect?: string | null;
  coverStyle?: string | null;
  /** 成片规格 JSON：建项目时定，生图/生视频/合成共用 */
  outputCfg?: string | null;
  seed?: number | null;
  createdAt: string;
  updatedAt: string;
  episodeCount?: number;
  characterCount?: number;
  mergedCount?: number;
  progress?: 'not_started' | 'editing' | 'completed';
}

export interface Episode {
  id: number;
  dramaId: number;
  title: string;
  episodeNumber?: number | null;
  description?: string | null;
  duration?: number | null;
  storyboardCount?: number;
  hasScript?: boolean;
  status?: 'draft' | 'editing' | 'completed' | string | null;
  merged?: boolean;
  mergedUrl?: string | null;
  mergeCfg?: string | null;
  genCfg?: string | null;
  scriptText?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 分集生成一致性配置（genCfg JSON） */
export interface GenConfig {
  /** 音轨/字幕语言：zh-CN 中文普通话（默认） */
  language: string;
  /** 是否允许唱词（默认 false = 禁止唱歌，保证全剧一致） */
  allowSinging: boolean;
  /** 画面风格：cartoon（默认）| anime2d | anime3d | realistic | watercolor */
  artStyle: string;
}

export interface SchedulerConfig {
  max_image_concurrency: number;
  max_video_concurrency: number;
  max_retries: number;
  retry_initial_delay_ms: number;
  retry_max_delay_ms?: number;
  video_min_interval_ms?: number;
}

/** 火山引擎 TTS 凭据（可界面更换，不必改 .env） */
export interface TtsConfig {
  appId: string;
  token: string;
  cluster: string;
  defaultVoice: string;
  /** 是否已配置（后端只回传脱敏值 + 该标志） */
  appIdSet?: boolean;
  tokenSet?: boolean;
  defaultVoiceSet?: boolean;
}

export interface AiProviderEntry {
  name: string;
  type?: string;
  baseUrl?: string;
  apiKey?: string;
  /** 是否已配置 Key */
  apiKeySet?: boolean;
  /** 能力 → 模型名；后端保证已与默认值合并，不会缺失 */
  models: Record<string, string>;
}

/**
 * 全局 AI 配置。
 * 注意：apiKey 等敏感字段后端只返回脱敏串（含 ****），
 * 原样回传表示「未修改」，后端会保留已存的真实值。
 */
export interface AiConfig {
  defaultProvider: string;
  providers: Record<string, AiProviderEntry>;
  tts?: TtsConfig;
}

/** 合并弹窗一次性读写的全局设置 */
export interface GlobalSettings {
  scheduler: SchedulerConfig;
  ai: AiConfig;
}

export interface IdialectEntry {
  label: string;
  language: string;
  voice: string;
}

// ===== 第三层 · 剧本编辑 =====

export interface Character {
  id: number;
  dramaId: number;
  name: string;
  dialect?: string | null;
  role?: string | null;
  roleLabel?: string | null;
  appearance?: string | null;
  anchors?: string | null;
  imageUrl?: string | null;
  sourceUrl?: string | null;
  referenceImageUrl?: string | null;
  intro?: string | null;
  storyboardCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Scene {
  id: number;
  episodeId: number;
  location: string;
  time?: string | null;
  description?: string | null;
  prompt?: string | null;
  quadPrompt?: string | null;
  imageUrl?: string | null;
  referenceImageUrl?: string | null;
  sourceUrl?: string | null;
  useQuadGrid?: boolean;
  storyboardCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Prop {
  id: number;
  episodeId: number;
  name: string;
  type?: string | null;
  description?: string | null;
  prompt?: string | null;
  imageUrl?: string | null;
  referenceImageUrl?: string | null;
  sourceUrl?: string | null;
  useQuadGrid?: boolean;
  storyboardCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Storyboard {
  id: number;
  episodeId: number;
  number: number;
  characterId?: number | null;
  characterIds?: number[];
  sceneId?: number | null;
  propId?: number | null;
  propIds?: number[];
  dialogue?: string | null;
  narration?: string | null;
  sceneDescription?: string | null;
  motionDescription?: string | null;
  emotion?: string | null;
  duration?: number | null;
  dialect?: string | null;
  imageUrl?: string | null;
  referenceImageUrl?: string | null;
  sourceUrl?: string | null;
  lastFrameUrl?: string | null;
  lastFrameSourceUrl?: string | null;
  imagePrompt?: string | null;
  videoPrompt?: string | null;
  audioUrl?: string | null;
  videoUrl?: string | null;
  status?: 'pending' | 'generating' | 'finished' | 'cancelled' | string | null;
  // 关联摘要（后端 listStoryboards 附带）
  characterName?: string | null;
  sceneLocation?: string | null;
  sceneTime?: string | null;
  propName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MergeConfig {
  burn_dialogue_audio: boolean;
  burn_narration_subtitles: boolean;
  keep_original_audio: boolean;
  /** 画幅 / 帧率 / 清晰度已上移到「建项目」，这里只保留合成专属开关 */
  auto_correct_rotation?: boolean;
}

/**
 * 成片规格：建项目时确定，生图 / 生视频 / 合成全流程共用。
 * 不在合成阶段提供修改 —— 到那一步素材已按旧画幅生成完毕，改之无用只会变形。
 */
export interface OutputSpec {
  aspect_ratio: '9:16' | '16:9';
  frame_rate: number;
  resolution: '720p' | '1080p';
}