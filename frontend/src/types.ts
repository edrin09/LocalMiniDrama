// 与后端 Prisma 模型 / demo 对齐的数据类型

export interface Drama {
  id: number;
  title: string;
  description?: string | null;
  dialect?: string | null;
  coverStyle?: string | null;
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
}

export interface SchedulerConfig {
  max_image_concurrency: number;
  max_video_concurrency: number;
  max_retries: number;
  retry_initial_delay_ms: number;
  retry_max_delay_ms?: number;
}

export interface AiConfig {
  defaultProvider: string;
  providers: Record<string, any>;
  keys?: Record<string, any>;
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
  sceneId?: number | null;
  propId?: number | null;
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
  aspect_ratio: '9:16' | '16:9';
  frame_rate: number;
  resolution: '1080p' | '720p';
}