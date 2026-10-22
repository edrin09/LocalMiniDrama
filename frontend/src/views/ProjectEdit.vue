<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowLeft, Check } from '@element-plus/icons-vue';
import { dramaApi } from '@/api';
import {
  DIALECT_MAP,
  COVER_STYLES,
  ASPECT_RATIOS,
  FRAME_RATES,
  RESOLUTIONS,
  parseOutputSpec,
  DEFAULT_OUTPUT_SPEC,
} from '@/utils/dialect';
import type { Drama, Episode, OutputSpec } from '@/types';

const route = useRoute();
const router = useRouter();
const dramaId = Number(route.params.id);

interface ProjectDetailDto extends Drama {
  episodes?: Episode[];
  characters?: unknown[];
}

const loading = ref(false);
const saving = ref(false);
const saved = ref(false);
const project = ref<ProjectDetailDto | null>(null);

const statEpisodes = () => project.value?.episodes?.length ?? project.value?.episodeCount ?? 0;
const statCharacters = () => project.value?.characters?.length ?? project.value?.characterCount ?? 0;
const statMerged = () => project.value?.episodes?.filter((e) => e.merged).length ?? project.value?.mergedCount ?? 0;
const form = reactive({
  title: '',
  description: '',
  dialect: 'standard',
  coverStyle: 'default',
  // 成片规格：全流程共用（建项目时定，此处可改但需二次确认）
  aspect_ratio: DEFAULT_OUTPUT_SPEC.aspect_ratio as string,
  frame_rate: DEFAULT_OUTPUT_SPEC.frame_rate as number,
  resolution: DEFAULT_OUTPUT_SPEC.resolution as string,
});
/** 已保存的规格，用于判断本次保存是否改动了画幅（改动会让已有素材全部失效） */
const savedSpec = ref({
  aspect_ratio: DEFAULT_OUTPUT_SPEC.aspect_ratio as string,
  frame_rate: DEFAULT_OUTPUT_SPEC.frame_rate as number,
  resolution: DEFAULT_OUTPUT_SPEC.resolution as string,
});

async function load() {
  loading.value = true;
  try {
    project.value = (await dramaApi.get(dramaId)) as unknown as ProjectDetailDto;
    if (project.value) {
      form.title = project.value.title;
      form.description = project.value.description || '';
      form.dialect = project.value.dialect || 'standard';
      form.coverStyle = project.value.coverStyle || 'default';
      const spec = parseOutputSpec(project.value.outputCfg);
      form.aspect_ratio = spec.aspect_ratio;
      form.frame_rate = spec.frame_rate;
      form.resolution = spec.resolution;
      savedSpec.value = { ...spec };
    }
    saved.value = false;
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

function goBack() {
  router.push(`/project/${dramaId}`);
}

async function save() {
  if (!form.title.trim()) {
    ElMessage.warning('请输入项目名称');
    return;
  }
  // 画幅变更会让已生成的全部素材失效（它们是按旧画幅出图的），
  // 必须让用户明确知情，避免「改一下比例」这种轻率操作毁掉整片素材。
  const specChanged =
    form.aspect_ratio !== savedSpec.value.aspect_ratio ||
    form.resolution !== savedSpec.value.resolution ||
    Number(form.frame_rate) !== Number(savedSpec.value.frame_rate);
  if (specChanged && statEpisodes() > 0) {
    try {
      await ElMessageBox.confirm(
        `成片规格从 ${savedSpec.value.aspect_ratio} · ${savedSpec.value.frame_rate}fps · ${savedSpec.value.resolution} ` +
          `改为 ${form.aspect_ratio} · ${form.frame_rate}fps · ${form.resolution}。\n\n` +
          `画幅/清晰度是生成参数：已生成的角色立绘、场景图、分镜首尾帧与视频都按旧规格出图，` +
          `改规格后它们无法自动适配，必须重新生成全部素材，否则合成会拉伸或加黑边。\n\n确定继续？`,
        '更改成片规格',
        { type: 'warning', confirmButtonText: '更改并继续', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
  }
  saving.value = true;
  try {
    project.value = await dramaApi.update(dramaId, {
      title: form.title.trim(),
      description: form.description,
      dialect: form.dialect,
      coverStyle: form.coverStyle,
      outputCfg: {
        aspect_ratio: form.aspect_ratio as OutputSpec['aspect_ratio'],
        frame_rate: Number(form.frame_rate),
        resolution: form.resolution as OutputSpec['resolution'],
      },
    });
    savedSpec.value = {
      aspect_ratio: form.aspect_ratio,
      frame_rate: Number(form.frame_rate),
      resolution: form.resolution,
    };
    saved.value = true;
    ElMessage.success(
      specChanged ? '项目已保存；若已生成素材，请重新生成以匹配新的成片规格' : '项目已保存',
    );
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="flex flex-col min-h-screen">
    <!-- 顶栏 -->
    <header class="lmd-topbar">
      <div class="max-w-9xl mx-auto w-full flex items-center justify-between px-6 py-4">
        <div class="flex items-center gap-4">
          <button class="lmd-back-btn" @click="goBack" title="返回分集管理">
            <el-icon :size="18"><ArrowLeft /></el-icon>
          </button>
          <div>
            <h1 class="lmd-title">项目管理 · 编辑</h1>
            <p class="lmd-subtitle">{{ project?.title || '加载中...' }}</p>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <button class="lmd-btn-ghost" @click="goBack">返回</button>
          <button class="lmd-btn-primary flex items-center gap-1" :disabled="saving || loading" @click="save">
            <span v-if="saving" class="saving-spinner" />
            <el-icon v-else :size="15"><Check /></el-icon>{{ saving ? '保存中...' : '保存更改' }}
          </button>
        </div>
      </div>
    </header>

    <!-- 主内容 -->
    <main class="flex-1 max-w-9xl mx-auto w-full px-6 py-8">
      <div v-if="loading" class="text-center py-20 text-slate-400">加载中...</div>
      <div v-else class="lmd-card p-6 mx-auto" style="max-width: 900px">
        <div class="edit-cols">
          <!-- 基本信息 -->
          <div class="space-y-4">
            <h2 class="lmd-section-title">基本信息</h2>
            <div>
              <label class="lmd-label">项目名称</label>
              <input v-model="form.title" class="lmd-input" type="text" placeholder="例如：霸道总裁爱上我" />
            </div>
            <div>
              <label class="lmd-label">项目描述</label>
              <textarea v-model="form.description" rows="4" class="lmd-input" placeholder="简要描述剧情..."></textarea>
            </div>
          </div>

          <!-- 生成偏好 -->
          <div class="space-y-4">
            <h2 class="lmd-section-title">生成偏好</h2>
            <div>
              <label class="lmd-label">默认方言</label>
              <select v-model="form.dialect" class="lmd-input">
                <option v-for="(v, k) in DIALECT_MAP" :key="k" :value="k">{{ v.label }}</option>
              </select>
              <p class="lmd-range-hint mt-1">作为整剧各分集的默认说话音色，分镜或角色可单独覆写</p>
            </div>
            <div>
              <label class="lmd-label">封面风格</label>
              <select v-model="form.coverStyle" class="lmd-input">
                <option v-for="c in COVER_STYLES" :key="c.value" :value="c.value">{{ c.label }}</option>
              </select>
            </div>
            <!-- 成片规格：全流程共用的生成参数。改动会让已生成素材失效，故用醒目样式 + 保存时二次确认。 -->
            <div class="spec-block">
              <label class="lmd-label">
                成片规格
                <span class="lmd-hint-inline">生图 / 生视频 / 合成共用同一份</span>
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
                画幅与清晰度是生成参数而非后期裁切参数：更改后必须重新生成全部素材，否则合成会拉伸或加黑边。
              </p>
            </div>
          </div>
        </div>

        <!-- 概览统计 -->
        <div class="stat-cols mt-6">
          <div class="stat-box">
            <div class="stat-num">{{ statEpisodes() }}</div>
            <div class="stat-cap">分集数量</div>
          </div>
          <div class="stat-box">
            <div class="stat-num" style="color: var(--indigo)">{{ statCharacters() }}</div>
            <div class="stat-cap">角色数量</div>
          </div>
          <div class="stat-box">
            <div class="stat-num" style="color: var(--emerald)">{{ statMerged() }}</div>
            <div class="stat-cap">已合成</div>
          </div>
        </div>

        <div class="flex justify-end gap-3 mt-6">
          <span v-if="saved" class="saved-tip">✓ 已保存</span>
          <button class="lmd-btn-ghost" @click="goBack">取消</button>
          <button class="lmd-btn-primary" :disabled="saving" @click="save">
            <span v-if="saving" class="saving-spinner white" />
            <el-icon v-else :size="15"><Check /></el-icon>{{ saving ? '保存中...' : '保存更改' }}
          </button>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
/* 成片规格块：这是不可逆决策（改后素材需全部重生成），需与普通表单项视觉区分 */
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

.lmd-section-title { font-size: 15px; font-weight: 700; color: var(--text); margin: 0; }
.lmd-label { display: block; font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 6px; }
.lmd-input {
  width: 100%; background: var(--card); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 12px; font-size: 14px; color: var(--text);
  font-family: var(--font); resize: vertical;
}
.lmd-input:focus { outline: 2px solid var(--indigo-soft); border-color: var(--indigo); }
.lmd-range-hint { font-size: 12px; color: var(--muted); margin: 2px 0 0; }

.edit-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }

.stat-cols { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.stat-box {
  border: 1px solid var(--border); border-radius: 12px; padding: 14px;
  text-align: center; background: #fafbff;
}
.stat-num { font-size: 22px; font-weight: 800; color: var(--text); line-height: 1.2; }
.stat-cap { font-size: 12px; color: var(--muted); margin-top: 2px; }

.saved-tip { display: inline-flex; align-items: center; font-size: 13px; color: var(--emerald); font-weight: 600; }
.saving-spinner {
  width: 14px; height: 14px; border: 2px solid rgba(99,102,241,.25);
  border-top-color: var(--indigo); border-radius: 50%;
  animation: spin .7s linear infinite; display: inline-block;
}
.saving-spinner.white { border-color: rgba(255,255,255,.4); border-top-color: #fff; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 860px) {
  .edit-cols { grid-template-columns: 1fr; }
}
</style>