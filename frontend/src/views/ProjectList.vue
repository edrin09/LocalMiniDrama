<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Upload, Edit, Delete, Download, Setting, Cpu } from '@element-plus/icons-vue';
import { dramaApi, configApi } from '@/api';
import {
  DIALECT_MAP,
  dialectLabel,
  COVER_STYLES,
  PROGRESS_MAP,
  ASPECT_RATIOS,
  FRAME_RATES,
  RESOLUTIONS,
  DEFAULT_OUTPUT_SPEC,
} from '@/utils/dialect';
import type { Drama, SchedulerConfig, AiConfig, OutputSpec } from '@/types';

const router = useRouter();
const loading = ref(false);
const projects = ref<Drama[]>([]);

// ===== 新建项目 表单 =====
const showProjectModal = ref(false);
const savingProject = ref(false);
const form = reactive({
  title: '',
  description: '',
  dialect: 'standard',
  coverStyle: 'default',
  // 成片规格：建项目时定，生图/生视频/合成全流程共用（见 utils/dialect）
  aspect_ratio: DEFAULT_OUTPUT_SPEC.aspect_ratio as string,
  frame_rate: DEFAULT_OUTPUT_SPEC.frame_rate as number,
  resolution: DEFAULT_OUTPUT_SPEC.resolution as string,
});

// ===== 全局配置弹窗（调度 + AI 合一） =====
const showSettings = ref(false);
const savingSettings = ref(false);
const settingsTab = ref<'ai' | 'scheduler'>('ai');
const schedulerConfig = ref<SchedulerConfig>({
  max_image_concurrency: 3,
  max_video_concurrency: 2,
  max_retries: 5,
  retry_initial_delay_ms: 1000,
});
const aiConfig = ref<AiConfig | null>(null);

async function loadProjects() {
  loading.value = true;
  try {
    projects.value = await dramaApi.list();
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  form.title = '';
  form.description = '';
  form.dialect = 'standard';
  form.coverStyle = 'default';
  form.aspect_ratio = DEFAULT_OUTPUT_SPEC.aspect_ratio;
  form.frame_rate = DEFAULT_OUTPUT_SPEC.frame_rate;
  form.resolution = DEFAULT_OUTPUT_SPEC.resolution;
  showProjectModal.value = true;
}

function closeModal() {
  showProjectModal.value = false;
}

async function saveProject() {
  if (!form.title.trim()) {
    ElMessage.warning('请输入项目名称');
    return;
  }
  savingProject.value = true;
  try {
    await dramaApi.create({
      title: form.title.trim(),
      description: form.description,
      dialect: form.dialect,
      coverStyle: form.coverStyle,
      // 成片规格在创建时定下，之后全流程只读
      outputCfg: {
        aspect_ratio: form.aspect_ratio as OutputSpec['aspect_ratio'],
        frame_rate: form.frame_rate,
        resolution: form.resolution as OutputSpec['resolution'],
      },
    });
    ElMessage.success('项目创建成功');
    showProjectModal.value = false;
    await loadProjects();
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    savingProject.value = false;
  }
}

async function deleteProject(p: Drama) {
  try {
    await ElMessageBox.confirm(
      `确定要删除项目"${p.title}"吗？该项目及其分集、分镜与本地素材将一并删除，且不可恢复。`,
      '删除项目',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await dramaApi.remove(p.id);
    ElMessage.success('项目已删除');
    await loadProjects();
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function exportProject(p: Drama) {
  try {
    const full = await dramaApi.get(p.id);
    const blob = new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.title.replace(/[\\/:*?"<>|]/g, '_')}.project.json`;
    a.click();
    URL.revokeObjectURL(url);
    ElMessage.success('项目已导出');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

// ===== 进入项目（第二层：分集管理） =====
function openProject(p: Drama) {
  router.push(`/project/${p.id}`);
}

// ===== 全局配置（调度 + AI 合并为一个弹窗） =====
async function openSettings() {
  try {
    const s = await configApi.getSettings();
    schedulerConfig.value = { ...schedulerConfig.value, ...s.scheduler };
    aiConfig.value = JSON.parse(JSON.stringify(s.ai));
  } catch (e: any) {
    ElMessage.error(e.message);
  }
  showSettings.value = true;
}

/** 一次 PUT 同时保存调度与 AI：避免两个弹窗两次请求、配置互相覆盖 */
async function saveSettings() {
  if (!aiConfig.value) return;
  savingSettings.value = true;
  try {
    const s = await configApi.setSettings({
      scheduler: schedulerConfig.value,
      ai: aiConfig.value,
    });
    schedulerConfig.value = { ...schedulerConfig.value, ...s.scheduler };
    aiConfig.value = JSON.parse(JSON.stringify(s.ai));
    ElMessage.success('全局配置已保存并立即生效');
    showSettings.value = false;
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    savingSettings.value = false;
  }
}

/** Agnes 三件套模型的可选项（可自由输入以支持官方新增模型） */
const MODEL_FIELDS = [
  { key: 'text', label: '文本模型', hint: '剧本拆解 / 提示词优化 / 首帧质检' },
  { key: 'image', label: '生图模型', hint: '角色立绘 / 场景图 / 分镜首尾帧' },
  { key: 'video', label: '视频模型', hint: '分镜视频生成' },
] as const;

function formatDate(s: string) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function coverGradient(i: number) {
  const list = ['#6366f1', '#8b5cf6', '#10b981', '#ec4899', '#f59e0b'];
  const c = list[i % list.length];
  return `linear-gradient(135deg, color-mix(in srgb, ${c} 22%, #fff), color-mix(in srgb, ${c} 55%, #fff))`;
}

onMounted(loadProjects);
</script>

<template>
  <div class="flex flex-col min-h-screen">
    <!-- 顶栏 -->
    <header class="lmd-topbar">
      <div class="max-w-7xl mx-auto w-full flex items-center justify-between px-6 py-4">
        <div class="flex items-center gap-3">
          <div class="lmd-logo">
            <span>🎬</span>
          </div>
          <div>
            <h1 class="lmd-title">本地短剧助手</h1>
            <p class="lmd-subtitle">LocalMiniDrama - AI漫剧生成系统</p>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <button class="lmd-btn-ghost" @click="openSettings">
            <el-icon class="mr-1"><Setting /></el-icon>全局配置
          </button>
        </div>
      </div>
    </header>

    <!-- 主内容 -->
    <main class="flex-1 max-w-7xl mx-auto w-full px-6 py-8">
      <div class="mb-8">
        <h2 class="lmd-page-title">我的短剧项目</h2>
        <p class="lmd-muted-text">创建、管理和编辑你的AI漫剧项目</p>
      </div>

      <!-- 操作栏 -->
      <div class="flex items-center gap-4 mb-6">
        <button class="lmd-btn-primary flex items-center gap-1" @click="openCreate">
          <el-icon :size="18"><Plus /></el-icon>新建短剧项目
        </button>
        <button class="lmd-btn-ghost flex items-center gap-1" @click="ElMessage.info('导入功能开发中...')">
          <el-icon :size="16"><Upload /></el-icon>导入项目
        </button>
      </div>

      <!-- 空态 -->
      <div v-if="!loading && projects.length === 0" class="lmd-empty">
        <div class="lmd-empty-icon">🎬</div>
        <h3>创建你的第一部短剧</h3>
        <p>从零开始，制作属于你的 AI 漫剧</p>
        <button class="lmd-btn-primary mt-4" @click="openCreate">＋ 创建第一部短剧</button>
      </div>

      <!-- 加载态 -->
      <div v-if="loading" class="text-center py-20 text-slate-400">加载中...</div>

      <!-- 项目网格 -->
      <div v-else class="grid gap-6" style="grid-template-columns: repeat(auto-fill, minmax(300px, 1fr))">
        <div
          v-for="(p, i) in projects"
          :key="p.id"
          class="lmd-card card-hover cursor-pointer overflow-hidden"
          @click="openProject(p)"
        >
          <!-- 封面 -->
          <div class="relative h-40 flex items-center justify-center" :style="{ background: coverGradient(i) }">
            <span class="text-6xl opacity-40">🎬</span>
            <span v-if="p.progress" class="lmd-cover-badge"
              :class="PROGRESS_MAP[p.progress]?.cls || 'lmd-status-gray'">
              {{ PROGRESS_MAP[p.progress]?.label || '未开始' }}
            </span>
          </div>

          <!-- 内容 -->
          <div class="p-5">
            <div class="flex items-start justify-between mb-3">
              <h3 class="lmd-card-title">{{ p.title }}</h3>
              <span class="lmd-badge-indigo">{{ p.episodeCount || 0 }} 集</span>
            </div>
            <p class="lmd-card-desc">{{ p.description || '暂无简介' }}</p>
            <div class="flex items-center justify-between text-xs text-slate-500 mt-4">
              <span>默认方言: {{ dialectLabel(p.dialect) }}</span>
              <span>{{ formatDate(p.createdAt) }}</span>
            </div>
          </div>

          <!-- 操作 -->
          <div class="px-5 pb-5 flex gap-2" @click.stop>
            <button class="lmd-card-btn" @click.stop="router.push(`/project/${p.id}/edit`)">
              <el-icon :size="14"><Edit /></el-icon>编辑
            </button>
            <button class="lmd-card-btn" @click="exportProject(p)">
              <el-icon :size="14"><Download /></el-icon>导出
            </button>
            <button class="lmd-card-btn lmd-card-btn-rose" @click="deleteProject(p)">
              <el-icon :size="14"><Delete /></el-icon>删除
            </button>
          </div>
        </div>
      </div>
    </main>

    <!-- ===== 新建 / 编辑项目弹窗 ===== -->
    <div v-if="showProjectModal" class="lmd-mask" @click.self="closeModal">
      <div class="lmd-modal">
        <h3 class="lmd-modal-title">创建新短剧项目</h3>
        <div class="space-y-4 mt-6">
          <div>
            <label class="lmd-label">项目名称</label>
            <input v-model="form.title" class="lmd-input" type="text" placeholder="例如：霸道总裁爱上我" />
          </div>
          <div>
            <label class="lmd-label">项目描述</label>
            <textarea v-model="form.description" rows="3" class="lmd-input" placeholder="简要描述剧情..."></textarea>
          </div>
          <div>
            <label class="lmd-label">默认方言</label>
            <select v-model="form.dialect" class="lmd-input">
              <option v-for="(v, k) in DIALECT_MAP" :key="k" :value="k">{{ v.label }}</option>
            </select>
          </div>
          <div>
            <label class="lmd-label">封面风格</label>
            <select v-model="form.coverStyle" class="lmd-input">
              <option v-for="c in COVER_STYLES" :key="c.value" :value="c.value">{{ c.label }}</option>
            </select>
          </div>
          <!-- 成片规格：建项目时定，生图/生视频/合成全流程共用。
               画幅是生成参数而非后期裁切参数，一旦开始生成便不可更改。 -->
          <div class="spec-block">
            <label class="lmd-label">
              成片规格
              <span class="lmd-hint-inline">建项目时确定，生成后不可更改</span>
            </label>
            <div class="spec-grid">
              <div>
                <label class="lmd-label sm">画面比例</label>
                <select v-model="form.aspect_ratio" class="lmd-input">
                  <option v-for="a in ASPECT_RATIOS" :key="a.value" :value="a.value">{{ a.label }}</option>
                </select>
              </div>
              <div>
                <label class="lmd-label sm">帧率</label>
                <select v-model="form.frame_rate" class="lmd-input">
                  <option v-for="f in FRAME_RATES" :key="f.value" :value="f.value">{{ f.label }}</option>
                </select>
              </div>
              <div>
                <label class="lmd-label sm">输出清晰度</label>
                <select v-model="form.resolution" class="lmd-input">
                  <option v-for="r in RESOLUTIONS" :key="r.value" :value="r.value">{{ r.label }}</option>
                </select>
              </div>
            </div>
            <p class="lmd-range-hint">
              所有角色立绘、场景图、分镜首尾帧与视频都会按此规格生成，合成时直接沿用。
            </p>
          </div>
        </div>
        <div class="flex justify-end gap-3 mt-6">
          <button class="lmd-btn-ghost" @click="closeModal">取消</button>
          <button class="lmd-btn-primary" :disabled="savingProject" @click="saveProject">
            {{ savingProject ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ===== 调度配置弹窗 ===== -->
    <!-- ===== 全局配置弹窗（AI + 调度 合一，一次保存） ===== -->
    <div v-if="showSettings" class="lmd-mask" @click.self="showSettings = false">
      <div class="lmd-modal" style="max-width: 680px">
        <h3 class="lmd-modal-title">⚙️ 全局配置</h3>
        <div class="settings-tabs mt-5">
          <button class="settings-tab" :class="{ active: settingsTab === 'ai' }" @click="settingsTab = 'ai'">
            <el-icon class="mr-1"><Cpu /></el-icon>AI 配置
          </button>
          <button class="settings-tab" :class="{ active: settingsTab === 'scheduler' }" @click="settingsTab = 'scheduler'">
            <el-icon class="mr-1"><Setting /></el-icon>调度配置
          </button>
        </div>

        <!-- AI 配置：可换 Key 与模型，保存后立即生效，无需重启后端 -->
        <div v-if="settingsTab === 'ai'" class="space-y-5 mt-5">
          <template v-if="aiConfig">
            <div>
              <label class="lmd-label">默认 Provider</label>
              <select v-model="aiConfig.defaultProvider" class="lmd-input">
                <option v-for="k in Object.keys(aiConfig.providers || {})" :key="k" :value="k">
                  {{ aiConfig.providers[k].name || k }}
                </option>
              </select>
              <p class="lmd-range-hint mt-1">剧本拆解 / 生图 / 生视频默认走该平台</p>
            </div>

            <!-- Agnes：Key + BaseURL + 三件套模型 -->
            <div v-if="aiConfig.providers?.agnes" class="settings-card">
              <div class="settings-card-title">Agnes（文本 / 图片 / 视频）</div>
              <div class="space-y-3 mt-3">
                <div>
                  <label class="lmd-label">API Key</label>
                  <input
                    v-model="aiConfig.providers.agnes.apiKey"
                    class="lmd-input mono"
                    type="password"
                    :placeholder="aiConfig.providers.agnes.apiKeySet ? '已配置（留空则保持不变）' : '未配置，粘贴你的 API Key'"
                    autocomplete="off"
                  />
                  <p class="lmd-range-hint mt-1">留空保持不变；填写新 Key 将在保存后立即生效</p>
                </div>
                <div>
                  <label class="lmd-label">Base URL</label>
                  <input v-model="aiConfig.providers.agnes.baseUrl" class="lmd-input mono" placeholder="https://api.agnes-ai.cn/v1" />
                </div>
                <div v-for="m in MODEL_FIELDS" :key="m.key">
                  <label class="lmd-label">{{ m.label }}</label>
                  <input v-model="aiConfig.providers.agnes.models[m.key]" class="lmd-input mono" />
                  <p class="lmd-range-hint mt-1">{{ m.hint }}</p>
                </div>
              </div>
            </div>

            <!-- 火山引擎 TTS：可换凭据 -->
            <div v-if="aiConfig.tts" class="settings-card">
              <div class="settings-card-title">火山引擎 TTS（配音，可选）</div>
              <p class="lmd-range-hint mt-1">不配置则自动回退到免费 edge-tts，配音仍为中文</p>
              <div class="settings-grid mt-3">
                <div>
                  <label class="lmd-label">App ID</label>
                  <input v-model="aiConfig.tts.appId" class="lmd-input mono" type="password"
                    :placeholder="aiConfig.tts.appIdSet ? '已配置（留空保持）' : '未配置'" autocomplete="off" />
                </div>
                <div>
                  <label class="lmd-label">Resource Token</label>
                  <input v-model="aiConfig.tts.token" class="lmd-input mono" type="password"
                    :placeholder="aiConfig.tts.tokenSet ? '已配置（留空保持）' : '未配置'" autocomplete="off" />
                </div>
                <div>
                  <label class="lmd-label">Cluster</label>
                  <input v-model="aiConfig.tts.cluster" class="lmd-input mono" placeholder="volcano_tts" />
                </div>
                <div>
                  <label class="lmd-label">默认音色（可选）</label>
                  <input v-model="aiConfig.tts.defaultVoice" class="lmd-input mono"
                    :placeholder="aiConfig.tts.defaultVoiceSet ? '已配置（留空保持）' : '按方言自动映射'" />
                </div>
              </div>
            </div>
          </template>
        </div>

    <!-- 调度配置（同一弹窗的第二页，保存时与 AI 配置一并提交） -->
        <div v-else class="space-y-6 mt-5">
          <div class="lmd-range-row">
            <div class="flex justify-between">
              <span class="lmd-range-label">图片生成并发数</span>
              <span class="lmd-range-val indigo">{{ schedulerConfig.max_image_concurrency }}</span>
            </div>
            <el-slider v-model="schedulerConfig.max_image_concurrency" :min="1" :max="10" />
            <p class="lmd-range-hint">控制同时生成图片的任务数量</p>
          </div>
          <div class="lmd-range-row">
            <div class="flex justify-between">
              <span class="lmd-range-label">视频生成并发数</span>
              <span class="lmd-range-val purple">{{ schedulerConfig.max_video_concurrency }}</span>
            </div>
            <el-slider v-model="schedulerConfig.max_video_concurrency" :min="1" :max="5" />
            <p class="lmd-range-hint">控制同时生成视频的任务数量</p>
          </div>
          <div class="lmd-range-row">
            <div class="flex justify-between">
              <span class="lmd-range-label">最大重试次数</span>
              <span class="lmd-range-val pink">{{ schedulerConfig.max_retries }} 次</span>
            </div>
            <el-slider v-model="schedulerConfig.max_retries" :min="1" :max="10" />
            <p class="lmd-range-hint">API调用失败后的最大重试次数</p>
          </div>
          <div class="lmd-range-row">
            <div class="flex justify-between">
              <span class="lmd-range-label">重试初始延迟</span>
              <span class="lmd-range-val emerald">{{ schedulerConfig.retry_initial_delay_ms }} ms</span>
            </div>
            <el-slider v-model="schedulerConfig.retry_initial_delay_ms" :min="500" :max="5000" :step="100" />
            <p class="lmd-range-hint">首次重试前的等待时间（指数退避）</p>
          </div>
        </div>

        <div class="flex justify-end gap-3 mt-6">
          <button class="lmd-btn-ghost" @click="showSettings = false">取消</button>
          <button class="lmd-btn-primary" :disabled="savingSettings" @click="saveSettings">
            {{ savingSettings ? '保存中...' : '保存配置' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 全局配置弹窗：Tab 分页 + Provider 分组卡片 */
.settings-tabs {
  display: flex;
  gap: 6px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0;
}
.settings-tab {
  display: inline-flex;
  align-items: center;
  padding: 8px 16px;
  font-size: 13px;
  color: var(--muted);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
}
.settings-tab.active {
  color: var(--indigo, #6366f1);
  border-bottom-color: var(--indigo, #6366f1);
  font-weight: 600;
}
.settings-card {
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(99, 102, 241, 0.04);
}
.settings-card-title { font-size: 13px; font-weight: 600; color: var(--text); }
.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.lmd-topbar {
  background: rgba(255, 255, 255, 0.92);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 20;
  backdrop-filter: blur(8px);
}
.lmd-logo {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  background: var(--grad-main);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
}
.lmd-title { font-size: 20px; font-weight: 700; color: var(--text); margin: 0; line-height: 1.2; }
.lmd-subtitle { font-size: 12px; color: var(--muted); margin: 2px 0 0; }
.lmd-page-title { font-size: 28px; font-weight: 700; color: var(--text); margin: 0 0 4px; }
.lmd-muted-text { color: var(--muted); margin: 0; }

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

.lmd-card-title { font-size: 17px; font-weight: 700; color: var(--text); margin: 0; line-height: 1.35; }
.lmd-card-desc {
  font-size: 13px; color: var(--muted); margin: 0;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  min-height: 36px;
}
.lmd-badge-indigo {
  padding: 2px 10px; font-size: 12px; color: var(--indigo);
  background: var(--indigo-soft); border-radius: 999px; white-space: nowrap;
}
.lmd-cover-badge {
  position: absolute; bottom: 8px; right: 8px;
  padding: 2px 10px; font-size: 12px; border-radius: 999px; font-weight: 600;
}
.lmd-card-btn {
  flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  padding: 8px 10px; font-size: 13px; color: var(--text-2);
  background: #f1f5f9; border: 1px solid var(--border); border-radius: 10px; cursor: pointer;
  transition: background 0.2s;
}
.lmd-card-btn:hover { background: #e2e8f0; }
.lmd-card-btn-rose { flex: 0 0 auto; color: var(--rose); background: var(--rose-soft); border-color: transparent; }
.lmd-card-btn-rose:hover { background: rgba(244, 63, 94, 0.22); }

/* 状态标签 */
.lmd-status-gray { background: rgba(100, 116, 139, 0.16); color: #475569; }
.lmd-status-indigo { background: var(--indigo-soft); color: var(--indigo); }
.lmd-status-emerald { background: var(--emerald-soft); color: var(--emerald); }

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
.lmd-input.mono { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 12px; }

/* 调度配置 */
.lmd-range-row { padding: 4px 0; }
.lmd-range-label { font-size: 14px; color: var(--text-2); }
.lmd-range-val { font-weight: 700; }
.lmd-range-val.indigo { color: var(--indigo); }
.lmd-range-val.purple { color: var(--purple); }
.lmd-range-val.pink { color: #ec4899; }
.lmd-range-val.emerald { color: var(--emerald); }
.lmd-range-hint { font-size: 12px; color: var(--muted); margin: 2px 0 0; }
/* 成片规格块：建项目时确定，需与普通表单项区分开（不可逆决策） */
.spec-block {
  padding: 12px;
  border: 1px solid rgba(99, 102, 241, 0.28);
  border-radius: 8px;
  background: rgba(99, 102, 241, 0.06);
}
.spec-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.spec-grid .lmd-label.sm { font-size: 12px; font-weight: 500; margin-bottom: 4px; }
.lmd-hint-inline {
  margin-left: 8px;
  font-size: 11px;
  font-weight: 400;
  color: #a5b4fc;
}
.space-y-4 > * + * { margin-top: 16px; }
.space-y-6 > * + * { margin-top: 24px; }
</style>