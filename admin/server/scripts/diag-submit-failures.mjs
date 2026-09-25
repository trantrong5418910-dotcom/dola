/**
 * 只读诊断：查「任务提交不了」卡在哪一层。不提交、不扣费、不改库。
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const db = new DatabaseSync(join(ROOT, 'server', 'data', 'admin.db'));
const out = {};

function dump(table, limit = 12) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  const order = cols.includes('id') ? 'id' : cols[0];
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${order} DESC LIMIT ${limit}`).all();
  const keep = cols.filter(c => /id|status|state|error|note|message|seconds|account|token|prefix|created|updated|attempt|code|reason|stage/i.test(c));
  const rows2 = rows.map((r) => {
    const o = {};
    for (const c of keep) {
      const v = r[c];
      o[c] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) : v;
    }
    return o;
  });
  return { cols, rows: rows2 };
}

out.dola_videos = dump('dola_videos', 12);
out.statusCounts = db.prepare(`SELECT status, COUNT(*) n FROM dola_videos GROUP BY status`).all();
out.jobs = dump('jobs', 8);
out.journal = dump('dola_submission_journal', 8);
out.guards = db.prepare(`SELECT account_id, reason_code, COUNT(*) n FROM dola_generation_guards WHERE cleared_at IS NULL GROUP BY account_id, reason_code ORDER BY n DESC LIMIT 15`).all();

console.log(JSON.stringify(out, null, 2));
process.exit(0);
