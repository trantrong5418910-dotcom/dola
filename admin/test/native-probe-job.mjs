/** Isolated batch native-capability job checks; no browser, Dola or real account is used. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { isVerifiedNativeCapability } from '../server/dola/generation-policy.js';

async function waitFor(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`等待${label}超时`);
}

test('batch native probe job is read-only, serial and skips accounts without a bound proxy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dola-native-probe-job-'));
  process.env.ADMIN_DB = join(dir, 'fixture.db');
  process.env.ADMIN_INIT_PASSWORD = 'fixture-only-password';
  process.env.ADMIN_JWT_SECRET = randomBytes(32).toString('hex');
  process.env.DOLA_BASE = 'http://127.0.0.1:9';

  const database = await import('../server/db.js');
  const db = await database.initDb();
  const jobs = await import('../server/jobs.js');
  const auth = await import('../server/auth.js');
  await import('../server/routes/dola.js');

  const at = new Date().toISOString();
  const cookie = 'ttwid=synthetic; odin_tt=synthetic-session';
  const cookieHash = createHash('sha256').update(cookie).digest('hex').slice(0, 32);
  const account = db.prepare(`INSERT INTO dola_accounts
    (label,cookie,cookie_hash,cookie_names,status,proxy,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run('synthetic-native-probe', cookie, cookieHash, 'ttwid,odin_tt', 'valid', '', at, at);
  const accountId = Number(account.lastInsertRowid);

  const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  const token = auth.signJwt({ uid: adminId });
  const app = express();
  app.use(express.json());
  app.use(auth.authMiddleware);
  const { default: routes } = await import('../server/routes/dola.js');
  app.use('/api/dola', routes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(`${base}/api/dola/jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'dola_native_15s', ids: [accountId] }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.job.type, 'dola_native_15s');
    assert.equal(body.job.concurrency, 1);

    const finished = await waitFor(() => {
      const job = jobs.getJob(body.job.id);
      return job && !['queued', 'running'].includes(job.status) ? job : null;
    }, '批量能力探测任务');
    assert.equal(finished.status, 'done');
    assert.equal(finished.done, 1);
    assert.equal(finished.result.details[0].ok, false);
    assert.match(finished.result.details[0].message, /代理/);

    const row = db.prepare('SELECT native_15s_state,native_15s_note FROM dola_accounts WHERE id=?').get(accountId);
    assert.equal(row.native_15s_state, 'unknown');
    assert.match(row.native_15s_note, /代理/);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM dola_videos').get().c, 0);

    const referenceResponse = await fetch(`${base}/api/dola/jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'dola_reference_images', ids: [accountId] }),
    });
    assert.equal(referenceResponse.status, 201);
    const referenceBody = await referenceResponse.json();
    assert.equal(referenceBody.job.type, 'dola_reference_images');
    assert.equal(referenceBody.job.concurrency, 1);
    const referenceFinished = await waitFor(() => {
      const job = jobs.getJob(referenceBody.job.id);
      return job && !['queued', 'running'].includes(job.status) ? job : null;
    }, '批量参考图能力探测任务');
    assert.equal(referenceFinished.status, 'done');
    const referenceRow = db.prepare('SELECT reference_image_state,reference_image_note FROM dola_accounts WHERE id=?').get(accountId);
    assert.equal(referenceRow.reference_image_state, 'unknown');
    assert.match(referenceRow.reference_image_note, /代理/);

    const all = await fetch(`${base}/api/dola/jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'dola_native_15s', all: true }),
    });
    assert.equal(all.status, 400);
    assert.match((await all.json()).message, /没有要处理/);

    const allReference = await fetch(`${base}/api/dola/jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'dola_reference_images', all: true }),
    });
    assert.equal(allReference.status, 400);
    assert.match((await allReference.json()).message, /没有要处理/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.raw.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('native probe contract must not persist a wrong UI carrier as available', () => {
  // Keep this regression close to the batch job contract: 20s uses the 10s
  // carrier, 30s uses the 15s carrier. A mismatched carrier is unknown,
  // not capability evidence.
  const good20 = { ok: true, state: 'available', seconds: 20, uiSeconds: 10,
    native: false, rewriteCarrier: true, model: 'seedance_v2.5' };
  assert.equal(isVerifiedNativeCapability(good20, 20), true);
  assert.equal(isVerifiedNativeCapability({ ...good20, uiSeconds: 15 }, 20), false);
  const good30 = { ok: true, state: 'available', seconds: 30, uiSeconds: 15,
    native: false, rewriteCarrier: true, model: 'seedance_v2.5' };
  assert.equal(isVerifiedNativeCapability(good30, 30), true);
  assert.equal(isVerifiedNativeCapability({ ...good30, uiSeconds: 10 }, 30), false);
  assert.equal(isVerifiedNativeCapability({ ...good20, seconds: 10, uiSeconds: 10,
    native: true, rewriteCarrier: false }, 10), true);
});
