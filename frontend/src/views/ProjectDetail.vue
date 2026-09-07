<script setup lang="ts">
import { onMounted, reactive, ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowLeft, Plus, Edit, Delete, VideoPlay, MagicStick, Refresh, Upload } from '@element-plus/icons-vue';
import { dramaApi, episodeApi, generateApi } from '@/api';
import type { Drama, Episode } from '@/types';

const route = useRoute();
const router = useRouter();
const dramaId = Number(route.params.id);

const loading = ref(false);
const project = ref<Drama | null>(null);
const episodes = ref<Episode[]>([]);

// 分集状态映射
const EP_STATUS_MAP: Record<string, { label: string; cls: string }> = {
  draft: { label: '草稿', cls: 'lmd-status-gray' },
  editing: { label: '编辑中', cls: 'lmd-status-indigo' },
  completed: { label: '已完成', cls: 'lmd-status-emerald' },
};
const statusOf = (e: Episode) => EP_STATUS_MAP[e.status || 'draft'] || EP_STATUS_MAP.draft;

// ===== 项目概览 =====
async function loadAll() {
  loading.value = true;
  try {
    const [p, eps] = await Promise.all([dramaApi.get(dramaId), episodeApi.list(dramaId)]);
    project.value = p;
    episodes.value = eps;
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

// ===== 进入项目管理编辑页 =====
function openProjectEdit() {
  router.push(`/project/${dramaId}/edit`);
}

// ===== 新建分集：创建空集并进入剧本编辑 =====
const creating = ref(false);
async function addEpisode() {
  creating.value = true;
  try {
    const ep = await episodeApi.create({ dramaId });
    ElMessage.success(`已创建「${ep.title}」`);
    await loadAll();
    openEpisode(ep.id);
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    creating.value = false;
  }
}

// ===== 删除分集 =====
async function deleteEpisode(e: Episode) {
  try {
    await ElMessageBox.confirm(
      `确定要删除分集"${e.title}"吗？该集的分镜、场景、道具及本地素材将一并删除，且不可恢复（整剧共享的角色不受影响）。`,
      '删除分集',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await episodeApi.remove(e.id);
    ElMessage.success('分集已删除');
    await loadAll();
  } catch (err: any) {
    ElMessage.error(err.message);
  }
}

// ===== 进入剧本编辑 / 一键全流程 =====
function openEpisode(e: Episode | number, generate = false) {
  const id = typeof e === 'number' ? e : e.id;
  router.push({ path: `/project/${dramaId}/episode/${id}`, query: generate ? { generate: '1' } : {} });
}

function goBack() {
  router.push('/');
}

// ===== 整剧一键成片：进入整剧流水线进度页 =====
function openProduce() {
  router.push(`/project/${dramaId}/produce`);
}

// ===== 重置分集（清空重来：删光本集数据 + 自动按剧本重建）=====
async function resetEpisode(e: Episode) {
  try {
    await ElMessageBox.confirm(
      `确定要重置分集"${e.title}"吗？\n本集的全部分镜、场景、道具记录及其全部生成素材（图片/视频/配音/成片）将被删除且不可恢复，本集不再使用的角色也会一并清理。\n随后将自动按剧本原文重新拆解生成角色、场景、道具与分镜。确定继续？`,
      '重置分集',
      { type: 'warning', confirmButtonText: '清空并重建', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await generateApi.resetEpisode(e.id);
    ElMessage.success(`分集"${e.title}"已清空，正在自动按剧本重建，请到剧本编辑页查看日志`);
    await loadAll();
  } catch (err: any) {
    ElMessage.error(err.message);
  }
}

// ===== 重置整部剧 =====
async function resetDrama() {
  try {
    await ElMessageBox.confirm(
      '确定要重置整个项目吗？\n所有分集的分镜、场景、道具记录及全部生成素材（图片/视频/配音/成片）、角色形象图都将被删除，不可恢复。\n随后将按各分集剧本原文自动重新拆解生成角色、场景、道具与分镜。确定继续？',
      '重置项目',
      { type: 'warning', confirmButtonText: '清空并重建', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await generateApi.resetDrama(dramaId);
    ElMessage.success('项目已清空，正在按各分集剧本自动重建，请稍后刷新查看');
    await loadAll();
  } catch (err: any) {
    ElMessage.error(err.message);
  }
}

// ===== 批量拆解：对每个已保存剧本的分集按剧本原文重建（replace 模式，后台执行）=====
const batchParsing = ref(false);
async function batchParseScripts() {
  if (batchParsing.value) return;
  const targets = episodes.value.filter((e) => e.hasScript);
  if (!targets.length) {
    ElMessage.warning('没有已保存剧本原文的分集，请先到各分集「剧本」面板粘贴并保存剧本');
    return;
  }
  const without = episodes.value.filter((e) => !e.hasScript).length;
  try {
    await ElMessageBox.confirm(
      `将对 ${targets.length} 个已保存剧本的分集按剧本原文重建（替换模式：先清空该集已有的分镜/场景/道具，再重新生成）。${without ? `\n另有 ${without} 个分集未保存剧本，将跳过。` : ''}\n确定继续？`,
      '批量剧本拆解',
      { type: 'warning', confirmButtonText: `开始拆解（${targets.length} 集）`, cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  batchParsing.value = true;
  try {
    for (const e of targets) {
      try {
        await generateApi.parseScript(e.id, 'replace');
        ElMessage.info(`分集「${e.title}」拆解已发起`);
      } catch (err: any) {
        ElMessage.error(`分集「${e.title}」拆解发起失败：${err.message}`);
      }
    }
    ElMessage.success('批量拆解已全部发起，请到各分集剧本编辑页查看日志');
  } finally {
    batchParsing.value = false;
    await loadAll();
  }
}

function formatDuration(s?: number | null) {
  if (!s || s <= 0) return '0 秒';
  return `${s} 秒`;
}

// ===== 一键导入整本剧本 =====
const importModal = reactive({ show: false });
const importState = reactive({
  text: '',
  mode: 'append' as 'append' | 'replace',
  busy: false,
});
const importing = ref(false);

function openImport() {
  importState.text = '';
  importState.mode = 'append';
  importModal.show = true;
}

function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    importState.text = String(reader.result || '');
  };
  reader.readAsText(file, 'utf-8');
  input.value = '';
}

async function confirmImport() {
  const text = importState.text.trim();
  if (!text) {
    ElMessage.warning('请先粘贴剧本文本或上传 TXT 文件');
    return;
  }
  if (importing.value) return;
  importing.value = true;
  try {
    const res = await episodeApi.importScript(dramaId, text, importState.mode);
    ElMessage.success(`成功导入 ${res.imported} 个分集`);
    importModal.show = false;
    await loadAll();
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    importing.value = false;
  }
}

function coverGradient(i: number) {
  const list = ['#8b5cf6', '#6366f1', '#10b981', '#ec4899', '#f59e0b'];
  const c = list[i % list.length];
  return `linear-gradient(135deg, color-mix(in srgb, ${c} 20%, #fff), color-mix(in srgb, ${c} 52%, #fff))`;
}

onMounted(loadAll);
</script>

<template>
  <div class="flex flex-col min-h-screen">
    <!-- 顶栏 -->
    <header class="lmd-topbar">
      <div class="max-w-7xl mx-auto w-full flex items-center justify-between px-6 py-4">
        <div class="flex items-center gap-4">
          <button class="lmd-back-btn" @click="goBack">
            <el-icon :size="18"><ArrowLeft /></el-icon>
          </button>
          <div>
            <h1 class="lmd-title">{{ project?.title || '加载中...' }}</h1>
            <p class="lmd-subtitle">分集管理 · 共 {{ episodes.length }} 集</p>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <button class="lmd-btn-ghost" @click="openProjectEdit" title="编辑项目名称、描述与默认方言等">
            <el-icon class="mr-1"><Edit /></el-icon>项目设置
          </button>
          <button class="lmd-btn-ghost" @click="openProduce" title="排队跑完所有分集成片流水线，带整剧进度">
            <el-icon class="mr-1"><VideoPlay /></el-icon>整剧一键成片
          </button>
          <button class="lmd-btn-ghost" @click="resetDrama">
            <el-icon class="mr-1"><Refresh /></el-icon>重置项目
          </button>
          <button class="lmd-btn-ghost" :disabled="batchParsing" @click="batchParseScripts" title="对每个已保存剧本的分集，按剧本原文重建角色/场景/道具/分镜">
            <el-icon class="mr-1"><MagicStick /></el-icon>{{ batchParsing ? '拆解发起中...' : '批量拆解' }}
          </button>
          <button class="lmd-btn-ghost" @click="openImport" title="一次性导入整本 TXT 剧本，自动按「第N集」拆分成分集">
            <el-icon class="mr-1"><Upload /></el-icon>一键导入
          </button>
          <button class="lmd-btn-primary flex items-center gap-1" :disabled="creating" @click="addEpisode">
            <el-icon :size="16"><Plus /></el-icon>{{ creating ? '创建中...' : '添加分集' }}
          </button>
        </div>
      </div>
    </header>

    <!-- 主内容 -->
    <main class="flex-1 max-w-7xl mx-auto w-full px-6 py-8">
      <!-- 项目概览卡片 -->
      <div class="lmd-card p-6 mb-8">
        <div class="grid md:grid-cols-4 gap-6">
          <div class="md:col-span-2">
            <h3 class="lmd-overview-label">项目描述</h3>
            <p class="lmd-overview-text">{{ project?.description || '暂无描述' }}</p>
          </div>
          <div>
            <h3 class="lmd-overview-label">角色数量</h3>
            <p class="text-2xl font-bold" style="color: var(--indigo)">{{ project?.characterCount || 0 }}</p>
          </div>
          <div>
            <h3 class="lmd-overview-label">分集数量</h3>
            <p class="text-2xl font-bold" style="color: var(--purple)">{{ episodes.length }}</p>
          </div>
        </div>
      </div>

      <!-- 分集列表头部 -->
      <div class="mb-6 flex items-center justify-between">
        <h2 class="lmd-page-title" style="font-size: 22px">分集列表</h2>
        <span class="text-sm" style="color: var(--muted)">点击分集卡片进入剧本编辑</span>
      </div>

      <!-- 加载态 -->
      <div v-if="loading" class="text-center py-20 text-slate-400">加载中...</div>

      <!-- 空态 -->
      <div v-else-if="episodes.length === 0" class="lmd-empty">
        <div class="lmd-empty-icon">🎬</div>
        <h3>还没有分集</h3>
        <p>添加你的第一个分集，或一键导入整本 TXT 剧本</p>
        <div class="flex items-center justify-center gap-3 mt-4">
          <button class="lmd-btn-primary" @click="addEpisode">＋ 添加第一个分集</button>
          <button class="lmd-btn-ghost" @click="openImport">一键导入 TXT</button>
        </div>
      </div>

      <!-- 分集网格 -->
      <div v-else class="grid gap-6" style="grid-template-columns: repeat(auto-fill, minmax(300px, 1fr))">
        <div
          v-for="(e, i) in episodes"
          :key="e.id"
          class="lmd-card card-hover cursor-pointer overflow-hidden"
          @click="openEpisode(e)"
        >
          <!-- 封面区 -->
          <div class="h-28 px-5 py-4 flex items-start justify-between" :style="{ background: coverGradient(i) }">
            <span class="lmd-ep-badge">第 {{ e.episodeNumber }} 集</span>
            <div class="flex items-center gap-2">
              <span class="lmd-ep-count">{{ e.storyboardCount || 0 }} 个分镜</span>
              <span v-if="e.merged" class="lmd-merged-mark">✓ 已合成</span>
            </div>
          </div>

          <!-- 内容 -->
          <div class="p-5">
            <h3 class="lmd-card-title">{{ e.title }}</h3>
            <p class="lmd-card-desc">{{ e.description || '暂无描述' }}</p>
            <div class="flex items-center justify-between text-xs mt-4" style="color: var(--muted)">
              <span>时长: {{ formatDuration(e.duration) }}</span>
              <span class="lmd-status" :class="statusOf(e).cls">{{ statusOf(e).label }}</span>
            </div>
          </div>

          <!-- 操作 -->
          <div class="px-5 pb-5 flex gap-2" @click.stop>
            <button class="lmd-card-btn" @click="openEpisode(e)">
              <el-icon :size="14"><Edit /></el-icon>编辑分镜
            </button>
            <button class="lmd-card-btn lmd-card-btn-emerald" @click="openEpisode(e, true)">
              <el-icon :size="14"><MagicStick /></el-icon>一键生成
            </button>
            <button class="lmd-card-btn lmd-card-btn-amber" @click="resetEpisode(e)">
              <el-icon :size="14"><Refresh /></el-icon>重置
            </button>
            <button class="lmd-card-btn lmd-card-btn-rose" @click="deleteEpisode(e)">
              <el-icon :size="14"><Delete /></el-icon>删除
            </button>
          </div>
        </div>
      </div>
    </main>

    <!-- ===== 一键导入整本剧本弹窗 ===== -->
    <div v-if="importModal.show" class="lmd-mask" @click.self="importModal.show = false">
      <div class="lmd-modal" style="max-width: 680px">
        <h3 class="lmd-modal-title">一键导入整本剧本</h3>
        <p class="text-sm mt-2" style="color: var(--muted)">
          粘贴整本 TXT 剧本（或上传 .txt 文件），系统会按「第N集」标题行自动拆分成多个分集，并自动填入每集剧本原文。
        </p>
        <div class="space-y-4 mt-4">
          <div class="flex items-center gap-3">
            <label class="lmd-btn-ghost" style="cursor: pointer; display: inline-flex; align-items: center; gap: 6px">
              <el-icon :size="14"><Upload /></el-icon>上传 TXT 文件
              <input type="file" accept=".txt,text/plain" style="display: none" @change="onImportFile" />
            </label>
            <span class="text-xs" style="color: var(--muted)">支持 .txt，编码建议 UTF-8</span>
          </div>
          <div>
            <label class="lmd-label">剧本内容（每集以「第N集 标题」开头）</label>
            <textarea
              v-model="importState.text"
              rows="12"
              class="lmd-input"
              placeholder="第1集 初见兵马俑&#10;【镜头】兵马俑一号坑&#10;蛋蛋：哇！……&#10;&#10;第2集 和跪射俑灵魂对话&#10;【镜头】跪射俑玻璃展柜&#10;……"
            ></textarea>
          </div>
          <div>
            <label class="lmd-label">导入方式</label>
            <div class="flex items-center gap-4">
              <label class="flex items-center gap-2 text-sm" style="color: var(--text-2); cursor: pointer">
                <input type="radio" value="append" v-model="importState.mode" /> 追加（保留已有分集）
              </label>
              <label class="flex items-center gap-2 text-sm" style="color: var(--text-2); cursor: pointer">
                <input type="radio" value="replace" v-model="importState.mode" /> 覆盖（清空已有分集后重建）
              </label>
            </div>
          </div>
        </div>
        <div class="flex justify-end gap-3 mt-6">
          <button class="lmd-btn-ghost" @click="importModal.show = false">取消</button>
          <button class="lmd-btn-primary" :disabled="importing" @click="confirmImport">
            {{ importing ? '导入中...' : '开始导入' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lmd-topbar {
  background: rgba(255, 255, 255, 0.92);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 20;
  backdrop-filter: blur(8px);
}
.lmd-back-btn {
  width: 38px; height: 38px; border-radius: 10px;
  background: #eef2f7; border: 1px solid var(--border);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--text-2); transition: background 0.2s;
}
.lmd-back-btn:hover { background: #e2e8f0; }
.lmd-title { font-size: 20px; font-weight: 700; color: var(--text); margin: 0; line-height: 1.2; }
.lmd-subtitle { font-size: 12px; color: var(--muted); margin: 2px 0 0; }
.lmd-page-title { font-size: 28px; font-weight: 700; color: var(--text); margin: 0 0 4px; }
.lmd-muted-text { color: var(--muted); margin: 0; }

.lmd-overview-label {
  font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 8px;
}
.lmd-overview-text { color: var(--text-2); margin: 0; font-size: 14px; line-height: 1.6; }

.lmd-empty {
  border: 1px dashed var(--border);
  border-radius: 20px;
  padding: 64px 24px;
  text-align: center;
  background: var(--card);
}
.lmd-empty-icon { font-size: 56px; opacity: 0.35; }
.lmd-empty h3 { font-size: 20px; color: var(--text); margin: 12px 0 4px; }
.lmd-empty p { color: var(--muted); margin: 0; }

.lmd-ep-badge {
  padding: 3px 12px; font-size: 13px; font-weight: 700;
  background: rgba(139, 92, 246, 0.22); color: #7c3aed;
  border-radius: 999px; white-space: nowrap;
}
.lmd-ep-count {
  font-size: 12px; padding: 2px 10px; border-radius: 999px;
  background: rgba(255, 255, 255, 0.55); color: var(--text-2);
  white-space: nowrap;
}
.lmd-merged-mark {
  font-size: 12px; font-weight: 700; padding: 2px 10px; border-radius: 999px;
  background: rgba(16, 185, 129, 0.9); color: #fff; white-space: nowrap;
}
.lmd-card-title { font-size: 17px; font-weight: 700; color: var(--text); margin: 0 0 8px; line-height: 1.35; }
.lmd-card-desc {
  font-size: 13px; color: var(--muted); margin: 0;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  min-height: 36px;
}
.lmd-status {
  padding: 2px 10px; font-size: 12px; border-radius: 999px; font-weight: 600;
}
.lmd-status-gray { background: rgba(100, 116, 139, 0.16); color: #475569; }
.lmd-status-indigo { background: var(--indigo-soft); color: var(--indigo); }
.lmd-status-emerald { background: var(--emerald-soft); color: var(--emerald); }
.lmd-card-btn {
  flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  padding: 8px 10px; font-size: 13px; color: var(--text-2);
  background: #f1f5f9; border: 1px solid var(--border); border-radius: 10px; cursor: pointer;
  transition: background 0.2s;
}
.lmd-card-btn:hover { background: #e2e8f0; }
.lmd-card-btn-emerald { color: var(--emerald); background: var(--emerald-soft); border-color: transparent; }
.lmd-card-btn-emerald:hover { background: rgba(16, 185, 129, 0.24); }
.lmd-card-btn-rose { flex: 0 0 auto; color: var(--rose); background: var(--rose-soft); border-color: transparent; }
.lmd-card-btn-rose:hover { background: rgba(244, 63, 94, 0.22); }
.lmd-card-btn-amber { flex: 0 0 auto; color: #d97706; background: rgba(245, 158, 11, 0.14); border-color: transparent; }
.lmd-card-btn-amber:hover { background: rgba(245, 158, 11, 0.26); }

/* 弹窗 */
.lmd-modal {
  background: var(--card); border: 1px solid var(--border); border-radius: 18px;
  width: 100%; max-width: 480px; padding: 24px; box-shadow: 0 24px 48px rgba(15,23,42,0.18);
}
.lmd-modal-title { font-size: 19px; font-weight: 700; color: var(--text); margin: 0; }
.lmd-label { display: block; font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 6px; }
.lmd-input {
  width: 100%; background: var(--card); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 12px; font-size: 14px; color: var(--text);
  font-family: var(--font); resize: vertical;
}
.lmd-input:focus { outline: 2px solid var(--indigo-soft); border-color: var(--indigo); }
.lmd-range-hint { font-size: 12px; color: var(--muted); margin: 2px 0 0; }
.space-y-4 > * + * { margin-top: 16px; }
</style>
