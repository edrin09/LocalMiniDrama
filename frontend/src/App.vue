<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router';
import { Film } from '@element-plus/icons-vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const NAV = [
  { to: '/', label: '项目', icon: Film },
];
const isActive = (to: string) =>
  to === '/' ? route.path === '/' : route.path.startsWith(to);
</script>

<template>
  <div class="app-shell">
    <!-- 左侧导航工作台 -->
    <aside class="app-nav">
      <div class="nav-brand">
        <span class="nav-logo">🎬</span>
        <span class="nav-brand-text">本地短剧</span>
      </div>
      <nav class="nav-list">
        <RouterLink
          v-for="n in NAV"
          :key="n.to"
          :to="n.to"
          class="nav-item"
          :class="{ active: isActive(n.to) }"
        >
          <el-icon :size="18"><component :is="n.icon" /></el-icon>
          <span>{{ n.label }}</span>
        </RouterLink>
      </nav>
    </aside>

    <!-- 内容区 -->
    <div class="app-main">
      <RouterView />
    </div>
  </div>
</template>

<style scoped>
.app-shell { display: flex; min-height: 100vh; }
.app-nav {
  width: 200px; flex-shrink: 0; background: #fff; border-right: 1px solid var(--border);
  display: flex; flex-direction: column; position: sticky; top: 0; height: 100vh;
}
.nav-brand { display: flex; align-items: center; gap: 8px; padding: 18px 16px; border-bottom: 1px solid var(--border); }
.nav-logo { font-size: 22px; }
.nav-brand-text { font-size: 15px; font-weight: 800; color: var(--text); }
.nav-list { padding: 12px 10px; display: flex; flex-direction: column; gap: 4px; }
.nav-item {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 10px;
  color: var(--text-2); font-size: 14px; font-weight: 600; text-decoration: none; transition: all .2s;
}
.nav-item:hover { background: #f1f5f9; }
.nav-item.active { background: var(--indigo-soft); color: var(--indigo); }
.app-main { flex: 1; min-width: 0; }
</style>