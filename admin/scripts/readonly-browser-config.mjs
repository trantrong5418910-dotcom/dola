/** Temporary Playwright CLI session using an authorized pool account and its bound proxy.
 * Does not write the DB. Deletes temporary credential/config files on exit.
 * Usage: node scripts/readonly-browser-config.mjs <accountId>; close browser, then send SIGTERM.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCookies, DOLA_HEADERS, getPlaywright } from '../server/dola/provider.js';
import { proxyOf } from '../server/dola/proxy.js';
import { startSocksBridge } from '../server/dola/socks-bridge.js';

const id = Number(process.argv[2]);
const production = process.argv.includes('--production');
const executablePath = production ? (await getPlaywright()).chromium.executablePath() : undefined;
if (!Number.isSafeInteger(id) || id < 1) throw new Error('Expected account id');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(path.join(root, 'server/data/admin.db'), { readonly: true });
const account = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(id);
if (!account || account.status !== 'valid' || !account.proxy
  || (account.cooldown_until && account.cooldown_until > new Date().toISOString())) throw new Error('Account not eligible');
if (db.prepare("SELECT 1 FROM dola_videos WHERE account_id=? AND status IN ('queued','submitting','generating','resolving')").get(id)) throw new Error('Account busy');
db.close();
const bridge = /^socks5h?:/.test(account.proxy) ? await startSocksBridge(account.proxy) : null;
const proxy = bridge ? { server: bridge.url } : proxyOf(account);
if (!proxy?.server) throw new Error('Proxy missing; direct connection forbidden');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dola-readonly-cli-'));
await fs.chmod(dir, 0o700);
const init = path.join(dir, 'readonly-init.cjs');
await fs.writeFile(init, `exports.default = async ({ page }) => {
  const { installReadonlyNetwork } = await import(${JSON.stringify(new URL('../server/dola/readonly-network.js', import.meta.url).href)});
  const { observeVideoComposerBootstrap } = await import(${JSON.stringify(new URL('../server/dola/composer-bootstrap.js', import.meta.url).href)});
  page.__readonlyDiagnostics = { blocked: [], errors: [] };
  await installReadonlyNetwork(page.context(), { onBlocked: request => {
    const url = new URL(request.url());
    if (page.__readonlyDiagnostics.blocked.length < 100) page.__readonlyDiagnostics.blocked.push({host: url.hostname, path: url.pathname, method: request.method()});
  }});
  observeVideoComposerBootstrap(page);
  page.on('pageerror', error => page.__readonlyDiagnostics.errors.push(String(error.stack || error.message).replace(/https?:\\/\\/([^\\s?)]+)[^\\s)]*/g, '$1').slice(0, 700)));
};\n`, { mode: 0o600 });
const config = path.join(dir, 'config.json');
await fs.writeFile(config, JSON.stringify({
  browser: {
    browserName: 'chromium', isolated: true,
    launchOptions: { proxy, headless: production, ...(executablePath ? { executablePath } : {}) },
    contextOptions: {
      serviceWorkers: 'block',
      viewport: { width: production ? 1280 : 1440, height: production ? 900 : 1000 }, locale: 'zh-CN', userAgent: DOLA_HEADERS['user-agent'],
      storageState: { origins: [], cookies: Object.entries(parseCookies(account.cookie)).map(([name, value]) => ({
        name, value: String(value), domain: '.dola.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax',
      })) },
    }, initPage: [init],
  },
  outputDir: path.join(root, '../output/playwright'),
  timeouts: { navigation: 60000, action: 10000 },
  console: { level: 'error' },
}), { mode: 0o600 });
console.log(JSON.stringify({ accountId: id, config, pid: process.pid, mode: 'read-only; generation requests blocked' }));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await fs.unlink(config).catch(() => {});
  await fs.unlink(init).catch(() => {});
  await fs.rmdir(dir).catch(() => {});
  await bridge?.close(); process.exit(0);
}
process.on('SIGTERM', close); process.on('SIGINT', close);
setInterval(() => {}, 30000);
