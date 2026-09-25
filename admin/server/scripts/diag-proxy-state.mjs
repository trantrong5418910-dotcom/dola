/** 只读：确认 419 的代理到底怎么没的，以及现在有没有可分配的代理凭据。 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const db = new DatabaseSync(join(ROOT, 'server', 'data', 'admin.db'));

const acc = db.prepare(`SELECT id, label, proxy, exit_ip, group_name, source, updated_at, status
                        FROM dola_accounts WHERE id = 419`).get();

const proxyLike = db.prepare("SELECT key, value FROM settings WHERE key LIKE '%proxy%' OR key LIKE '%ipweb%' ORDER BY key").all()
  .map(r => ({ key: r.key, value: typeof r.value === 'string' && /pass|secret|pwd/i.test(r.key) ? '***' : r.value }));

const allProxy = db.prepare(`SELECT id, label, substr(proxy,1,60) p, exit_ip FROM dola_accounts
                             WHERE proxy IS NOT NULL AND length(proxy) > 0 ORDER BY id`).all();

console.log(JSON.stringify({
  a419: { ...acc, proxyLength: acc?.proxy ? acc.proxy.length : 0, proxyRawIsEmpty: !acc?.proxy || String(acc.proxy).trim() === '' },
  settingsKeys: proxyLike,
  accountsWithProxy: allProxy,
}, null, 2));
process.exit(0);
