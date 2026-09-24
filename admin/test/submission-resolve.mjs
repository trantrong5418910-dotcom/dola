/**
 * 「未结算提交」的人工出口 —— 回归测试。
 *
 * 覆盖的是本次审计补上的缺口：dispatching / uncertain / acknowledged 会永久锁住
 * 账号和提示词，而 closeSubmission 只接受 rejected/completed，导致 uncertain
 * 原本**无法离开**（管理端也没有任何路由能碰这张表）。
 *
 * 这里锁死三件事：
 *   1. releaseSubmission 能把 uncertain 推到 released，并且**真的解除封锁**
 *   2. 它只肯动「未结算」的记录，不会去改写终态历史
 *   3. 核对台返回的数据不含 cookie / 代理凭据 / 提示词
 *
 * SQLite 只用 :memory:，不碰应用库、不启服务、不发网络请求。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SUBMISSION_JOURNAL_SCHEMA, PENDING_SUBMISSION_STATES,
  recordSubmissionDispatch, recordSubmissionConversation, getSubmission,
  holdUncertainSubmission, closeSubmission, accountHasUnsettledSubmission, findUnsettledPrompt,
  releaseSubmission, listPendingSubmissions, listBlockedAccounts, countPendingSubmissions,
} from '../server/dola/submission-journal.js';

function fixture(t) {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE dola_accounts(id,label,status,cookie_hash,proxy,sec_user_id,cooldown_until);
    CREATE TABLE dola_videos(id INTEGER PRIMARY KEY,account_id,status,conversation_id,stage,error,
      updated_at,owner_token_id,prompt,created_at);
    CREATE TABLE tokens(id INTEGER PRIMARY KEY,name,prefix);
    INSERT INTO dola_accounts VALUES(1,'synthetic@example.invalid','valid','synthetic-cookie-hash',
      'http://fixture:secret@example.invalid:1234','synthetic-id',NULL);
    INSERT INTO tokens VALUES(5,'synthetic-token','dv_ab');
    INSERT INTO dola_videos VALUES(1,1,'submitting',NULL,'','',NULL,5,'synthetic  prompt','2020-01-01');`);
  db.exec(SUBMISSION_JOURNAL_SCHEMA);
  const account = db.prepare('SELECT * FROM dola_accounts').get();
  return {
    db, account,
    row: () => db.prepare('SELECT * FROM dola_videos WHERE id=1').get(),
    dispatch: () => recordSubmissionDispatch(db, { taskId: 1, account,
      deadlineAt: '2099-01-01T00:00:00.000Z' }),
  };
}

/** 把记录推到 uncertain —— 也就是线上最容易出现的卡死形态 */
function stuck(t) {
  const h = fixture(t);
  h.dispatch();
  holdUncertainSubmission(h.db, 1);
  assert.equal(getSubmission(h.db, 1).state, 'uncertain');
  assert.equal(accountHasUnsettledSubmission(h.db, 1), true, '前置条件：此时账号应被锁住');
  return h;
}

test('released 状态确实解除了账号与提示词的封锁', t => {
  const h = stuck(t);
  assert.equal(findUnsettledPrompt(h.db, 5, 'synthetic prompt').id, 1, '前置条件：提示词应被锁住');

  assert.equal(releaseSubmission(h.db, 1), 'uncertain');

  assert.equal(getSubmission(h.db, 1).state, 'released');
  assert.equal(accountHasUnsettledSubmission(h.db, 1), false, '放行后账号必须能再次被选中');
  assert.equal(findUnsettledPrompt(h.db, 5, 'synthetic prompt'), null, '放行后同一提示词必须能再次提交');
});

test('放行后记录仍保留（审计链不能断）', t => {
  const h = fixture(t);
  h.dispatch();
  recordSubmissionConversation(h.db, 1, '1234567890123', 'sse_ack');
  holdUncertainSubmission(h.db, 1);
  releaseSubmission(h.db, 1);

  const receipt = getSubmission(h.db, 1);
  assert.equal(receipt.state, 'released');
  assert.equal(receipt.evidence, 'sse_ack', '证据字段不能被放行动作抹掉');
  assert.equal(receipt.conversation_id, '1234567890123');
  assert.equal(receipt.account_id, 1);
  assert.ok(receipt.updated_at, '放行时间要留在 updated_at 上');
});

test('releaseSubmission 只肯动「未结算」记录，拒绝改写终态历史', t => {
  const h = fixture(t);
  h.dispatch();

  // dispatching 属于未结算 → 可以放行
  assert.equal(releaseSubmission(h.db, 1), 'dispatching');

  // 放行过（released）就不再是未结算 → 再放一次应被拒
  assert.throws(() => releaseSubmission(h.db, 1), (e) => e.status === 409);

  // 终态同样拒
  const g = fixture(t); g.dispatch(); closeSubmission(g.db, 1, 'rejected');
  assert.throws(() => releaseSubmission(g.db, 1), (e) => e.status === 409);
  const c = fixture(t); c.dispatch(); closeSubmission(c.db, 1, 'completed');
  assert.throws(() => releaseSubmission(c.db, 1), (e) => e.status === 409);

  // 不存在的记录
  assert.throws(() => releaseSubmission(h.db, 999), (e) => e.status === 404);
});

test('核对台只列未结算记录，且不泄漏 cookie / 代理凭据 / 提示词', t => {
  const h = fixture(t); h.dispatch(); holdUncertainSubmission(h.db, 1);
  // 再造一条已放行的，用来验证「不列已处理」
  const h2 = fixture(t); h2.dispatch(); releaseSubmission(h2.db, 1);

  assert.equal(countPendingSubmissions(h.db), 1);
  assert.equal(countPendingSubmissions(h2.db), 0);

  const items = listPendingSubmissions(h.db);
  assert.equal(items.length, 1);
  assert.equal(items[0].task_id, 1);
  assert.equal(items[0].state, 'uncertain');
  assert.equal(items[0].account_label, 'synthetic@example.invalid');
  assert.equal(items[0].token_name, 'synthetic-token');

  const flat = JSON.stringify(items);
  for (const secret of ['fixture:secret', 'example.invalid:1234', 'synthetic-cookie-hash', 'synthetic  prompt']) {
    assert.equal(flat.includes(secret), false, `核对台不得泄漏：${secret}`);
  }
});

test('被卡住的账号清单能回答「哪些号不能用、卡了多久」', t => {
  const h = fixture(t); h.dispatch(); holdUncertainSubmission(h.db, 1);
  const blocked = listBlockedAccounts(h.db);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].id, 1);
  assert.equal(blocked[0].label, 'synthetic@example.invalid');
  assert.equal(blocked[0].pending_count, 1);
  assert.ok(blocked[0].oldest_at && blocked[0].newest_at);

  releaseSubmission(h.db, 1);
  assert.equal(listBlockedAccounts(h.db).length, 0, '放行后不应再出现在卡号清单里');
});

test('未结算状态集合与守卫查询是同一份定义（防漂移）', t => {
  const h = fixture(t);
  h.dispatch();
  const pending = getSubmission(h.db, 1);
  assert.ok(PENDING_SUBMISSION_STATES.includes(pending.state));
  // 集合里每一个成员都必须真的锁住账号
  for (const state of PENDING_SUBMISSION_STATES) {
    h.db.prepare('UPDATE dola_submission_journal SET state=? WHERE task_id=1').run(state);
    assert.equal(accountHasUnsettledSubmission(h.db, 1), true, `${state} 必须锁定账号`);
  }
});
