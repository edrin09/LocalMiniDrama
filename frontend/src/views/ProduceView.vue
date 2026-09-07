<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { ArrowLeft, MagicStick, VideoPlay } from '@element-plus/icons-vue';
import { dramaApi, episodeApi, generateApi } from '@/api';
import type { Drama, Episode } from '@/types';

const route = useRoute();
const router = useRouter();
const dramaId = Number(route.params.id);

const project = ref<Drama | null>(null);
const episodes = ref<Episode[]>([]);
const loading = ref(false);
const running = ref(false);

/** 整剧流水线六步 */
const DRAMA_STEPS = [
  '① 角色形象',
  '② 场景图',
  '③ 道具图',
  '④ 分镜首尾帧',
  '⑤ 分镜视频',
  '⑥ 合成成片',
];
const EP_STEP_KEYS = ['characters', 'scenes', 'props', 'storyboards', 'storyboardVideos', 'merge'];

const flowStep = ref<string>('');      // 当前整剧/整集步骤 key
const flowEp = ref<number | null>(null); // 当前正在处理的 episodeId
const flowLabel = ref<string>('');
const flowPercent = ref(0);
const flowIdx = computed(() => {
  const i = EP_STEP_KEYS.indexOf(flowStep.value);
  return i < 0 ? -1 : i;
});

type EPStatus = { id: number; no: number | null; title: string; merged: boolean; run: string; hasScript: boolean };
const epList = ref<EPStatus[]>([]);

function refreshProject() {
  return Promise.all([dramaApi.get(dramaId), episodeApi.list(dramaId)]).then(([p, eps]) => {
    project.value = p;
    episodes.value = eps;
    epList.value = eps.map((e) => ({
      id: e.id,
      no: e.episodeNumber ?? null,
      title: e.title,
      merged: !!e.merged,
      run: 'pending',
      hasScript: !!e.hasScript,
    }));
  });
}

/* ================= 整剧级 SSE ================= */
let source: EventSource | null = null;
const produceLogs = ref<{ level: string; text: string; at: number; id: number }[]>([]);
let logSeq = 0;
const logEl = ref<HTMLElement | null>(null);

function addLog(level: string, text: string) {
  produceLogs.value.unshift({ level, text, at: Date.now(), id: ++logSeq });
  if (produceLogs.value.length > 500) produceLogs.value.length = 500;
  requestAnimationFrame(() => {
    if (logEl.value) logEl.value.scrollTop = 0;
  });
}

function runStatusOf(id: number): string {
  return epList.value.find((e) => e.id === id)?.run ?? 'pending';
}
function setEpRun(id: number, s: string) {
  const ep = epList.value.find((e) => e.id === id);
  if (ep) ep.run = s;
}

function connectDramaLogs() {
  if (source) source.close();
  source = new EventSource(generateApi.dramaLogsUrl(dramaId));
  source.onmessage = (ev: any) => handleEvent(ev.data);
  source.addEventListener('message', (ev: any) => handleEvent(ev.data));
  source.onerror = () => {
    /* 浏览器自动重连 */
  };
}

function handleEvent(data: string) {
  try {
    const e = JSON.parse(data);
    if (!e?.type) return;
    const d = e.data || {};
    if (e.type === 'log') {
      addLog(d.level || 'info', d.text || '');
    } else if (e.type === 'phase') {
      flowStep.value = d?.stepId ?? '';
      flowLabel.value = d?.stepLabel ?? '';
      if (typeof d?.percent === 'number') flowPercent.value = d.percent;
      // 切换当前集：把上一步进行中的集标记为已完成
      if (typeof d?.episodeId === 'number' && d.episodeId !== flowEp.value) {
        if (flowEp.value != null) setEpRun(flowEp.value, 'done');
        flowEp.value = d.episodeId;
        setEpRun(d.episodeId, 'running');
      }
      // 单集内部 phase（scope:'episode'）也更新流程图的步骤
      if (d?.scope === 'episode') {
        flowStep.value = d.stepId ?? flowStep.value;
        flowLabel.value = d.stepLabel ?? flowLabel.value;
      }
    } else if (e.type === 'merge') {
      flowPercent.value = d.progress ?? flowPercent.value;
      if (d.progress >= 100 && flowEp.value != null) setEpRun(flowEp.value, 'done');
    } else if (e.type === 'error') {
      addLog('error', d.text || '出错');
      if (flowEp.value != null) setEpRun(flowEp.value, 'error');
    } else if (e.type === 'done') {
      running.value = false;
      if (flowEp.value != null) setEpRun(flowEp.value, 'done');
      refreshProject();
      ElMessage.success('整剧成片任务结束');
    }
  } catch {
    /* ignore */
  }
}

/* ================= 操作 ================= */
async function start() {
  if (running.value) return;
  const targets = episodes.value.filter((e) => e.hasScript);
  if (!targets.length) {
    ElMessage.warning('没有已保存剧本原文的分集，无法整剧成片。请先在分集「剧本」面板粘贴并保存剧本。');
    return;
  }
  produceLogs.value = [];
  flowPercent.value = 0;
  flowStep.value = '';
  flowEp.value = null;
  epList.value.forEach((e) => (e.run = 'pending'));
  running.value = true;
  try {
    await generateApi.generateDrama(dramaId);
  } catch (err: any) {
    running.value = false;
    ElMessage.error(err.message);
  }
}

function goBack() {
  router.push(`/project/${dramaId}`);
}

onMounted(() => {
  loading.value = true;
  refreshProject()
    .catch((e) => ElMessage.error(e.message))
    .finally(() => (loading.value = false));
  connectDramaLogs();
});
onBeforeUnmount(() => {
  if (source) source.close();
});
</script>

<template>
  <div class="flex flex-col min-h-screen">
    <header class="lmd-topbar">
      <div class="max-w-5xl mx-auto w-full flex items-center justify-between px-6 py-4">
        <div class="flex items-center gap-4">
          <button class="lmd-back-btn" @click="goBack" title="返回分集管理"><el-icon :size="18"><ArrowLeft /></el-icon></button>
          <div>
            <h1 class="lmd-title">整剧一键成片</h1>
            <p class="lmd-subtitle">{{ project?.title || '加载中...' }} · 共 {{ episodes.length }} 集</p>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <button class="lmd-btn-primary flex items-center gap-1.5" :disabled="running" @click="start">
            <span v-if="running" class="lmd-spinner" />
            <el-icon v-else :size="16"><VideoPlay /></el-icon>
            {{ running ? '成片中...' : '开始整剧成片' }}
          </button>
        </div>
      </div>
    </header>

    <main class="flex-1 max-w-5xl mx-auto w-full px-6 py-6 space-y-5">
      <!-- 整体进度条 -->
      <div class="lmd-card p-5">
        <div class="flex items-center gap-2 mb-3">
          <el-icon :size="16" style="color: var(--indigo)"><MagicStick /></el-icon>
          <span class="font-bold" style="color: var(--text)">全剧进度</span>
          <span class="flow-tag" v-if="flowEp != null && (flowLabel || running)">{{ flowLabel }}</span>
          <span class="flow-percent">{{ flowPercent }}%</span>
        </div>
        <div class="flow-bar">
          <div
            v-for="(label, i) in DRAMA_STEPS"
            :key="i"
            class="flow-step"
            :class="{ active: flowIdx === i, done: flowIdx > i }"
          >
            <span class="flow-dot">{{ '①②③④⑤⑥'[i] }}</span>
            <span class="flow-label">{{ label }}</span>
          </div>
        </div>
        <p class="flow-status" v-if="running && !flowLabel">正在读取分集与素材，稍候开始第一集...</p>
        <p class="flow-status" v-if="running && flowLabel">{{ flowLabel }}进行中...</p>
        <p class="flow-status muted" v-if="!running">点击「开始整剧成片」将按顺序逐集完成全部流水线并输出成片。</p>
      </div>

      <!-- 分集进度列表 -->
      <div class="lmd-card p-5">
        <h3 class="panel-title">分集成片状态</h3>
        <div v-if="epList.length === 0" class="lmd-empty mini">还没有分集，请先回到分集管理添加/导入剧本。</div>
        <ul v-else class="ep-flow">
          <li v-for="e in epList" :key="e.id" class="ep-flow-item">
            <span class="ep-no">第 {{ e.no }} 集</span>
            <span class="ep-title">{{ e.title }}</span>
            <span v-if="!e.hasScript" class="ep-state warn">无剧本</span>
            <span v-else-if="e.merged" class="ep-state ok">✓ 已成片</span>
            <span v-else-if="e.run === 'running'" class="ep-state run">成片中</span>
            <span v-else-if="e.run === 'done'" class="ep-state ok">✓ 完成</span>
            <span v-else-if="e.run === 'error'" class="ep-state err">出错</span>
            <span v-else class="ep-state idle">待处理</span>
          </li>
        </ul>
      </div>

      <!-- 实时日志 -->
      <div class="lmd-card p-0 overflow-hidden">
        <div class="log-head">整剧生成日志（最新在上）</div>
        <div ref="logEl" class="produce-log">
          <div v-if="produceLogs.length === 0" class="log-empty">等待开始整剧成片...</div>
          <div v-for="l in produceLogs" :key="l.id" class="log-line" :class="`log-${l.level}`">
            <span class="log-time">{{ new Date(l.at).toLocaleTimeString() }}</span>
            {{ l.text }}
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.lmd-topbar { background: rgba(255,255,255,0.92); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 20; backdrop-filter: blur(8px); }
.lmd-back-btn { width: 38px; height: 38px; border-radius: 10px; background: #eef2f7; border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--text-2); }
.lmd-back-btn:hover { background: #e2e8f0; }
.lmd-title { font-size: 20px; font-weight: 700; color: var(--text); margin: 0; line-height: 1.2; }
.lmd-subtitle { font-size: 12px; color: var(--muted); margin: 2px 0 0; }
.lmd-card { background: var(--card); border: 1px solid var(--border); border-radius: 18px; }
.panel-title { font-size: 16px; font-weight: 700; color: var(--text); margin: 0 0 14px; }
.flow-tag { font-size: 12px; font-weight: 600; color: var(--indigo); background: var(--indigo-soft); padding: 2px 10px; border-radius: 999px; }
.flow-percent { margin-left: auto; font-size: 16px; font-weight: 700; color: var(--indigo); }
.flow-bar { display: flex; align-items: center; gap: 4px; }
.flow-step { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; position: relative; opacity: 0.45; }
.flow-step:not(:last-child)::after { content: ''; position: absolute; top: 13px; right: -2px; left: calc(50% + 15px); height: 2px; background: var(--border); }
.flow-step.active, .flow-step.done { opacity: 1; }
.flow-step.active .flow-dot, .flow-step.done .flow-dot { background: var(--indigo); color: #fff; box-shadow: 0 0 0 4px var(--indigo-soft); }
.flow-dot { width: 28px; height: 28px; border-radius: 50%; background: var(--screen-soft); border: 1px solid var(--border); color: var(--text-2); font-size: 12px; display: flex; align-items: center; justify-content: center; z-index: 1; }
.flow-label { font-size: 11px; color: var(--text-2); white-space: nowrap; }
.flow-step.active .flow-label { color: var(--indigo); font-weight: 700; }
.flow-status { margin-top: 10px; font-size: 12px; color: var(--indigo); font-weight: 600; }
.flow-status.muted { color: var(--muted); font-weight: 400; }

.ep-flow { list-style: none; margin: 0; padding: 0; }
.ep-flow-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); margin-bottom: 8px; background: var(--screen-soft); }
.ep-no { font-weight: 700; color: var(--indigo); white-space: nowrap; }
.ep-title { flex: 1; color: var(--text); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ep-state { font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 999px; white-space: nowrap; }
.ep-state.ok { background: var(--emerald-soft); color: var(--emerald); }
.ep-state.run { background: var(--indigo-soft); color: var(--indigo); }
.ep-state.err { background: var(--rose-soft); color: var(--rose); }
.ep-state.warn { background: rgba(245,158,11,0.16); color: #d97706; }
.ep-state.idle { background: rgba(100,116,139,0.16); color: #64748b; }

.log-head { font-size: 13px; font-weight: 700; color: var(--text); padding: 12px 16px; border-bottom: 1px solid var(--border); }
.produce-log { max-height: 320px; overflow-y: auto; padding: 12px 16px; font-family: ui-monospace, Consolas, monospace; font-size: 13px; line-height: 1.8; }
.log-line { color: var(--text-2); }
.log-time { color: var(--muted); margin-right: 8px; font-size: 12px; }
.log-success { color: var(--emerald); }
.log-error { color: var(--rose); }
.log-warn { color: #d97706; }
.log-empty { color: var(--muted); }
</style>