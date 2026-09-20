/** Pure generation guards. No database, browser, account files or network access. */
const badRequest = message => Object.assign(new Error(message), { status: 400 });
export const SUPPORTED_VIDEO_SECONDS = Object.freeze([10, 15, 20, 30]);

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
 * Validate one Seedance 2.5 / native duration generation request. This checks request shape,
 * not subscription, server acceptance or output duration; those are different facts.
 */
export function isNativeVideoRequest(body, expectedSeconds, targetModel = 'seedance_v2.5') {
  try {
    const seconds = Number(expectedSeconds);
    if (!SUPPORTED_VIDEO_SECONDS.includes(seconds)) return false;
    if (typeof body !== 'string' || !body || body.length > 1024 * 1024) return false;
    const abilities = [];
    const visit = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 8) return;
      if (Number(value.ability_type) === 17) {
        const param = typeof value.ability_param === 'string'
          ? JSON.parse(value.ability_param) : value.ability_param;
        abilities.push(param);
      }
      for (const [key, child] of Object.entries(value)) {
        if (child && typeof child === 'object') visit(child, depth + 1);
        else if (typeof child === 'string' && /ability|payload|data|message/i.test(key)) {
          try { visit(JSON.parse(child), depth + 1); } catch { /* Plain text is not an ability. */ }
        }
      }
    };
    visit(JSON.parse(body));
    return abilities.length > 0 && abilities.every(param => param?.model === targetModel
      && Number(param.duration) === seconds);
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
