/** Pure generation guards. No database, browser, account files or network access. */
import { quotaObservation } from './account-observations.js';
import { DURATION_SOURCE } from './generation-duration.js';
const badRequest = message => Object.assign(new Error(message), { status: 400 });
// ★ 档位精简（2026-09-27）：10 秒与 20 秒已下线，只保留 30 秒（主档位，2 额度）
// 与 15 秒（专家模式 / Seedance 2.0）。10/20 在网关入口被 `DURATION_RETIRED` 拒绝，
// 不做静默降级；历史任务与账本不受影响，所以历史库里仍可能出现 10/20 的值。
export const SUPPORTED_VIDEO_SECONDS = Object.freeze([15, 30]);

/** 已下线的档位。保留常量是为了让「拒绝」有唯一措辞来源，别在各处散写魔数。 */
export const RETIRED_VIDEO_SECONDS = Object.freeze([10, 20]);

/** 调用方完全不传 seconds 时的默认档位：30 秒（主档位，2 额度）。 */
export const DEFAULT_VIDEO_SECONDS = 30;

/** Only a fresh explicit receipt may prove zero quota. Unknown/stale is not zero;
 * positive quota is not proof that it covers a particular model's price.
 */
export function hasConfirmedZeroVideoQuota(account, at = new Date().toISOString()) {
  const observation = quotaObservation(account || {}, at);
  return observation.state === 'confirmed' && observation.remaining === 0;
}

function duration(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') {
    throw badRequest('seconds/forceSeconds 必须是 15 或 30');
  }
  const result = Number(value);
  if (RETIRED_VIDEO_SECONDS.includes(result)) {
    throw Object.assign(badRequest(`seconds=${result} 档位已下线，仅支持 15 秒（专家模式）或 30 秒`), { code: 'DURATION_RETIRED' });
  }
  if (!SUPPORTED_VIDEO_SECONDS.includes(result)) throw badRequest('seconds/forceSeconds 仅支持 15 或 30');
  return result;
}

export function normalizeVideoDuration({ seconds, forceSeconds = null } = {}) {
  const forced = forceSeconds == null ? null : duration(forceSeconds);
  // 默认档位 30（档位精简后的主档位）。原来是 10 —— 那个默认值会穿过这里直达上游，
  // 网关入口改了默认值但这里没改的话，"不传 seconds"的调用方仍会拿到已下线的 10 秒。
  const expected = duration(seconds ?? forced ?? DEFAULT_VIDEO_SECONDS);
  if (forced != null && forced !== expected) throw badRequest('seconds 与 forceSeconds 必须一致');
  return {
    seconds: expected,
    // 15 秒 = 原生 Seedance 2.0 专家路径；30 秒 = Seedance 2.5。档位精简后只剩这两档，
    // 两者都要把时长显式注入请求（没有"不注入、用页面默认"的兼容档了），
    // 所以 forceSeconds 一律带值，不再保留 10 秒的 null 兼容分支。
    forceSeconds: forced ?? expected,
    requireSessionRecheck: true,
    targetModel: expected === 15 ? 'seedance_v2.0' : 'seedance_v2.5',
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
 * A page probe is admission evidence when it proves either the requested native
 * duration or the explicitly enabled carrier rewrite path. A shorter UI carrier
 * is accepted only with the rewrite policy enabled; the archived media duration
 * remains the final delivery check.
 *
 * `allowUpstreamConcat` 单独开关：上游合成档位默认**不放行**，
 * 因为它改变的是"我们愿意把什么算作 30 秒任务"这个口径，属于要显式拍板的事。
 *
 * `allowCarrierRewrite` 是 30 秒专用的第二个口径开关，默认 `false` = 仍要求原生目标档位；
 * 打开后允许页面上的更短载体（包括 10 秒）在提交阶段改写为 30 秒。
 *
 * ⚠️ 为什么需要它（2026-09-25 实测）：服务端 `video-duration` 控件的 `option_list`
 *    对免费号只下发 `5`/`10`，三个模型都一样 —— **15s 在配置层面不存在**。
 *    于是 30 秒在整条链上永久不可达：探针选不到 15s 载体 → `native_30s_state`
 *    恒为 `unknown` → 三处硬门禁（选号 / 只读预检 / 路由诊断）全部要求
 *    `available` → 永远接不住 30 秒请求，与"上游到底收不收 30 秒"无关。
 *    打开后改为「任何**真实存在于该账号页面**的更短档位都能当载体」，
 *    真正的验收口子仍然是归档阶段的 ffprobe 时长校验（不达标 → `fail()` + 自动退款）。
 */
export function isVerifiedNativeCapability(result, seconds, {
  allowUpstreamConcat = false,
  allowCarrierRewrite = false,
} = {}) {
  const target = Number(seconds);
  if (!SUPPORTED_VIDEO_SECONDS.includes(target) || !result || result.ok !== true
      || result.state !== 'available' || result.seconds !== target) return false;
  const model = target === 15 ? 'seedance_v2.0' : 'seedance_v2.5';
  if (result.model !== model) return false;
  // 上游合成档位：整条片子由上游合成后交付，本地不拼接。
  if (isUpstreamConcatCapability(result, target)) return allowUpstreamConcat;
  // A genuine native target is stronger evidence than any shorter carrier, but
  // the shape alone is not enough: only the duration probe's explicit
  // `native_single` source proves that the page exposed a one-shot target
  // option.  This keeps a carrier/concat result from being promoted to native
  // capability merely because a caller filled in matching UI fields.
  if (result.uiSeconds === target && result.native === true && result.rewriteCarrier === false) {
    return result.source === DURATION_SOURCE.NATIVE_SINGLE;
  }
  // 30 秒：默认仍是历史口径（载体必须是 15s）；显式放行后接受任何真实存在的更短载体。
  if (target === 30) {
    if (!allowCarrierRewrite) {
      return result.uiSeconds === 15 && result.native === false && result.rewriteCarrier === true;
    }
    // 载体必须是**真实档位**：数值类型、正整数、且严格短于目标。
    // 不认字符串 '10' —— 真实证据只由 selectNativeVideoDuration() 产出（恒为 number），
    // 一个字符串只能来自被篡改或手写的探测结果，没必要为它放宽。
    return result.native === false && result.rewriteCarrier === true
      && typeof result.uiSeconds === 'number' && Number.isInteger(result.uiSeconds)
      && result.uiSeconds > 0 && result.uiSeconds < target;
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
