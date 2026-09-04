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