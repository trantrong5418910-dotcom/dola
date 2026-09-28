import { createRouter, createWebHistory } from 'vue-router';
import { ref } from 'vue';
import { state, can, ensureBootstrap } from './store.js';

/**
 * 是否有导航正在进行 —— 覆盖「路由守卫执行 + 懒加载页面 chunk 拉取」整段时间。
 * AdminLayout 用它决定是否显示内容区骨架（见那边的模板注释）。
 */
export const routePending = ref(false);

/**
 * meta.perm 必须和 server/rbac.js 里的权限点一致；
 * meta.icon 是 Element Plus 图标组件名（在 main.js 全量注册过）。
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
      { path: 'proxies', name: 'proxies', component: () => import('./views/Proxies.vue'), meta: { title: '代理管理', perm: 'dola:list', icon: 'Share' } },
      { path: 'proxy-pool', name: 'proxy-pool', component: () => import('./views/ProxyPool.vue'), meta: { title: '代理池', perm: 'dola:list', icon: 'Connection' } },
      { path: 'media', name: 'media', component: () => import('./views/MediaLibrary.vue'), meta: { title: '成片库', perm: 'dola:list', icon: 'Film' } },
      { path: 'materials', name: 'materials', component: () => import('./views/Materials.vue'), meta: { title: '素材库', perm: 'material:list', icon: 'Picture' } },
      { path: 'reference-images', name: 'reference-images', component: () => import('./views/ReferenceImages.vue'), meta: { title: '参考图库', perm: 'refimage:list', icon: 'Files' } },
      { path: 'scripts', name: 'scripts', component: () => import('./views/ScriptStudio.vue'), meta: { title: '脚本工作台', perm: 'script:list', icon: 'EditPen' } },
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
  routePending.value = true;
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

const CHUNK_RELOAD_KEY = 'admin_chunk_reload_at';

router.afterEach(() => {
  routePending.value = false;
  // 本次导航成功 ⇒ 说明 chunk 拉得到，解除强刷配额，下次发版还能再自愈一次。
  try { sessionStorage.removeItem(CHUNK_RELOAD_KEY); } catch { /* 隐私模式忽略 */ }
});

/**
 * 懒加载 chunk 拉取失败的兜底。
 *
 * 为什么需要：页面 chunk 是带哈希的独立文件，发版后文件名会变。如果浏览器里还开着旧版的
 * 页面（内存里是旧 entry），此时点菜单去 import 一个「已经被换掉的旧文件名」就会 404，
 * 而**表现是无提示的空白内容区 + 一条容易被忽略的 console 报错**。
 *
 * 处置：整页强刷一次即可拿到新 index.html / 新 chunk 名。用 sessionStorage 限流，
 * 10 秒内只刷一次，避免「chunk 真的坏了」时无限重载。
 */
router.onError((err) => {
  routePending.value = false;
  const msg = String(err?.message || err || '');
  if (!/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg)) return;
  let last = 0;
  try { last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0); } catch { /* 忽略 */ }
  if (Date.now() - last < 10000) return;
  try { sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now())); } catch { /* 忽略 */ }
  location.reload();
});
