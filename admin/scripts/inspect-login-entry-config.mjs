/** Empty, proxied CLI browser for inspecting the public login entry only.
 * No account password, Cookie, Storage, code endpoint or DB write is used.
 * Usage: node scripts/inspect-login-entry-config.mjs <login-profile-id>
 * Close the CLI browser and SIGTERM this helper to remove its private config.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlaywright } from '../server/dola/provider.js';
import { proxyOf } from '../server/dola/proxy.js';
import { createLoginProxyResolver } from '../server/dola/google-login-proxy.js';
import { startSocksBridge } from '../server/dola/socks-bridge.js';

const id = Number(process.argv[2]);
if (!Number.isSafeInteger(id) || id < 1) throw new Error('Expected login profile id');
const root = fileURLToPath(new URL('../', import.meta.url));
const db = new Database(path.join(root, 'server/data/admin.db'), { readonly: true, fileMustExist: true });
const profile = db.prepare('SELECT email FROM dola_login_profiles WHERE id=?').get(id);
if (!profile) throw new Error('Unknown profile');
const rows = db.prepare('SELECT proxy,status FROM dola_accounts WHERE lower(label)=?').all(profile.email);
if (rows.length > 1 || rows[0]?.status === 'disabled') throw new Error('Account unavailable');
const rawProxy = createLoginProxyResolver(db).resolveProxy(profile.email, rows[0]);
db.close();
const bridge = /^socks5h?:/.test(rawProxy) ? await startSocksBridge(rawProxy) : null;
const proxy = bridge ? { server: bridge.url } : proxyOf({ proxy: rawProxy });
if (!proxy?.server) throw new Error('Proxy required');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dola-login-entry-'));
await fs.chmod(dir, 0o700);
const config = path.join(dir, 'config.json');
const pw = await getPlaywright();
await fs.writeFile(config, JSON.stringify({ browser: {
  browserName: 'chromium', isolated: true,
  launchOptions: { proxy, headless: false, executablePath: pw.chromium.executablePath() },
  contextOptions: { locale: 'zh-CN', viewport: { width: 1120, height: 820 } },
}, outputDir: path.join(root, '../output/playwright'), timeouts: { navigation: 45000, action: 10000 },
console: { level: 'error' } }), { mode: 0o600 });
console.log(JSON.stringify({ profileId: id, config, pid: process.pid, emptyContext: true }));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await fs.unlink(config).catch(() => {});
  await fs.rmdir(dir).catch(() => {});
  await bridge?.close(); process.exit(0);
}
process.on('SIGTERM', close); process.on('SIGINT', close);
setInterval(() => {}, 30000);
