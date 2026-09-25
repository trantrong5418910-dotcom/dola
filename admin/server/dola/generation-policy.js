/** Pure generation guards. No database, browser, account files or network access. */
import { quotaObservation } from './account-observations.js';
import { DURATION_SOURCE } from './generation-duration.js';
const badRequest = message => Object.assign(new Error(message), { status: 400 });
export const SUPPORTED_VIDEO_SECONDS = Object.freeze([10, 15, 20, 30]);

/** Only a fresh explicit receipt may prove zero quota. Unknown/stale is not zero;
 * positive quota is not proof that it covers a particular model's price.
 */
export function hasConfirmedZeroVideoQuota(account, at = new Date().toISOString()) {
  const observation = quotaObservation(account || {}, at);
  return observation.state === 'confirmed' && observation.remaining === 0;
}

function duration(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') {
    throw badRequest('seconds/forceSeconds 必须是 10、15、20 或 30');
  }
  const result = Number(value);
  if (!SUPPORTED_VIDEO_SECONDS.includes(result)) throw badRequest('seconds/forceSeconds 仅支持 10、15、20 或 30');
  return result;
}

export function normalizeVideoDuration({ seconds, forceSeconds = null } = {}) {
  const forced = forceSeconds == null ? null : duration(forceSeconds);
  const expected = duration(seconds ?? forced ?? 10);
  if (forced != null && forced !== expected) throw badRequest('seconds 与 forceSeconds 必须一致');
  return {
    seconds: expected,
    // 15s is the native Seedance 2.0 expert path; 20s and 30s are native
    // Seedance 2.5 paths. Keep the explicit 10s compatibility adapter
    // behavior, while carrying an effective target for native paths.
    forceSeconds: expected >= 15 ? (forced ?? expected) : forced,
    requireSessionRecheck: true,
    targetModel: expected === 15 ? 'seedance_v2.0' : expected >= 20 ? 'seedance_v2.5' : null,
  };
}

/** An absent or malformed proxy must never silently become a direct connection. */
export function requireGenerationProxy(raw) {
  try {
    if (typeof raw !== 'string' || !raw || /[\s\x00-\x1f\x7f]/.test(raw)) throw new Error();
    const url = new URL(raw);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname
        || url.search || url.hash || (url.pathname && url.pathname !== '/')) throw new Error();
    if (/[\s\x00-\x1f\x7f]/.test(decodeURIComponent(url.username + url.password))) throw new Error();
    if (/^gate[123]\.ipweb\.cc$/i.test(url.hostname)
        && (url.port !== '7778' || !url.username || !url.password)) throw new Error();
    return raw;
  } catch { throw Object.assign(new Error('生成必须配置有效的 IPWeb 或显式代理，禁止直连'), { status: 409 }); }
}

/** Login validity and video capability are separate; membership is not a duration gate. */
export function hasLiveSession(profile) {
  return profile?.ok === true && profile.status === 200 && profile.code === 0
    && Boolean(String(profile.entityId || profile.id || '').trim());
}

/**
 * 页面自己声明的**上游合成档位**（形如 `30s (15s ×2)`）证据判定。
 *
 * 与载体改写的区别：载体改写是我们把 15s 请求改成 30s，能不能出 30 秒
 * 由上游决定；合成档位是**页面自己就把这一档标成 30 秒**，拆段与首尾相接
 * 都在上游完成，交回来的是一条连续成片。所以它要求的证据形态是
 * 「UI 秒数 = 目标秒数 + 明确拼接标记」，而不是"更短的载体"。
 *
 * 单独的导出，是因为生成器也要用它决定「这一单要不要关掉请求改写」。
 */
export function isUpstreamConcatCapability(result, seconds) {
  const target = Number(seconds);
  return Boolean(result) && result.source === DURATION_SOURCE.UPSTREAM_CONCAT
    && result.concat === true && result.native === false && result.rewriteCarrier === false
    && result.seconds === target && result.uiSeconds === target;
}

/**
 * A page probe is admission evidence only when it proves the requested native
 * duration itself. A shorter UI carrier plus a request rewrite is useful
 * diagnostics, but it is not proof that the upstream accepts the target
 * duration and must not create/charge a task.
 *
 * `allowUpstreamConcat` 单独开关：上游合成档位默认**不放行**，
 * 因为它改变的是"我们愿意把什么算作 30 秒任务"这个口径，属于要显式拍板的事。
 */
export function isVerifiedNativeCapability(result, seconds, { allowUpstreamConcat = false } = {}) {
  const target = Number(seconds);
  if (!SUPPORTED_VIDEO_SECONDS.includes(target) || !result || result.ok !== true
      || result.state !== 'available' || result.seconds !== target) return false;
  const model = target === 15 ? 'seedance_v2.0' : 'seedance_v2.5';
  if (result.model !== model) return false;
  // 上游合成档位：整条片子由上游合成后交付，本地不拼接。
  if (isUpstreamConcatCapability(result, target)) return allowUpstreamConcat;
  // 20/30 秒走改写路径：20s 载体 10s，30s 载体 15s（2 额度档），rewriteCarrier=true 即为有效
  if (target === 20 || target === 30) {
    const expectCarrier = target === 30 ? 15 : 10;
    return result.uiSeconds === expectCarrier && result.native === false && result.rewriteCarrier === true;
  }
  return result.uiSeconds === target && result.native === true && result.rewriteCarrier === false;
}

/**
 * Validate one Seedance 2.5 / native duration generation request. This checks request shape,
 * not subscription, server acceptance or output duration; those are different facts.
 */
export function isNativeVideoRequest(body, expectedSeconds, targetModel = 'seedance_v2.5') {
  try {
    const seconds = Number(expectedSeconds);
    if (!SUPPORTED_VIDEO_SECONDS.includes(seconds)) return false;
    if (typeof body !== 'string' || !body || body.length > 1024 * 1024) return false;
    const abilities = [];
    const envelopes = new Set(['chat_ability', 'ability', 'abilities', 'payload', 'data',
      'message', 'messages', 'body', 'params', 'param', 'request', 'requests', 'list']);
    let visited = 0, decoded = body.length;
    const decode = text => {
      decoded += text.length;
      if (decoded > 2 * 1024 * 1024) throw new RangeError('Request budget exceeded');
      return JSON.parse(text);
    };
    const visit = (value, depth = 0) => {
      if (++visited > 4096 || depth > 8) throw new RangeError('Request budget exceeded');
      if (typeof value === 'string') { visit(decode(value), depth + 1); return; }
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
      if (Object.hasOwn(value, 'ability_type') || Object.hasOwn(value, 'ability_param')) {
        if (![17, '17'].includes(value.ability_type)) throw new TypeError('Unexpected ability');
        const param = typeof value.ability_param === 'string'
          ? decode(value.ability_param) : value.ability_param;
        abilities.push(param);
        return; // Never interpret a prompt/reference/metadata inside the parameters.
      }
      for (const [key, child] of Object.entries(value)) {
        if (envelopes.has(key)) visit(child, depth + 1);
      }
    };
    visit(JSON.parse(body));
    // One request must not silently turn into a multi-video batch. Duration must
    // be an explicit scalar, never JS-coerced true/[10] or an object.
    return abilities.length === 1 && abilities.every(param => param?.model === targetModel
      && ['number', 'string'].includes(typeof param.duration) && Number(param.duration) === seconds);
  } catch { return false; }
}

export function isNativeThirtySecondRequest(body, targetModel = 'seedance_v2.5') {
  return isNativeVideoRequest(body, 30, targetModel);
}

export function isActiveGenerationStatus(status) {
  return ['queued', 'submitting', 'generating', 'resolving'].includes(status);
}

export function validateArchivedVideo(archive, actualSeconds, expectedSeconds) {
  if (!archive || typeof archive.path !== 'string' || !archive.path
      || !Number.isFinite(archive.bytes) || archive.bytes < 1024) return 'archive_failed';
  if (!Number.isFinite(actualSeconds) || actualSeconds <= 0) return 'duration_unverified';
  if (!SUPPORTED_VIDEO_SECONDS.includes(Number(expectedSeconds))
      || Math.abs(actualSeconds - Number(expectedSeconds)) > 1.5) {
    return 'duration_mismatch';
  }
  return null;
}
