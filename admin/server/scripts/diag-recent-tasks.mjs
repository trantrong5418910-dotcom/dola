/** 只读：列出最近 N 条任务的时间/账号/状态/错误，用来判断"提交不了"是不是还在发生。 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const db = new DatabaseSync(join(ROOT, 'server', 'data', 'admin.db'));
const N = Number(process.argv[2] || 15);

const cols = db.prepare('PRAGMA table_info(dola_tasks)').all().map((r) => r.name);
const want = ['id', 'account_id', 'status', 'seconds', 'created_at', 'updated_at',
  'error', 'error_code', 'reason', 'message', 'failure_reason', 'result_url', 'stage'];
const pick = want.filter((c) => cols.includes(c));
const sql = 'SELECT ' + pick.join(', ') + ' FROM dola_tasks ORDER BY id DESC LIMIT ' + N;
const rows = db.prepare(sql).all();
console.log(JSON.stringify({ columns: cols, shown: pick, tasks: rows }, null, 2));
