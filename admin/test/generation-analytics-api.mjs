import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import express from 'express';

test('guard endpoint does not label carrier-only evidence available after refusing to unlock', async () => {
  const source = readFileSync(new URL('../server/routes/dola.js', import.meta.url), 'utf8');
  const start = source.indexOf("router.post('/accounts/:id/generation-guard-probe'");
  assert.ok(start >= 0);
  const end = source.indexOf('\n});', start);
  assert.ok(end > start);
  let handler;
  const account = { id: 1, status: 'valid', proxy: 'http://example.invalid' };
  const guard = { account_id: 1, scope: 'duration:20' };
  const result = { ok: true, state: 'available', seconds: 20, uiSeconds: 10,
    model: 'seedance_v2.5', native: false, rewriteCarrier: true };
  const guardProbes = new Set();
  const box = {
    router: { post: (_path, _auth, fn) => { handler = fn; } }, requirePerm: () => () => {},
    db: { prepare: sql => ({ get: () => sql.includes('FROM dola_accounts') ? account
      : sql.includes('FROM dola_generation_guards') ? guard : undefined }) },
    guardProbes, now: () => '2026-09-20T21:00:00.000Z',
    proxyOf: () => ({ server: account.proxy }), proxyUrlOf: () => account.proxy,
    accountCookies: () => ({}),
    probeNativeVideoViaBrowser: async (_cookies, options) => { assert.equal(options.seconds, 20); return result; },
    clearGenerationGuard: (_db, g, a, observed) => {
      assert.equal(g, guard); assert.equal(a, account); assert.equal(observed, result); return false;
    }, audit() {},
  };
  vm.createContext(box); vm.runInContext(source.slice(start, end + 4), box);
  const response = { status(n) { this.statusCode = n; return this; }, json(data) { this.data = data; return this; } };
  await handler({ params: { id: '1' }, body: { scope: 'duration:20' } }, response);
  assert.equal(response.data.cleared, false);
  assert.equal(response.data.state, 'unknown');
  assert.match(response.data.message, /较短时长.*不能证明目标时长.*保留失败保护/);
  assert.equal(guardProbes.size, 0);
});

test('admin analytics is permission-checked/read-only, rejects bad ranges; guard probe fails closed without proxy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dola-analytics-api-'));
  process.env.ADMIN_DB = join(dir, 'fixture.db');
  process.env.ADMIN_INIT_PASSWORD = 'fixture-only-password';
  process.env.ADMIN_JWT_SECRET = randomBytes(32).toString('hex');
  const database = await import('../server/db.js');
  const db = await database.initDb();
  const auth = await import('../server/auth.js');
  const { default: routes } = await import('../server/routes/dola.js');
  const user = db.prepare("SELECT id,role_id FROM users WHERE username='admin'").get();
  const token = auth.signJwt({ uid: user.id });
  const app = express(); app.use(express.json()); app.use(auth.authMiddleware); app.use('/api/dola', routes);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/dola`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  try {
    const at = new Date().toISOString();
    const id = Number(db.prepare(`INSERT INTO dola_accounts(label,cookie,cookie_hash,cookie_names,status,proxy,created_at,updated_at)
      VALUES('fixture','SYNTHETIC_COOKIE','synthetic','ttwid','valid','',?,?)`).run(at, at).lastInsertRowid);
    db.prepare(`INSERT INTO dola_videos(account_id,seconds,status,error,created_at,updated_at,finished_at)
      VALUES(?,15,'failed','未确认原生 15 秒 SYNTHETIC_SECRET',?,?,?)`).run(id, at, at, at);
    const before = JSON.stringify(db.prepare('SELECT * FROM dola_accounts').all());
    assert.equal((await fetch(`${base}/generation-analytics`)).status, 401);
    const response = await fetch(`${base}/generation-analytics?hours=24&timezone=Asia%2FShanghai`, { headers });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.totals.failed, 1); assert.equal(result.reasons[0].code, 'capability');
    assert.equal(JSON.stringify(result).includes('SYNTHETIC'), false);
    assert.equal(result.guards.length, 0); // GET does not backfill or mutate.
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM dola_accounts').all()), before);
    assert.equal((await fetch(`${base}/generation-analytics?hours=100000`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/generation-analytics?timezone=invalid`, { headers })).status, 400);
    db.prepare('UPDATE roles SET permissions=? WHERE id=?').run('[]', user.role_id);
    assert.equal((await fetch(`${base}/generation-analytics`, { headers })).status, 403);
    db.prepare('UPDATE roles SET permissions=? WHERE id=?').run('["dola:list"]', user.role_id);
    const probe = () => fetch(`${base}/accounts/${id}/generation-guard-probe`, { method: 'POST', headers, body: '{"scope":"duration:15"}' });
    assert.equal((await probe()).status, 403);
    db.prepare('UPDATE roles SET permissions=? WHERE id=?').run('["*"]', user.role_id);
    db.prepare(`INSERT INTO dola_generation_guards(account_id,scope,reason_code,source_task_id,blocked_at)
      VALUES(?,'duration:15','capability',1,?)`).run(id, at);
    assert.equal((await probe()).status, 409);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM dola_videos').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM point_transactions').get().n, 0);
    assert.equal(db.prepare('SELECT cleared_at FROM dola_generation_guards').get().cleared_at, null);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    db.raw.close(); await rm(dir, { recursive: true, force: true });
  }
});
