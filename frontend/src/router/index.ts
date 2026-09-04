import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'project-list',
      component: () => import('@/views/ProjectList.vue'),
      meta: { title: '我的短剧项目' },
    },
    {
      path: '/project/:id',
      name: 'project-detail',
      component: () => import('@/views/ProjectDetail.vue'),
      meta: { title: '分集管理' },
    },
    {
      path: '/project/:id/episode/:eid',
      name: 'episode-edit',
      component: () => import('@/views/EpisodeEdit.vue'),
      meta: { title: '剧本编辑' },
    },
  ],
});

router.afterEach((to) => {
  const base = '本地短剧助手';
  document.title = to.meta.title ? `${String(to.meta.title)} · ${base}` : base;
});

export default router;