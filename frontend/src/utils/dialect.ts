import type { IdialectEntry } from '@/types';

// 与 demo DIALECT_MAP 完全一致（共 6 种）
export const DIALECT_MAP: Record<string, IdialectEntry> = {
  standard: { label: '标准普通话', language: 'zh_mandarin', voice: 'BV001_streaming' },
  zh_xian: { label: '陕西话', language: 'zh_xian', voice: 'BV704_streaming' },
  zh_dongbei: { label: '东北话', language: 'zh_dongbei', voice: 'BV704_streaming' },
  zh_yueyu: { label: '粤语', language: 'zh_yueyu', voice: 'BV704_streaming' },
  zh_chengdu: { label: '成都话', language: 'zh_chengdu', voice: 'BV704_streaming' },
  zh_shanghai: { label: '上海话', language: 'zh_shanghai', voice: 'BV704_streaming' },
};

export function dialectLabel(key: string | null | undefined, fallback = '标准普通话'): string {
  if (key && DIALECT_MAP[key]) return DIALECT_MAP[key].label;
  return fallback;
}

export const COVER_STYLES = [
  { value: 'default', label: '默认风格' },
  { value: 'comic', label: '国漫卡通' },
  { value: 'realistic', label: '写实电影' },
];

// 进度映射
export const PROGRESS_MAP: Record<string, { label: string; cls: string }> = {
  not_started: { label: '未开始', cls: 'lmd-status-gray' },
  editing: { label: '编辑中', cls: 'lmd-status-indigo' },
  completed: { label: '已完成', cls: 'lmd-status-emerald' },
};

/* ================= 成片规格（建项目时定，全流程共用） =================
 * 与后端 backend/src/output-spec.ts 的取值范围保持一致。
 * 画幅不是后期裁切参数：生图 / 生视频都按它出，所以必须在建项目时就定下来。
 */
export const ASPECT_RATIOS = [
  { value: '9:16', label: '9:16 竖屏（抖音/快手/视频号）' },
  { value: '16:9', label: '16:9 横屏（网页大屏/B站）' },
] as const;

export const FRAME_RATES = [
  { value: 30, label: '30 fps（通用，推荐）' },
  { value: 24, label: '24 fps（电影感）' },
  { value: 25, label: '25 fps（PAL 制）' },
  { value: 60, label: '60 fps（高帧率）' },
] as const;

export const RESOLUTIONS = [
  { value: '1080p', label: '1080P 高清' },
  { value: '720p', label: '720P 标清' },
] as const;

export const DEFAULT_OUTPUT_SPEC = {
  aspect_ratio: '9:16',
  frame_rate: 30,
  resolution: '1080p',
} as const;

/** 容错解析 Drama.outputCfg（JSON 字符串），非法值回落默认 */
export function parseOutputSpec(raw?: string | null): {
  aspect_ratio: string;
  frame_rate: number;
  resolution: string;
} {
  let obj: any = null;
  if (raw) {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = null;
    }
  }
  const ratios = ASPECT_RATIOS.map((r) => r.value);
  const fps: readonly number[] = FRAME_RATES.map((r) => r.value);
  const res = RESOLUTIONS.map((r) => r.value);
  return {
    aspect_ratio: ratios.includes(obj?.aspect_ratio) ? obj.aspect_ratio : DEFAULT_OUTPUT_SPEC.aspect_ratio,
    frame_rate: fps.includes(Number(obj?.frame_rate)) ? Number(obj.frame_rate) : DEFAULT_OUTPUT_SPEC.frame_rate,
    resolution: res.includes(obj?.resolution) ? obj.resolution : DEFAULT_OUTPUT_SPEC.resolution,
  };
}

/** 规格的一句话摘要，用于在合成面板只读展示 */
export function outputSpecLabel(spec: { aspect_ratio: string; frame_rate: number; resolution: string }) {
  return `${spec.aspect_ratio} · ${spec.frame_rate}fps · ${spec.resolution}`;
}