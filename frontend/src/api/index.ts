import axios from 'axios';
import type { Drama, Episode, SchedulerConfig, AiConfig, Character, Scene, Prop, Storyboard, MergeConfig } from '@/types';

// 统一走 Vite 代理：/api -> 后端 5679
const http = axios.create({ baseURL: '/api', timeout: 60000 });

http.interceptors.response.use(
  (res) => res,
  (err) => {
    const msg = err?.response?.data?.message || err?.message || '请求失败';
    return Promise.reject(new Error(Array.isArray(msg) ? msg.join('；') : msg));
  },
);

// ===== 项目 =====
export const dramaApi = {
  list: () => http.get<Drama[]>('/dramas').then((r) => r.data),
  get: (id: number) => http.get<Drama>(`/dramas/${id}`).then((r) => r.data),
  create: (data: Partial<Drama>) => http.post<Drama>('/dramas', data).then((r) => r.data),
  update: (id: number, data: Partial<Drama>) => http.put<Drama>(`/dramas/${id}`, data).then((r) => r.data),
  remove: (id: number) => http.delete(`/dramas/${id}`).then((r) => r.data),
};

// ===== 分集 =====
export const episodeApi = {
  list: (dramaId: number) => http.get<Episode[]>('/episodes', { params: { dramaId } }).then((r) => r.data),
  get: (id: number) => http.get<Episode>(`/episodes/${id}`).then((r) => r.data),
  create: (data: Partial<Episode>) => http.post<Episode>('/episodes', data).then((r) => r.data),
  update: (id: number, data: Partial<Episode>) => http.put<Episode>(`/episodes/${id}`, data).then((r) => r.data),
  remove: (id: number) => http.delete(`/episodes/${id}`).then((r) => r.data),
  importScript: (dramaId: number, text: string, mode: 'append' | 'replace' = 'append') =>
    http
      .post<{ imported: number; episodes: Array<{ id: number; episodeNumber: number; title: string }> }>(
        '/episodes/import-script',
        { dramaId, text, mode },
      )
      .then((r) => r.data),
};

// ===== 配置 =====
export const configApi = {
  getScheduler: () => http.get<SchedulerConfig>('/scheduler-config').then((r) => r.data),
  setScheduler: (data: Partial<SchedulerConfig>) => http.put<SchedulerConfig>('/scheduler-config', data).then((r) => r.data),
  getAi: () => http.get<AiConfig>('/ai-config').then((r) => r.data),
  setAi: (data: Partial<AiConfig>) => http.put<AiConfig>('/ai-config', data).then((r) => r.data),
};

// ===== 第三层 · 剧本编辑 =====
export const characterApi = {
  list: (dramaId?: number) =>
    http.get<Character[]>('/characters', { params: { dramaId } }).then((r) => r.data),
  create: (data: Partial<Character>) => http.post<Character>('/characters', data).then((r) => r.data),
  update: (id: number, data: Partial<Character>) => http.put<Character>(`/characters/${id}`, data).then((r) => r.data),
  remove: (id: number) => http.delete(`/characters/${id}`).then((r) => r.data),
};

export const sceneApi = {
  list: (episodeId?: number) =>
    http.get<Scene[]>('/scenes', { params: { episodeId } }).then((r) => r.data),
  create: (data: Partial<Scene>) => http.post<Scene>('/scenes', data).then((r) => r.data),
  update: (id: number, data: Partial<Scene>) => http.put<Scene>(`/scenes/${id}`, data).then((r) => r.data),
  remove: (id: number) => http.delete(`/scenes/${id}`).then((r) => r.data),
};

export const propApi = {
  list: (episodeId?: number) =>
    http.get<Prop[]>('/props', { params: { episodeId } }).then((r) => r.data),
  create: (data: Partial<Prop>) => http.post<Prop>('/props', data).then((r) => r.data),
  update: (id: number, data: Partial<Prop>) => http.put<Prop>(`/props/${id}`, data).then((r) => r.data),
  remove: (id: number) => http.delete(`/props/${id}`).then((r) => r.data),
};

export const storyboardApi = {
  list: (episodeId?: number) =>
    http.get<Storyboard[]>('/storyboards', { params: { episodeId } }).then((r) => r.data),
  create: (data: Partial<Storyboard>) => http.post<Storyboard>('/storyboards', data).then((r) => r.data),
  update: (id: number, data: Partial<Storyboard>) => http.put<Storyboard>(`/storyboards/${id}`, data).then((r) => r.data),
  remove: (id: number) => http.delete(`/storyboards/${id}`).then((r) => r.data),
  reorder: (episodeId: number, ids: number[]) =>
    http.put(`/storyboards/${episodeId}/reorder`, { ids }).then((r) => r.data),
};

// ===== 参考图上传与描述提取 =====
export const uploadApi = {
  image: (data: { dataUri: string; kind: 'character' | 'scene' | 'prop' | 'storyboard'; dramaId: number; episodeId?: number }) =>
    http.post<{ url: string }>('/upload/image', data).then((r) => r.data),
  extractDescription: (data: { dataUri: string; kind: 'character' | 'scene' | 'prop' }) =>
    http.post<{ description: string | null }>('/upload/extract-description', data).then((r) => r.data),
};

export const generateApi = {
  logsUrl: (episodeId: number) => `/api/episodes/${episodeId}/logs/stream`,
  dramaLogsUrl: (dramaId: number) => `/api/dramas/${dramaId}/logs/stream`,
  generateDrama: (dramaId: number) =>
    http.post(`/dramas/${dramaId}/generate-all`).then((r) => r.data),
  generateEpisode: (episodeId: number, steps?: Record<string, boolean>) =>
    http.post(`/episodes/${episodeId}/generate`, steps ? { steps } : {}).then((r) => r.data),
  regenerateStoryboards: (episodeId: number) =>
    http.post(`/episodes/${episodeId}/regenerate-storyboards`).then((r) => r.data),
  generateStoryboard: (storyboardId: number) =>
    http.post(`/storyboards/${storyboardId}/generate`).then((r) => r.data),
  generateCharacter: (id: number) =>
    http.post(`/characters/${id}/generate`).then((r) => r.data),
  generateScene: (id: number, body: { quad?: boolean; force?: boolean } = {}) =>
    http.post(`/scenes/${id}/generate`, body).then((r) => r.data),
  generateProp: (id: number, body: { quad?: boolean; force?: boolean } = {}) =>
    http.post(`/props/${id}/generate`, body).then((r) => r.data),
  generateStoryboardImage: (id: number, force = false) =>
    http.post(`/storyboards/${id}/generate-image`, { force }).then((r) => r.data),
  generateStoryboardVideo: (id: number, force = false) =>
    http.post(`/storyboards/${id}/generate-video`, { force }).then((r) => r.data),
  generateStoryboardAudio: (id: number, force = false) =>
    http.post(`/storyboards/${id}/generate-audio`, { force }).then((r) => r.data),
  generateEpisodeAudio: (episodeId: number) =>
    http.post(`/episodes/${episodeId}/generate-audio`).then((r) => r.data),
  merge: (episodeId: number, cfg: Partial<MergeConfig>) =>
    http.post(`/episodes/${episodeId}/merge`, cfg).then((r) => r.data),
  resetEpisode: (episodeId: number) =>
    http.post(`/episodes/${episodeId}/reset`).then((r) => r.data),
  resetDrama: (dramaId: number) =>
    http.post(`/dramas/${dramaId}/reset`).then((r) => r.data),
  parseScript: (episodeId: number, mode: 'append' | 'replace' = 'replace') =>
    http.post(`/episodes/${episodeId}/parse-script`, { mode }).then((r) => r.data),
  // 拆解预览：同步等 AI 返回结构化结果（不落库），用户确认后再调 apply
  previewParseScript: (episodeId: number) =>
    http
      .post(`/episodes/${episodeId}/parse-script/preview`, {}, { timeout: 180000 })
      .then((r) => r.data),
  // 拆解应用：把确认过的拆解结果落库（后台执行 + SSE 日志）
  applyParsedScript: (
    episodeId: number,
    data: { mode: 'append' | 'replace'; parsed: any },
  ) => http.post(`/episodes/${episodeId}/parse-script/apply`, data).then((r) => r.data),
};

export default http;
// ===== AI 文案（描述 / 提示词 生成与丰富） =====
export const aiApi = {
  enrich: (data: {
    field: string;
    content?: string;
    context?: string;
    instruction?: string;
  }) => http.post<{ text: string }>('/ai/enrich', data).then((r) => r.data),
};
