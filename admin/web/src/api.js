/**
 * 统一请求封装：自动带 token、统一错误提示、401 自动踢回登录页、超时兜底、全局忙碌计数。
 *
 * 2026-09-25 补的两层：
 *   1. 超时兜底（AbortController）。之前 fetch 是裸调用，上游卡住就**永久挂起**，
 *      v-loading 永远转，用户只能刷新页面。现在按路径分档给上限。
 *   2. 全局忙碌计数（busy.js）。慢操作时顶部进度条有反馈，不会让人以为点没生效而重复点。
 */
import { ElMessage } from 'element-plus';
import { busyBegin, busyEnd } from './busy.js';

const TOKEN_KEY = 'admin_token';

/**
 * 超时分三档。为什么不是统一一个值：
 *   - dola 账号池那批接口会驱动真实浏览器（探测额度、Google 登录、30s 能力核验），
 *     单个账号就要几十秒，批量更是分钟级。给它们套 30 秒上限 = 砍断正常请求，
 *     而且有些上游是「创建成功即扣费」，被客户端砍断就是白扣钱（血泪教训）。
 *   - 常规增删改查没理由超过 30 秒，早点失败早点重试，比挂着强。
 *
 * 备注：`long` 取 300 秒是和 Node 自身的上限对齐 —— Node 18+ 的
 * `server.requestTimeout` 默认就是 300000ms，超过它服务端会先断，
 * 客户端再等也没有意义。
 */
export const TIMEOUT = {
  /** 只读列表 / 详情 */
  fast: 30_000,
  /** 常规增删改 */
  default: 60_000,
  /** dola 账号池相关：浏览器自动化、批量探测、批量登录、维护任务 */
  long: 300_000,
};

/**
 * 按路径前缀自动升档。这样不用去改每一个调用点，
 * 也不会因为漏改某个慢接口而把它砍断。
 */
/**
 * 按路径前缀自动升档。这样不用去改每一个调用点，
 * 也不会因为漏改某个慢接口而把它砍断。
 *
 * 只放**确实慢**的路径：代理池的巡检/重均衡会逐条真连出口检测服务，
 * 几十条 × 并发 8 是分钟级的；而同一前缀下的列表/汇总接口仍然走 60 秒，
 * 免得一个卡住的读请求把页面挂 5 分钟。
 */
const LONG_PATH_PREFIXES = [
  '/api/dola',
  '/api/frontend/open',
  '/api/proxy-pool/sweep',
  '/api/proxy-pool/rebalance',
  '/api/proxy-pool/release-isolated',
  /**
   * 成片库这两个**只放慢的那两个**，不要把整个 /api/media 拖成 5 分钟：
   *   - scan：要拉一次消息链（25 秒上限）+ 逐条解析无水印（最多 8 个 fallback_api × 15 秒），
   *     最坏情况能到分钟级 —— 用默认 60 秒会被砍断，而砍断时上游其实已经读完了，白等一轮。
   *   - import：默认勾了「同时归档」，每条都要下载几十 MB，多条就是分钟级。
   * 而 library / stats 这些纯读接口仍然走默认档，免得一个卡住的查询把页面挂住。
   */
  '/api/media/conversation/scan',
  '/api/media/conversation/import',
];

export function timeoutFor(url, explicit) {
  if (explicit) return explicit;
  return LONG_PATH_PREFIXES.some((p) => String(url).startsWith(p)) ? TIMEOUT.long : TIMEOUT.default;
}

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

async function request(method, url, body, { silent = false, timeoutMs } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const limit = timeoutFor(url, timeoutMs);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), limit);

  busyBegin();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    if (!silent) {
      ElMessage.error(aborted
        ? `请求超时（超过 ${Math.round(limit / 1000)} 秒），请稍后重试或到日志页查看进度`
        : '网络请求失败：' + e.message);
    }
    // status 用 0 表示「没拿到响应」，方便调用方区分于 HTTP 错误码
    throw Object.assign(aborted ? new Error('请求超时') : e, { aborted, status: 0 });
  } finally {
    // ★ 必须放在 finally：成功和失败两条路径都要清定时器，
    //   否则一个请求就漏一个定时器，长会话下会攒起来。
    clearTimeout(timer);
    busyEnd();
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
  patch: (url, body, opt) => request('PATCH', url, body, opt),
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
