/** 只读：列出最近 N 条 jobs 的时间/账号/状态/错误，用来判断"提交不了"是不是还在发生。 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const db = new DatabaseSync(join(ROOT, 'server', 'data', 'admin.db'));
const N = Number(process.argv[2] || 15);

const cols = db.prepare('PRAGMA table_info(jobs)').all().map((r) => r.name);
const order = cols.includes('id') ? 'id DESC' : 'rowid DESC';
const sql = 'SELECT * FROM jobs ORDER BY ' + order + ' LIMIT ' + N;
const rows = db.prepare(sql).all();

const trim = (s) => (typeof s === 'string' && s.length > 220 ? s.slice(0, 220) + '…' : s);
const out = rows.map((r) => {
  const o = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === null || v === undefined || v === '') continue;
    o[k] = trim(v);
  }
  return o;
});
console.log(JSON.stringify({ columns: cols, tasks: out }, null, 2));
