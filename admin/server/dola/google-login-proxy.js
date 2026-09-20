import { createHash } from 'node:crypto';
import { buildIpwebProxy, parseIpwebExport } from './proxy.js';

/** Authentication must fail closed; never pass an empty/invalid proxy to a browser. */
export function requireLoginProxy(raw) {
  try {
    if (typeof raw !== 'string' || !raw.trim() || /[\s\x00-\x1f\x7f]/.test(raw)) throw new Error();
    const url = new URL(raw);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname
        || url.search || url.hash || (url.pathname && url.pathname !== '/')) throw new Error();
    if (/[\x00-\x1f\x7f]/.test(decodeURIComponent(url.username + url.password))) throw new Error();
    return raw;
  } catch { throw new Error('login_proxy_required'); }
}

export function createLoginProxyResolver(db) {
  return {
    resolveProxy(email, account) {
      if (account?.proxy) return requireLoginProxy(account.proxy);
      const rows = db.prepare("SELECT proxy FROM dola_accounts WHERE status='valid' AND proxy<>'' ORDER BY id DESC").all();
      for (const row of rows) {
        try {
          const raw = requireLoginProxy(row.proxy);
          const url = new URL(raw);
          if (!/^gate[123]\.ipweb\.cc$/i.test(url.hostname) || url.port !== '7778') continue;
          const config = parseIpwebExport(raw);
          const sid = createHash('sha256').update(String(email).trim().replace(/\\@/g, '@').toLowerCase()).digest('hex').slice(0, 8);
          return requireLoginProxy(buildIpwebProxy({ ...config, sid }));
        } catch { /* Do not log proxy credentials; try another already configured template. */ }
      }
      throw new Error('ipweb_proxy_not_configured');
    },
  };
}
