import { createRouter, createWebHistory } from 'vue-router';
import { state, can, ensureBootstrap } from './store.js';

/**
 * meta.perm 必须和 server/rbac.js 里的权限点一致；
 * meta.icon 是 Element Plus 图标组件名（在 Layout 里注册过）。
 */
const routes = [
  { path: '/login', name: 'login', component: () => import('./views/Login.vue'), meta: { public: true, title: '登录' } },
  {
    path: '/',
    component: () => import('./layouts/AdminLayout.vue'),
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', name: 'dashboard', component: () => import('./views/Dashboard.vue'), meta: { title: '仪表盘', perm: 'dashboard:view', icon: 'Odometer' } },
      { path: 'users', name: 'users', component: () => import('./views/Users.vue'), meta: { title: '用户管理', perm: 'user:list', icon: 'User' } },
      { path: 'roles', name: 'roles', component: () => import('./views/Roles.vue'), meta: { title: '角色权限', perm: 'role:list', icon: 'Key' } },
      { path: 'contents', name: 'contents', component: () => import('./views/Content.vue'), meta: { title: '内容管理', perm: 'content:list', icon: 'Document' } },
      { path: 'tokens', name: 'tokens', component: () => import('./views/Tokens.vue'), meta: { title: '访问令牌', perm: 'token:list', icon: 'Postcard' } },
      { path: 'cards', name: 'cards', component: () => import('./views/Cards.vue'), meta: { title: '充值卡', perm: 'card:list', icon: 'Tickets' } },
      { path: 'dola', name: 'dola', component: () => import('./views/Dola.vue'), meta: { title: 'dola 账号池', perm: 'dola:list', icon: 'Cloudy' } },
      { path: 'materials', name: 'materials', component: () => import('./views/Materials.vue'), meta: { title: '素材库', perm: 'material:list', icon: 'Picture' } },
      { path: 'settings', name: 'settings', component: () => import('./views/Settings.vue'), meta: { title: '系统设置', perm: 'setting:view', icon: 'Setting' } },
      { path: 'logs', name: 'logs', component: () => import('./views/Logs.vue'), meta: { title: '操作日志', perm: 'log:list', icon: 'List' } },
      { path: 'profile', name: 'profile', component: () => import('./views/Profile.vue'), meta: { title: '个人设置', icon: 'Avatar' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
];

export const router = createRouter({ history: createWebHistory(), routes });

/** 所有菜单项（有 perm 的才按权限过滤，没 perm 的（如个人设置）人人可见） */
export function menuItems() {
  const layout = routes.find((r) => r.path === '/');
  return layout.children
    .filter((c) => c.meta?.title && c.meta?.icon)
    .filter((c) => can(c.meta.perm))
    .map((c) => ({ path: '/' + c.path, title: c.meta.title, icon: c.meta.icon }));
}

router.beforeEach(async (to) => {
  document.title = to.meta?.title ? `${to.meta.title} · 管理后台` : '管理后台';

  // 必须先等登录态恢复完，否则整页刷新时会被误判成未登录（见 store.js 的注释）
  await ensureBootstrap();

  if (to.meta?.public) {
    return state.user ? '/dashboard' : true;
  }
  if (!state.user) return { path: '/login', query: { redirect: to.fullPath } };
  if (to.meta?.perm && !can(to.meta.perm)) {
    return { path: '/dashboard' };
  }
  return true;
});
