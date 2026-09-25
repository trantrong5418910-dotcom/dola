/** 只读：打印各账号代理的**脱敏**形态，用来看清格式差异。不打印口令。 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const ADMIN = '/www/wwwroot/dola.fei85.cn/admin';
const db = new DatabaseSync(join(ADMIN, 'server', 'data', 'admin.db'), { readOnly: true });
const rows = db.prepare('SELECT id,label,proxy,exit_ip,status FROM dola_accounts ORDER BY id').all();

for (const r of rows) {
  const p = String(r.proxy || '');
  // 只保留 scheme://用户名:***@host:port，顺手把 session 段单独拎出来
  const masked = p.replace(/\/\/([^:]+):[^@]+@/, '//$1:***@');
  const sess = /-session-([a-z0-9]+)/i.exec(p)?.[1] ?? '(无 session 段)';
  console.log(`#${r.id} ${r.label}  status=${r.status}  len=${p.length}  session=${sess}  exit_ip=${r.exit_ip || '(空)'}`);
  console.log(`     ${masked}`);
}
