<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { characterApi, sceneApi, propApi, storyboardApi } from '@/api';

type TabKey = 'characters' | 'scenes' | 'props' | 'storyboards';
const tabs: { key: TabKey; label: string }[] = [
  { key: 'characters', label: '角色' },
  { key: 'scenes', label: '场景' },
  { key: 'props', label: '道具' },
  { key: 'storyboards', label: '分镜' },
];
const active = ref<TabKey>('characters');
const keyword = ref('');
const loading = ref(false);

const characters = ref<any[]>([]);
const scenes = ref<any[]>([]);
const props = ref<any[]>([]);
const storyboards = ref<any[]>([]);

const visible = computed(() => {
  const k = keyword.value.trim().toLowerCase();
  let list: any[] = [];
  if (active.value === 'characters') list = characters.value;
  else if (active.value === 'scenes') list = scenes.value;
  else if (active.value === 'props') list = props.value;
  else list = storyboards.value;
  if (!k) return list;
  return list.filter((x) => String(x.name || x.location || x.dialogue || x.playletName || '').toLowerCase().includes(k));
});

const counts = computed(() => ({
  characters: characters.value.length,
  scenes: scenes.value.length,
  props: props.value.length,
  storyboards: storyboards.value.length,
}));

function loadAll() {
  loading.value = true;
  Promise.all([
    characterApi.list().then((r) => (characters.value = r)),
    sceneApi.list().then((r) => (scenes.value = r)),
    propApi.list().then((r) => (props.value = r)),
    storyboardApi.list().then((r) => (storyboards.value = r)),
  ])
    .catch((e) => console.error(e))
    .finally(() => (loading.value = false));
}

const titleOf = (x: any) =>
  x.name || x.location || `分镜 #${x.number}` || '(未命名)';
const imgOf = (x: any) =>
  x.imageUrl || x.lastFrameUrl || x.videoUrl || null;
const subOf = (x: any) => {
  if (x.roleLabel) return x.roleLabel;
  if (x.time) return x.time;
  if (x.type) return x.type;
  if (x.dialogue) return `对白：${x.dialogue}`;
  if (x.sceneLocation) return x.sceneLocation;
  return '暂无描述';
};

onMounted(loadAll);
</script>

<template>
  <div class="flex flex-col min-h-screen">
    <header class="lmd-topbar">
      <div class="max-w-7xl mx-auto w-full flex items-center justify-between px-6 py-4">
        <div>
          <h1 class="lmd-title">资产中心</h1>
          <p class="lmd-subtitle">汇聚所有剧集生成的角色 / 场景 / 道具 / 分镜素材</p>
        </div>
        <div class="flex items-center gap-3">
          <input v-model="keyword" class="lmd-input search" type="text" placeholder="搜索名称 / 地点 / 对白..." />
        </div>
      </div>
    </header>

    <main class="flex-1 max-w-7xl mx-auto w-full px-6 py-6">
      <div class="asset-tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="asset-tab"
          :class="{ active: active === t.key }"
          @click="active = t.key"
        >
          {{ t.label }} <span class="asset-count">{{ counts[t.key] }}</span>
        </button>
      </div>

      <div v-if="loading" class="lmd-empty">加载中...</div>
      <div v-else-if="visible.length === 0" class="lmd-empty">
        <div class="lmd-empty-icon">🗂️</div>
        <h3>暂无{{ tabs.find((t) => t.key === active)?.label }}素材</h3>
        <p>到对应项目使用「一键成片」生成后，素材会实时汇总到这里。</p>
      </div>
      <div v-else class="asset-grid">
        <div v-for="x in visible" :key="x.id" class="asset-card">
          <div class="asset-thumb" :class="{ isVideo: !!(x.videoUrl && active === 'storyboards') }">
            <img v-if="imgOf(x)" :src="imgOf(x)" :alt="titleOf(x)" />
            <video
              v-else-if="active === 'storyboards' && x.videoUrl"
              :src="x.videoUrl"
              class="asset-video"
              muted
              playsinline
            />
            <div v-else class="asset-null">未生成</div>
          </div>
          <div class="asset-info">
            <div class="asset-name">{{ titleOf(x) }}</div>
            <div class="asset-sub">{{ subOf(x) }}</div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.lmd-topbar { background: rgba(255,255,255,0.92); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 20; backdrop-filter: blur(8px); }
.lmd-title { font-size: 20px; font-weight: 700; color: var(--text); margin: 0; line-height: 1.2; }
.lmd-subtitle { font-size: 12px; color: var(--muted); margin: 2px 0 0; }
.lmd-input.search { width: 280px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 9px 12px; font-size: 14px; color: var(--text); }
.lmd-input.search:focus { outline: 2px solid var(--indigo-soft); border-color: var(--indigo); }
.asset-tabs { display: flex; gap: 8px; margin-bottom: 20px; }
.asset-tab { font-size: 14px; font-weight: 600; color: var(--text-2); cursor: pointer; padding: 8px 16px; border-radius: 999px; border: 1px solid var(--border); background: var(--screen-soft); transition: all .2s; }
.asset-tab.active { background: var(--indigo); color: #fff; border-color: var(--indigo); }
.asset-count { font-size: 12px; opacity: 0.75; }
.lmd-empty { border: 1px dashed var(--border); border-radius: 20px; padding: 48px 24px; text-align: center; color: var(--muted); background: var(--card); }
.lmd-empty-icon { font-size: 48px; opacity: 0.3; }
.lmd-empty h3 { font-size: 18px; color: var(--text); margin: 10px 0 4px; }
.lmd-empty p { margin: 0; }
.asset-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
.asset-card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; transition: box-shadow .2s; }
.asset-card:hover { box-shadow: 0 10px 20px rgba(15,23,42,0.08); }
.asset-thumb { aspect-ratio: 9 / 13; background: #eef2f7; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.asset-thumb img { width: 100%; height: 100%; object-fit: cover; }
.asset-video { width: 100%; height: 100%; object-fit: cover; }
.asset-null { color: var(--muted); font-size: 13px; }
.asset-info { padding: 8px 10px; }
.asset-name { font-size: 13px; font-weight: 700; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-sub { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>