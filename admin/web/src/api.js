/**
 * 统一请求封装：自动带 token、统一错误提示、401 自动踢回登录页。
 */
import { ElMessage } from 'element-plus';

const TOKEN_KEY = 'admin_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(method, url, body, { silent = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    if (!silent) ElMessage.error('网络请求失败：' + e.message);
    throw e;
  }

  let data = {};
  try { data = await res.json(); } catch { /* 空响应 */ }

  if (res.status === 401) {
    setToken('');
    if (onUnauthorized) onUnauthorized();
    if (!silent) ElMessage.error(data.message || '登录已过期，请重新登录');
    throw Object.assign(new Error(data.message || '未登录'), { status: 401 });
  }
  if (!res.ok || data.ok === false) {
    const msg = data.message || `请求失败 (HTTP ${res.status})`;
    if (!silent) ElMessage.error(msg);
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return data;
}

export const api = {
  get: (url, opt) => request('GET', url, undefined, opt),
  post: (url, body, opt) => request('POST', url, body, opt),
  put: (url, body, opt) => request('PUT', url, body, opt),
  del: (url, body, opt) => request('DELETE', url, body, opt),
};

/** 拼查询串，自动丢掉空值 */
export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== '' && v !== null && v !== undefined) sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
