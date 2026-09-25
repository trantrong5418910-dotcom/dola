/** 只读：看 IPWeb 配置是否存在（assign_proxy 复用的来源），以及最近代理相关审计。 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const db = new DatabaseSync(join(ROOT, 'server', 'data', 'admin.db'));

const settings = db.prepare('SELECT * FROM settings').all()
  .map((r) => ({ key: r.key ?? r.k ?? r.name, value: String(r.value ?? r.v ?? '').slice(0, 60) }))
  .filter((r) => /ipweb|proxy|代理/i.test(String(r.key)));

const recent = db.prepare("SELECT id, username, action, target_id, detail, ip, created_at FROM audit_logs WHERE action LIKE '%proxy%' OR action LIKE '%ipweb%' ORDER BY id DESC LIMIT 15").all();

console.log(JSON.stringify({ ipwebishSettings: settings, recentProxyActions: recent }, null, 2));
