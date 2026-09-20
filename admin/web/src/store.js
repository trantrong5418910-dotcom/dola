/** 极简全局状态（不引 pinia，够用） */
import { reactive, computed } from 'vue';
import { api, setToken, getToken } from './api.js';

export const state = reactive({
  user: null,          // 当前登录用户（含 permissions）
  ready: false,        // 是否已尝试恢复登录态
  dark: localStorage.getItem('admin_theme') !== 'light',  // 默认深色
});

export const isLoggedIn = computed(() => Boolean(state.user));

/** 权限判断：超级管理员 permissions = ['*'] */
export function can(code) {
  if (!code) return true;
  const perms = state.user?.permissions || [];
  return perms.includes('*') || perms.includes(code);
}

export function applyTheme() {
  document.documentElement.classList.toggle('dark', state.dark);
  localStorage.setItem('admin_theme', state.dark ? 'dark' : 'light');
}

export function toggleTheme() {
  state.dark = !state.dark;
  applyTheme();
}

/** 应用启动时用本地 token 换回用户信息 */
export async function bootstrap() {
  if (!getToken()) { state.ready = true; return null; }
  try {
    const { user } = await api.get('/api/auth/me', { silent: true });
    state.user = user;
  } catch {
    setToken('');
    state.user = null;
  } finally {
    state.ready = true;
  }
  return state.user;
}

/**
 * 保证 bootstrap 只跑一次，并让调用方可以 await。
 *
 * ⚠️ 这是踩过的坑：`app.use(router)` 会立刻触发首次导航，那一刻 bootstrap 还没跑完，
 * 路由守卫看到 state.user 为空就把人弹去 /login —— 表现是「登录后只要刷新页面就掉登录态」，
 * 而单纯 SPA 跳转却正常。所以守卫必须 await 这个 promise 再判断登录态。
 */
let bootPromise = null;
export function ensureBootstrap() {
  if (!bootPromise) bootPromise = bootstrap();
  return bootPromise;
}

export async function login(username, password) {
  const { token, user } = await api.post('/api/auth/login', { username, password }, { silent: true });
  setToken(token);
  state.user = user;
  return user;
}

export async function logout() {
  try { await api.post('/api/auth/logout', {}, { silent: true }); } catch { /* 忽略 */ }
  setToken('');
  state.user = null;
}
