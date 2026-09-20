/**
 * 后端网关客户端：用户端用它跟管理后台通信。
 *
 * 信任边界：两边共享一个密钥（后台「系统设置 → 用户端网关」里能看到）。
 * 网关接口不是给人用的，所以不走 JWT，走 `X-Gateway-Key`。
 */
import { isGatewayArchiveUrl, parseMediaUrl } from './media-url.js';

export const CREATE_TIMEOUT_MS = 90_000;

export function createGateway({ url = '', key = '', timeout = 15000, createTimeout = CREATE_TIMEOUT_MS, mediaTimeout = 90_000, fetchImpl = globalThis.fetch } = {}) {
  const base = String(url || '').replace(/\/+$/, '');
  if (base && (!parseMediaUrl(base) || new URL(base).search)) throw new Error('网关地址无效');

  async function call(path, body = null, requestTimeout = timeout, creating = false) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), requestTimeout);
    try {
      const r = await fetchImpl(base + path, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'X-Gateway-Key': key },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        redirect: 'error',
      });
      const j = await r.json().catch((error) => { if (ctrl.signal.aborted) throw error; return {}; });
      if (!r.ok) {
        throw Object.assign(new Error(j.message || `网关返回 HTTP ${r.status}`), { status: r.status, raw: j });
      }
      return j;
    } catch (e) {
      if (ctrl.signal.aborted) {
        throw Object.assign(new Error(creating
          ? '提交结果未知，请刷新任务列表确认；不要重复提交'
          : '管理后台网关请求超时，请稍后查询'), {
          status: 504, code: creating ? 'GATEWAY_CREATE_TIMEOUT' : 'GATEWAY_TIMEOUT',
        });
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // The key stays in this closure. Never forward redirects, cookies, or caller headers.
  async function fetchMedia(value, { range, signal } = {}) {
    const target = parseMediaUrl(value);
    if (!target) throw Object.assign(new Error('媒体地址无效'), { status: 502 });
    const headers = {};
    if (range) headers.Range = range;
    if (base && target.origin === new URL(base).origin) {
      if (!isGatewayArchiveUrl(value, base)) throw Object.assign(new Error('非归档媒体路径'), { status: 502 });
      if (!key) throw Object.assign(new Error('归档媒体鉴权未配置'), { status: 503 });
      headers['X-Gateway-Key'] = key;
    }
    const deadline = AbortSignal.timeout(mediaTimeout);
    try {
      return await fetchImpl(target.href, {
        headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch {
      throw Object.assign(new Error('媒体获取失败（超时或不允许的重定向）'), { status: 502 });
    }
  }

  return {
    enabled: Boolean(base && key),
    base,
    fetchMedia,
    verify: (token) => call('/api/gateway/verify', { token }),
    redeem: ({ token, card }) => call('/api/gateway/redeem', { token, card }),
    consume: ({ token, ref, points, reason }) => call('/api/gateway/consume', { token, ref, points, reason }),
    refund: ({ ref, note }) => call('/api/gateway/refund', { ref, note }),
    health: () => call('/api/gateway/health'),

    /**
     * 生成能力（控制面持有 dola 账号池和浏览器，用户面只提交意图）。
     * 每个方法都显式带 userToken —— 网关密钥只证明"我是那个服务"，
     * 用户名下的任务要靠这个令牌来区分。
     */
    generation: {
      create: ({ token, prompt, ratio, mode, seconds, forceSeconds, accountId }) =>
        call('/api/gateway/gen', { token, prompt, ratio, mode, seconds, forceSeconds, accountId }, createTimeout, true),
      status: ({ token, taskId }) =>
        call(`/api/gateway/gen/${encodeURIComponent(taskId)}?token=${encodeURIComponent(token)}`),
      list: ({ token, limit = 20 }) =>
        call(`/api/gateway/gen?token=${encodeURIComponent(token)}&limit=${Number(limit) || 20}`),
      cancel: ({ token, taskId }) =>
        call(`/api/gateway/gen/${encodeURIComponent(taskId)}/cancel`, { token }),
    },
  };
}

/**
 * 任务归属本地账本（零依赖 JSON 文件）。
 *
 * 为什么需要：改用网关令牌后，生成走的是**平台自己的生成资源**（上游令牌 / dola 账号池），
 * 上游按"平台账号"返回任务列表 —— 所有用户会看到彼此的任务。
 * 所以用户端自己记一笔「哪个 task 属于哪个令牌」，列表按它过滤。
 */
import fs from 'node:fs';
import path from 'node:path';

export function createTaskLedger(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let data = { tasks: {} };
  try {
    if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { data = { tasks: {} }; }
  if (!data.tasks) data.tasks = {};

  let dirty = false;
  const flush = () => {
    if (!dirty) return;
    dirty = false;
    try { fs.writeFileSync(file, JSON.stringify(data)); } catch { /* 忽略写失败，别影响主流程 */ }
  };
  const timer = setInterval(flush, 1000);
  timer.unref?.();

  return {
    close() { clearInterval(timer); flush(); },
    /** 记一笔归属 */
    own(taskId, { tokenId, prefix, ref, prompt }) {
      data.tasks[String(taskId)] = { tokenId, prefix, ref, prompt: String(prompt || '').slice(0, 200), at: new Date().toISOString() };
      dirty = true;
      flush();
      return data.tasks[String(taskId)];
    },
    get(taskId) { return data.tasks[String(taskId)] || null; },
    /** 某个令牌拥有的 taskId 集合 */
    idsOf(tokenId) {
      const out = new Set();
      for (const [id, v] of Object.entries(data.tasks)) if (v.tokenId === tokenId) out.add(id);
      return out;
    },
    belongsTo(taskId, tokenId) { const v = data.tasks[String(taskId)]; return Boolean(v && v.tokenId === tokenId); },
    forget(taskId) { delete data.tasks[String(taskId)]; dirty = true; flush(); },
  };
}
