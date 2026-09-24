import { isNativeVideoRequest } from './generation-policy.js';
import { rewriteVideoDurationBody } from './generation-request.js';

/** One browser submission may forward at most one completion request.
 * Reserving happens synchronously, BEFORE network I/O; a failed continue is
 * uncertain and must never reset the reservation or trigger a second send.
 * This verifies transport parameters, not entitlement or server acceptance.
 */
export function createGenerationWireGate({ seconds, model, isActive, sessionVerified }) {
  if (![10, 15, 20, 30].includes(seconds)) throw new TypeError('Unsupported duration');
  const expectedModel = model || (seconds === 15 ? 'seedance_v2.0' : 'seedance_v2.5');
  let forwarded = 0;
  let blocked = 0;
  let lastReason = null;
  const reject = reason => {
    blocked++;
    lastReason = reason;
    return { action: 'abort', reason };
  };
  return {
    inspect(request) {
      let url;
      try { url = new URL(request.url()); } catch { return reject('invalid_url'); }
      if (!/^\/chat\/completion(?:\/|$)/.test(url.pathname)) return { action: 'unrelated' };
      if (url.origin !== 'https://www.dola.com' || url.username || url.password
          || url.pathname !== '/chat/completion' || request.method() !== 'POST') return reject('invalid_endpoint');
      if (!isActive() || !sessionVerified()) return reject('inactive_session');
      if (forwarded) return reject('duplicate_submission');
      let body = request.postData() || '';
      if ([20, 30].includes(seconds)) {
        body = rewriteVideoDurationBody(body, { seconds, targetModel: expectedModel }).body;
      }
      // 10s must be checked too: a plain chat or another model is not a video.
      if (!isNativeVideoRequest(body, seconds, expectedModel)) return reject('request_mismatch');
      forwarded++;
      return { action: 'forward', body };
    },
    snapshot: () => ({ forwarded, blocked, lastReason }),
  };
}
