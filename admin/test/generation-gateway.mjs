/** Isolated regression checks: no production DB, credentials, browser or Dola calls. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import Database from 'better-sqlite3';
import { chargeVideoTask, settleFailedVideoRefund } from '../server/dola/generation-billing.js';
import { parseVideoRange, streamVideoFile } from '../server/dola/video-file.js';

function billingDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE tokens (id INTEGER PRIMARY KEY, prefix TEXT, points INTEGER, status TEXT, expires_at TEXT, updated_at TEXT);
    CREATE TABLE dola_videos (id INTEGER PRIMARY KEY, owner_token_id INTEGER, status TEXT, charge_ref TEXT, conversation_id TEXT);
    CREATE TABLE point_transactions (id INTEGER PRIMARY KEY, token_id INTEGER, token_prefix TEXT, delta INTEGER, kind TEXT, reason TEXT, ref TEXT, created_at TEXT, UNIQUE(kind,ref));
    INSERT INTO tokens VALUES(1,'fixture',10,'active',NULL,NULL);
    INSERT INTO dola_videos VALUES(1,1,'queued','',NULL);`);
  return db;
}

test('charge and failed refund are atomic and idempotent, without a polling client', () => {
  const db = billingDb();
  try {
    assert.equal(chargeVideoTask(db, { taskId: 1, tokenId: 1, points: 3 }).balance, 7);
    assert.equal(chargeVideoTask(db, { taskId: 1, tokenId: 1, points: 3 }).duplicated, true);
    assert.equal(db.prepare('SELECT charge_ref FROM dola_videos').get().charge_ref, 'gen-1');
    assert.equal(settleFailedVideoRefund(db, { id: 1, status: 'failed' }).refunded, false);
    db.exec("UPDATE dola_videos SET status='failed'");
    assert.equal(settleFailedVideoRefund(db, { id: 1 }).balance, 10);
    assert.equal(settleFailedVideoRefund(db, { id: 1 }).duplicated, true);
    assert.equal(db.prepare('SELECT count(*) AS n FROM point_transactions').get().n, 2);
  } finally { db.close(); }
});

test('a failed ledger insert rolls back the balance and task reference', () => {
  const db = billingDb();
  try {
    db.exec("CREATE TRIGGER refuse_consume BEFORE INSERT ON point_transactions BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.throws(() => chargeVideoTask(db, { taskId: 1, tokenId: 1, points: 3 }));
    assert.equal(db.prepare('SELECT points FROM tokens').get().points, 10);
    assert.equal(db.prepare('SELECT charge_ref FROM dola_videos').get().charge_ref, '');
  } finally { db.close(); }
});

test('a failed refund ledger insert rolls back the credited balance', () => {
  const db = billingDb();
  try {
    chargeVideoTask(db, { taskId: 1, tokenId: 1, points: 3 });
    db.exec("UPDATE dola_videos SET status='failed'; CREATE TRIGGER refuse_refund BEFORE INSERT ON point_transactions WHEN NEW.kind='refund' BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.throws(() => settleFailedVideoRefund(db, { id: 1 }));
    assert.equal(db.prepare('SELECT points FROM tokens').get().points, 7);
  } finally { db.close(); }
});

test('no overdraft, cross-owner charge, expired token or arbitrary live-task refund', () => {
  const db = billingDb();
  try {
    assert.throws(() => chargeVideoTask(db, { taskId: 1, tokenId: 1, points: 11 }), { status: 402 });
    assert.throws(() => chargeVideoTask(db, { taskId: 1, tokenId: 2, points: 1 }), { status: 409 });
    db.exec("UPDATE tokens SET expires_at='2020-01-01T00:00:00Z'");
    assert.throws(() => chargeVideoTask(db, { taskId: 1, tokenId: 1, points: 1 }), { status: 403 });
    assert.equal(db.prepare('SELECT points FROM tokens').get().points, 10);
  } finally { db.close(); }
});

test('only pre-submit cancellation refunds; cancellation after submission cannot refund', () => {
  const db = billingDb();
  try {
    chargeVideoTask(db, { taskId: 1, tokenId: 1, points: 3 });
    db.exec("UPDATE dola_videos SET status='cancelled'");
    assert.equal(settleFailedVideoRefund(db, { id: 1, status: 'generating' }, { cancelledBeforeSubmit: true }).refunded, false);
    assert.equal(settleFailedVideoRefund(db, { id: 1, status: 'queued' }, { cancelledBeforeSubmit: true }).balance, 10);
  } finally { db.close(); }
});

test('byte ranges include suffix requests and reject malformed or out of bounds ranges', () => {
  assert.deepEqual(parseVideoRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseVideoRange('bytes=3-', 10), { start: 3, end: 9 });
  assert.deepEqual(parseVideoRange('bytes=0-999', 10), { start: 0, end: 9 });
  for (const range of ['bytes=-0', 'bytes=-', 'bytes=10-', 'bytes=4-3', 'bytes=0-1,3-4', 'bad', 'bytes=999999999999999999999-']) assert.equal(parseVideoRange(range, 10), false);
});

test('real HTTP attachment, range, HEAD and missing archive paths', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dola-video-file-test-'));
  const file = path.join(dir, 'fixture.mp4');
  await writeFile(file, Buffer.from('0123456789'));
  const app = express();
  app.get('/video', (req, res) => streamVideoFile(req, res, { file, filename: 'test.mp4' }));
  app.get('/missing', (req, res) => streamVideoFile(req, res, { file: path.join(dir, 'missing.mp4'), filename: 'missing.mp4' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const full = await fetch(`${base}/video?download=1`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-disposition'), 'attachment; filename="test.mp4"');
    assert.equal(await full.text(), '0123456789');
    const range = await fetch(`${base}/video?download=1`, { headers: { Range: 'bytes=-3' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), 'bytes 7-9/10');
    assert.equal(range.headers.get('content-disposition'), 'attachment; filename="test.mp4"');
    assert.equal(await range.text(), '789');
    assert.equal((await fetch(`${base}/video`, { headers: { Range: 'bytes=10-' } })).status, 416);
    const head = await fetch(`${base}/video?download=1`, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), '10');
    assert.equal(await head.text(), '');
    assert.equal((await fetch(`${base}/missing`)).status, 410);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true }); }
});

test('actual gateway router enforces owner and readiness, with an isolated database', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dola-gateway-isolated-'));
  process.env.ADMIN_DB = path.join(dir, 'fixture.db');
  process.env.ADMIN_INIT_PASSWORD = 'fixture-only-not-a-user-password';
  const { initDb } = await import('../server/db.js');
  const db = await initDb();
  // Remove only this freshly seeded temporary database's sample tokens.
  db.prepare('DELETE FROM tokens').run();
  db.prepare("UPDATE settings SET value='fixture-key' WHERE key='gateway_key'").run();
  const at = new Date().toISOString();
  for (const id of [1, 2]) db.prepare("INSERT INTO tokens(id,value,prefix,points,status,created_at,updated_at) VALUES(?,?,?,10,'active',?,?)").run(id, `fixture-token-${id}`, 'fixture', at, at);
  const file = path.join(dir, 'fixture.mp4');
  await writeFile(file, Buffer.from('0123456789'));
  db.prepare("INSERT INTO dola_videos(id,owner_token_id,seconds,status,local_path,local_bytes,duration_sec,created_at,updated_at) VALUES(1,1,30,'ready',?,10,30,?,?)").run(file, at, at);
  const { default: routes } = await import('../server/routes/gateway.js');
  const app = express(); app.use(express.json()); app.use('/api/gateway', routes);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/gateway`;
  const headers = { 'X-Gateway-Key': 'fixture-key' };
  try {
    assert.equal((await fetch(`${base}/gen/1`, { headers })).status, 401);
    assert.equal((await fetch(`${base}/gen/1?token=fixture-token-2`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/gen/1/file?token=fixture-token-2`, { headers })).status, 404);
    const closedHealth = await (await fetch(`${base}/health`, { headers })).json();
    assert.equal(closedHealth.fixedSeconds, 30);
    assert.deepEqual(closedHealth.supportedSeconds, [10, 15, 20, 30]);
    assert.deepEqual(closedHealth.expertSeconds, [15]);
    assert.equal(closedHealth.expertSecondsReady, false);
    assert.equal(closedHealth.fixedSecondsReady, false);
    assert.equal(closedHealth.native15.ready, false);
    assert.equal(closedHealth.native30.ready, false);

    const accountAt = new Date().toISOString();
    db.prepare(`INSERT INTO dola_accounts
      (label,cookie,cookie_hash,status,proxy,exit_ip,native_15s_state,native_30s_state,created_at,updated_at)
      VALUES ('fixture-account','fixture-cookie','fixture-cookie-hash','valid',?,?,?,?,?,?)`)
      .run('http://127.0.0.1:1', '198.51.100.10', 'available', 'available', accountAt, accountAt);
    const openHealth = await (await fetch(`${base}/health`, { headers })).json();
    assert.equal(openHealth.expertSecondsReady, true);
    assert.equal(openHealth.native15.ready, true);
    assert.equal(openHealth.native15.eligible, 1);
    assert.equal(openHealth.fixedSecondsReady, true);
    assert.equal(openHealth.native30.ready, true);
    assert.equal(openHealth.native30.eligible, 1);
    assert.equal('exitIp' in openHealth.native30, false);
    assert.equal(JSON.stringify(openHealth).includes('fixture-cookie'), false);
    // Restore an empty generation pool before the later create rejection path;
    // this test must never launch a browser or touch a real upstream account.
    db.prepare("UPDATE dola_accounts SET status='disabled' WHERE cookie_hash='fixture-cookie-hash'").run();
    const download = await fetch(`${base}/gen/1/file?token=fixture-token-1&download=1`, { headers });
    assert.equal(download.status, 200); assert.equal(await download.text(), '0123456789');
    const items = (await (await fetch(`${base}/gen?token=fixture-token-1`, { headers })).json()).items;
    assert.equal(items[0].archived, true); assert.equal('local_path' in items[0], false); assert.equal('account_label' in items[0], false);
    db.prepare("UPDATE dola_videos SET status='resolving' WHERE id=1").run();
    assert.equal((await fetch(`${base}/gen/1/file?token=fixture-token-1`, { headers })).status, 409);
    const blocked = await fetch(`${base}/gen`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'fixture-token-1', prompt: 'fixture only', seconds: 30, forceSeconds: 30 }) });
    assert.equal(blocked.status, 409); // Empty isolated pool: cannot reach Dola.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM point_transactions').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dola_videos').get().n, 1);

    // Queue admission is checked before account probing and before billing. The
    // gateway exposes only safe capacity counters so the user can retry later.
    db.prepare("UPDATE dola_videos SET status='ready' WHERE id=1").run();
    db.prepare("UPDATE settings SET value='1' WHERE key='dola_gen_queue_limit'").run();
    db.prepare("INSERT INTO dola_videos(id,owner_token_id,seconds,status,created_at,updated_at) VALUES(99,1,10,'queued',?,?)").run(at, at);
    const full = await fetch(`${base}/gen`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'fixture-token-1', prompt: 'queue capacity fixture', seconds: 10 }) });
    const fullBody = await full.json();
    assert.equal(full.status, 429);
    assert.equal(fullBody.code, 'GENERATION_QUEUE_FULL');
    assert.deepEqual(fullBody.generation, { activeTasks: 1, queueLimit: 1, queueAvailable: 0 });
    assert.equal(db.prepare('SELECT points FROM tokens WHERE id=1').get().points, 10);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM point_transactions').get().n, 0);
    db.prepare("UPDATE dola_videos SET status='cancelled' WHERE id=99").run();

    // Listing historical failures is read-only: no surprise migration of old balances.
    db.prepare("INSERT INTO dola_videos(id,owner_token_id,status,created_at,updated_at) VALUES(2,1,'queued',?,?)").run(at, at);
    chargeVideoTask(db, { taskId: 2, tokenId: 1, points: 1 });
    db.prepare("UPDATE dola_videos SET status='failed' WHERE id=2").run();
    await (await fetch(`${base}/gen?token=fixture-token-1`, { headers })).json();
    assert.equal(db.prepare('SELECT points FROM tokens WHERE id=1').get().points, 9);
    assert.equal(db.prepare("SELECT count(*) AS n FROM point_transactions WHERE kind='refund'").get().n, 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.raw.close(); await rm(dir, { recursive: true }); }
});
