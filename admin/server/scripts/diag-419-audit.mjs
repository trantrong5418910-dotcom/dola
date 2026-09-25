/** 只读：看 #419 最近的操作审计（谁在什么时候动了代理），定位"代理被清空"的来源。 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const db = new DatabaseSync(join(ROOT, 'server', 'data', 'admin.db'));
const id = Number(process.argv[2] || 419);
const cols = db.prepare('PRAGMA table_info(audit_logs)').all().map((r) => r.name);
const sql = 'SELECT * FROM audit_logs WHERE target_id = ' + id
  + " AND target_type = 'dola_account' ORDER BY id DESC LIMIT 30";
const rows = db.prepare(sql).all();
console.log(JSON.stringify({ columns: cols, rows }, null, 2));
