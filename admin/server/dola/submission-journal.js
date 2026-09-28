import { createHash } from 'node:crypto';

// No cookies, proxy credentials, prompts or raw SSE are stored here.
export const SUBMISSION_JOURNAL_SCHEMA = `CREATE TABLE IF NOT EXISTS dola_submission_journal (
  task_id INTEGER PRIMARY KEY,
  account_id INTEGER,
  cookie_hash TEXT NOT NULL DEFAULT '',
  proxy_hash TEXT NOT NULL DEFAULT '',
  identity_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  conversation_id TEXT,
  evidence TEXT NOT NULL DEFAULT '',
  sent_at TEXT,
  deadline_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dsj_account ON dola_submission_journal(account_id,state);`;
const active = new Set(['queued', 'submitting', 'generating', 'resolving']);

/**
 * 「未结算」状态集合 —— 也就是"这次上游提交的结果还不知道"的几种情形。
 *
 * 处于这些状态的 journal 会：① 阻止该账号被再次选中
 * （`accountHasUnsettledSubmission`）② 阻止同一提示词重复提交
 * （`findUnsettledPrompt`）。
 *
 * 抽成常量是因为原本两个查询各写了一遍字面量 —— 一旦漏改一处，
 * 守卫就会出现"一个拦得住、一个拦不住"的静默不一致。
 */
export const PENDING_SUBMISSION_STATES = ['dispatching', 'uncertain', 'acknowledged'];
/** 拼给 SQL 用。值来自上面的硬编码常量（不含外部输入），且**由常量派生**，两边不可能漂移。 */
const pendingList = `(${PENDING_SUBMISSION_STATES.map((s) => `'${s}'`).join(',')})`;

const hash = proxy => createHash('sha256').update(String(proxy || '')).digest('hex');
const validId = id => typeof id === 'string' && /^\d{10,30}$/.test(id);
function atomic(db, work) {
  db.exec('SAVEPOINT submission_journal');
  try { const result = work(); db.exec('RELEASE submission_journal'); return result; }
  catch (error) { db.exec('ROLLBACK TO submission_journal'); db.exec('RELEASE submission_journal'); throw error; }
}

export const getSubmission = (db, id) => db.prepare('SELECT * FROM dola_submission_journal WHERE task_id=?').get(id);

/** Write intent before any outgoing request. A crash immediately after this
 * write is uncertain, never permission to submit again. INSERT cannot overwrite.
 */
export function recordSubmissionDispatch(db, { taskId, account, deadlineAt, at = new Date().toISOString() }) {
  return atomic(db, () => {
    const row = db.prepare('SELECT * FROM dola_videos WHERE id=?').get(taskId);
    const current = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(account.id);
    if (!row || row.status !== 'submitting' || row.account_id !== account.id
        || !current || current.status !== 'valid' || current.cookie_hash !== account.cookie_hash
        || current.proxy !== account.proxy || current.sec_user_id !== account.sec_user_id
        || (current.cooldown_until && current.cooldown_until > at)) throw new Error('submission_state_changed');
    if (!Number.isFinite(Date.parse(deadlineAt)) || deadlineAt <= at) throw new Error('submission_deadline_invalid');
    db.prepare(`INSERT INTO dola_submission_journal
      (task_id,account_id,cookie_hash,proxy_hash,identity_id,state,sent_at,deadline_at,updated_at)
      VALUES (?,?,?,?,?,'dispatching',?,?,?)`).run(taskId, account.id, account.cookie_hash || '',
        hash(account.proxy), account.sec_user_id || '', at, deadlineAt, at);
  });
}

/** Persist the conversation while the browser is still alive. URL evidence is
 * weaker than a correlated SSE_ACK and is not eligible for automatic recovery.
 */
export function recordSubmissionConversation(db, id, conversationId, evidence) {
  if (!validId(conversationId) || !['sse_ack', 'conversation_url'].includes(evidence)) return false;
  return atomic(db, () => {
    const receipt = getSubmission(db, id);
    const row = db.prepare('SELECT status,conversation_id FROM dola_videos WHERE id=?').get(id);
    if (!receipt || !active.has(row?.status) || ['rejected', 'completed'].includes(receipt.state)) return false;
    if ((receipt.conversation_id && receipt.conversation_id !== conversationId)
        || (row.conversation_id && row.conversation_id !== conversationId)) throw new Error('submission_conversation_conflict');
    const at = new Date().toISOString();
    const proof = receipt.evidence === 'sse_ack' ? 'sse_ack' : evidence;
    db.prepare("UPDATE dola_submission_journal SET state='acknowledged',conversation_id=?,evidence=?,updated_at=? WHERE task_id=?")
      .run(conversationId, proof, at, id);
    db.prepare('UPDATE dola_videos SET conversation_id=?,updated_at=? WHERE id=?').run(conversationId, at, id);
    return true;
  });
}

export function holdUncertainSubmission(db, id, reason = '提交结果待核对；不会自动重提或退款') {
  return atomic(db, () => {
    const row = db.prepare('SELECT * FROM dola_videos WHERE id=?').get(id);
    if (!row || !active.has(row.status)) return false;
    const at = new Date().toISOString();
    // Legacy in-flight tasks lack a trustworthy account snapshot. Preserve them
    // for review instead of guessing credentials or rewriting a terminal record.
    db.prepare(`INSERT INTO dola_submission_journal (task_id,account_id,state,evidence,updated_at)
      VALUES (?,?,'uncertain','legacy',?) ON CONFLICT(task_id) DO UPDATE SET
        state=CASE WHEN state IN ('rejected','completed') THEN state ELSE 'uncertain' END,updated_at=excluded.updated_at`)
      .run(id, row.account_id, at);
    db.prepare("UPDATE dola_videos SET stage='待核对上游结果（不会自动重提）',error=?,updated_at=? WHERE id=?")
      .run(String(reason).slice(0, 400), at, id);
    return true;
  });
}

/**
 * 落终态。**必须 UPSERT，不能裸 UPDATE。**
 *
 * 裸 UPDATE 在 journal 没有行时**静默失效**（影响 0 行、不报错），于是
 * 「上游已明确拒绝」这个终态事实根本没落库。重启后
 * `recoverStaleVideoTasks()` 读不到 `rejected`，就会把这条任务当成
 * 「结果不明」而 `holdUncertainSubmission` —— 三连击：
 * 任务永不终态、用户积分永不退、账号永久不再被选中。
 *
 * 什么时候会「没有行」：换号重试路径会 `DELETE FROM dola_submission_journal`
 * （generator.js，为了让下一轮能重新记录派发）。若进程恰好在
 * 「已 DELETE、下一轮 dispatch 尚未落库」的窗口里被杀，就正好命中。
 *
 * 生产实例：任务 #231（2026-09-29 02:50），上游 4 次拒绝 code=710022002 后
 * 卡成 `uncertain`，1 积分未退、账号 #445 被锁，只能人工 resolve。
 *
 * `ON CONFLICT` 分支**只改 state / updated_at，绝不碰 evidence**：
 * 已有 `sse_ack` 这类强证据必须原样保留（它是自动恢复的唯一凭据）。
 * INSERT 分支写 `evidence='legacy'`，与 `holdUncertainSubmission` 同语义 ——
 * 明确标注「这条终态是补写的，没有 dispatching 前置记录」，
 * 让运维一眼看出这不是一条可信的完整链路。
 */
export function closeSubmission(db, id, state) {
  if (!['rejected', 'completed'].includes(state)) throw new TypeError('Invalid terminal submission state');
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO dola_submission_journal (task_id, account_id, state, evidence, updated_at)
    VALUES (?, (SELECT account_id FROM dola_videos WHERE id=?), ?, 'legacy', ?)
    ON CONFLICT(task_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`)
    .run(id, id, state, at);
}

/** Commit the explicit rejection and its task/billing changes together. */
export function settleRejectedSubmission(db, id, settle) {
  return atomic(db, () => { closeSubmission(db, id, 'rejected'); return settle(); });
}

export function accountHasUnsettledSubmission(db, accountId) {
  // Cancelling/deleting a local row does not cancel an upstream operation.
  return Boolean(db.prepare(`SELECT 1 FROM dola_submission_journal
    WHERE account_id=? AND state IN ${pendingList} LIMIT 1`).get(accountId));
}

export function findUnsettledPrompt(db, ownerTokenId, prompt) {
  const normalized = String(prompt || '').trim().replace(/\s+/gu, ' ');
  return db.prepare(`SELECT v.id,v.status,v.prompt,v.created_at FROM dola_videos v
    JOIN dola_submission_journal j ON j.task_id=v.id
    WHERE v.owner_token_id=? AND j.state IN ${pendingList}`)
    .all(ownerTokenId).find(row => String(row.prompt || '').trim().replace(/\s+/gu, ' ') === normalized) || null;
}

/** Zero quota/cooldown are submission constraints, not reasons to lose an
 * already submitted result. Recovery is bound to the original identity/proxy.
 */
export function canRecoverSubmission(receipt, row, account, at = new Date().toISOString()) {
  return Boolean(['acknowledged', 'completed'].includes(receipt?.state) && receipt.evidence === 'sse_ack'
    && active.has(row?.status) && validId(receipt.conversation_id)
    && row.conversation_id === receipt.conversation_id && row.account_id === receipt.account_id
    && account?.id === receipt.account_id && account.status === 'valid'
    && receipt.cookie_hash && receipt.cookie_hash === account.cookie_hash
    && receipt.proxy_hash === hash(account.proxy) && receipt.identity_id === (account.sec_user_id || '')
    && receipt.deadline_at > at);
}

// ---------------------------------------------------------------- 出口（运维）

/**
 * 下面的三个函数是给「未结算」状态**开出口**的。
 *
 * 背景（这是个真实的设计缺口）：
 * `dispatching` / `uncertain` / `acknowledged` 会把账号和提示词一直锁住，
 * 而 `closeSubmission` 只接受 `rejected` / `completed` 两个终态 ——
 * 也就是说 **`uncertain` 一旦写入就没有任何代码路径能离开它**，
 * 管理端原本也没有任何路由能操作这张表，只能人肉改数据库。
 *
 * 触发它又特别容易：`holdUncertainSubmission` 在 generator.js 里有 10 处调用，
 * 连"服务重启"都会命中。后果是三连击：任务永不终态、用户积分永不退、
 * 账号永久不再被选中。
 *
 * 拦得对（结果不明时绝不能重提、也不能复用账号，否则上游会重复生成/双花），
 * 但**只进不出的状态机不是安全设计，是定时炸弹** —— 所以补出口，
 * 而不是放宽拦截条件。
 */

/**
 * 列出所有「卡住」的提交，给运维面板看。
 *
 * 只回**元数据 + 哈希**：cookie / 代理凭据 / 提示词本来就不存在这张表里
 * （见顶部 schema 注释），所以这个查询天然不会泄漏敏感材料。
 * 提示词只用于「同一提示词重复提交」的判据，从不落库。
 */
export function listPendingSubmissions(db, { limit = 200 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 200, 1), 500);
  return db.prepare(`
    SELECT j.task_id, j.account_id, j.state, j.evidence, j.conversation_id,
           j.sent_at, j.deadline_at, j.updated_at,
           v.status AS task_status, v.stage AS task_stage, v.error AS task_error,
           v.owner_token_id, v.created_at AS task_created_at,
           t.name AS token_name, t.prefix AS token_prefix,
           a.label AS account_label, a.status AS account_status
      FROM dola_submission_journal j
      LEFT JOIN dola_videos   v ON v.id = j.task_id
      LEFT JOIN dola_accounts a ON a.id = j.account_id
      LEFT JOIN tokens        t ON t.id = v.owner_token_id
     WHERE j.state IN ${pendingList}
     ORDER BY j.updated_at DESC
     LIMIT ?`).all(n);
}

/** 被卡住的账号 —— 直接回答"号池里哪些号不能用了、卡了多久"。 */
export function listBlockedAccounts(db) {
  return db.prepare(`
    SELECT a.id, a.label, a.status,
           COUNT(j.task_id) AS pending_count,
           MIN(j.updated_at) AS oldest_at, MAX(j.updated_at) AS newest_at
      FROM dola_submission_journal j
      JOIN dola_accounts a ON a.id = j.account_id
     WHERE j.state IN ${pendingList}
     GROUP BY a.id
     ORDER BY oldest_at ASC`).all();
}

/** 面板角标用 */
export function countPendingSubmissions(db) {
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM dola_submission_journal
    WHERE state IN ${pendingList}`).get()?.c || 0);
}

/**
 * 人工核对后**放行账号** —— 把 journal 推到 `released`。
 *
 * 为什么这样就够：上面两个守卫查询是**显式枚举**封锁状态的，
 * `released` 不在枚举里，所以推到它之后封锁自然解除，
 * 不需要（也不应该）去改守卫逻辑本身。
 *
 * 记录**保留**（state + evidence + updated_at 都在），审计链不断；
 * 是谁、什么时候、为什么放行的，记在 `audit_logs`（由路由层写入）。
 *
 * ⚠️ 这是显式运维决策，代表「已确认这次提交的结果不必再追究」。
 * 它不改变上游事实，也**不退积分** —— 退款走「确认失败」那条路。
 */
export function releaseSubmission(db, id, at = new Date().toISOString()) {
  return atomic(db, () => {
    const receipt = getSubmission(db, id);
    if (!receipt) throw Object.assign(new Error('没有这条提交记录'), { status: 404 });
    if (!PENDING_SUBMISSION_STATES.includes(receipt.state)) {
      throw Object.assign(new Error(`当前状态 ${receipt.state} 不需要放行`), { status: 409 });
    }
    db.prepare("UPDATE dola_submission_journal SET state='released',updated_at=? WHERE task_id=?").run(at, id);
    return receipt.state;
  });
}
