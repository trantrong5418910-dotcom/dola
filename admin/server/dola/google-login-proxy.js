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

/**
 * 直连出口的**哨兵值**。刻意选一个"明显不是代理 URL"的字符串：
 * 一旦它漏进 proxyOf / requireLoginProxy 会立刻报错，而不会被当成一个能用的代理。
 * 只允许由 createLoginProxyResolver({ allowDirect: true }) 在号池里找不到任何可用 IPWeb
 * 模板时返回；驱动只有看到**这个值**才会不带代理启动浏览器。
 *
 * ⚠️ 空串 / undefined **不是**直连 —— 那是「没配代理」，仍然 fail-closed。
 */
export const DIRECT_LOGIN_PROXY = 'direct:';

/**
 * 落库用的代理值：把直连哨兵换成空串（dola_accounts.proxy 的约定是「空 = 不用代理」），
 * 其余一律走 fail-closed 校验。绝不把哨兵本身写进数据库。
 */
export function storedLoginProxy(raw) {
  if (raw === DIRECT_LOGIN_PROXY) return '';
  return requireLoginProxy(raw);
}

/**
 * @param {object} db
 * @param {{ allowDirect?: boolean }} [options] allowDirect 打开后，找不到任何可用 IPWeb
 *   模板时返回 DIRECT_LOGIN_PROXY（直连）而不是抛错。默认关闭。
 */
export function createLoginProxyResolver(db, { allowDirect = false } = {}) {
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
      // 直连备用（2026-09-29 飞哥确认）：号池里没有任何可用 IPWeb 模板时，允许**直连**，
      // 出口即本机公网 IP（腾讯东京）。必须由调用方显式打开 allowDirect ——
      // 默认仍是 fail-closed，避免「忘了配代理」被静默降级成直连。
      // 顺序保证：账号自带代理 > 号池 IPWeb 模板 > 直连，绝不会把已有代理的账号换成直连
      //（storeAccount 的 login_proxy_changed 还会再兜一层）。
      if (allowDirect) return DIRECT_LOGIN_PROXY;
      throw new Error('ipweb_proxy_not_configured');
    },
  };
}
