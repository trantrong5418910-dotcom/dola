/** Read-only browser diagnostics. Install before creating/navigating any page,
 * with serviceWorkers:'block'. POST is not synonymous with a write: the site
 * uses it for several bootstrap/IM reads. Allow only those observed read RPCs.
 * Unknown writes and all generation traffic are blocked; never fabricate ACKs.
 */
export const READONLY_CONTEXT_OPTIONS = Object.freeze({ serviceWorkers: 'block' });

/** Diagnostic-only compatibility for Playwright's WebSocket mock. Some site
 * URL polyfills replace the constructor without URL.parse, which the mock uses.
 * Preserve standard parse semantics; do not modify network responses, tokens,
 * account capability, or the production generation browser.
 */
export function preserveDiagnosticUrlParse() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'URL');
  if (!descriptor?.configurable || typeof globalThis.URL !== 'function') return;
  let current = globalThis.URL;
  const repair = () => {
    if (typeof current === 'function' && typeof current.parse !== 'function') {
      const Constructor = current;
      Object.defineProperty(Constructor, 'parse', { configurable: true, writable: true,
        value(input, base) { try { return new Constructor(input, base); } catch { return null; } },
      });
    }
    return current;
  };
  Object.defineProperty(globalThis, 'URL', { configurable: true, enumerable: descriptor.enumerable,
    get: repair, set(value) { current = value; },
  });
}
const READ_POSTS = new Set([
  '/alice/user/get_web_anon_id', '/alice/user/config/pull', '/alice/user/launch',
  '/alice/profile/self', '/alice/profile/self_brief', '/alice/im/launch', '/alice/basic/launch',
  '/alice/call/downgrade_config_pc', '/alice/commerce/sale/subscription/entry/config/',
  '/alice/slot/action_bar_v3/get_item_conf', '/alice/search/launch',
  '/samantha/skill/recommend', '/samantha/skill/pack', '/samantha/user/ab/get',
  '/im/chain/recent_conv', '/im/conversation/batch_get', '/im/project/list',
  '/im/message/send_rate_limit', '/ttwid/check/', '/passport/token/beat/web/',
  '/service/settings/v3/', '/biz/activity/get_pop_window', '/biz/activity/get_push_banner',
  '/alice/office/skills/list_user_and_featured',
]);
// Site-loaded SDK initialization/telemetry, never a generation or account CRUD API.
const SDK_POSTS = new Set([
  'mssdk.bytedance.com/web/r/token', 'mssdk.bytedance.com/web/common',
  'mcs-sg.ciciai.com/webid', 'mcs-sg.ciciai.com/tobid', 'mcs-sg.ciciai.com/list',
  'maliva-mcs.byteoversea.com/webid', 'vmweb-sg.ciciai.com/service/2/abtest_config/',
  'vcs.zijieapi.com/vc/setting', 'mon-sg.byteintlapi.com/monitor_browser/collect/batch/',
]);

export function permitsReadonlyRequest(rawUrl, method) {
  try {
    const url = new URL(rawUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false;
    if (/\/chat\/completion(?:\/|$)/.test(url.pathname) || /\/logout(?:\/|$)/.test(url.pathname)) return false;
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
    return method === 'POST' && url.protocol === 'https:'
      && ((['www.dola.com', 'dola.com'].includes(url.hostname) && READ_POSTS.has(url.pathname))
        || SDK_POSTS.has(url.hostname + url.pathname));
  } catch { return false; }
}

export async function installReadonlyNetwork(context, { onBlocked = () => {}, repairWebSocketMock = false } = {}) {
  if (typeof context.routeWebSocket !== 'function') throw new Error('Diagnostic runtime must support WebSocket isolation');
  // Do not connect to the real server: all diagnostic WebSockets remain closed.
  await context.routeWebSocket('**/*', ws => ws.close());
  if (repairWebSocketMock) await context.addInitScript(preserveDiagnosticUrlParse);
  await context.route('**/*', async route => {
    const request = route.request();
    if (permitsReadonlyRequest(request.url(), request.method())) return route.continue();
    // Diagnostic callbacks cannot accidentally let a request escape on failure.
    try { await onBlocked(request); } finally { await route.abort(); }
  });
}
