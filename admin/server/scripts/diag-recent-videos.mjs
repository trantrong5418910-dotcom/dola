/** 只读：列出最近 N 条 dola_videos（生成任务）的关键字段与失败原因。 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const db = new DatabaseSync(join(ROOT, 'server', 'data', 'admin.db'));
const N = Number(process.argv[2] || 12);

const cols = db.prepare('PRAGMA table_info(dola_videos)').all().map((r) => r.name);
const rows = db.prepare('SELECT * FROM dola_videos ORDER BY id DESC LIMIT ' + N).all();
const trim = (s) => (typeof s === 'string' && s.length > 200 ? s.slice(0, 200) + '…' : s);
const out = rows.map((r) => {
  const o = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === null || v === undefined || v === '') continue;
    o[k] = trim(v);
  }
  return o;
});
console.log(JSON.stringify({ columns: cols, tasks: out }, null, 2));
