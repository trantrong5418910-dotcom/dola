import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SUBMISSION_JOURNAL_SCHEMA, recordSubmissionDispatch, recordSubmissionConversation,
  getSubmission, holdUncertainSubmission, closeSubmission, accountHasUnsettledSubmission,
  findUnsettledPrompt, canRecoverSubmission } from '../server/dola/submission-journal.js';

function fixture(t) {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE dola_accounts(id,status,cookie_hash,proxy,sec_user_id,cooldown_until);
    CREATE TABLE dola_videos(id INTEGER PRIMARY KEY,account_id,status,conversation_id,stage,error,updated_at,owner_token_id,prompt,created_at);
    INSERT INTO dola_accounts VALUES(1,'valid','synthetic-cookie-hash','http://fixture:secret@example.invalid:1234','synthetic-id',NULL);
    INSERT INTO dola_videos VALUES(1,1,'submitting',NULL,'','',NULL,5,'synthetic  prompt','2020-01-01');`);
  db.exec(SUBMISSION_JOURNAL_SCHEMA);
  const account = db.prepare('SELECT * FROM dola_accounts').get();
  return { db, account, row: () => db.prepare('SELECT * FROM dola_videos WHERE id=1').get(),
    dispatch: () => recordSubmissionDispatch(db, { taskId: 1, account, deadlineAt: '2099-01-01T00:00:00.000Z' }) };
}

test('dispatch intent is insert-once and stores no proxy credentials, cookies or prompt', t => {
  const h = fixture(t); h.dispatch();
  assert.equal(getSubmission(h.db, 1).state, 'dispatching');
  assert.equal(accountHasUnsettledSubmission(h.db, 1), true);
  const saved = JSON.stringify(getSubmission(h.db, 1));
  for (const secret of ['fixture:secret', 'example.invalid', 'synthetic  prompt']) assert.equal(saved.includes(secret), false);
  assert.throws(h.dispatch, /UNIQUE/);
  assert.equal(getSubmission(h.db, 1).state, 'dispatching');
});

for (const condition of ['cancelled', 'identity', 'proxy', 'cookie', 'cooldown']) {
  test(`dispatch checks latest task/account atomically: ${condition}`, t => {
    const h = fixture(t);
    if (condition === 'cancelled') h.db.exec("UPDATE dola_videos SET status='cancelled'");
    else h.db.exec(`UPDATE dola_accounts SET ${({ identity: 'sec_user_id', proxy: 'proxy', cookie: 'cookie_hash', cooldown: 'cooldown_until' })[condition]}='2099-01-01'`);
    assert.throws(h.dispatch, /state_changed/);
    assert.equal(getSubmission(h.db, 1), undefined);
  });
}

test('only exact correlated ACK evidence with original identity permits automatic query recovery', t => {
  const h = fixture(t); h.dispatch();
  assert.equal(recordSubmissionConversation(h.db, 1, '1234567890123', 'conversation_url'), true);
  assert.equal(canRecoverSubmission(getSubmission(h.db, 1), h.row(), h.account), false);
  assert.equal(recordSubmissionConversation(h.db, 1, '1234567890123', 'sse_ack'), true);
  assert.equal(canRecoverSubmission(getSubmission(h.db, 1), h.row(), h.account), true);
  for (const change of [{ cookie_hash: 'new' }, { proxy: 'changed' }, { sec_user_id: 'other' }, { status: 'disabled' }]) {
    assert.equal(canRecoverSubmission(getSubmission(h.db, 1), h.row(), { ...h.account, ...change }), false);
  }
  assert.equal(canRecoverSubmission(getSubmission(h.db, 1), h.row(), { ...h.account, quota_remaining: 0, cooldown_until: '2099' }), true);
  assert.equal(canRecoverSubmission(getSubmission(h.db, 1), h.row(), h.account, '2099-01-02'), false);
  assert.throws(() => recordSubmissionConversation(h.db, 1, '9999999999999', 'sse_ack'), /conflict/);
  assert.equal(getSubmission(h.db, 1).conversation_id, '1234567890123');
});

test('uncertainty blocks same account and same-owner prompt even beyond cooldown or local cancellation', t => {
  const h = fixture(t); h.dispatch(); holdUncertainSubmission(h.db, 1);
  assert.equal(h.row().status, 'submitting');
  assert.equal(findUnsettledPrompt(h.db, 5, ' synthetic\nprompt ').id, 1);
  assert.equal(findUnsettledPrompt(h.db, 6, 'synthetic prompt'), null);
  h.db.exec("UPDATE dola_videos SET status='cancelled'");
  assert.equal(accountHasUnsettledSubmission(h.db, 1), true);
  assert.equal(holdUncertainSubmission(h.db, 1), false);
  h.db.exec('DELETE FROM dola_videos');
  assert.equal(accountHasUnsettledSubmission(h.db, 1), true, 'deleting a local row cannot settle a remote operation');
  closeSubmission(h.db, 1, 'rejected');
  assert.equal(accountHasUnsettledSubmission(h.db, 1), false);
});

test('historical terminal tasks are never reopened, rewritten or fabricated as acknowledged', t => {
  const h = fixture(t);
  for (const status of ['failed', 'ready', 'cancelled']) {
    h.db.prepare('UPDATE dola_videos SET status=?').run(status);
    const before = h.row();
    assert.equal(holdUncertainSubmission(h.db, 1), false);
    assert.equal(recordSubmissionConversation(h.db, 1, '1234567890123', 'sse_ack'), false);
    assert.deepEqual(h.row(), before);
  }
  assert.equal(getSubmission(h.db, 1), undefined);
});

test('journal proof survives SQLite backup/reopen without any account credential material', async t => {
  const h = fixture(t); h.dispatch(); recordSubmissionConversation(h.db, 1, '1234567890123', 'sse_ack');
  const dir = await mkdtemp(path.join(tmpdir(), 'submission-journal-test-'));
  let reopened;
  try {
    const file = path.join(dir, 'fixture.db');
    await h.db.backup(file);
    reopened = new Database(file);
    reopened.exec(SUBMISSION_JOURNAL_SCHEMA); // Idempotent schema on restart.
    const receipt = getSubmission(reopened, 1);
    assert.equal(receipt.evidence, 'sse_ack');
    assert.equal(receipt.conversation_id, '1234567890123');
    assert.equal(canRecoverSubmission(receipt, h.row(), h.account), true);
    assert.throws(() => recordSubmissionDispatch(reopened, { taskId: 1, account: h.account,
      deadlineAt: '2099-01-01T00:00:00.000Z' }), /UNIQUE/);
  } finally {
    reopened?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
