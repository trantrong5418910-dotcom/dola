import { classifyFailure } from './generation-analytics.js';

export const GENERATION_GUARD_SCHEMA = `CREATE TABLE IF NOT EXISTS dola_generation_guards (
  account_id INTEGER NOT NULL, scope TEXT NOT NULL, reason_code TEXT NOT NULL,
  source_task_id INTEGER NOT NULL, blocked_at TEXT NOT NULL, cleared_at TEXT,
  PRIMARY KEY(account_id,scope)
);`;

export function failureScope(row) {
  const { code } = classifyFailure(row.error);
  if (code === 'reference') return 'reference-images';
  return code === 'capability' && [10, 15, 20, 30].includes(Number(row.seconds)) ? `duration:${Number(row.seconds)}` : null;
}

export function hasGenerationGuard(db, accountId, seconds, refs = false) {
  return Boolean(db.prepare(`SELECT 1 FROM dola_generation_guards
    WHERE account_id=? AND cleared_at IS NULL AND (scope=? OR (?=1 AND scope='reference-images')) LIMIT 1`)
    .get(accountId, `duration:${Number(seconds)}`, refs ? 1 : 0));
}

function capabilityColumn(scope) {
  return scope === 'reference-images' ? 'reference_image'
    : ['duration:15', 'duration:30'].includes(scope) ? `native_${scope.split(':')[1]}s` : null;
}

// Only called after the task transitions to failed. Cancelled/late callbacks cannot poison accounts.
export function recordGenerationGuard(db, row, accountSnapshot) {
  const scope = failureScope(row);
  if (!scope || row.status !== 'failed' || !row.account_id) return false;
  const current = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(row.account_id);
  if (!current) return false;
  if (accountSnapshot && ['cookie_hash', 'proxy', 'sec_user_id'].some(key => current[key] !== accountSnapshot[key])) return false;
  const at = row.finished_at || row.updated_at || row.created_at;
  const column = capabilityColumn(scope);
  // A newer verified probe wins over an old failed callback / historical import.
  if (column && current[`${column}_state`] === 'available' && current[`${column}_at`] > at) return false;
  const existing = db.prepare('SELECT * FROM dola_generation_guards WHERE account_id=? AND scope=?').get(row.account_id, scope);
  if (existing && (existing.blocked_at >= at || existing.cleared_at >= at)) return false;
  db.prepare(`INSERT INTO dola_generation_guards(account_id,scope,reason_code,source_task_id,blocked_at,cleared_at)
    VALUES(?,?,?,?,?,NULL) ON CONFLICT(account_id,scope) DO UPDATE SET
    reason_code=excluded.reason_code,source_task_id=excluded.source_task_id,blocked_at=excluded.blocked_at,cleared_at=NULL`)
    .run(row.account_id, scope, classifyFailure(row.error).code, row.id, at);
  if (column) db.prepare(`UPDATE dola_accounts SET ${column}_state='unknown',${column}_at=?,${column}_note=?,updated_at=? WHERE id=?`)
    .run(at, `生成任务 #${row.id} 未确认能力，已暂停并等待只读复核`, new Date().toISOString(), row.account_id);
  return true;
}

// Startup-only backfill; GET analytics never mutates accounts. Cleared rows are retained as evidence.
export function seedHistoricalGenerationGuards(db) {
  let count = 0;
  const rows = db.prepare(`SELECT id,account_id,seconds,status,error,created_at,updated_at,finished_at,has_reference_images
    FROM dola_videos WHERE status IN ('ready','failed') ORDER BY id DESC`).all();
  const seen = new Set();
  for (const row of rows) {
    if (row.status === 'ready') {
      seen.add(`${row.account_id}/duration:${Number(row.seconds)}`);
      if (row.has_reference_images) seen.add(`${row.account_id}/reference-images`);
      continue;
    }
    const scope = failureScope(row);
    if (!scope) continue;
    const key = `${row.account_id}/${scope}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (recordGenerationGuard(db, row)) count++;
  }
  return count;
}

// A successful read-only probe is the only UI unlock path; it never buys quota or submits a prompt.
export function clearGenerationGuard(db, guard, accountSnapshot, result, at = new Date().toISOString()) {
  if (!result?.ok || result.state !== 'available') return false;
  const duration = /^duration:(10|15|20|30)$/.exec(guard.scope);
  if (duration) {
    const seconds = Number(duration[1]);
    // A selectable 10s carrier is not new evidence that a rejected 20/30s
    // capability works. Nor can a generic available flag prove the target model.
    if (result.seconds !== seconds || result.uiSeconds !== seconds || result.native !== true
      || result.rewriteCarrier !== false
      || result.model !== (seconds === 15 ? 'seedance_v2.0' : 'seedance_v2.5')) return false;
  } else if (guard.scope !== 'reference-images') return false;
  const current = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(guard.account_id);
  if (!current || current.status !== 'valid'
    || ['cookie_hash', 'proxy', 'sec_user_id'].some(key => current[key] !== accountSnapshot[key])) return false;
  if (db.prepare("SELECT 1 FROM dola_videos WHERE account_id=? AND status IN ('queued','submitting','generating','resolving') LIMIT 1").get(guard.account_id)) return false;
  const changed = db.prepare(`UPDATE dola_generation_guards SET cleared_at=?
    WHERE account_id=? AND scope=? AND source_task_id=? AND blocked_at=? AND cleared_at IS NULL`)
    .run(at, guard.account_id, guard.scope, guard.source_task_id, guard.blocked_at).changes;
  const column = capabilityColumn(guard.scope);
  if (changed && column) db.prepare(`UPDATE dola_accounts SET ${column}_state='available',${column}_at=?,${column}_note=?,updated_at=? WHERE id=?`)
    .run(at, '只读复核通过；仅确认页面控件，不保证生成成功或额度充足', at, guard.account_id);
  return Boolean(changed);
}

export function listGenerationGuards(db) {
  return db.prepare(`SELECT g.* FROM dola_generation_guards g JOIN dola_accounts a ON a.id=g.account_id
    WHERE g.cleared_at IS NULL ORDER BY g.blocked_at DESC`).all().map(row => ({
    ...row, ...classifyFailure(row.reason_code === 'reference' ? '参考图控件未确认' : '能力探测未完成'),
    label: row.scope === 'reference-images' ? '参考图' : `${row.scope.split(':')[1]} 秒`,
  }));
}
