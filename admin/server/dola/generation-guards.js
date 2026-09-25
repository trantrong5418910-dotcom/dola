import { classifyFailure, FAILURE_REASONS } from './generation-analytics.js';

export const GENERATION_GUARD_SCHEMA = `CREATE TABLE IF NOT EXISTS dola_generation_guards (
  account_id INTEGER NOT NULL, scope TEXT NOT NULL, reason_code TEXT NOT NULL,
  source_task_id INTEGER NOT NULL, blocked_at TEXT NOT NULL, cleared_at TEXT,
  PRIMARY KEY(account_id,scope)
);`;

/**
 * 失败 → 作用域。作用域决定"封多久、封多宽"。
 *
 * `duration:<n>`  只封该账号的那个时长（能力问题是按时长算的）。
 * `reference-images` / `login` 是**账号级**：与请求时长无关，一旦命中就不该再被选中。
 *   —— `login` 对照参考站 §4：`unsigned`（未登录）是独立状态、不参与调度。
 *      页面连创作输入框都拿不到时，问题不在某个时长上，而在整个账号的登录态。
 */
export function failureScope(row) {
  const { code } = classifyFailure(row.error);
  if (code === 'reference') return 'reference-images';
  // ★ 2026-09-25 新增：登录未确认 → 账号级防护。
  //   原先这句话被 session 分支的正则（含「登录」）先吃掉，session 没有作用域，
  //   于是 failureScope 返回 null、recordGenerationGuard 直接返回 false、**一个防护都不建** ——
  //   这个号就永远留在待选池里，每轮再白烧最多 3 分钟。这是线上真实故障，不是理论问题。
  if (code === 'login') return 'login';
  return code === 'capability' && [10, 15, 20, 30].includes(Number(row.seconds)) ? `duration:${Number(row.seconds)}` : null;
}

export function hasGenerationGuard(db, accountId, seconds, refs = false) {
  return Boolean(db.prepare(`SELECT 1 FROM dola_generation_guards
    WHERE account_id=? AND cleared_at IS NULL
      AND (scope=? OR scope='login' OR (?=1 AND scope='reference-images')) LIMIT 1`)
    .get(accountId, `duration:${Number(seconds)}`, refs ? 1 : 0));
}

function capabilityColumn(scope) {
  // login 复用同样的三段式账号字段（login_state / login_at / login_note），
  // 于是"记录"和"解除"都能走和时长能力**完全一样**的代码路径，不需要第二套机制
  //（这正是它可解除、不会变成第二个永久锁的原因）。
  if (scope === 'login') return 'login';
  return scope === 'reference-images' ? 'reference_image'
    : ['duration:15', 'duration:30'].includes(scope) ? `native_${scope.split(':')[1]}s` : null;
}

/**
 * 写回账号字段时用的状态值。
 *
 * ⚠️ 两者语义**不同**，不能都写 unknown：
 *   - 时长/参考图能力探测失败，只说明"没确认"→ 写 `unknown`（绝不断言"不可用"）。
 *   - 登录未确认是**有明确证据的否定结论**（创作输入框始终没出现）→ 写成 `unavailable` 才诚实，
 *     选号也能据此直接排除它（对照参考站 §4 的 `unsigned` 态）。
 */
const GUARD_ACCOUNT_STATE = Object.freeze({ login: 'unavailable' });

const GUARD_ACCOUNT_NOTE = Object.freeze({
  login: '未确认登录态（创作输入框未出现），已暂停选号并等待只读复核',
});

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
  if (column) db.prepare(`UPDATE dola_accounts SET ${column}_state=?,${column}_at=?,${column}_note=?,updated_at=? WHERE id=?`)
    .run(GUARD_ACCOUNT_STATE[scope] || 'unknown', at,
      GUARD_ACCOUNT_NOTE[scope] || `生成任务 #${row.id} 未确认能力，已暂停并等待只读复核`,
      new Date().toISOString(), row.account_id);
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
  } else if (guard.scope === 'login') {
    // ★ 「登录未确认」的解除凭据：只读探针**真的拿到了创作输入框**并认出了一个时长控件。
    //
    // 为什么不能只看 result.ok / state==='available'：那只是"页面探测跑完了"，
    // 必须同时证明「登录态 + 创作面板可用」这两件事。所以要求探针给出一个合法的时长识别结果
    // （原生 10/15 秒 native=true；20/30 秒是改写载体 rewriteCarrier=true，同样说明控件被认出来了）。
    //
    // ⚠️ 这一条分支是**必须存在**的：没有它 clearGenerationGuard 会对未知作用域直接返回 false，
    //    于是 login 防护永远解不开 —— 那就是本项目已经吃过一次的"永久锁"（见 submission-journal.js
    //    里 uncertain「一旦写入就没有任何代码路径能离开它」）。test/generation-login-guard.mjs 专门断言可解除。
    const secs = Number(result.seconds), ui = Number(result.uiSeconds);
    if (![10, 15, 20, 30].includes(secs) || ![10, 15, 20, 30].includes(ui)) return false;
    if (result.native !== true && result.rewriteCarrier !== true) return false;
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
    .run(at, guard.scope === 'login'
      ? '只读复核通过：已确认页面处于登录态且创作输入框可用；未提交视频，不保证额度或成片成功'
      : '只读复核通过；仅确认页面控件，不保证生成成功或额度充足', at, guard.account_id);
  return Boolean(changed);
}

export function listGenerationGuards(db) {
  return db.prepare(`SELECT g.* FROM dola_generation_guards g JOIN dola_accounts a ON a.id=g.account_id
    WHERE g.cleared_at IS NULL ORDER BY g.blocked_at DESC`).all().map(row => ({
    ...row,
    // 直接按库里存下来的 reason_code 取文案，而不是从别处再猜一句话 ——
    // 猜的那版会把 login 防护显示成"能力探测未完成"，运维看了不知道该修登录还是修控件。
    ...(FAILURE_REASONS[row.reason_code] || FAILURE_REASONS.other),
    label: row.scope === 'reference-images' ? '参考图'
      : row.scope === 'login' ? '登录态'
        : `${row.scope.split(':')[1]} 秒`,
  }));
}
