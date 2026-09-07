<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  ArrowLeft,
  Plus,
  MagicStick,
  Delete,
  Edit,
  Setting,
  VideoCamera,
  VideoPlay,
  Picture,
  RefreshRight,
  Refresh,
  Upload,
  User,
  Location,
  Goods,
  Film,
  ArrowDown,
} from '@element-plus/icons-vue';
import {
  episodeApi,
  dramaApi,
  characterApi,
  sceneApi,
  propApi,
  storyboardApi,
  generateApi,
  uploadApi,
  aiApi,
} from '@/api';
import { DIALECT_MAP } from '@/utils/dialect';
import type {
  Episode,
  Character,
  Scene,
  Prop,
  Storyboard,
  MergeConfig,
  GenConfig,
} from '@/types';

const route = useRoute();
const router = useRouter();
const dramaId = Number(route.params.id);
const episodeId = Number(route.params.eid);

/* ================= 基础数据 ================= */
const episode = ref<Episode | null>(null);
const dramaTitle = ref('');
const dramaDialect = ref<string | null>(null);
const characters = ref<Character[]>([]);
const scenes = ref<Scene[]>([]);
const props = ref<Prop[]>([]);
const storyboards = ref<Storyboard[]>([]);
const loading = ref(false);

const steps = [
  { key: 'script', label: '剧本' },
  { key: 'characters', label: '角色' },
  { key: 'scenes', label: '场景' },
  { key: 'props', label: '道具' },
  { key: 'storyboards', label: '分镜' },
  { key: 'merge', label: '合成视频' },
] as const;
type StepKey = (typeof steps)[number]['key'];
const scriptTab = ref<StepKey>('storyboards');

const logs = ref<{ level: string; text: string; at: number; id: number }[]>([]);
const logSeq = ref(0);
const terminalEl = ref<HTMLElement | null>(null);
const logOpen = ref(true);
const generating = ref(false);
const mergeRunning = ref(false);
const mergeProgress = ref(0);

/** 流水线进度（供「成片进度流程图」实时定位当前步骤） */
const PIPELINE_STEPS = [
  { key: 'characters', label: '① 角色形象' },
  { key: 'scenes', label: '② 场景图' },
  { key: 'props', label: '③ 道具图' },
  { key: 'storyboards', label: '④ 分镜首尾帧' },
  { key: 'storyboardVideos', label: '⑤ 分镜视频' },
  { key: 'merge', label: '⑥ 合成成片' },
] as const;
const flowStep = ref<string>('');       // 当前流水线步骤 key
const flowLabel = ref<string>('');      // 当前步骤文字
const flowPercent = ref(0);             // 整剧/整集整体进度
const flowTag = ref<string>('');        // 整剧成片时的当前集标签
const flowIdx = computed(() => {
  const i = PIPELINE_STEPS.findIndex((p) => p.key === flowStep.value);
  return i < 0 ? -1 : i;
});

function addLog(level: string, text: string) {
  logs.value.unshift({ level, text, at: Date.now(), id: ++logSeq.value });
  keepLogTail();
}
function keepLogTail() {
  // 上限 500 行；倒序展示：最新在最上面，自动滚到顶
  if (logs.value.length > 500) logs.value.length = 500;
  requestAnimationFrame(() => {
    if (terminalEl.value) terminalEl.value.scrollTop = 0;
  });
}

/* ================= 素材生成（Agnes 生图 / 生视频） ================= */
// 生成在后端后台执行，进度走 SSE 日志；这里只做「发起 + 进行中状态」
const assetBusy = ref<Record<string, boolean>>({});
const keyOf = (kind: StepKey, id: number) => `${kind}:${id}`;

function clearBusy() {
  assetBusy.value = {};
}

async function genCharacter(c: Character) {
  const key = keyOf('characters', c.id);
  if (assetBusy.value[key]) return;
  assetBusy.value[key] = true;
  addLog('info', `🎨 角色「${c.name}」形象生成中...`);
  try {
    await generateApi.generateCharacter(c.id);
  } catch (e: any) {
    assetBusy.value[key] = false;
    ElMessage.error(e.message);
  }
}

async function genScene(s: Scene, force = false) {
  const key = keyOf('scenes', s.id);
  if (assetBusy.value[key]) return;
  assetBusy.value[key] = true;
  addLog('info', `🏠 场景「${s.location}」${s.useQuadGrid ? '四宫格' : '单图'}生成中...`);
  try {
    await generateApi.generateScene(s.id, { force });
  } catch (e: any) {
    assetBusy.value[key] = false;
    ElMessage.error(e.message);
  }
}

async function genProp(p: Prop, force = false) {
  const key = keyOf('props', p.id);
  if (assetBusy.value[key]) return;
  assetBusy.value[key] = true;
  addLog('info', `🪑 道具「${p.name}」${p.useQuadGrid ? '四视图' : '单图'}生成中...`);
  try {
    await generateApi.generateProp(p.id, { force });
  } catch (e: any) {
    assetBusy.value[key] = false;
    ElMessage.error(e.message);
  }
}

async function genSbImage(force = false) {
  const sb = selectedStoryboard.value;
  if (!sb || assetBusy.value['sb-image']) return;
  assetBusy.value['sb-image'] = true;
  addLog('info', `[分镜#${sb.number}] 首帧 + 尾帧参考图生成中...`);
  try {
    await generateApi.generateStoryboardImage(sb.id, force);
  } catch (e: any) {
    assetBusy.value['sb-image'] = false;
    ElMessage.error(e.message);
  }
}

async function genSbVideo(force = false) {
  const sb = selectedStoryboard.value;
  if (!sb || assetBusy.value['sb-video']) return;
  assetBusy.value['sb-video'] = true;
  addLog('info', `[分镜#${sb.number}] 视频生成中（keyframe · 9:16 · 720P）...`);
  try {
    await generateApi.generateStoryboardVideo(sb.id, force);
  } catch (e: any) {
    assetBusy.value['sb-video'] = false;
    ElMessage.error(e.message);
  }
}

/* ================= AI 文案生成 / 丰富（描述、提示词等文本字段） ================= */
const enrichBusy = ref<Record<string, boolean>>({});
// 每个字段的「补充要求 / 风格指令」，仅本次生成会话内有效，不落库
const enrichInstr = reactive<Record<string, string>>({});
const EMOTION_LABELS: Record<string, string> = {
  neutral: '平静', happy: '高兴', sad: '悲伤', angry: '愤怒', fear: '恐惧', surprise: '惊讶',
};

function aiBtnLabel(key: string, hasContent: string | null | undefined) {
  return enrichBusy.value[key] ? 'AI 生成中' : hasContent ? 'AI 丰富' : 'AI 生成';
}

/**
 * 通用：调后端 /ai/enrich，把结果回填到表单字段（不自动保存，用户可继续编辑）。
 * opts.regenerate=true 时忽略当前框内文字，让 AI 换一版全新的（对应「重新生成」）。
 * opts.instruction 为用户写的补充要求 / 风格指令（可粘贴剧本片段），透传给 AI。
 */
async function aiEnrich(
  key: string,
  field: string,
  content: string,
  context: string,
  apply: (text: string) => void,
  opts: { regenerate?: boolean; instruction?: string } = {},
) {
  if (enrichBusy.value[key]) return;
  enrichBusy.value[key] = true;
  try {
    const r = await aiApi.enrich({
      field,
      content: opts.regenerate ? undefined : content.trim() || undefined,
      context: context.trim() || undefined,
      instruction: opts.instruction?.trim() || undefined,
    });
    apply(r.text);
  } catch (e: any) {
    ElMessage.error(e.message || 'AI 生成失败');
  } finally {
    enrichBusy.value[key] = false;
  }
}

// ---- 角色弹窗 ----
function charContext(exclude: 'appearance' | 'intro') {
  return [
    `剧名：${dramaTitle.value}`,
    charForm.name ? `角色名：${charForm.name}` : '',
    charForm.roleLabel ? `身份定位：${charForm.roleLabel}` : '',
    exclude !== 'intro' && charForm.intro ? `角色简介：${charForm.intro}` : '',
    exclude !== 'appearance' && charForm.appearance ? `外貌描述：${charForm.appearance}` : '',
  ].filter(Boolean).join('\n');
}
function enrichChar(field: 'appearance' | 'intro', regenerate = false) {
  if (!charForm.name.trim()) {
    ElMessage.warning('请先填写角色名，AI 才能生成相关文案');
    return;
  }
  const key = `char:${field}`;
  aiEnrich(key, field, charForm[field], charContext(field), (t) => {
    charForm[field] = t;
  }, { regenerate, instruction: enrichInstr[key] });
}

// ---- 场景弹窗 ----
function sceneContext(exclude: 'description' | 'prompt') {
  return [
    `剧名：${dramaTitle.value}`,
    episode.value?.title ? `本集：${episode.value.title}` : '',
    episode.value?.description ? `本集简介：${episode.value.description}` : '',
    sceneForm.location ? `场景地点：${sceneForm.location}` : '',
    sceneForm.time ? `时间段：${sceneForm.time}` : '',
    exclude !== 'description' && sceneForm.description ? `场景描述：${sceneForm.description}` : '',
  ].filter(Boolean).join('\n');
}
function enrichScene(field: 'description' | 'prompt', regenerate = false) {
  if (!sceneForm.location.trim()) {
    ElMessage.warning('请先填写场景地点，AI 才能生成相关文案');
    return;
  }
  const key = `scene:${field}`;
  aiEnrich(key, field, sceneForm[field], sceneContext(field), (t) => {
    sceneForm[field] = t;
  }, { regenerate, instruction: enrichInstr[key] });
}

// ---- 道具弹窗 ----
function propContext(exclude: 'description' | 'prompt') {
  return [
    `剧名：${dramaTitle.value}`,
    episode.value?.title ? `本集：${episode.value.title}` : '',
    episode.value?.description ? `本集简介：${episode.value.description}` : '',
    propForm.name ? `道具名：${propForm.name}` : '',
    propForm.type ? `道具类型：${propForm.type}` : '',
    exclude !== 'description' && propForm.description ? `道具描述：${propForm.description}` : '',
  ].filter(Boolean).join('\n');
}
function enrichProp(field: 'description' | 'prompt', regenerate = false) {
  if (!propForm.name.trim()) {
    ElMessage.warning('请先填写道具名，AI 才能生成相关文案');
    return;
  }
  const key = `prop:${field}`;
  aiEnrich(key, field, propForm[field], propContext(field), (t) => {
    propForm[field] = t;
  }, { regenerate, instruction: enrichInstr[key] });
}

// ---- 角色定位标签 ----
function enrichCharRoleLabel(regenerate = false) {
  if (!charForm.name.trim()) {
    ElMessage.warning('请先填写角色名，AI 才能生成相关文案');
    return;
  }
  const key = 'char:roleLabel';
  aiEnrich(key, 'roleLabel', charForm.roleLabel, charContext('intro'), (t) => {
    charForm.roleLabel = t;
  }, { regenerate, instruction: enrichInstr[key] });
}

// ---- 分集简介 ----
function epContext() {
  return [
    `剧名：${dramaTitle.value}`,
    episode.value?.title ? `本集：${episode.value.title}` : '',
    episode.value?.episodeNumber ? `集数：第 ${episode.value.episodeNumber} 集` : '',
    episode.value?.description ? `当前简介：${episode.value.description}` : '',
  ].filter(Boolean).join('\n');
}
function enrichEpisodeDescription(regenerate = false) {
  const key = 'ep:description';
  aiEnrich(key, 'episodeDescription', epForm.description, epContext(), (t) => {
    epForm.description = t;
  }, { regenerate, instruction: enrichInstr[key] });
}

// ---- 分镜编辑区 ----
function sbContext(exclude: string) {
  const sb = selectedStoryboard.value;
  if (!sb) return '';
  const f = sbForm;
  const charIds = f.characterIds?.length ? f.characterIds : (f.characterId != null ? [f.characterId] : []);
  const chars = characters.value.filter((c) => charIds.includes(c.id));
  const scene = scenes.value.find((s) => s.id === f.sceneId);
  const propIds = f.propIds?.length ? f.propIds : (f.propId != null ? [f.propId] : []);
  const propsInFrame = props.value.filter((p) => propIds.includes(p.id));
  return [
    `剧名：${dramaTitle.value}`,
    episode.value?.title ? `本集：${episode.value.title}` : '',
    episode.value?.description ? `本集简介：${episode.value.description}` : '',
    `分镜序号：第 ${sb.number} 镜`,
    chars.length
      ? `出场角色：${chars.map((c) => `${c.name}（${c.roleLabel || '配角'}）`).join('、')}`
      : '出场角色：无（旁白镜头）',
    scene ? `场景：${scene.location}${scene.time ? `，${scene.time}` : ''}` : '',
    propsInFrame.length
      ? `道具：${propsInFrame.map((p) => `${p.name}${p.type ? `（${p.type}）` : ''}`).join('、')}`
      : '',
    f.emotion ? `情绪：${EMOTION_LABELS[f.emotion] || f.emotion}` : '',
    f.duration ? `镜头时长：${f.duration} 秒` : '',
    exclude !== 'dialogue' && f.dialogue ? `对白：${f.dialogue}` : '',
    exclude !== 'narration' && f.narration ? `旁白：${f.narration}` : '',
    exclude !== 'sceneDescription' && f.sceneDescription ? `画面描述：${f.sceneDescription}` : '',
    exclude !== 'motionDescription' && f.motionDescription ? `动作描述：${f.motionDescription}` : '',
    exclude !== 'imagePrompt' && f.imagePrompt ? `图片提示词：${f.imagePrompt}` : '',
    exclude !== 'videoPrompt' && f.videoPrompt ? `视频提示词：${f.videoPrompt}` : '',
  ].filter(Boolean).join('\n');
}
function enrichSb(field: 'dialogue' | 'narration' | 'sceneDescription' | 'motionDescription' | 'imagePrompt' | 'videoPrompt', regenerate = false) {
  if (!selectedStoryboard.value) return;
  const charIds = sbForm.characterIds?.length ? sbForm.characterIds : (sbForm.characterId != null ? [sbForm.characterId] : []);
  const char = charIds.length > 0 ? characters.value.find((c) => c.id === charIds[0]) : null;
  if (field === 'dialogue' && !char) {
    ElMessage.warning('旁白镜头请用「旁白」输入框，生成对白需先选择角色');
    return;
  }
  const key = `sb:${field}`;
  aiEnrich(key, field, (sbForm as any)[field] ?? '', sbContext(field), (t) => {
    (sbForm as any)[field] = t;
  }, { regenerate, instruction: enrichInstr[key] });
}

/* ================= 数据加载 ================= */
async function loadAll() {
  loading.value = true;
  try {
    const [ep, drama] = await Promise.all([episodeApi.get(episodeId), dramaApi.get(dramaId)]);
    episode.value = ep;
    dramaTitle.value = drama.title;
    dramaDialect.value = drama.dialect ?? null;
    mergeConfig.value = parseMergeCfg(ep.mergeCfg);
    genCfg.value = parseGenCfg(ep.genCfg);

    const [cs, scs, ps, sbs] = await Promise.all([
      characterApi.list(dramaId),
      sceneApi.list(episodeId),
      propApi.list(episodeId),
      storyboardApi.list(episodeId),
    ]);
    characters.value = cs;
    scenes.value = scs;
    props.value = ps;
    storyboards.value = sbs;
    if (sbs.length > 0) selectStoryboard(0);
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

/** 生成任务结束后静默刷新素材，保持当前选中的分镜 */
async function reloadAssets() {
  try {
    const selId = selectedStoryboard.value?.id ?? null;
    const [cs, scs, ps, sbs] = await Promise.all([
      characterApi.list(dramaId),
      sceneApi.list(episodeId),
      propApi.list(episodeId),
      storyboardApi.list(episodeId),
    ]);
    characters.value = cs;
    scenes.value = scs;
    props.value = ps;
    storyboards.value = sbs;
    if (selId) {
      const idx = sbs.findIndex((s) => s.id === selId);
      if (idx >= 0) selectStoryboard(idx);
    }
  } catch {
    /* 静默失败，日志面板已有提示 */
  }
}

function parseMergeCfg(raw?: string | null): MergeConfig {
  if (raw) {
    try {
      return { ...defaultMergeCfg(), ...JSON.parse(raw) };
    } catch {
      /* ignore */
    }
  }
  return defaultMergeCfg();
}
function defaultMergeCfg(): MergeConfig {
  return {
    burn_dialogue_audio: true,
    burn_narration_subtitles: true,
    keep_original_audio: false,
    aspect_ratio: '9:16',
    frame_rate: 30,
    resolution: '1080p',
  };
}
const mergeConfig = ref<MergeConfig>(defaultMergeCfg());

/* ================= 生成一致性配置（genCfg：画面风格 / 音轨语言） ================= */
const ART_STYLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'cartoon', label: '2D 卡通动漫（推荐）' },
  { value: 'anime2d', label: '日系二维动画' },
  { value: 'anime3d', label: '3D 动画电影' },
  { value: 'realistic', label: '写实真人' },
  { value: 'watercolor', label: '国风水墨' },
];
const genCfg = ref<GenConfig>({ language: 'zh-CN', allowSinging: false, artStyle: 'cartoon' });
function parseGenCfg(raw?: string | null): GenConfig {
  const base: GenConfig = { language: 'zh-CN', allowSinging: false, artStyle: 'cartoon' };
  if (raw) {
    try {
      return { ...base, ...JSON.parse(raw) };
    } catch {
      /* ignore */
    }
  }
  return base;
}

/* ================= 一键生成选项（分步勾选） ================= */
const genDialog = reactive({ show: false });
// 默认全流程勾选：一键成片 = 依次走完 角色→场景→道具→首尾帧→视频→合成
const genSteps = reactive({
  characters: true,
  scenes: true,
  props: true,
  storyboardImages: true,
  storyboardVideos: true,
  merge: true,
});
const GEN_STEP_LABELS: Record<keyof typeof genSteps, string> = {
  characters: '① 角色形象',
  scenes: '② 场景图',
  props: '③ 道具图',
  storyboardImages: '④ 分镜首尾帧',
  storyboardVideos: '⑤ 分镜视频',
  merge: '⑥ 合成成片',
};
// 勾选「合成成片」时自动补选视频，避免空片段合成
watch(
  () => genSteps.merge,
  (v) => {
    if (v) {
      genSteps.storyboardVideos = true;
    }
  },
);

/* ================= 分镜选择与编辑 ================= */
const selectedStoryboard = ref<Storyboard | null>(null);
const sbForm = reactive({
  dialogue: '',
  narration: '',
  sceneDescription: '',
  motionDescription: '',
  characterId: null as number | null,
  characterIds: [] as number[],
  sceneId: null as number | null,
  propId: null as number | null,
  propIds: [] as number[],
  dialect: null as string | null,
  emotion: 'neutral',
  duration: 5,
  imagePrompt: '',
  videoPrompt: '',
});

/** 表单回填期间挂起自动保存，避免切换分镜触发误保存 */
/* 分镜编辑区：可折叠区块（默认全展开，供快速编辑） */
const sbSections = reactive({
  preview: true,
  basic: true,
  copy: true,
  prompt: true,
});

/** 关联与基本设置区块的折叠摘要 */
function sbSectionSummary(): string {
  const parts: string[] = [];
  const roleNames = sbCharacterNames(selectedStoryboard.value as Storyboard);
  if (selectedStoryboard.value && charsOf(selectedStoryboard.value).length) parts.push(`角色 ${roleNames}`);
  if (sceneOf(selectedStoryboard.value as Storyboard)) parts.push(`场景 ${sceneOf(selectedStoryboard.value as Storyboard)!.location}`);
  if (propsOf(selectedStoryboard.value as Storyboard).length) parts.push(`道具 ${propsOf(selectedStoryboard.value as Storyboard).length} 个`);
  if (!parts.length) return '未配置关联';
  return parts.join(' · ');
}

/** 锚点导航：滚动到对应区块 */
function scrollToSection(key: string) {
  const el = document.querySelector(`[data-sb="${key}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let sbHydrating = false;
let sbSaveTimer: ReturnType<typeof setTimeout> | null = null;
const autoSavedAt = ref<string | null>(null);

function selectStoryboard(index: number) {
  const sb = storyboards.value[index];
  if (!sb) return;
  sbHydrating = true;
  selectedStoryboard.value = sb;
  sbForm.dialogue = sb.dialogue ?? '';
  sbForm.narration = sb.narration ?? '';
  sbForm.sceneDescription = sb.sceneDescription ?? '';
  sbForm.motionDescription = sb.motionDescription ?? '';
  sbForm.characterId = sb.characterId ?? null;
  sbForm.characterIds = sb.characterIds?.length
    ? [...sb.characterIds]
    : sb.characterId != null
      ? [sb.characterId]
      : [];
  sbForm.sceneId = sb.sceneId ?? null;
  sbForm.propId = sb.propId ?? null;
  sbForm.propIds = sb.propIds?.length
    ? [...sb.propIds]
    : sb.propId != null
      ? [sb.propId]
      : [];
  sbForm.dialect = sb.dialect ?? null;
  sbForm.emotion = sb.emotion ?? 'neutral';
  sbForm.duration = sb.duration ?? 5;
  sbForm.imagePrompt = sb.imagePrompt ?? '';
  sbForm.videoPrompt = sb.videoPrompt ?? '';
  autoSavedAt.value = null;
  nextTick(() => {
    sbHydrating = false;
  });
}

// debounce 自动保存：编辑停顿 800ms 后静默保存当前分镜
watch(
  sbForm,
  () => {
    if (sbHydrating || !selectedStoryboard.value) return;
    if (sbSaveTimer) clearTimeout(sbSaveTimer);
    sbSaveTimer = setTimeout(() => {
      sbSaveTimer = null;
      void saveStoryboard(true);
    }, 500);
  },
  { deep: true },
);

async function saveStoryboard(silent = false) {
  if (!selectedStoryboard.value) return;
  if (!silent && sbSaveTimer) {
    clearTimeout(sbSaveTimer);
    sbSaveTimer = null;
  }
  const id = selectedStoryboard.value.id;
  // 多选为主：characterIds/propIds 作为新主数据；同时回写单值 characterId/propId 保持兼容
  const charIds = sbForm.characterIds?.length ? sbForm.characterIds : (sbForm.characterId != null ? [sbForm.characterId] : []);
  const propIds = sbForm.propIds?.length ? sbForm.propIds : (sbForm.propId != null ? [sbForm.propId] : []);
  const patch = {
    dialogue: sbForm.dialogue || null,
    narration: sbForm.narration || null,
    sceneDescription: sbForm.sceneDescription || null,
    motionDescription: sbForm.motionDescription || null,
    characterId: charIds[0] ?? null,
    characterIds: charIds,
    sceneId: sbForm.sceneId,
    propId: propIds[0] ?? null,
    propIds: propIds,
    dialect: sbForm.dialect,
    emotion: sbForm.emotion,
    duration: sbForm.duration,
    imagePrompt: sbForm.imagePrompt || null,
    videoPrompt: sbForm.videoPrompt || null,
  };
  try {
    const updated = await storyboardApi.update(id, patch);
    applyStoryboardUpdate(updated);
    if (silent) {
      autoSavedAt.value = new Date().toLocaleTimeString();
    } else {
      ElMessage.success(`分镜 #${updated.number} 已保存`);
    }
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

function applyStoryboardUpdate(sb: Storyboard) {
  const idx = storyboards.value.findIndex((s) => s.id === sb.id);
  if (idx >= 0) {
    // 后端 update 不返回关联摘要，回填本地已知的角色/场景/道具名
    const cur = storyboards.value[idx];
    const merged = {
      ...cur,
      ...sb,
      characterName: characters.value.find((c) => c.id === sb.characterId)?.name ?? null,
      sceneLocation: scenes.value.find((s) => s.id === sb.sceneId)?.location ?? null,
      sceneTime: scenes.value.find((s) => s.id === sb.sceneId)?.time ?? null,
      propName: props.value.find((p) => p.id === sb.propId)?.name ?? null,
    } as Storyboard;
    storyboards.value.splice(idx, 1, merged);
    selectedStoryboard.value = merged;
  }
  return storyboards.value[idx] ?? sb;
}

const selectedSbIndex = computed(() =>
  selectedStoryboard.value
    ? storyboards.value.findIndex((s) => s.id === selectedStoryboard.value!.id)
    : -1,
);

async function addStoryboard() {
  try {
    const sb = await storyboardApi.create({
      episodeId,
      dialogue: '',
      narration: '',
      emotion: 'neutral',
      duration: 5,
    });
    storyboards.value.push(sb as Storyboard);
    selectStoryboard(storyboards.value.length - 1);
    selectSbTab();
    addLog('info', `+ 新增分镜 #${sb.number}（自动排序到末尾）`);
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function removeStoryboard(sb: Storyboard) {
  if (!selectedStoryboard.value) return;
  if (sb.id === selectedStoryboard.value.id && storyboards.value.length === 1) {
    ElMessage.warning('至少保留一个分镜，清空请使用分集重置');
    return;
  }
  try {
    await ElMessageBox.confirm(`删除分镜 #${sb.number}？其素材一并清理。`, '删除分镜', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  try {
    await storyboardApi.remove(sb.id);
    storyboards.value = storyboards.value.filter((s) => s.id !== sb.id).map((s, i) => ({ ...s, number: i + 1 }));
    if (selectedStoryboard.value && sb.id === selectedStoryboard.value.id) {
      selectStoryboard(0);
    }
    addLog('info', `已删除分镜 #${sb.number}`);
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

/* ================= 分镜时间线：拖动排序 ================= */
const dragIdx = ref(-1); // 当前被拖动的分镜下标
const dragOverIdx = ref(-1); // 拖拽悬停目标下标


function onSbDragStart(i: number) {
  if (generating.value || regenSbRunning.value) return;
  dragIdx.value = i;
  dragOverIdx.value = -1;
}
function onSbDragOver(e: DragEvent, i: number) {
  if (dragIdx.value < 0) return;
  e.preventDefault();
  if (i !== dragOverIdx.value) dragOverIdx.value = i;
}
function onSbDrop(i: number) {
  const from = dragIdx.value;
  dragIdx.value = -1;
  dragOverIdx.value = -1;
  if (from < 0 || from === i) return;
  const arr = [...storyboards.value];
  const [moved] = arr.splice(from, 1);
  arr.splice(i, 0, moved);
  const numbered = arr.map((s, idx) => ({ ...s, number: idx + 1 }));
  storyboards.value = numbered;
  // 同步选中下标，保持当前编辑分镜不变
  if (selectedStoryboard.value) {
    const ni = numbered.findIndex((s) => s.id === selectedStoryboard.value!.id);
    if (ni >= 0) selectStoryboard(ni);
  }
  // 调用 reorder 持久化
  storyboardApi
    .reorder(episodeId, numbered.map((s) => s.id))
    .then(() => {
      addLog('info', `已调整分镜顺序，新顺序 #${numbered.map((s) => s.number).join(' → #')}`);
    })
    .catch((e: any) => {
      ElMessage.error(`排序保存失败：${e.message}`);
      reloadAssets();
    });
}
function onSbDragEnd(i: number) {
  dragIdx.value = -1;
  dragOverIdx.value = -1;
}

/* ================= 方言解析（三级级联） ================= */
function resolveDialect(sb: Storyboard) {
  if (sb.dialect && DIALECT_MAP[sb.dialect]) {
    return { label: DIALECT_MAP[sb.dialect].label, level: '分镜覆写' };
  }
  if (sb.characterId) {
    const c = characters.value.find((x) => x.id === sb.characterId);
    if (c?.dialect && DIALECT_MAP[c.dialect]) {
      return { label: DIALECT_MAP[c.dialect].label, level: '角色默认' };
    }
  }
  if (dramaDialect.value && DIALECT_MAP[dramaDialect.value]) {
    return { label: DIALECT_MAP[dramaDialect.value].label, level: '剧集兜底' };
  }
  const d = DIALECT_MAP.standard;
  return { label: d.label, level: '默认' };
}

/* ================= SSE 日志流 ================= */
let source: EventSource | null = null;
function connectLogStream() {
  if (source) source.close();
  source = new EventSource(generateApi.logsUrl(episodeId));
  source.onerror = () => {
    /* 断线由浏览器自动重连 */
  };
  source.onmessage = (ev) => handleEvent(ev.data);
  source.addEventListener('log', (ev: any) => {
    const d = JSON.parse(ev.data);
    addLog(d.level || 'info', d.text || '');
  });
  source.addEventListener('message', (ev: any) => handleEvent(ev.data));
}

function handleEvent(data: string) {
  try {
    const e: any = JSON.parse(data);
    if (!e || !e.type) return;
    if (e.type === 'log') {
      addLog(e.data?.level || 'info', e.data?.text || '');
    } else if (e.type === 'storyboard') {
      const d = e.data;
      const sb = storyboards.value.find((s) => s.id === d?.id);
      if (sb) {
        sb.status = d.status ?? sb.status;
        if (d.imageUrl) sb.imageUrl = d.imageUrl;           // 首帧实时显示
        if (d.lastFrameUrl) sb.lastFrameUrl = d.lastFrameUrl; // 尾帧实时显示
        if (d.videoUrl) sb.videoUrl = d.videoUrl;           // 视频实时可播放
      }
    } else if (e.type === 'asset') {
      // 角色/场景/道具形象图生成完成：实时补到当前数据，无需刷新
      const d = e.data;
      if (d?.kind === 'character') {
        const c = characters.value.find((x) => x.id === d.id);
        if (c) {
          c.imageUrl = d.imageUrl ?? c.imageUrl;
          c.sourceUrl = d.sourceUrl ?? c.sourceUrl;
        }
      } else if (d?.kind === 'scene') {
        const s = scenes.value.find((x) => x.id === d.id);
        if (s) {
          s.imageUrl = d.imageUrl ?? s.imageUrl;
          s.sourceUrl = d.sourceUrl ?? s.sourceUrl;
        }
      } else if (d?.kind === 'prop') {
        const p = props.value.find((x) => x.id === d.id);
        if (p) {
          p.imageUrl = d.imageUrl ?? p.imageUrl;
          p.sourceUrl = d.sourceUrl ?? p.sourceUrl;
        }
      }
    } else if (e.type === 'phase') {
      const d = e.data;
      flowStep.value = d?.stepId ?? '';
      flowLabel.value = d?.stepLabel ?? '';
      if (typeof d?.percent === 'number') flowPercent.value = d.percent;
      flowTag.value = d?.episodeTitle ? `第 ${d?.episodeNumber ?? ''} 集「${d.episodeTitle}」` : '';
    } else if (e.type === 'merge') {
      mergeProgress.value = e.data?.progress ?? mergeProgress.value;
      if (mergeProgress.value >= 100) {
        mergeRunning.value = false;
        flowPercent.value = 100;
        episode.value = {
          ...episode.value!,
          merged: true,
          status: 'completed',
          mergedUrl: e.data?.url ?? episode.value?.mergedUrl ?? null,
        } as Episode;
      }
    } else if (e.type === 'done') {
      // asset 级任务结束不代表整集生成结束
      if (e.data?.scope !== 'asset') {
        generating.value = false;
        flowStep.value = '';
        flowLabel.value = '';
      }
      clearBusy();
      reloadAssets();
      // 剧本拆解落库完成：复位状态，并引导衔接「一键生成」
      if (pendingParseDone && e.data?.scope !== 'asset') {
        pendingParseDone = false;
        parseRunning.value = false;
        ElMessage.success('剧本拆解完成');
        ElMessageBox.confirm(
          '剧本拆解完成，是否立即开始生成本集素材（角色/场景/道具/分镜首尾帧）？',
          '拆解完成',
          { type: 'success', confirmButtonText: '立即生成', cancelButtonText: '稍后再说' },
        )
          .then(() => startGenerate())
          .catch(() => {});
      }
    } else if (e.type === 'error') {
      generating.value = false;
      clearBusy();
      ElMessage.error(e.data?.text || '生成出错');
    }
  } catch {
    /* ignore */
  }
}

/* ================= 生成控制 ================= */
async function startGenerate() {
  if (generating.value) return;
  // 分镜为空时不再拦截：后端会先自动拆解剧本再继续流水线（logs/进度图会展示当前步骤）
  genDialog.show = true;
}
async function confirmGenerate() {
  genDialog.show = false;
  generating.value = true;
  try {
    // 先持久化一致性配置（画面风格 / 音轨语言），再发起分步生成
    await episodeApi.update(episodeId, {
      genCfg: JSON.stringify({
        language: genCfg.value.language,
        allowSinging: genCfg.value.allowSinging,
        artStyle: genCfg.value.artStyle,
      }),
    });
    await generateApi.generateEpisode(episodeId, { ...genSteps });
  } catch (e: any) {
    generating.value = false;
    ElMessage.error(e.message);
  }
}

// 一键重新生成分镜素材：按当前剧本强制重做全部首尾帧 → 视频
const regenSbRunning = ref(false);
async function regenerateStoryboards() {
  if (generating.value || regenSbRunning.value) return;
  if (storyboards.value.length === 0) {
    ElMessage.warning('暂无分镜，请先添加分镜');
    return;
  }
  try {
    await ElMessageBox.confirm(
      '将根据当前剧本重新生成全部分镜的首尾帧与分镜视频（覆盖已有素材，耗时较长）。\n生成时会统一人物风格与音轨语言（中文），确定继续？',
      '一键重新生成分镜素材',
      { type: 'warning', confirmButtonText: '重新生成', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  regenSbRunning.value = true;
  generating.value = true;
  try {
    await generateApi.regenerateStoryboards(episodeId);
  } catch (e: any) {
    generating.value = false;
    regenSbRunning.value = false;
    ElMessage.error(e.message);
  }
}
async function startMerge() {
  if (mergeRunning.value) return;
  if (storyboards.value.length === 0) {
    ElMessage.warning('无可合成的分镜');
    return;
  }
  mergeRunning.value = true;
  mergeProgress.value = 0;
  try {
    await generateApi.merge(episodeId, mergeConfig.value);
  } catch (e: any) {
    mergeRunning.value = false;
    ElMessage.error(e.message);
  }
}

function totalDuration() {
  return storyboards.value.reduce((s, x) => s + (x.duration ?? 0), 0).toFixed(1);
}

/** 分镜缩略图：优先首帧图，回退尾帧 */
function sbThumb(sb: Storyboard): string {
  return sb.imageUrl || sb.lastFrameUrl || '';
}
/** 分镜是否已生成视频（可播放预览） */
function sbHasVideo(sb: Storyboard): boolean {
  return !!sb.videoUrl;
}

/* ================= 资源管理（角色/场景/道具） ================= */
const resDialog = reactive({ show: false, kind: '' as StepKey, editingId: null as number | null });
const charForm = reactive({ name: '', role: 'supporting', roleLabel: '配角', dialect: null as string | null, appearance: '', intro: '' });
const sceneForm = reactive({
  location: '',
  time: '',
  description: '',
  prompt: '',
  useQuadGrid: false,
});
const propForm = reactive({
  name: '',
  type: '',
  description: '',
  prompt: '',
  useQuadGrid: false,
});

function openCharDialog(ch: Character | null) {
  resDialog.kind = 'characters';
  resDialog.editingId = ch?.id ?? null;
  charForm.name = ch?.name ?? '';
  charForm.role = ch?.role ?? 'supporting';
  charForm.roleLabel = ch?.roleLabel ?? (ch?.role === 'main' ? '主角' : '配角');
  charForm.dialect = ch?.dialect ?? null;
  charForm.appearance = ch?.appearance ?? '';
  charForm.intro = ch?.intro ?? '';
  resDialog.show = true;
}
function openSceneDialog(sc: Scene | null) {
  resDialog.kind = 'scenes';
  resDialog.editingId = sc?.id ?? null;
  sceneForm.location = sc?.location ?? '';
  sceneForm.time = sc?.time ?? '';
  sceneForm.description = sc?.description ?? '';
  sceneForm.prompt = sc?.prompt ?? '';
  sceneForm.useQuadGrid = sc?.useQuadGrid ?? false;
  resDialog.show = true;
}
function openPropDialog(p: Prop | null) {
  resDialog.kind = 'props';
  resDialog.editingId = p?.id ?? null;
  propForm.name = p?.name ?? '';
  propForm.type = p?.type ?? '';
  propForm.description = p?.description ?? '';
  propForm.prompt = p?.prompt ?? '';
  propForm.useQuadGrid = p?.useQuadGrid ?? false;
  resDialog.show = true;
}

async function saveResource() {
  try {
    if (resDialog.kind === 'characters') {
      if (resDialog.editingId) {
        const u = await characterApi.update(resDialog.editingId, {
          name: charForm.name,
          role: charForm.role,
          roleLabel: charForm.roleLabel,
          dialect: charForm.dialect,
          appearance: charForm.appearance || null,
          intro: charForm.intro || null,
        });
        const i = characters.value.findIndex((c) => c.id === u.id);
        if (i >= 0) characters.value[i] = { ...characters.value[i], ...u };
      } else {
        const c = await characterApi.create({
          dramaId,
          name: charForm.name,
          role: charForm.role,
          roleLabel: charForm.roleLabel,
          dialect: charForm.dialect,
          appearance: charForm.appearance || null,
          intro: charForm.intro || null,
        });
        characters.value.push(c as Character);
      }
    } else if (resDialog.kind === 'scenes') {
      if (resDialog.editingId) {
        const u = await sceneApi.update(resDialog.editingId, {
          location: sceneForm.location,
          time: sceneForm.time || null,
          description: sceneForm.description || null,
          prompt: sceneForm.prompt || null,
          useQuadGrid: sceneForm.useQuadGrid,
        });
        const i = scenes.value.findIndex((s) => s.id === u.id);
        if (i >= 0) scenes.value[i] = { ...scenes.value[i], ...u };
      } else {
        const s = await sceneApi.create({
          episodeId,
          location: sceneForm.location,
          time: sceneForm.time || null,
          description: sceneForm.description || null,
          prompt: sceneForm.prompt || null,
          useQuadGrid: sceneForm.useQuadGrid,
        });
        scenes.value.push(s as Scene);
      }
    } else if (resDialog.kind === 'props') {
      if (resDialog.editingId) {
        const u = await propApi.update(resDialog.editingId, {
          name: propForm.name,
          type: propForm.type || null,
          description: propForm.description || null,
          prompt: propForm.prompt || null,
          useQuadGrid: propForm.useQuadGrid,
        });
        const i = props.value.findIndex((p) => p.id === u.id);
        if (i >= 0) props.value[i] = { ...props.value[i], ...u };
      } else {
        const p = await propApi.create({
          episodeId,
          name: propForm.name,
          type: propForm.type || null,
          description: propForm.description || null,
          prompt: propForm.prompt || null,
          useQuadGrid: propForm.useQuadGrid,
        });
        props.value.push(p as Prop);
      }
    }
    resDialog.show = false;
    ElMessage.success('已保存');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function removeResource(kind: StepKey, item: any) {
  try {
    await ElMessageBox.confirm(`删除「${item.name || item.location || item.name}」？引用它的分镜将解除关联。`, '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  try {
    if (kind === 'characters') {
      await characterApi.remove(item.id);
      characters.value = characters.value.filter((c) => c.id !== item.id);
    } else if (kind === 'scenes') {
      await sceneApi.remove(item.id);
      scenes.value = scenes.value.filter((s) => s.id !== item.id);
    } else if (kind === 'props') {
      await propApi.remove(item.id);
      props.value = props.value.filter((p) => p.id !== item.id);
    }
    ElMessage.success('已删除');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

// 分镜关联资产（供关联卡片与生成提示词使用）
// 多选：返回该分镜关联的所有角色/道具（优先 characterIds/propIds，回退单值）
function charsOf(sb: Storyboard): Character[] {
  const ids = sb.characterIds?.length
    ? sb.characterIds
    : sb.characterId != null
      ? [sb.characterId]
      : [];
  return characters.value.filter((c) => ids.includes(c.id));
}
function charOf(sb: Storyboard) {
  return charsOf(sb)[0] ?? null;
}
function sceneOf(sb: Storyboard) {
  return scenes.value.find((s) => s.id === sb.sceneId) ?? null;
}
function propsOf(sb: Storyboard): Prop[] {
  const ids = sb.propIds?.length
    ? sb.propIds
    : sb.propId != null
      ? [sb.propId]
      : [];
  return props.value.filter((p) => ids.includes(p.id));
}
function propOf(sb: Storyboard) {
  return propsOf(sb)[0] ?? null;
}

/** 分镜列表里显示的出场角色名（多角色用顿号连接） */
function sbCharacterNames(sb: Storyboard): string {
  const names = charsOf(sb).map((c) => c.name);
  if (names.length) return names.join('、');
  return '旁白';
}

// 资源被分镜引用次数
function usedBy(kind: StepKey, id: number) {
  if (kind === 'characters') {
    return storyboards.value.filter((s) =>
      (s.characterIds?.length ? s.characterIds : s.characterId != null ? [s.characterId] : []).includes(id),
    ).length;
  }
  if (kind === 'scenes') return storyboards.value.filter((s) => s.sceneId === id).length;
  return storyboards.value.filter((s) =>
    (s.propIds?.length ? s.propIds : s.propId != null ? [s.propId] : []).includes(id),
  ).length;
}

/* ================= 参考图上传与描述提取 ================= */
const refTarget = reactive({ kind: '' as 'character' | 'scene' | 'prop' | 'storyboard', id: 0 });
const refFileInput = ref<HTMLInputElement | null>(null);
const refStore = reactive<Record<string, { url: string; dataUri: string }>>({});
const refKey = (kind: string, id: number) => `${kind}:${id}`;

function openRefPicker(kind: 'character' | 'scene' | 'prop' | 'storyboard', id: number) {
  refTarget.kind = kind;
  refTarget.id = id;
  refFileInput.value?.click();
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('读取图片失败'));
    r.readAsDataURL(file);
  });
}

async function onRefPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const kind = refTarget.kind as 'character' | 'scene' | 'prop' | 'storyboard';
  const id = refTarget.id;
  if (!file || !kind || !id) return;
  try {
    const dataUri = await readAsDataURL(file);
    addLog('info', `📤 上传参考图（${kind} #${id}）...`);
    const res = await uploadApi.image({
      dataUri,
      kind,
      dramaId,
      episodeId: kind === 'character' ? undefined : episodeId,
    });
    refStore[refKey(kind, id)] = { url: res.url, dataUri };
    await patchRef(kind, id, res.url);
    ElMessage.success('参考图已上传');
  } catch (err: any) {
    ElMessage.error(err.message || '上传失败');
  }
}

async function patchRef(
  kind: 'character' | 'scene' | 'prop' | 'storyboard',
  id: number,
  url: string,
) {
  if (kind === 'character') {
    const u = await characterApi.update(id, { referenceImageUrl: url });
    const i = characters.value.findIndex((c) => c.id === id);
    if (i >= 0) characters.value[i] = { ...characters.value[i], ...u };
  } else if (kind === 'scene') {
    const u = await sceneApi.update(id, { referenceImageUrl: url });
    const i = scenes.value.findIndex((s) => s.id === id);
    if (i >= 0) scenes.value[i] = { ...scenes.value[i], ...u };
  } else if (kind === 'prop') {
    const u = await propApi.update(id, { referenceImageUrl: url });
    const i = props.value.findIndex((p) => p.id === id);
    if (i >= 0) props.value[i] = { ...props.value[i], ...u };
  } else {
    const u = await storyboardApi.update(id, { referenceImageUrl: url });
    applyStoryboardUpdate(u);
  }
}

async function ensureDataUri(key: string, fallbackUrl?: string | null): Promise<string | null> {
  if (refStore[key]?.dataUri) return refStore[key].dataUri;
  if (!fallbackUrl) return null;
  try {
    const blob = await (await fetch(fallbackUrl)).blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.onerror = () => reject(new Error('读取参考图失败'));
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function extractRef(kind: 'character' | 'scene' | 'prop', id: number) {
  const key = refKey(kind, id);
  const ent =
    kind === 'character'
      ? characters.value.find((c) => c.id === id)
      : kind === 'scene'
        ? scenes.value.find((s) => s.id === id)
        : props.value.find((p) => p.id === id);
  if (!ent) return;
  const dataUri = await ensureDataUri(key, (ent as any).referenceImageUrl);
  if (!dataUri) {
    ElMessage.warning('请先上传参考图后再提取描述');
    return;
  }
  try {
    addLog('info', `🔍 提取参考图描述（${kind} #${id}）...`);
    const r = await uploadApi.extractDescription({ dataUri, kind });
    if (!r.description) {
      ElMessage.warning('未能提取到描述，请手动填写');
      return;
    }
    if (kind === 'character') {
      openCharDialog(ent as Character);
      charForm.appearance = r.description!;
    } else if (kind === 'scene') {
      openSceneDialog(ent as Scene);
      sceneForm.description = r.description!;
    } else {
      openPropDialog(ent as Prop);
      propForm.description = r.description!;
    }
    ElMessage.success('已从参考图提取描述，可修改后保存');
  } catch (err: any) {
    ElMessage.error(err.message || '提取失败');
  }
}

/* ================= 分集设置 ================= */
const epDialog = reactive({ show: false });
const epForm = reactive({ title: '', description: '' });
function openEpSettings() {
  epForm.title = episode.value?.title ?? '';
  epForm.description = episode.value?.description ?? '';
  epDialog.show = true;
}
async function saveEpisode() {
  try {
    const u = await episodeApi.update(episodeId, {
      title: epForm.title,
      description: epForm.description || null,
    });
    episode.value = { ...episode.value!, ...u } as Episode;
    epDialog.show = false;
    ElMessage.success('分集设置已保存');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

/* ================= 环境 ================= */
function selectSbTab() {
  scriptTab.value = 'storyboards';
}
function goBack() {
  router.push(`/project/${dramaId}`);
}

/* ================= 重置分集（清空重来：删光本集数据 + 自动按剧本重建） ================= */
async function resetEpisode() {
  try {
    await ElMessageBox.confirm(
      '确定要重置本分集吗？\n本集的全部分镜、场景、道具记录及其全部生成素材（图片/视频/成片）将被删除且不可恢复，本集不再使用的角色也会一并清理。\n随后将自动按剧本原文重新拆解生成角色、场景、道具与分镜。确定继续？',
      '重置分集',
      { type: 'warning', confirmButtonText: '清空并重建', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await generateApi.resetEpisode(episodeId);
    ElMessage.success('分集已清空，正在自动按剧本重建，请关注下方日志');
    await loadAll();
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

/* ================= 剧本原文（AI 拆解输入源） ================= */
const scriptDraft = ref('');
const scriptDirty = ref(false);
const parseRunning = ref(false);

watch(
  () => episode.value?.scriptText,
  (v) => {
    if (!scriptDirty.value) scriptDraft.value = v ?? '';
  },
  { immediate: true },
);

async function saveScript() {
  try {
    const u = await episodeApi.update(episodeId, { scriptText: scriptDraft.value || null });
    episode.value = { ...episode.value!, ...u } as Episode;
    scriptDirty.value = false;
    ElMessage.success('剧本已保存');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

/** AI 拆解剧本：先调 preview 拿到结构化结果弹窗确认，确认后走 apply 落库（后台 + SSE） */
const parsePreview = reactive<{ show: boolean; mode: 'replace' | 'append'; data: any }>({
  show: false,
  mode: 'replace',
  data: null,
});
const previewLoading = ref(false);
let pendingParseDone = false;

async function parseScript(mode: 'replace' | 'append') {
  if (previewLoading.value || parseRunning.value) return;
  if (!scriptDraft.value.trim()) {
    ElMessage.warning('请先粘贴剧本原文并保存');
    return;
  }
  if (scriptDirty.value) {
    ElMessage.warning('剧本有未保存的修改，请先点「保存剧本」再拆解');
    return;
  }
  previewLoading.value = true;
  addLog('info', '📖 AI 正在拆解剧本生成预览，请稍候（约 10~60 秒）...');
  try {
    const r = await generateApi.previewParseScript(episodeId);
    parsePreview.mode = mode;
    parsePreview.data = r.parsed;
    parsePreview.show = true;
    addLog(
      'success',
      `拆解预览就绪：角色 ${r.counts.characters}、场景 ${r.counts.scenes}、道具 ${r.counts.props}、分镜 ${r.counts.storyboards}，请在弹窗中确认`,
    );
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    previewLoading.value = false;
  }
}

/** 预览不满意：丢弃本次结果，重新调 AI 拆一版 */
async function rerunParsePreview() {
  parsePreview.show = false;
  await parseScript(parsePreview.mode);
}

/** 预览确认：把拆解结果落库（replace 先清空本集旧记录），完成事件里自动衔接一键生成 */
async function confirmApplyParsed() {
  if (parseRunning.value) return;
  const parsed = parsePreview.data;
  if (!parsed?.storyboards?.length) {
    ElMessage.warning('拆解结果中没有分镜，无法落库');
    return;
  }
  parsePreview.show = false;
  parseRunning.value = true;
  pendingParseDone = true;
  scriptTab.value = 'script';
  addLog('info', `📖 已确认拆解结果，正在落库（${parsePreview.mode === 'replace' ? '替换' : '追加'}模式）...`);
  try {
    await generateApi.applyParsedScript(episodeId, { mode: parsePreview.mode, parsed });
  } catch (e: any) {
    parseRunning.value = false;
    pendingParseDone = false;
    ElMessage.error(e.message);
  }
}

function statusMeta(status?: string | null) {
  if (status === 'generating') return { text: '生成中', cls: 'lmd-badge-indigo' };
  if (status === 'finished') return { text: '完成', cls: 'lmd-badge-emerald' };
  if (status === 'cancelled') return { text: '已取消', cls: 'lmd-badge-gray' };
  return { text: '待生成', cls: 'lmd-badge-gray' };
}

const countFor = (k: StepKey) => {
  if (k === 'script') return scriptDraft.value.trim() ? 1 : 0;
  if (k === 'characters') return characters.value.length;
  if (k === 'scenes') return scenes.value.length;
  if (k === 'props') return props.value.length;
  if (k === 'storyboards') return storyboards.value.length;
  return 0;
};

/* ================= 详细流水线进度（每个角色/场景/道具/分镜的完成状态） ================= */
const detailDone = computed(() => ({
  characters: characters.value.filter((c) => !!c.imageUrl).length,
  scenes: scenes.value.filter((s) => !!s.imageUrl).length,
  props: props.value.filter((p) => !!p.imageUrl).length,
  sbImages: storyboards.value.filter((s) => !!s.imageUrl || !!s.lastFrameUrl).length,
  sbVideos: storyboards.value.filter((s) => !!s.videoUrl).length,
}));
const detailTotal = computed(() => ({
  characters: characters.value.length,
  scenes: scenes.value.length,
  props: props.value.length,
  storyboards: storyboards.value.length,
}));

onMounted(() => {
  connectLogStream();
  flowStep.value = route.query.generate === '1' ? 'characters' : '';
  loadAll().then(() => {
    // 从分集列表「一键成片」进入：自动走全流程，进度在顶部流程图 / 下方日志实时可见
    if (route.query.generate === '1' && !generating.value) {
      addLog('info', '📌 检测到「一键成片」，已自动开始整集流水线，进度见顶部流程图');
      confirmGenerate();
    }
  });
});
onBeforeUnmount(() => {
  if (source) source.close();
});
</script>

<template>
  <div class="flex flex-col min-h-screen">
    <!-- 顶栏 -->
    <header class="lmd-topbar">
      <div class="lmd-topbar-inner">
        <div class="flex items-center gap-4">
          <button class="lmd-back-btn" @click="goBack" title="返回分集管理">
            <el-icon :size="18"><ArrowLeft /></el-icon>
          </button>
          <div>
            <h1 class="lmd-title">{{ episode?.title || '加载中...' }}</h1>
            <p class="lmd-subtitle">剧本编辑 · {{ dramaTitle }} · 第 {{ episode?.episodeNumber }} 集</p>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <button class="lmd-btn-ghost" @click="openEpSettings">
            <el-icon class="mr-1" :size="15"><Setting /></el-icon>分集设置
          </button>
          <button class="lmd-btn-ghost" @click="resetEpisode">
            <el-icon class="mr-1" :size="15"><Refresh /></el-icon>重置分集
          </button>
          <button class="lmd-btn-ghost" @click="addStoryboard">
            <el-icon class="mr-1" :size="15"><Plus /></el-icon>添加分镜
          </button>
          <button class="lmd-btn-primary flex items-center gap-1.5" :disabled="generating" @click="startGenerate">
            <span v-if="generating" class="lmd-spinner" />
            <el-icon v-else :size="16"><MagicStick /></el-icon>
            {{ generating ? '生成中...' : '一键成片' }}
          </button>
        </div>
      </div>
    </header>

    <!-- 成片进度流程图：实时高亮当前流水线步骤（SSE phase 事件驱动）+ 各资源详细进度 -->
    <section v-show="generating || flowStep" class="pipeline-box">
      <div class="pipeline-inner">
        <div class="pipeline-title">
          <el-icon :size="15" style="color: var(--indigo)"><MagicStick /></el-icon>
          <span>成片进度</span>
          <span v-if="flowTag" class="pipeline-tag">{{ flowTag }}</span>
          <span class="pipeline-percent">{{ flowPercent }}%</span>
        </div>
        <div class="pipeline-bar">
          <div
            v-for="(p, pi) in PIPELINE_STEPS"
            :key="p.key"
            class="pipeline-step"
            :class="{
              done: flowIdx > pi,
              active: flowStep === p.key,
            }"
          >
            <span class="pipeline-dot">{{ '①②③④⑤⑥'[pi] }}</span>
            <span class="pipeline-label">{{ p.label }}</span>
          </div>
        </div>
        <div class="pipeline-status">
          <span v-if="flowLabel">{{ flowLabel }}进行中...</span>
          <span v-else-if="generating">流水线启动中...</span>
          <span v-else>等待生成</span>
        </div>

        <!-- 详细资源进度：每个角色/场景/道具/分镜的完成状态 -->
        <div class="pipeline-detail">
          <div class="pdetail-block" v-if="detailTotal.characters">
            <span class="pdetail-cap"><el-icon :size="12"><User /></el-icon>角色</span>
            <div class="pdetail-pills">
              <span
                v-for="c in characters"
                :key="c.id"
                class="pdetail-pill"
                :class="{ done: !!c.imageUrl, busy: assetBusy[keyOf('characters', c.id)] }"
                :title="`${c.name}${c.imageUrl ? '：形象已生成' : '：形象待生成'}`"
              >{{ c.name }}<template v-if="c.imageUrl">✓</template></span>
            </div>
          </div>
          <div class="pdetail-block" v-if="detailTotal.scenes">
            <span class="pdetail-cap"><el-icon :size="12"><Location /></el-icon>场景</span>
            <div class="pdetail-pills">
              <span
                v-for="s in scenes"
                :key="s.id"
                class="pdetail-pill"
                :class="{ done: !!s.imageUrl, busy: assetBusy[keyOf('scenes', s.id)] }"
                :title="`${s.location}${s.imageUrl ? '：场景图已生成' : '：场景图待生成'}`"
              >{{ s.location }}<template v-if="s.imageUrl">✓</template></span>
            </div>
          </div>
          <div class="pdetail-block" v-if="detailTotal.props">
            <span class="pdetail-cap"><el-icon :size="12"><Goods /></el-icon>道具</span>
            <div class="pdetail-pills">
              <span
                v-for="p in props"
                :key="p.id"
                class="pdetail-pill"
                :class="{ done: !!p.imageUrl, busy: assetBusy[keyOf('props', p.id)] }"
                :title="`${p.name}${p.imageUrl ? '：道具图已生成' : '：道具图待生成'}`"
              >{{ p.name }}<template v-if="p.imageUrl">✓</template></span>
            </div>
          </div>
          <div class="pdetail-block">
            <span class="pdetail-cap"><el-icon :size="12"><Film /></el-icon>分镜</span>
            <div class="pdetail-pills">
              <span
                v-for="(sb, si) in storyboards"
                :key="sb.id"
                class="pdetail-pill"
                :class="{
                  done: !!sb.videoUrl,
                  half: !!sb.imageUrl && !sb.videoUrl,
                  busy: selectedSbIndex === si && assetBusy['sb-image'] || assetBusy['sb-video'],
                }"
                :title="`分镜#${sb.number}：${sb.videoUrl ? '视频已生成' : sb.imageUrl ? '图片已生成，视频待生成' : '素材待生成'}`"
              >#{{ sb.number }}<template v-if="sb.videoUrl">✓</template><template v-else-if="sb.imageUrl">◐</template></span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 流程步进条 -->
    <nav class="lmd-stepper">
      <div class="lmd-stepper-inner">
        <template v-for="(s, i) in steps" :key="s.key">
          <button class="lmd-step" :class="{ active: scriptTab === s.key }" @click="scriptTab = s.key">
            {{ '①②③④⑤⑥'[i] }} {{ s.label }}<span class="lmd-step-count">{{ countFor(s.key) }}</span>
          </button>
        </template>
      </div>
    </nav>

    <!-- 主内容 -->
    <main class="lmd-main">
      <!-- ⓪ 剧本 -->
      <section v-if="scriptTab === 'script'">
        <div class="panel-head">
          <h3 class="panel-title">剧本原文 <span class="muted">· AI 拆解的输入源，拆解前请先保存</span></h3>
          <div class="flex items-center gap-2">
            <button class="lmd-btn-ghost sm" :disabled="!scriptDirty" @click="saveScript">保存剧本</button>
            <button class="lmd-btn-ghost sm" :disabled="previewLoading || parseRunning" title="先预览拆解结果，确认后追加到现有记录" @click="parseScript('append')">
              <span v-if="previewLoading && parsePreview.mode === 'append'" class="mini-spinner dark" />
              <el-icon v-else :size="13"><MagicStick /></el-icon>AI 拆解 · 追加
            </button>
            <button class="lmd-btn-primary sm" :disabled="previewLoading || parseRunning" title="先预览拆解结果，确认后清空本集旧数据并重新生成（角色按姓名去重复用）" @click="parseScript('replace')">
              <span v-if="previewLoading && parsePreview.mode === 'replace'" class="lmd-spinner" style="border-top-color:#fff" />
              <el-icon v-else :size="13"><MagicStick /></el-icon>AI 拆解 · 替换生成
            </button>
          </div>
        </div>
        <div class="lmd-card" style="padding:16px">
          <el-input
            v-model="scriptDraft"
            type="textarea"
            :rows="18"
            resize="vertical"
            placeholder="把本集剧本粘贴到这里（支持纯文本剧本：场景说明、人物对白、动作描述均可）。&#10;保存后点「AI 拆解」，会自动生成本集的角色、场景、道具与分镜文本记录。"
            @input="scriptDirty = true"
          />
          <p class="muted" style="font-size:12px;margin-top:8px">
            拆解只生成文本记录（角色形象、场景图、分镜首尾帧等素材仍需到对应面板或「一键生成」中产出）；整剧共享的角色按姓名去重复用，不会重复创建。
          </p>
        </div>
      </section>

      <!-- ① 角色 -->
      <section v-if="scriptTab === 'characters'">
        <div class="panel-head">
          <h3 class="panel-title">角色管理 <span class="muted">· 整剧共享</span></h3>
          <button class="lmd-btn-primary" @click="openCharDialog(null)"><el-icon :size="14" class="mr-1"><Plus /></el-icon>新增角色</button>
        </div>
        <div class="lmd-card res-grid">
          <div v-for="c in characters" :key="c.id" class="res-card">
            <div class="res-top">
              <div class="res-avatar">
                <el-image v-if="c.imageUrl" :src="c.imageUrl" :alt="c.name" class="res-thumb" :preview-src-list="[c.imageUrl]" preview-teleported fit="cover" />
                <span v-else>{{ c.role === 'main' ? '⭐' : '🧑' }}</span>
              </div>
              <div class="res-body">
                <div class="res-name">{{ c.name }} <el-tag size="small" effect="plain">{{ c.roleLabel || (c.role === 'main' ? '主角' : '配角') }}</el-tag></div>
                <div class="res-meta">方言：{{ c.dialect ? DIALECT_MAP[c.dialect]?.label : '跟随剧集/分镜' }}</div>
                <div class="res-meta">关联分镜：{{ usedBy('characters', c.id) }} · {{ c.appearance ? c.appearance.slice(0, 40) : '暂无外貌描述' }}</div>
                <div class="res-meta" v-if="c.anchors"><span class="anchor-tag">✅ 视觉锚点已生成</span></div>
                <div class="res-meta" v-if="c.referenceImageUrl"><span class="anchor-tag" style="color:#6366f1">📷 参考图已上传</span></div>
              </div>
            </div>
            <div class="res-actions">
              <button class="icon-btn" :class="{ busy: assetBusy[keyOf('characters', c.id)] }" :title="c.imageUrl ? '重新生成形象' : 'AI 生成形象'" @click="genCharacter(c)">
                <span v-if="assetBusy[keyOf('characters', c.id)]" class="mini-spinner" />
                <el-icon v-else><MagicStick /></el-icon>
              </button>
              <button class="icon-btn" :title="c.referenceImageUrl ? '更换参考图' : '上传参考图'" @click="openRefPicker('character', c.id)"><el-icon><Upload /></el-icon></button>
              <button v-if="c.referenceImageUrl" class="icon-btn" title="据此提取外貌" @click="extractRef('character', c.id)"><el-icon><MagicStick /></el-icon></button>
              <button class="icon-btn" title="编辑" @click="openCharDialog(c)"><el-icon><Edit /></el-icon></button>
              <button class="icon-btn danger" title="删除" @click="removeResource('characters', c)"><el-icon><Delete /></el-icon></button>
            </div>
          </div>
          <div v-if="characters.length === 0" class="empty-tip">还没有角色，点击「新增角色」创建</div>
        </div>
      </section>

      <!-- ② 场景 -->
      <section v-if="scriptTab === 'scenes'">
        <div class="panel-head">
          <h3 class="panel-title">场景管理 <span class="muted">· 本集</span></h3>
          <button class="lmd-btn-primary" @click="openSceneDialog(null)"><el-icon :size="14" class="mr-1"><Plus /></el-icon>新增场景</button>
        </div>
        <div class="lmd-card res-grid">
          <div v-for="s in scenes" :key="s.id" class="res-card">
            <div class="res-top">
              <div class="res-avatar">
                <el-image v-if="s.imageUrl" :src="s.imageUrl" :alt="s.location" class="res-thumb" :preview-src-list="[s.imageUrl]" preview-teleported fit="cover" />
                <span v-else>🏠</span>
              </div>
              <div class="res-body">
                <div class="res-name">{{ s.location }} <el-tag v-if="s.time" size="small" effect="plain">{{ s.time }}</el-tag>
                  <el-tag v-if="s.useQuadGrid" size="small" type="warning" effect="plain">四宫格</el-tag>
                </div>
                <div class="res-meta">关联分镜：{{ usedBy('scenes', s.id) }}</div>
                <div class="res-meta">{{ s.description ? s.description.slice(0, 40) : '暂无场景描述' }}</div>
                <div class="res-meta" v-if="s.referenceImageUrl"><span class="anchor-tag" style="color:#6366f1">📷 参考图已上传</span></div>
              </div>
            </div>
            <div class="res-actions">
              <button class="icon-btn" :class="{ busy: assetBusy[keyOf('scenes', s.id)] }" :title="s.imageUrl ? '重新生成场景图' : 'AI 生成场景图'" @click="genScene(s, true)">
                <span v-if="assetBusy[keyOf('scenes', s.id)]" class="mini-spinner" />
                <el-icon v-else><MagicStick /></el-icon>
              </button>
              <button class="icon-btn" title="编辑" @click="openSceneDialog(s)"><el-icon><Edit /></el-icon></button>
              <button class="icon-btn" :title="s.referenceImageUrl ? '更换参考图' : '上传参考图'" @click="openRefPicker('scene', s.id)"><el-icon><Upload /></el-icon></button>
              <button v-if="s.referenceImageUrl" class="icon-btn" title="据此提取描述" @click="extractRef('scene', s.id)"><el-icon><MagicStick /></el-icon></button>
              <button class="icon-btn danger" title="删除" @click="removeResource('scenes', s)"><el-icon><Delete /></el-icon></button>
            </div>
          </div>
          <div v-if="scenes.length === 0" class="empty-tip">还没有场景，点击「新增场景」创建</div>
        </div>
      </section>

      <!-- ③ 道具 -->
      <section v-if="scriptTab === 'props'">
        <div class="panel-head">
          <h3 class="panel-title">道具管理 <span class="muted">· 本集</span></h3>
          <button class="lmd-btn-primary" @click="openPropDialog(null)"><el-icon :size="14" class="mr-1"><Plus /></el-icon>新增道具</button>
        </div>
        <div class="lmd-card res-grid">
          <div v-for="p in props" :key="p.id" class="res-card">
            <div class="res-top">
              <div class="res-avatar">
                <el-image v-if="p.imageUrl" :src="p.imageUrl" :alt="p.name" class="res-thumb" :preview-src-list="[p.imageUrl]" preview-teleported fit="cover" />
                <span v-else>🪑</span>
              </div>
              <div class="res-body">
                <div class="res-name">{{ p.name }} <el-tag v-if="p.type" size="small" effect="plain">{{ p.type }}</el-tag>
                  <el-tag v-if="p.useQuadGrid" size="small" type="warning" effect="plain">四视图</el-tag>
                </div>
                <div class="res-meta">关联分镜：{{ usedBy('props', p.id) }}</div>
                <div class="res-meta">{{ p.description ? p.description.slice(0, 40) : '无描述' }}</div>
                <div class="res-meta" v-if="p.referenceImageUrl"><span class="anchor-tag" style="color:#6366f1">📷 参考图已上传</span></div>
              </div>
            </div>
            <div class="res-actions">
              <button class="icon-btn" :class="{ busy: assetBusy[keyOf('props', p.id)] }" :title="p.imageUrl ? '重新生成道具图' : 'AI 生成道具图'" @click="genProp(p, true)">
                <span v-if="assetBusy[keyOf('props', p.id)]" class="mini-spinner" />
                <el-icon v-else><MagicStick /></el-icon>
              </button>
              <button class="icon-btn" title="编辑" @click="openPropDialog(p)"><el-icon><Edit /></el-icon></button>
              <button class="icon-btn" :title="p.referenceImageUrl ? '更换参考图' : '上传参考图'" @click="openRefPicker('prop', p.id)"><el-icon><Upload /></el-icon></button>
              <button v-if="p.referenceImageUrl" class="icon-btn" title="据此提取描述" @click="extractRef('prop', p.id)"><el-icon><MagicStick /></el-icon></button>
              <button class="icon-btn danger" title="删除" @click="removeResource('props', p)"><el-icon><Delete /></el-icon></button>
            </div>
          </div>
          <div v-if="props.length === 0" class="empty-tip">还没有道具，点击「新增道具」创建</div>
        </div>
      </section>

      <!-- ④ 分镜 -->
      <section v-if="scriptTab === 'storyboards'" class="sb-layout">
        <!-- 左侧分镜列表 -->
        <aside class="sb-list">
          <div class="sb-list-head">
            <span class="panel-title" style="margin:0">分镜列表</span>
            <span class="muted">{{ totalDuration() }}s</span>
            <button class="lmd-btn-ghost sm" :disabled="regenSbRunning || generating" title="按当前剧本强制重做全部分镜的首尾帧与视频（统一人物风格/音轨语言）" @click="regenerateStoryboards">
              <span v-if="regenSbRunning" class="mini-spinner dark" />
              <el-icon v-else :size="13"><RefreshRight /></el-icon>{{ regenSbRunning ? '重新生成中...' : '重新生成素材' }}
            </button>
          </div>
          <div class="sb-list-body">
            <div
              v-for="(sb, i) in storyboards"
              :key="sb.id"
              class="sb-item"
              :class="{ active: selectedSbIndex === i, dragging: dragIdx === i, 'drag-over': dragOverIdx === i }"
              :draggable="!generating && !regenSbRunning"
              @click="selectStoryboard(i)"
              @dragstart="onSbDragStart(i)"
              @dragover="onSbDragOver($event, i)"
              @drop.prevent="onSbDrop(i)"
              @dragend="onSbDragEnd(i)"
              @dragleave="dragOverIdx = -1"
            >
              <div class="sb-thumb">
                <el-image v-if="sbThumb(sb)" :src="sbThumb(sb)" :alt="`分镜 #${sb.number}`" class="sb-thumb-img" :preview-src-list="[sbThumb(sb)]" preview-teleported fit="cover" />
                <div v-else class="sb-thumb-null">未生成素材</div>
                <button class="sb-grip" title="按住拖动排序" @click.stop>⠿</button>
                <button class="icon-btn danger sb-del" title="删除分镜" @click.stop="removeStoryboard(sb)">
                  <el-icon :size="14"><Delete /></el-icon>
                </button>
                <div class="sb-thumb-bar">
                  <span class="sb-num">#{{ sb.number }}</span>
                  <span class="sb-dur">{{ sb.duration }}s</span>
                  <span class="sb-bar-spacer"></span>
                  <span v-if="sbHasVideo(sb)" class="sb-bar-video"><el-icon :size="11"><VideoPlay /></el-icon></span>
                  <span class="badge" :class="statusMeta(sb.status).cls">{{ statusMeta(sb.status).text }}</span>
                </div>
              </div>
            </div>
            <div v-if="storyboards.length === 0" class="empty-tip">暂无分镜，点击右上角「添加分镜」</div>
          </div>
        </aside>

        <!-- 右侧分镜编辑 -->
        <div v-if="selectedStoryboard" class="sb-edit">
          <div class="sb-edit-dock">
            <div class="panel-head sb-edit-head">
              <h3 class="panel-title flex items-center gap-2">
                分镜 #{{ selectedStoryboard.number }} 编辑
                <span class="badge" :class="statusMeta(selectedStoryboard.status).cls">{{ statusMeta(selectedStoryboard.status).text }}</span>
              </h3>
              <div class="sb-save-actions">
                <span v-if="autoSavedAt" class="autosave-tip">✓ 已自动保存 {{ autoSavedAt }}</span>
                <span v-else-if="sbHydrating" class="autosave-tip">保存中…</span>
                <button class="lmd-btn-primary" @click="saveStoryboard()">保存更改</button>
              </div>
            </div>

            <!-- 锚点快速跳转 -->
            <div class="sb-anchor-nav">
              <button class="sb-anchor" @click="scrollToSection('sb-preview')">画面</button>
              <button class="sb-anchor" @click="scrollToSection('sb-basic')">关联</button>
              <button class="sb-anchor" @click="scrollToSection('sb-copy')">文案</button>
              <button class="sb-anchor" @click="scrollToSection('sb-prompt')">提示词</button>
              <button class="sb-anchor" @click="scrollToSection('sb-gen')">生成</button>
            </div>
          </div>

          <!-- ① 画面预览 -->
          <section class="sb-section" data-sb="sb-preview">
            <button class="sb-section-head" @click="sbSections.preview = !sbSections.preview">
              <span class="sb-section-title"><el-icon :size="14"><Picture /></el-icon>画面预览</span>
              <div class="sb-section-right">
                <span class="sb-section-summary">{{ selectedStoryboard.imageUrl && selectedStoryboard.videoUrl ? '✓ 图片+视频就绪' : selectedStoryboard.imageUrl ? '图片就绪' : selectedStoryboard.videoUrl ? '视频就绪' : '未生成' }}</span>
                <el-icon class="sb-chevron" :class="{ open: sbSections.preview }"><ArrowDown /></el-icon>
              </div>
            </button>
            <div v-show="sbSections.preview" class="sb-section-body">
              <div class="preview-row">
                <div class="preview-box">
                  <div class="preview-cap">首帧</div>
                  <el-image v-if="selectedStoryboard.imageUrl" :src="selectedStoryboard.imageUrl" class="preview-img" :preview-src-list="[selectedStoryboard.imageUrl]" preview-teleported fit="cover" />
                  <div v-else class="preview-empty">未生成</div>
                </div>
                <div class="preview-box">
                  <div class="preview-cap">尾帧</div>
                  <el-image v-if="selectedStoryboard.lastFrameUrl" :src="selectedStoryboard.lastFrameUrl" class="preview-img" :preview-src-list="[selectedStoryboard.lastFrameUrl]" preview-teleported fit="cover" />
                  <div v-else class="preview-empty">未生成</div>
                </div>
                <div class="preview-box">
                  <div class="preview-cap">分镜视频</div>
                  <video v-if="selectedStoryboard.videoUrl" :src="selectedStoryboard.videoUrl" class="preview-video" controls playsinline />
                  <div v-else class="preview-empty">未生成</div>
                </div>
              </div>
            </div>
          </section>

          <!-- ② 关联 & 基本设置 -->
          <section class="sb-section" data-sb="sb-basic">
            <button class="sb-section-head" @click="sbSections.basic = !sbSections.basic">
              <span class="sb-section-title"><el-icon :size="14"><Setting /></el-icon>关联与基本设置</span>
              <div class="sb-section-right">
                <span class="sb-section-summary">{{ sbSectionSummary() }}</span>
                <el-icon class="sb-chevron" :class="{ open: sbSections.basic }"><ArrowDown /></el-icon>
              </div>
            </button>
            <div v-show="sbSections.basic" class="sb-section-body">
              <div class="sb-basic-grid">
                <el-form label-position="top" class="edit-form">
                  <el-form-item label="角色（可多选）">
                    <el-select v-model="sbForm.characterIds" multiple placeholder="无角色（旁白）" clearable style="width:100%">
                      <el-option v-for="c in characters" :key="c.id" :value="c.id" :label="`${c.name}（${c.roleLabel || '配角'}）`" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="场景">
                    <el-select v-model="sbForm.sceneId" placeholder="未选择场景" clearable style="width:100%">
                      <el-option v-for="s in scenes" :key="s.id" :value="s.id" :label="`${s.location}${s.time ? ' · ' + s.time : ''}`" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="道具（可多选）">
                    <el-select v-model="sbForm.propIds" multiple placeholder="无道具" clearable style="width:100%">
                      <el-option v-for="p in props" :key="p.id" :value="p.id" :label="p.name" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="方言（覆写）">
                    <el-select v-model="sbForm.dialect" placeholder="跟随角色/剧集" clearable style="width:100%">
                      <el-option v-for="(v, k) in DIALECT_MAP" :key="k" :value="k" :label="v.label" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="情绪">
                    <el-select v-model="sbForm.emotion" style="width:100%">
                      <el-option value="neutral" label="平静" />
                      <el-option value="happy" label="高兴" />
                      <el-option value="sad" label="悲伤" />
                      <el-option value="angry" label="愤怒" />
                      <el-option value="fear" label="恐惧" />
                      <el-option value="surprise" label="惊讶" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="时长（秒）">
                    <el-input-number v-model="sbForm.duration" :min="1" :max="30" :step="0.5" style="width:100%" />
                  </el-form-item>
                </el-form>

                <div class="sb-assoc-panel">
                  <div class="sb-assoc-head">
                    关联资产
                    <span class="sb-assoc-dialect">
                      方言：
                      <span class="dialect-chip strong">{{ resolveDialect(selectedStoryboard).label }}</span>
                      <span class="muted">{{ resolveDialect(selectedStoryboard).level }}</span>
                    </span>
                  </div>
                  <div class="assoc-grid">
                    <div class="assoc-card">
                      <div class="assoc-cap">场景</div>
                      <template v-if="sceneOf(selectedStoryboard)">
                        <el-image v-if="sceneOf(selectedStoryboard)!.imageUrl" :src="sceneOf(selectedStoryboard)!.imageUrl || undefined" class="assoc-thumb" :preview-src-list="[sceneOf(selectedStoryboard)!.imageUrl!]" preview-teleported fit="cover" />
                        <div v-else class="assoc-thumb assoc-thumb-null">🏞️</div>
                        <div class="assoc-info">
                          <div class="assoc-name">{{ sceneOf(selectedStoryboard)!.location }}</div>
                          <div class="assoc-sub">{{ sceneOf(selectedStoryboard)!.time || '未指定时间' }}</div>
                        </div>
                      </template>
                      <div v-else class="assoc-empty">未选择场景</div>
                    </div>
                    <div class="assoc-card">
                      <div class="assoc-cap">角色</div>
                      <div v-if="charsOf(selectedStoryboard).length" class="assoc-multi">
                        <div v-for="c in charsOf(selectedStoryboard)" :key="c.id" class="assoc-info multi">
                          <el-image v-if="c.imageUrl" :src="c.imageUrl || undefined" class="assoc-thumb sm" :preview-src-list="[c.imageUrl!]" preview-teleported fit="cover" />
                          <div v-else class="assoc-avatar-null sm">👤</div>
                          <div class="min-w-0">
                            <div class="assoc-name">{{ c.name }}</div>
                            <div class="assoc-sub">{{ c.roleLabel || '配角' }}</div>
                          </div>
                        </div>
                      </div>
                      <div v-else class="assoc-empty">无角色（旁白）</div>
                    </div>
                    <div class="assoc-card">
                      <div class="assoc-cap">道具</div>
                      <div v-if="propsOf(selectedStoryboard).length" class="assoc-multi">
                        <div v-for="p in propsOf(selectedStoryboard)" :key="p.id" class="assoc-info multi">
                          <el-image v-if="p.imageUrl" :src="p.imageUrl || undefined" class="assoc-thumb sm" :preview-src-list="[p.imageUrl!]" preview-teleported fit="cover" />
                          <div v-else class="assoc-avatar-null sm">🪑</div>
                          <div class="min-w-0">
                            <div class="assoc-name">{{ p.name }}</div>
                            <div class="assoc-sub">{{ p.type || '未分类' }}</div>
                          </div>
                        </div>
                      </div>
                      <div v-else class="assoc-empty">未选择道具</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- ③ 文案（对白 / 旁白 / 画面描述） -->
          <section class="sb-section" data-sb="sb-copy">
            <button class="sb-section-head" @click="sbSections.copy = !sbSections.copy">
              <span class="sb-section-title"><el-icon :size="14"><Edit /></el-icon>文案与描述</span>
              <div class="sb-section-right">
                <span class="sb-section-summary">对白 / 旁白 / 画面 / 动作</span>
                <el-icon class="sb-chevron" :class="{ open: sbSections.copy }"><ArrowDown /></el-icon>
              </div>
            </button>
            <div v-show="sbSections.copy" class="sb-section-body">
              <div class="prompt-grid">
                <label class="prompt-item">
                  <span class="prompt-cap">对白
                    <span class="ai-actions">
                      <button type="button" class="ai-mini" :disabled="enrichBusy['sb:dialogue']" @click.prevent="enrichSb('dialogue')">
                        <span v-if="enrichBusy['sb:dialogue']" class="mini-spinner dark" />
                        <el-icon v-else :size="12"><MagicStick /></el-icon>{{ aiBtnLabel('sb:dialogue', sbForm.dialogue) }}
                      </button>
                      <button type="button" class="ai-mini ghost" :disabled="enrichBusy['sb:dialogue']" title="丢弃当前内容，换一版全新的" @click.prevent="enrichSb('dialogue', true)">
                        <el-icon :size="12"><RefreshRight /></el-icon>重新生成
                      </button>
                      <el-popover placement="top" :width="280" trigger="click">
                        <template #reference>
                          <button type="button" class="ai-mini ghost" :disabled="enrichBusy['sb:dialogue']" title="补充要求 / 风格指令（可粘贴剧本片段或写方向）">
                            <el-icon :size="12"><Edit /></el-icon>补充要求
                          </button>
                        </template>
                        <div class="instr-pop">
                          <div class="instr-title">补充要求 / 风格指令</div>
                          <p class="instr-hint">可粘贴剧本片段，或写方向（如「更可爱一点、偏悬疑」），AI 生成时会参考。</p>
                          <el-input v-model="enrichInstr['sb:dialogue']" type="textarea" :rows="3" resize="none" placeholder="例如：参考本集剧本第 3 场，语气更凶狠" />
                        </div>
                      </el-popover>
                    </span>
                  </span>
                  <el-input v-model="sbForm.dialogue" type="textarea" :autosize="{ minRows: 2, maxRows: 8 }" resize="none" placeholder="角色台词，可直接编辑后点 AI 丰富；留空可由 AI 生成" />
                </label>
                <label class="prompt-item">
                  <span class="prompt-cap">旁白（画外音）
                    <span class="ai-actions">
                      <button type="button" class="ai-mini" :disabled="enrichBusy['sb:narration']" @click.prevent="enrichSb('narration')">
                        <span v-if="enrichBusy['sb:narration']" class="mini-spinner dark" />
                        <el-icon v-else :size="12"><MagicStick /></el-icon>{{ aiBtnLabel('sb:narration', sbForm.narration) }}
                      </button>
                      <button type="button" class="ai-mini ghost" :disabled="enrichBusy['sb:narration']" title="丢弃当前内容，换一版全新的" @click.prevent="enrichSb('narration', true)">
                        <el-icon :size="12"><RefreshRight /></el-icon>重新生成
                      </button>
                      <el-popover placement="top" :width="280" trigger="click">
                        <template #reference>
                          <button type="button" class="ai-mini ghost" :disabled="enrichBusy['sb:narration']" title="补充要求 / 风格指令（可粘贴剧本片段或写方向）">
                            <el-icon :size="12"><Edit /></el-icon>补充要求
                          </button>
                        </template>
                        <div class="instr-pop">
                          <div class="instr-title">补充要求 / 风格指令</div>
                          <p class="instr-hint">可粘贴剧本片段，或写方向（如「更可爱一点、偏悬疑」），AI 生成时会参考。</p>
                          <el-input v-model="enrichInstr['sb:narration']" type="textarea" :rows="3" resize="none" placeholder="例如：参考本集剧本第 3 场，语气更凶狠" />
                        </div>
                      </el-popover>
                    </span>
                  </span>
                  <el-input v-model="sbForm.narration" type="textarea" :autosize="{ minRows: 2, maxRows: 8 }" resize="none" placeholder="画外音，可编辑后 AI 丰富，或留空由 AI 生成" />
                </label>
                <label class="prompt-item">
                  <span class="prompt-cap">场景描述（本镜画面内容 / 机位 / 构图）
                    <span class="ai-actions">
                      <button type="button" class="ai-mini" :disabled="enrichBusy['sb:sceneDescription']" @click.prevent="enrichSb('sceneDescription')">
                        <span v-if="enrichBusy['sb:sceneDescription']" class="mini-spinner dark" />
                        <el-icon v-else :size="12"><MagicStick /></el-icon>{{ aiBtnLabel('sb:sceneDescription', sbForm.sceneDescription) }}
                      </button>
                      <button type="button" class="ai-mini ghost" :disabled="enrichBusy['sb:sceneDescription']" title="丢弃当前内容，换一版全新的" @click.prevent="enrichSb('sceneDescription', true)">
                        <el-icon :size="12"><RefreshRight /></el-icon>重新生成
                      </button>
                      <el-popover placement="top" :width="280" trigger="click">
                        <template #reference>
                          <button type="button" class="ai-mini ghost" :disabled="enrichBusy['sb:sceneDescription']" title="补充要求 / 风格指令（可粘贴剧本片段或写方向）">
                            <el-icon :size="12"><Edit /></el-icon>补充要求
                          </button>
                        </template>
                        <div class="instr-pop">
                          <div class="instr-title">补充要求 / 风格指令</div>
                          <p class="instr-hint">可粘贴剧本片段，或写方向（如「更可爱一点、偏悬疑」），AI 生成时会参考。</p>
                          <el-input v-model="enrichInstr['sb:sceneDescription']" type="textarea" :rows="3" resize="none" placeholder="例如：参考本集剧本第 3 场，画面更压抑" />
                        </div>
                      </el-popover>
                    </span>
                  </span>
                  <el-input v-model="sbForm.sceneDescription" type="textarea" :autosize="{ minRows: 2, maxRows: 8 }" resize="none" placeholder="留空则自动按角色 + 场景 + 道具合成；可编辑后 AI 丰富" />
                </label>
                <label class="prompt-item">
                  <span class="prompt-cap">动作描述（角色动作与镜头运动）
                    <span class="ai-actions">
                      <button type="button" class="ai-mini" :disabled="enrichBusy['sb:motionDescription']" @click.prevent="enrichSb('motionDescription')">
                        <span v-if="enrichBusy['sb:motionDescription']" class="mini-spinner dark" />
                        <el-icon v-else :size="12"><MagicStick /></el-icon>{{ aiBtnLabel('sb:motionDescription', sbForm.motionDescription) }}
                      </button>
                      <button type="button" class="ai-mini ghost" :disabled="enrichBusy['sb:motionDescription']" title="丢弃当前内容，换一版全新的" @click.prevent="enrichSb('motionDescription', true)">
                        <el-icon :size="12"><RefreshRight /></el-icon>重新生成
                      </button>
                      <el-popover placement="top" :width="280" trigger="click">
                        <template #reference>
                          <button type="button" class="ai-mini ghost" :disabled="enrichBusy['sb:motionDescription']" title="补充要求 / 风格指令（可粘贴剧本片段或写方向）">
                            <el-icon :size="12"><Edit /></el-icon>补充要求
                          </button>
                        </template>
                        <div class="instr-pop">
                          <div class="instr-title">补充要求 / 风格指令</div>
                          <p class="instr-hint">可粘贴剧本片段，或写方向（如「镜头更急促、推近」），AI 生成时会参考。</p>
                          <el-input v-model="enrichInstr['sb:motionDescription']" type="textarea" :rows="3" resize="none" placeholder="例如：动作幅度更大，镜头快速推近" />
                        </div>
                      </el-popover>
                    </span>
                  </span>
                  <el-input v-model="sbForm.motionDescription" type="textarea" :autosize="{ minRows: 2, maxRows: 8 }" resize="none" placeholder="留空则默认轻微运动；可编辑后 AI 丰富" />
                </label>
              </div>
            </div>
          </section>

          <!-- ④ 提示词 & 参考图 -->
          <section class="sb-section" data-sb="sb-prompt">
            <button class="sb-section-head" @click="sbSections.prompt = !sbSections.prompt">
              <span class="sb-section-title"><el-icon :size="14"><MagicStick /></el-icon>提示词 & 参考图</span>
              <div class="sb-section-right">
                <span class="sb-section-summary">图片 / 视频提示词</span>
                <el-icon class="sb-chevron" :class="{ open: sbSections.prompt }"><ArrowDown /></el-icon>
              </div>
            </button>
            <div v-show="sbSections.prompt" class="sb-section-body">
              <div class="prompt-grid">
                <label class="prompt-item">
                  <span class="prompt-cap">图片提示词
                    <span class="ai-actions">
                      <button type="button" class="ai-mini" :disabled="enrichBusy['sb:imagePrompt']" @click.prevent="enrichSb('imagePrompt')">
                        <span v-if="enrichBusy['sb:imagePrompt']" class="mini-spinner dark" />
                        <el-icon v-else :size="12"><MagicStick /></el-icon>{{ aiBtnLabel('sb:imagePrompt', sbForm.imagePrompt) }}
                      </button>
                      <button type="button" class="ai-mini ghost" :disabled="enrichBusy['sb:imagePrompt']" title="丢弃当前内容，换一版全新的" @click.prevent="enrichSb('imagePrompt', true)">
                        <el-icon :size="12"><RefreshRight /></el-icon>重新生成
                      </button>
                      <el-popover placement="top" :width="280" trigger="click">
                        <template #reference>
                          <button type="button" class="ai-mini ghost" :disabled="enrichBusy['sb:imagePrompt']" title="补充要求 / 风格指令（可粘贴剧本片段或写方向）">
                            <el-icon :size="12"><Edit /></el-icon>补充要求
                          </button>
                        </template>
                        <div class="instr-pop">
                          <div class="instr-title">补充要求 / 风格指令</div>
                          <p class="instr-hint">可粘贴剧本片段，或写方向（如「偏赛博朋克、冷色调」），AI 生成时会参考。</p>
                          <el-input v-model="enrichInstr['sb:imagePrompt']" type="textarea" :rows="3" resize="none" placeholder="例如：参考本集剧本第 3 场视觉，冷色调" />
                        </div>
                      </el-popover>
                    </span>
                  </span>
                  <el-input v-model="sbForm.imagePrompt" type="textarea" :autosize="{ minRows: 2, maxRows: 10 }" resize="none" placeholder="留空则由系统按角色锚点 + 场景 + 道具自动合成；可编辑后 AI 丰富" />
                </label>
                <label class="prompt-item">
                  <span class="prompt-cap">视频提示词
                    <span class="ai-actions">
                      <button type="button" class="ai-mini" :disabled="enrichBusy['sb:videoPrompt']" @click.prevent="enrichSb('videoPrompt')">
                        <span v-if="enrichBusy['sb:videoPrompt']" class="mini-spinner dark" />
                        <el-icon v-else :size="12"><MagicStick /></el-icon>{{ aiBtnLabel('sb:videoPrompt', sbForm.videoPrompt) }}
                      </button>
                      <button type="button" class="ai-mini ghost" :disabled="enrichBusy['sb:videoPrompt']" title="丢弃当前内容，换一版全新的" @click.prevent="enrichSb('videoPrompt', true)">
                        <el-icon :size="12"><RefreshRight /></el-icon>重新生成
                      </button>
                      <el-popover placement="top" :width="280" trigger="click">
                        <template #reference>
                          <button type="button" class="ai-mini ghost" :disabled="enrichBusy['sb:videoPrompt']" title="补充要求 / 风格指令（可粘贴剧本片段或写方向）">
                            <el-icon :size="12"><Edit /></el-icon>补充要求
                          </button>
                        </template>
                        <div class="instr-pop">
                          <div class="instr-title">补充要求 / 风格指令</div>
                          <p class="instr-hint">可粘贴剧本片段，或写方向（如「运镜更平稳、慢推」），AI 生成时会参考。</p>
                          <el-input v-model="enrichInstr['sb:videoPrompt']" type="textarea" :rows="3" resize="none" placeholder="例如：参考本集剧本第 3 场，运镜更平稳" />
                        </div>
                      </el-popover>
                    </span>
                  </span>
                  <el-input v-model="sbForm.videoPrompt" type="textarea" :autosize="{ minRows: 2, maxRows: 10 }" resize="none" placeholder="留空则自动生成，并注入角色外貌硬约束；可编辑后 AI 丰富" />
                </label>
              </div>

              <!-- 上传参考图 -->
              <div class="ref-row">
                <button class="lmd-btn-ghost" @click="openRefPicker('storyboard', selectedStoryboard.id)">
                  <el-icon class="mr-1" :size="14"><Upload /></el-icon>上传参考图
                </button>
                <el-image v-if="selectedStoryboard.referenceImageUrl" :src="selectedStoryboard.referenceImageUrl" class="ref-thumb" :preview-src-list="[selectedStoryboard.referenceImageUrl]" preview-teleported fit="cover" />
                <span v-if="selectedStoryboard.referenceImageUrl" class="ref-name">参考图已上传（可作生图参考）</span>
              </div>
            </div>
          </section>

          <!-- ⑤ 生成操作（sticky 底部操作条） -->
          <div class="sb-gen-bar" data-sb="sb-gen">
            <div class="gen-row">
              <button class="lmd-btn-ghost" :disabled="!!assetBusy['sb-image']" @click="genSbImage(!!selectedStoryboard.imageUrl)">
                <span v-if="assetBusy['sb-image']" class="mini-spinner dark" />
                <el-icon v-else class="mr-1" :size="14"><Picture /></el-icon>{{ selectedStoryboard.imageUrl ? '重新生成图片' : '生成图片' }}
              </button>
              <button class="lmd-btn-ghost" :disabled="!!assetBusy['sb-video']" @click="genSbVideo(false)">
                <span v-if="assetBusy['sb-video']" class="mini-spinner dark" />
                <el-icon v-else class="mr-1" :size="14"><VideoCamera /></el-icon>生成视频
              </button>
              <button class="lmd-btn-ghost" :disabled="!!assetBusy['sb-video']" @click="genSbVideo(true)">
                <span v-if="assetBusy['sb-video']" class="mini-spinner dark" />
                <el-icon v-else class="mr-1" :size="14"><RefreshRight /></el-icon>重新生成视频
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- ⑤ 合成视频 -->
      <section v-if="scriptTab === 'merge'" class="merge-layout">
        <div class="lmd-card merge-card">
          <h3 class="panel-title">合成配置</h3>
          <p class="muted" style="margin:4px 0 16px">已就绪 {{ storyboards.length }} 个分镜片段 · 总时长约 {{ totalDuration() }}s</p>

          <div class="merge-options">
            <label class="merge-toggle">
              <el-switch v-model="mergeConfig.burn_dialogue_audio" />
              <span>合成对白音轨</span>
            </label>
            <label class="merge-toggle">
              <el-switch v-model="mergeConfig.burn_narration_subtitles" />
              <span>合成旁白字幕</span>
            </label>
            <label class="merge-toggle">
              <el-switch v-model="mergeConfig.keep_original_audio" />
              <span>保留原声</span>
            </label>
          </div>

          <el-form label-position="top" class="edit-form merge-form">
            <el-form-item label="画面比例">
              <el-select v-model="mergeConfig.aspect_ratio" style="width:100%">
                <el-option value="9:16" label="9:16 竖屏（默认）" />
                <el-option value="16:9" label="16:9 横屏" />
              </el-select>
            </el-form-item>
            <el-form-item label="帧率">
              <el-select v-model="mergeConfig.frame_rate" style="width:100%">
                <el-option :value="30" label="30 fps" />
                <el-option :value="24" label="24 fps" />
              </el-select>
            </el-form-item>
            <el-form-item label="输出清晰度">
              <el-select v-model="mergeConfig.resolution" style="width:100%">
                <el-option value="1080p" label="1080P" />
                <el-option value="720p" label="720P" />
              </el-select>
            </el-form-item>
          </el-form>

          <div class="merge-actions">
            <button class="lmd-btn-primary flex items-center gap-1.5" :disabled="mergeRunning" @click="startMerge">
              <el-icon :size="16"><VideoCamera /></el-icon>{{ mergeRunning ? '合成中...' : '开始合成' }}
            </button>
            <div v-if="mergeRunning || mergeProgress > 0" class="merge-progress">
              <el-progress :percentage="mergeProgress" :stroke-width="10" style="width:100%" />
            </div>
          </div>
        </div>

        <div class="lmd-card merge-info">
          <h3 class="panel-title">成片信息</h3>
          <dl class="info-list">
            <div><dt>分镜数</dt><dd>{{ storyboards.length }}</dd></div>
            <div><dt>预计时长</dt><dd>{{ totalDuration() }}s</dd></div>
            <div><dt>画面比例</dt><dd>{{ mergeConfig.aspect_ratio }}</dd></div>
            <div><dt>输出清晰度</dt><dd>{{ mergeConfig.resolution }}</dd></div>
            <div>
              <dt>合成状态</dt>
              <dd>
                <span v-if="episode?.merged" class="done-tag">✓ 已完成</span>
                <span v-else class="muted">未合成</span>
              </dd>
            </div>
          </dl>

          <div v-if="episode?.mergedUrl" class="merge-preview">
            <video :src="episode.mergedUrl" controls class="merge-video" preload="metadata"></video>
            <a class="lmd-btn-ghost merge-dl" :href="episode.mergedUrl" download>⬇ 下载成片</a>
          </div>
          <div v-else class="merge-placeholder">
            点击「开始合成」后，这里将显示成片预览与下载入口。
          </div>
        </div>
      </section>
    </main>

    <!-- 底部生成日志（SSE 实时，可展开/收起） -->
    <footer class="lmd-logbar" :class="{ collapsed: !logOpen }">
      <div class="lmd-terminal">
        <div class="log-head">
          <button class="log-toggle" @click="logOpen = !logOpen">
            <el-icon :size="14"><ArrowDown /></el-icon>
            <span class="log-title">生成日志</span>
            <span v-if="logs.length" class="log-badge">{{ logs.length }}</span>
          </button>
          <div class="log-head-right">
            <span v-if="generating || mergeRunning" class="log-live"><span class="log-live-dot" />实时</span>
            <button class="log-clear" @click="logs = []">清空</button>
          </div>
        </div>
        <div ref="terminalEl" v-show="logOpen" class="lmd-terminal-body">
          <div v-if="logs.length === 0" class="log-empty">等待生成任务...</div>
          <div v-else class="log-list">
            <div v-for="l in logs" :key="l.id" class="log-line" :class="l.level">
              <span class="log-time">{{ new Date(l.at).toLocaleTimeString() }}</span>
              {{ l.text }}
            </div>
            <div v-if="generating || mergeRunning" class="log-cursor">█</div>
          </div>
        </div>
      </div>
    </footer>

    <!-- 参考图上传：统一文件选择器 -->
    <input ref="refFileInput" type="file" accept="image/*" hidden @change="onRefPicked" />

    <!-- ================= 资源对话框 ================= -->
    <el-dialog
      v-model="resDialog.show"
      :title="resDialog.kind === 'characters' ? (resDialog.editingId ? '编辑角色' : '新增角色') : resDialog.kind === 'scenes' ? (resDialog.editingId ? '编辑场景' : '新增场景') : (resDialog.editingId ? '编辑道具' : '新增道具')"
      width="520px"
    >
      <el-form label-position="top" v-if="resDialog.kind === 'characters'">
        <el-form-item label="角色名" required><el-input v-model="charForm.name" placeholder="如：王小明" /></el-form-item>
        <el-form-item label="定位">
          <el-radio-group v-model="charForm.role">
            <el-radio label="main">主角</el-radio>
            <el-radio label="supporting">配角</el-radio>
            <el-radio label="minor">龙套</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item>
          <template #label>
            <span class="label-with-ai">自定义定位标签
              <span class="ai-actions">
                <button type="button" class="ai-mini" :disabled="enrichBusy['char:roleLabel']" @click="enrichCharRoleLabel()">
                  <span v-if="enrichBusy['char:roleLabel']" class="mini-spinner" />
                  <el-icon v-else :size="12"><MagicStick /></el-icon>{{ aiBtnLabel('char:roleLabel', charForm.roleLabel) }}
                </button>
                <button type="button" class="ai-mini ghost" :disabled="enrichBusy['char:roleLabel']" title="丢弃当前内容，换一版全新的" @click="enrichCharRoleLabel(true)">
                  <el-icon :size="12"><RefreshRight /></el-icon>重新生成
                </button>
                <el-popover placement="top" :width="280" trigger="click">
                  <template #reference>
                    <button type="button" class="ai-mini ghost" :disabled="enrichBusy['char:roleLabel']" title="补充要求 / 风格指令（可粘贴剧本片段或写方向）">
                      <el-icon :size="12"><Edit /></el-icon>补充要求
                    </button>
                  </template>
                  <div class="instr-pop">
                    <div class="instr-title">补充要求 / 风格指令</div>
                    <p class="instr-hint">可粘贴剧本片段，或写方向（如「更霸气、江湖气」），AI 生成时会参考。</p>
                    <el-input v-model="enrichInstr['char:roleLabel']" type="textarea" :rows="3" resize="none" placeholder="例如：参考剧本人设，突出身份地位" />
                  </div>
                </el-popover>
              </span>
            </span>
          </template>
          <el-input v-model="charForm.roleLabel" placeholder="如：矿区大当家" />
        </el-form-item>
        <el-form-item label="方言（默认）">
          <el-select v-model="charForm.dialect" clearable placeholder="跟随剧集" style="width:100%">
            <el-option v-for="(v, k) in DIALECT_MAP" :key="k" :value="k" :label="v.label" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <template #label>
            <span class="label-with-ai">外貌描述
              <span class="ai-actions">
                <button type="button" class="ai-mini" :disabled="enrichBusy['char:appearance']" @click="enrichChar('appearance')">
                  <span v-if="enrichBusy['char:appearance']" class="mini-spinner" />
                  <el-icon v-else :size="12"><MagicStick /></el-icon>{{ aiBtnLabel('char:appearance', charForm.appearance) }}
                </button>
                <button type="button" class="ai-mini ghost" :disabled="enrichBusy['char:appearance']" title="丢弃当前内容，换一版全新的" @click="enrichChar('appearance', true)">
                  <el-icon :size="12"><RefreshRight /></el-icon>重新生成
                </button>
                <el-popover placement="top" :width="280" trigger="click">
                  <template #reference>
                    <button type="button" class="ai-mini ghost" :disabled="enrichBusy['char:appearance']" title="补充要求 / 风格指令（可粘贴剧本片段或写方向）">
                      <el-icon :size="12"><Edit /></el-icon>补充要求
                    </button>
                  </template>
                  <div class="instr-pop">
                    <div class="instr-title">补充要求 / 风格指令</div>
                    <p class="instr-hint">可粘贴剧本片段，或写方向（如「更可爱、丸子头」），AI 生成时会参考。</p>
                    <el-input v-model="enrichInstr['char:appearance']" type="textarea" :rows="3" resize="none" placeholder="例如：参考剧本人设，走可爱御姐风" />
                  </div>
                </el-popover>
              </span>
            </span>
          </template>
          <el-input v-model="charForm.appearance" type="textarea" :rows="2" placeholder="发型、衣着、特征... 可编辑后 AI 丰富" />
        </el-form-item>
        <el-form-item>
          <template #label>
            <span class="label-with-ai">角色简介
              <span class="ai-actions">
                <button type="button" class="ai-mini" :disabled="enrichBusy['char:intro']" @click="enrichChar('intro')">
                  <span v-if="enrichBusy['char:intro']" class="mini-spinner" />
                  <el-icon v-else :size="12"><MagicStick /></el-icon>{{ aiBtnLabel('char:intro', charForm.intro) }}
                </button>
                <button type="button" class="ai-mini ghost" :disabled="enrichBusy['char:intro']" title="丢弃当前内容，换一版全新的" @click="enrichChar('intro', true)">
                  <el-icon :size="12"><RefreshRight /></el-icon>重新生成
                </button>
                <el-popover placement="top" :width="280" trigger="click">
                  <template #reference>
                    <button type="button" class="ai-mini ghost" :disabled="enrichBusy['char:intro']" title="补充要求 / 风格指令（可粘贴剧本片段或写方向）">
                      <el-icon :size="12"><Edit /></el-icon>补充要求
                    </button>
                  </template>
                  <div class="instr-pop">
                    <div class="instr-title">补充要求 / 风格指令</div>
                    <p class="instr-hint">可粘贴剧本片段，或写方向（如「更腹黑、嘴硬心软」），AI 生成时会参考。</p>
                    <el-input v-model="enrichInstr['char:intro']" type="textarea" :rows="3" resize="none" placeholder="例如：参考剧本人设，表面高冷内心柔软" />
                  </div>
                </el-popover>
              </span>
            </span>
          </template>
          <el-input v-model="charForm.intro" type="textarea" :rows="2" placeholder="背景、性格... 可编辑后 AI 丰富" />
        </el-form-item>
      </el-form>
      <el-form label-position="top" v-if="resDialog.kind === 'scenes'">
        <el-form-item label="场景地点" required><el-input v-model="sceneForm.location" placeholder="如：废弃矿区" /></el-form-item>
        <el-form-item label="时间段"><el-input v-model="sceneForm.time" placeholder="如：白天 / 黄昏 / 深夜" /></el-form-item>
        <el-form-item>
          <template #label>
            <span class="label-with-ai">描述
              <span class="ai-actions">
                <button type="button" class="ai-mini" :disabled="enrichBusy['scene:description']" @click="enrichScene('description')">
                  <span v-if="enrichBusy['scene:description']" class="mini-spinner" />
                  <el-icon v-else :size="12"><MagicStick /></el-icon>{{ aiBtnLabel('scene:description', sceneForm.description) }}
                </button>
                <button type="button" class="ai-mini ghost" :disabled="enrichBusy['scene:description']" title="丢弃当前内容，换一版全新的" @click="enrichScene('description', true)">
                  <el-icon :size="12"><RefreshRight /></el-icon>重新生成
                </button>
                <el-popover placement="top" :width="280" trigger="click">
                  <template #reference>
                    <button type="button" class="ai-mini ghost" :disabled="enrichBusy['scene:description']" title="补充要求 / 风格指令（可粘贴剧本片段或写方向）">
                      <el-icon :size="12"><Edit /></el-icon>补充要求
                    </button>
                  </template>
                  <div class="instr-pop">
                    <div class="instr-title">补充要求 / 风格指令</div>
                    <p class="instr-hint">可粘贴剧本片段，或写方向（如「阴雨、压抑」），AI 生成时会参考。</p>
                    <el-input v-model="enrichInstr['scene:description']" type="textarea" :rows="3" resize="none" placeholder="例如：参考本集剧本第 2 场，雨夜废弃工厂" />
                  </div>
                </el-popover>
              </span>
            </span>
          </template>
          <el-input v-model="sceneForm.description" type="textarea" :rows="3" placeholder="场景布局、光线、色调... 可编辑后 AI 丰富" />
        </el-form-item>
        <el-form-item>
          <template #label>
            <span class="label-with-ai">图片提示词
              <span class="ai-actions">
                <button type="button" class="ai-mini" :disabled="enrichBusy['scene:prompt']" @click="enrichScene('prompt')">
                  <span v-if="enrichBusy['scene:prompt']" class="mini-spinner" />
                  <el-icon v-else :size="12"><MagicStick /></el-icon>{{ aiBtnLabel('scene:prompt', sceneForm.prompt) }}
                </button>
                <button type="button" class="ai-mini ghost" :disabled="enrichBusy['scene:prompt']" title="丢弃当前内容，换一版全新的" @click="enrichScene('prompt', true)">
                  <el-icon :size="12"><RefreshRight /></el-icon>重新生成
                </button>
                <el-popover placement="top" :width="280" trigger="click">
                  <template #reference>
                    <button type="button" class="ai-mini ghost" :disabled="enrichBusy['scene:prompt']" title="补充要求 / 风格指令（可粘贴剧本片段或写方向）">
                      <el-icon :size="12"><Edit /></el-icon>补充要求
                    </button>
                  </template>
                  <div class="instr-pop">
                    <div class="instr-title">补充要求 / 风格指令</div>
                    <p class="instr-hint">可粘贴剧本片段，或写方向（如「广角、大场景」），AI 生成时会参考。</p>
                    <el-input v-model="enrichInstr['scene:prompt']" type="textarea" :rows="3" resize="none" placeholder="例如：参考本集剧本，史诗级大场景构图" />
                  </div>
                </el-popover>
              </span>
            </span>
          </template>
          <el-input v-model="sceneForm.prompt" type="textarea" :rows="2" placeholder="供生成场景参考图的提示词；可留空由 AI 生成" />
        </el-form-item>
        <el-form-item label="生成模式">
          <el-switch v-model="sceneForm.useQuadGrid" active-text="四宫格（正/侧/俯/仰）" inactive-text="单图（默认）" />
          <p class="form-hint">单图场景更适合直接作为分镜视频参考图；四宫格便于挑选机位。切换后需重新生成才会生效。</p>
        </el-form-item>
      </el-form>
      <el-form label-position="top" v-if="resDialog.kind === 'props'">
        <el-form-item label="道具名" required><el-input v-model="propForm.name" placeholder="如：安全帽" /></el-form-item>
        <el-form-item label="类型"><el-input v-model="propForm.type" placeholder="如：衣物 / 工具 / 随身物" /></el-form-item>
        <el-form-item>
          <template #label>
            <span class="label-with-ai">描述
              <span class="ai-actions">
                <button type="button" class="ai-mini" :disabled="enrichBusy['prop:description']" @click="enrichProp('description')">
                  <span v-if="enrichBusy['prop:description']" class="mini-spinner" />
                  <el-icon v-else :size="12"><MagicStick /></el-icon>{{ aiBtnLabel('prop:description', propForm.description) }}
                </button>
                <button type="button" class="ai-mini ghost" :disabled="enrichBusy['prop:description']" title="丢弃当前内容，换一版全新的" @click="enrichProp('description', true)">
                  <el-icon :size="12"><RefreshRight /></el-icon>重新生成
                </button>
                <el-popover placement="top" :width="280" trigger="click">
                  <template #reference>
                    <button type="button" class="ai-mini ghost" :disabled="enrichBusy['prop:description']" title="补充要求 / 风格指令（可粘贴剧本片段或写方向）">
                      <el-icon :size="12"><Edit /></el-icon>补充要求
                    </button>
                  </template>
                  <div class="instr-pop">
                    <div class="instr-title">补充要求 / 风格指令</div>
                    <p class="instr-hint">可粘贴剧本片段，或写方向（如「磨损严重、有血迹」），AI 生成时会参考。</p>
                    <el-input v-model="enrichInstr['prop:description']" type="textarea" :rows="3" resize="none" placeholder="例如：参考本集剧本，道具要带血迹" />
                  </div>
                </el-popover>
              </span>
            </span>
          </template>
          <el-input v-model="propForm.description" type="textarea" :rows="3" placeholder="道具外观、材质、特殊标记... 可编辑后 AI 丰富" />
        </el-form-item>
        <el-form-item>
          <template #label>
            <span class="label-with-ai">图片提示词
              <span class="ai-actions">
                <button type="button" class="ai-mini" :disabled="enrichBusy['prop:prompt']" @click="enrichProp('prompt')">
                  <span v-if="enrichBusy['prop:prompt']" class="mini-spinner" />
                  <el-icon v-else :size="12"><MagicStick /></el-icon>{{ aiBtnLabel('prop:prompt', propForm.prompt) }}
                </button>
                <button type="button" class="ai-mini ghost" :disabled="enrichBusy['prop:prompt']" title="丢弃当前内容，换一版全新的" @click="enrichProp('prompt', true)">
                  <el-icon :size="12"><RefreshRight /></el-icon>重新生成
                </button>
                <el-popover placement="top" :width="280" trigger="click">
                  <template #reference>
                    <button type="button" class="ai-mini ghost" :disabled="enrichBusy['prop:prompt']" title="补充要求 / 风格指令（可粘贴剧本片段或写方向）">
                      <el-icon :size="12"><Edit /></el-icon>补充要求
                    </button>
                  </template>
                  <div class="instr-pop">
                    <div class="instr-title">补充要求 / 风格指令</div>
                    <p class="instr-hint">可粘贴剧本片段，或写方向（如「特写、金属质感」），AI 生成时会参考。</p>
                    <el-input v-model="enrichInstr['prop:prompt']" type="textarea" :rows="3" resize="none" placeholder="例如：参考本集剧本，特写金属质感" />
                  </div>
                </el-popover>
              </span>
            </span>
          </template>
          <el-input v-model="propForm.prompt" type="textarea" :rows="2" placeholder="供生成道具参考图的提示词；可留空由 AI 生成" />
        </el-form-item>
        <el-form-item label="生成模式">
          <el-switch v-model="propForm.useQuadGrid" active-text="四视图（正/侧/背/45°）" inactive-text="单图（默认）" />
          <p class="form-hint">单图为纯色无缝背景；四视图便于保持多机位一致性。切换后需重新生成才会生效。</p>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="resDialog.show = false">取消</el-button>
        <el-button type="primary" @click="saveResource">保存</el-button>
      </template>
    </el-dialog>

    <!-- 分集设置对话框 -->
    <el-dialog v-model="epDialog.show" title="分集设置" width="480px">
      <el-form label-position="top">
        <el-form-item label="标题" required><el-input v-model="epForm.title" /></el-form-item>
        <el-form-item>
          <template #label>
            <span class="label-with-ai">简介
              <span class="ai-actions">
                <button type="button" class="ai-mini" :disabled="enrichBusy['ep:description']" @click="enrichEpisodeDescription()">
                  <span v-if="enrichBusy['ep:description']" class="mini-spinner" />
                  <el-icon v-else :size="12"><MagicStick /></el-icon>{{ aiBtnLabel('ep:description', epForm.description) }}
                </button>
                <button type="button" class="ai-mini ghost" :disabled="enrichBusy['ep:description']" title="丢弃当前内容，换一版全新的" @click="enrichEpisodeDescription(true)">
                  <el-icon :size="12"><RefreshRight /></el-icon>重新生成
                </button>
                <el-popover placement="top" :width="280" trigger="click">
                  <template #reference>
                    <button type="button" class="ai-mini ghost" :disabled="enrichBusy['ep:description']" title="补充要求 / 风格指令（可粘贴剧本片段或写方向）">
                      <el-icon :size="12"><Edit /></el-icon>补充要求
                    </button>
                  </template>
                  <div class="instr-pop">
                    <div class="instr-title">补充要求 / 风格指令</div>
                    <p class="instr-hint">可粘贴剧本片段，或写方向（如「更悬疑、反转多」），AI 生成时会参考。</p>
                    <el-input v-model="enrichInstr['ep:description']" type="textarea" :rows="3" resize="none" placeholder="例如：参考剧本大纲，突出情感冲突" />
                  </div>
                </el-popover>
              </span>
            </span>
          </template>
          <el-input v-model="epForm.description" type="textarea" :rows="3" placeholder="本集剧情简介，可编辑后 AI 丰富" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="epDialog.show = false">取消</el-button>
        <el-button type="primary" @click="saveEpisode">保存</el-button>
      </template>
    </el-dialog>

    <!-- 一键成片选项弹窗（分步勾选 + 全剧一致性配置） -->
    <el-dialog v-model="genDialog.show" title="一键成片" width="540px">
      <div class="gen-dialog">
        <div class="gen-dialog-section">
          <div class="gen-dialog-title">生成步骤（默认全流程，一步成片）</div>
          <div class="gen-step-grid">
            <label v-for="(label, key) in GEN_STEP_LABELS" :key="key" class="gen-step-item">
              <el-checkbox v-model="genSteps[key as keyof typeof genSteps]" />
              <span>{{ label }}</span>
            </label>
          </div>
          <p class="form-hint">默认按最优顺序一键走完「角色 → 场景 → 道具 → 分镜首尾帧 → 分镜视频 → 合成成片」，已生成的步骤自动跳过；也可取消勾选只做某几步。</p>
        </div>
        <div class="gen-dialog-section">
          <div class="gen-dialog-title">全剧一致性（画面风格 / 音轨语言）</div>
          <el-form label-position="top">
            <el-form-item label="画面风格">
              <el-select v-model="genCfg.artStyle" style="width:100%">
                <el-option
                  v-for="opt in ART_STYLE_OPTIONS"
                  :key="opt.value"
                  :value="opt.value"
                  :label="opt.label"
                />
              </el-select>
              <p class="form-hint">作为硬性风格锚点注入角色/场景/分镜的生图与生视频提示词，全剧统一；切换风格后重新生成即可生效（旧素材不会自动重做）。</p>
            </el-form-item>
            <el-form-item label="音轨 / 字幕语言">
              <el-select v-model="genCfg.language" filterable allow-create default-first-option style="width:100%">
                <el-option value="zh-CN" label="中文普通话（推荐）" />
                <el-option value="zh-yue" label="粤语" />
                <el-option value="en-US" label="英语" />
              </el-select>
              <p class="form-hint">生成时会把语言约束注入视频台词口播提示词，保证全片语言统一，避免出现外语对白。</p>
            </el-form-item>
          </el-form>
        </div>
      </div>
      <template #footer>
        <el-button @click="genDialog.show = false">取消</el-button>
        <el-button type="primary" :disabled="generating" @click="confirmGenerate">开始生成</el-button>
      </template>
    </el-dialog>

    <!-- AI 拆解预览弹窗：确认后再落库 -->
    <el-dialog v-model="parsePreview.show" :title="`AI 拆解预览（${parsePreview.mode === 'replace' ? '替换模式：落库前会清空本集旧记录' : '追加模式'}）`" width="720px" top="6vh">
      <template v-if="parsePreview.data">
        <div class="gen-dialog-section">
          <div class="gen-dialog-title">拆解概览</div>
          <p class="form-hint">
            角色 {{ parsePreview.data.characters?.length ?? 0 }} · 场景 {{ parsePreview.data.scenes?.length ?? 0 }} ·
            道具 {{ parsePreview.data.props?.length ?? 0 }} · 分镜 {{ parsePreview.data.storyboards?.length ?? 0 }}
          </p>
          <div class="parse-tags">
            <el-tag v-for="c in parsePreview.data.characters || []" :key="`c-${c.name}`" effect="plain" class="mr-1 mb-1">
              👤 {{ c.name }}<template v-if="c.roleLabel"> · {{ c.roleLabel }}</template>
            </el-tag>
            <el-tag v-for="s in parsePreview.data.scenes || []" :key="`s-${s.location}`" type="success" effect="plain" class="mr-1 mb-1">
              🏞️ {{ s.location }}<template v-if="s.time"> · {{ s.time }}</template>
            </el-tag>
            <el-tag v-for="p in parsePreview.data.props || []" :key="`p-${p.name}`" type="warning" effect="plain" class="mr-1 mb-1">
              🪑 {{ p.name }}
            </el-tag>
          </div>
        </div>
        <div class="gen-dialog-section">
          <div class="gen-dialog-title">分镜列表（可关闭弹窗后回「剧本」面板重新拆解）</div>
          <el-table :data="parsePreview.data.storyboards || []" size="small" max-height="320">
            <el-table-column label="#" width="48">
              <template #default="{ $index }">{{ $index + 1 }}</template>
            </el-table-column>
            <el-table-column label="角色" width="120" show-overflow-tooltip>
              <template #default="{ row }">
                {{ row.characters?.length ? row.characters.join('、') : (row.character || '旁白') }}
              </template>
            </el-table-column>
            <el-table-column prop="scene" label="场景" width="110" show-overflow-tooltip />
            <el-table-column prop="dialogue" label="对白" show-overflow-tooltip>
              <template #default="{ row }">{{ row.dialogue || '—' }}</template>
            </el-table-column>
            <el-table-column prop="sceneDescription" label="画面" show-overflow-tooltip />
            <el-table-column prop="duration" label="时长" width="64">
              <template #default="{ row }">{{ row.duration }}s</template>
            </el-table-column>
          </el-table>
        </div>
      </template>
      <template #footer>
        <el-button @click="parsePreview.show = false">取消</el-button>
        <el-button :disabled="parseRunning" @click="rerunParsePreview">重新拆解</el-button>
        <el-button type="primary" :disabled="parseRunning" @click="confirmApplyParsed">确认生成本集内容</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.parse-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
/* 顶栏 */
.lmd-topbar {
  background: rgba(255,255,255,0.92); border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 30; backdrop-filter: blur(8px);
}
.lmd-topbar-inner {
  max-width: 1440px; margin: 0 auto; width: 100%;
  display: flex; align-items: center; justify-content: space-between; padding: 14px 24px;
}
.lmd-back-btn { width: 38px; height: 38px; border-radius: 10px; background: #eef2f7; border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--text-2); transition: background .2s; }
.lmd-back-btn:hover { background: #e2e8f0; }
.lmd-title { font-size: 20px; font-weight: 700; color: var(--text); margin: 0; line-height: 1.2; }
.lmd-subtitle { font-size: 12px; color: var(--muted); margin: 2px 0 0; }

/* 步进条 */
.lmd-stepper { border-bottom: 1px solid var(--border); background: var(--card); padding: 10px 0; position: sticky; top: 67px; z-index: 20; }
.lmd-stepper-inner { max-width: 1440px; margin: 0 auto; padding: 0 24px; display: flex; gap: 8px; flex-wrap: wrap; }

/* 成片进度流程图 */
.pipeline-box { border-bottom: 1px solid var(--border); background: linear-gradient(180deg, #eef2ff, #fff); }
.pipeline-inner { max-width: 1440px; margin: 0 auto; padding: 12px 24px; }
.pipeline-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; color: var(--text); }
.pipeline-tag { font-size: 12px; font-weight: 600; color: var(--indigo); background: var(--indigo-soft); padding: 2px 10px; border-radius: 999px; }
.pipeline-percent { margin-left: auto; font-size: 13px; font-weight: 700; color: var(--indigo); }
.pipeline-bar { display: flex; align-items: center; gap: 4px; margin-top: 10px; }
.pipeline-step {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px;
  position: relative; opacity: 0.45; transition: opacity .2s;
}
.pipeline-step:not(:last-child)::after {
  content: ''; position: absolute; top: 12px; right: -2px; left: calc(50% + 14px);
  height: 2px; background: var(--border);
}
.pipeline-step.active, .pipeline-step.done { opacity: 1; }
.pipeline-step.active .pipeline-dot,
.pipeline-step.done .pipeline-dot {
  background: var(--indigo); color: #fff; box-shadow: 0 0 0 4px var(--indigo-soft);
}
.pipeline-dot {
  width: 26px; height: 26px; border-radius: 50%; background: var(--screen-soft);
  border: 1px solid var(--border); color: var(--text-2); font-size: 12px;
  display: flex; align-items: center; justify-content: center; z-index: 1;
}
.pipeline-label { font-size: 11px; color: var(--text-2); white-space: nowrap; }
.pipeline-step.active .pipeline-label { color: var(--indigo); font-weight: 700; }
.pipeline-status { margin-top: 8px; font-size: 12px; color: var(--indigo); font-weight: 600; }
.pipeline-detail { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border); }
.pdetail-block { display: flex; align-items: flex-start; gap: 8px; }
.pdetail-cap { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 700; color: var(--text-2); flex-shrink: 0; width: 44px; padding-top: 3px; }
.pdetail-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.pdetail-pill {
  font-size: 12px; color: var(--text-2); background: #fff; border: 1px solid var(--border);
  border-radius: 999px; padding: 2px 10px; line-height: 1.5; max-width: 180px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pdetail-pill.done { color: #059669; background: var(--emerald-soft); border-color: rgba(16,185,129,.4); }
.pdetail-pill.half { color: #b45309; background: var(--amber); background: rgba(245,158,11,.12); border-color: rgba(245,158,11,.4); }
.pdetail-pill.busy { border-color: var(--indigo); box-shadow: 0 0 0 2px var(--indigo-soft); }
.pdetail-pill svg { margin-left: 4px; }

.lmd-step {
  font-size: 14px; font-weight: 600; color: var(--text-2); cursor: pointer;
  padding: 7px 14px; border-radius: 999px; border: 1px solid rgba(99,102,241,0.25); background: var(--screen-soft);
  transition: all .2s;
}
.lmd-step:hover { border-color: var(--indigo); }
.lmd-step.active { background: var(--grad-main); color: #fff; border-color: transparent; }
.lmd-step-count { font-size: 11px; margin-left: 5px; opacity: .75; }

/* 主内容 */
.lmd-main { flex: 1; max-width: 1440px; margin: 0 auto; width: 100%; padding: 20px 24px 220px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.panel-title { font-size: 16px; font-weight: 700; color: var(--text); margin: 0; }
.muted { color: var(--muted); font-size: 12px; font-weight: 400; margin-left: 4px; }

/* 资源网格 */
.res-grid { padding: 16px; display: grid; grid-template-columns: repeat(auto-fill,minmax(300px,1fr)); gap: 12px; }
.res-card { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: 12px; transition: border-color .2s, box-shadow .2s; }
.res-card:hover { border-color: #c7d2fe; box-shadow: var(--shadow-sm); }
.res-top { display: flex; align-items: flex-start; gap: 12px; }
.res-avatar { width: 44px; height: 44px; border-radius: 10px; background: var(--screen-soft); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; overflow: hidden; }
.res-thumb { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; }
:deep(.res-thumb.el-image) { width: 100%; height: 100%; cursor: zoom-in; }
:deep(.res-thumb.el-image img) { width: 100%; height: 100%; object-fit: cover; }
.anchor-tag { color: var(--emerald); font-weight: 600; }
.mini-spinner { width: 12px; height: 12px; border: 2px solid rgba(99,102,241,.25); border-top-color: var(--indigo); border-radius: 50%; animation: spin .7s linear infinite; display: inline-block; }
.mini-spinner.dark { border-color: rgba(100,116,139,.3); border-top-color: var(--text-2); }
.icon-btn.busy { cursor: progress; opacity: .7; }
.res-body { flex: 1; min-width: 0; width: 100%; }
.res-name { font-weight: 600; color: var(--text); font-size: 14px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.res-meta { font-size: 12px; color: var(--muted); margin-top: 3px; line-height: 1.5; }
.res-actions { display: flex; gap: 6px; padding-top: 10px; border-top: 1px dashed var(--border); }
.icon-btn { width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--border); background: #fff; color: var(--text-2); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all .2s; }
.icon-btn:hover { background: var(--screen-soft); color: var(--indigo); }
.icon-btn.danger:hover { background: var(--rose-soft); color: var(--rose); border-color: #fecdd3; }
.empty-tip { grid-column: 1 / -1; text-align: center; color: var(--muted); padding: 32px 0; font-size: 13px; }
.form-hint { margin: 6px 0 0; font-size: 12px; color: var(--muted); line-height: 1.5; }

/* 分镜布局 */
.sb-layout { display: grid; grid-template-columns: minmax(380px, 460px) minmax(0, 1fr); gap: 16px; align-items: start; }
.sb-list { background: var(--card); border: 1px solid var(--border); border-radius: 16px; overflow: hidden; position: sticky; top: 132px; display: flex; flex-direction: column; }
.sb-list-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.sb-list-body { padding: 10px; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; align-content: start; }
.sb-item { position: relative; padding: 6px; border: 1px solid var(--border); border-radius: 12px; cursor: pointer; transition: all .2s; background: #fff; }
.sb-item:hover { border-color: #c7d2fe; }
.sb-item.active { background: var(--screen-soft); border-color: var(--indigo); }
.sb-item[draggable="true"] { cursor: grab; }
.sb-item[draggable="true"]:active { cursor: grabbing; }
.sb-item.dragging { opacity: 0.55; border-style: dashed; }
.sb-item.drag-over { border-color: var(--indigo); box-shadow: 0 0 0 2px var(--indigo-soft); transform: translateY(2px); }
/* 分镜缩略图（时间线画布） */
.sb-thumb { position: relative; aspect-ratio: 16 / 10; border-radius: 8px; overflow: hidden; background: #eef2f7; display: flex; align-items: center; justify-content: center; }
.sb-thumb img, :deep(.sb-thumb-img.el-image) { width: 100%; height: 100%; object-fit: cover; display: block; cursor: zoom-in; }
:deep(.sb-thumb-img.el-image img) { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; }
.sb-thumb-null { color: var(--muted); font-size: 12px; }
.sb-thumb-bar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: linear-gradient(to top, rgba(15,23,42,0.78), rgba(15,23,42,0)); }
.sb-thumb-bar .sb-num { color: #fff; }
.sb-thumb-bar .sb-dur { color: #cbd5e1; }
.sb-bar-spacer { flex: 1; }
.sb-bar-video { display: inline-flex; color: #fff; }
.sb-grip { position: absolute; left: 6px; top: 6px; width: 26px; height: 26px; border: none; background: rgba(255,255,255,0.85); border-radius: 6px; color: var(--text-2); cursor: grab; display: flex; align-items: center; justify-content: center; font-size: 16px; line-height: 1; opacity: 0; transition: opacity .2s; }
.sb-item:hover .sb-grip { opacity: 1; }
.sb-grip:active { cursor: grabbing; }
.sb-num { font-weight: 700; color: var(--indigo); font-size: 13px; }
.sb-dur { font-size: 11px; color: var(--muted); }
.badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; }
.lmd-badge-emerald { background: var(--emerald-soft); color: #059669; }
.lmd-badge-indigo { background: var(--screen-soft); color: var(--indigo); }
.lmd-badge-gray { background: #f1f5f9; color: var(--muted); }
.dialect-chip { background: #eef2ff; color: #4f46e5; border-radius: 6px; padding: 1px 6px; font-size: 11px; }
.dialect-chip.strong { color: #6d28d9; font-weight: 600; }
.sb-del { position: absolute; top: 8px; right: 8px; opacity: 0; transition: opacity .2s; }
.sb-item:hover .sb-del { opacity: 1; }

/* 分镜编辑 */
.sb-edit { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 18px; display: flex; flex-direction: column; gap: 12px; position: sticky; top: 132px; max-height: calc(100vh - 148px); overflow-y: auto; }
.sb-edit-dock { position: sticky; top: 0; z-index: 6; background: var(--card); padding-bottom: 6px; }
.sb-edit-head { margin-bottom: 0; }
.edit-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.edit-grid > .el-textarea, .assoc-label, .gen-row { grid-column: 1 / -1; }
.edit-form { margin: 0; }
.edit-form :deep(.el-form-item) { margin-bottom: 12px; }
.assoc-label { font-size: 13px; color: var(--text-2); display: flex; align-items: center; gap: 8px; }
.gen-row { display: flex; gap: 10px; flex-wrap: wrap; }
.lmd-btn-ghost.sm { padding: 4px 10px; font-size: 12px; }

/* 锚点导航 */
.sb-anchor-nav { display: flex; gap: 6px; flex-wrap: wrap; z-index: 5; background: rgba(255,255,255,0.95); padding: 6px; border: 1px solid var(--border); border-radius: 12px; backdrop-filter: blur(6px); }
.sb-anchor {
  flex: 1; font-size: 12px; font-weight: 600; color: var(--text-2); background: var(--screen-soft);
  border: 1px solid var(--border); border-radius: 8px; padding: 6px 0; cursor: pointer; transition: all .2s; text-align: center;
}
.sb-anchor:hover { color: var(--indigo); border-color: var(--indigo); background: transparent; }

/* 分镜编辑区块（可折叠卡片） */
.sb-section { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: #fff; scroll-margin-top: 104px; }
.sb-section-head {
  width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 10px 12px; background: #f8fafc; border-bottom: 1px solid var(--border); cursor: pointer;
  border: none; text-align: left; transition: background .2s;
}
.sb-section-head:hover { background: #f1f5f9; }
.sb-section-title { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 700; color: var(--text); }
.sb-section-right { display: inline-flex; align-items: center; gap: 8px; }
.sb-section-summary { font-size: 11px; color: var(--muted); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-chevron { transition: transform .2s; color: var(--muted); font-size: 13px; }
.sb-chevron.open { transform: rotate(180deg); }
.sb-section-body { padding: 14px; }
.sb-section-body > * + * { margin-top: 12px; }

/* 基本设置：表单 + 关联资产两栏 */
.sb-basic-grid { display: grid; grid-template-columns: 1fr 1.1fr; gap: 16px; }
.sb-assoc-panel { border: 1px dashed var(--border); border-radius: 12px; padding: 12px; background: #fafbff; }
.sb-assoc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; font-weight: 700; color: var(--text-2); margin-bottom: 10px; flex-wrap: wrap; }
.sb-assoc-dialect { display: inline-flex; align-items: center; gap: 6px; font-weight: 400; font-size: 12px; color: var(--text-2); }
.assoc-multi { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.assoc-avatar-null { background: var(--screen-soft); border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 16px; }
.assoc-avatar-null.sm { width: 28px; height: 28px; font-size: 13px; }
.assoc-thumb-null { display: flex; align-items: center; justify-content: center; font-size: 18px; }

/* 生成操作条 */
.sb-gen-bar { border-top: 1px solid var(--border); padding-top: 12px; position: sticky; bottom: 0; background: rgba(255,255,255,0.98); z-index: 4; backdrop-filter: blur(6px); }

/* 分镜关联资产 */
.assoc-grid { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.assoc-card { border: 1px solid var(--border); border-radius: 12px; padding: 10px; display: flex; align-items: center; gap: 10px; min-height: 62px; }
.assoc-cap { position: absolute; }
.assoc-card { position: relative; padding-top: 22px; }
.assoc-cap { top: 6px; left: 10px; font-size: 11px; color: var(--muted); }
.assoc-thumb { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; flex-shrink: 0; background: var(--screen-soft); }
.assoc-thumb.sm { width: 28px; height: 28px; border-radius: 6px; }
.assoc-info { min-width: 0; }
.assoc-info.multi { display: flex; align-items: center; gap: 6px; min-width: 0; }
.assoc-info.multi + .assoc-info.multi { margin-top: 6px; }
.assoc-name { font-size: 13px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.assoc-sub { font-size: 11px; color: var(--muted); }
.assoc-empty { font-size: 12px; color: var(--muted); }

/* 画面预览 */
.preview-row { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.preview-box { border: 1px solid var(--border); border-radius: 12px; padding: 8px; text-align: center; }
.preview-cap { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
.preview-img { width: 100%; max-height: 260px; border-radius: 8px; object-fit: cover; background: #0f172a; display: block; cursor: zoom-in; }
.preview-video { width: 100%; max-height: 260px; border-radius: 8px; background: #000; object-fit: contain; }
:deep(.preview-img.el-image) { width: 100%; max-height: 260px; border-radius: 8px; }
.preview-empty { height: 96px; display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--muted); background: #f8fafc; border-radius: 8px; }

/* 画面提示词 */
.prompt-grid { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.prompt-item { display: block; }
.prompt-cap { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }

/* AI 生成 / 丰富 小按钮（橙色主色，醒目标记 AI 能力） */
.ai-mini {
  display: inline-flex; align-items: center; gap: 4px; margin-left: auto;
  font-size: 11px; font-weight: 600; color: #c2410c; line-height: 1;
  background: var(--orange-soft); border: 1px solid rgba(249, 115, 22, 0.4);
  border-radius: 999px; padding: 3px 9px; cursor: pointer; transition: all .2s; white-space: nowrap;
}
.ai-mini:hover { background: #ffedd5; border-color: var(--orange); }
.ai-mini:disabled { cursor: progress; opacity: .7; }
/* 按钮组：把多个 AI 操作收拢在标签右侧 */
.ai-actions { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; }
.ai-actions .ai-mini { margin-left: 0; }
/* 次级按钮（重新生成 / 补充要求），更轻量 */
.ai-mini.ghost { color: var(--text-2); background: transparent; border-color: var(--border); }
.ai-mini.ghost:hover { background: var(--screen-soft); color: var(--text); border-color: var(--border); }
/* 补充要求弹出框 */
.instr-pop { font-size: 12px; }
.instr-pop .instr-title { font-weight: 700; color: var(--text); margin-bottom: 4px; }
.instr-pop .instr-hint { color: var(--muted); margin: 0 0 8px; line-height: 1.5; }
.label-with-ai { display: flex; align-items: center; width: 100%; gap: 8px; }

/* 合成 */
.merge-layout { display: grid; grid-template-columns: 1fr 320px; gap: 16px; align-items: start; }
.merge-card, .merge-info { padding: 20px; }
.merge-options { display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px; }
.merge-toggle { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--text-2); cursor: pointer; }
.merge-form { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.merge-actions { display: flex; flex-direction: column; gap: 14px; margin-top: 8px; }
.merge-progress { width: 100%; }
.info-list { margin: 0; }
.info-list > div { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px dashed var(--border); font-size: 13px; }
.info-list dt { color: var(--muted); }
.info-list dd { margin: 0; font-weight: 600; color: var(--text); }
.done-tag { color: var(--emerald); font-weight: 700; }
.merge-preview { margin-top: 16px; display: flex; flex-direction: column; gap: 10px; }
.merge-video { width: 100%; border-radius: 12px; background: #000; aspect-ratio: 9 / 16; max-height: 420px; }
.merge-dl { display: inline-flex; align-items: center; justify-content: center; text-decoration: none; }
.merge-placeholder { margin-top: 16px; font-size: 13px; color: var(--muted); background: var(--screen-soft); border-radius: 10px; padding: 14px; text-align: center; }

/* 生成日志 */
.lmd-logbar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 40; padding: 0 24px 0; pointer-events: none; display: flex; }
.lmd-terminal { pointer-events: auto; max-width: 1440px; margin: 0 auto; background: #0f172a; color: #cbd5e1; border-radius: 14px 14px 0 0; box-shadow: 0 -6px 24px rgba(15,23,42,.25); overflow: hidden; width: 100%; }
.log-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; border-bottom: 1px solid rgba(148,163,184,.15); cursor: pointer; }
.log-toggle { display: inline-flex; align-items: center; gap: 6px; background: transparent; border: none; color: #e2e8f0; cursor: pointer; padding: 0; }
.log-toggle .el-icon { transition: transform .2s; color: #64748b; }
.lmd-logbar.collapsed .log-toggle .el-icon { transform: rotate(180deg); }
.log-title { font-size: 13px; font-weight: 700; }
.log-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; font-size: 11px; font-weight: 700; color: #fff; background: var(--indigo); border-radius: 999px; }
.log-head-right { display: inline-flex; align-items: center; gap: 10px; }
.log-live { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: #34d399; font-weight: 600; }
.log-live-dot { width: 7px; height: 7px; border-radius: 50%; background: #34d399; animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.3; } }
.log-clear { background: transparent; border: none; color: #64748b; cursor: pointer; font-size: 12px; }
.log-clear:hover { color: #e2e8f0; }
.log-empty { padding: 12px 14px; font-size: 13px; color: #64748b; }
.lmd-terminal-body { max-height: 220px; overflow: hidden; }
.log-list { max-height: 204px; overflow-y: auto; padding: 8px 14px 12px; font-size: 13px; line-height: 1.8; font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; }
.log-line.success { color: #34d399; }
.log-line.warn { color: #fbbf24; }
.log-line.error { color: #f87171; }
.log-time { color: #64748b; margin-right: 8px; }
.log-cursor { color: #34d399; animation: blink 1s steps(2) infinite; }
@keyframes blink { 50% { opacity: 0; } }

.lmd-spinner { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 860px) {
  .sb-layout, .merge-layout { grid-template-columns: 1fr; }
  .sb-list { position: static; max-height: none; }
  .sb-basic-grid, .prompt-grid, .assoc-grid { grid-template-columns: 1fr; }
  .pdetail-cap { width: 36px; }
  .sb-anchor { flex: none; }
}

/* 分镜自动保存 / 参考图上传 */
.sb-save-actions { display: flex; align-items: center; gap: 10px; }
.autosave-tip { font-size: 12px; color: #059669; }
.ref-row { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ref-thumb { width: 44px; height: 44px; border-radius: 8px; object-fit: cover; border: 1px solid var(--border); cursor: zoom-in; }
:deep(.ref-thumb.el-image) { width: 44px; height: 44px; flex-shrink: 0; }
:deep(.ref-thumb.el-image img) { width: 100%; height: 100%; object-fit: cover; }
.ref-name { font-size: 12px; color: var(--muted); }

/* 一键生成选项弹窗 */
.gen-dialog { display: flex; flex-direction: column; gap: 18px; }
.gen-dialog-section { border: 1px solid var(--border); border-radius: 12px; padding: 14px; }
.gen-dialog-title { font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 12px; }
.gen-step-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 16px; }
.gen-step-item { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); cursor: pointer; }
.gen-dialog-section .form-hint { margin-top: 10px; }
</style>