/** Isolated proxy assignment safety checks; no IPWeb request is made. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';

test('retrying an explicit proxy batch skips an account that already has a proxy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dola-proxy-assign-'));
  process.env.ADMIN_DB = join(dir, 'fixture.db');
  process.env.ADMIN_INIT_PASSWORD = 'fixture-only-password';
  process.env.ADMIN_JWT_SECRET = randomBytes(32).toString('hex');
  process.env.DOLA_BASE = 'http://127.0.0.1:9';

  const database = await import('../server/db.js');
  const db = await database.initDb();
  const auth = await import('../server/auth.js');
  const { default: routes } = await import('../server/routes/dola.js');

  const at = new Date().toISOString();
  const cookie = 'ttwid=synthetic; odin_tt=synthetic-session';
  const cookieHash = createHash('sha256').update(cookie).digest('hex').slice(0, 32);
  const originalProxy = 'socks5://B_FIXTURE_JP_30_D0000001:fixture@gate2.ipweb.cc:7778';
  const account = db.prepare(`INSERT INTO dola_accounts
    (label,cookie,cookie_hash,cookie_names,status,proxy,exit_ip,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('synthetic-proxy-retry', cookie, cookieHash, 'ttwid,odin_tt', 'valid', originalProxy, '198.51.100.10', at, at);
  const accountId = Number(account.lastInsertRowid);
  const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  const token = auth.signJwt({ uid: adminId });

  const app = express();
  app.use(express.json());
  app.use(auth.authMiddleware);
  app.use('/api/dola', routes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(`${base}/api/dola/accounts/proxy/assign`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        account: 'B_FIXTURE', password: 'fixture', country: 'JP', ids: [accountId],
        force: false, verify: true,
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.assigned, 0);
    assert.equal(body.skipped, 1);
    assert.equal(body.failed, 0);
    assert.deepEqual(body.results[0], {
      id: accountId,
      ok: true,
      skipped: true,
      message: '已有代理，跳过（未使用 --force）',
    });

    const row = db.prepare('SELECT proxy,exit_ip FROM dola_accounts WHERE id=?').get(accountId);
    assert.equal(row.proxy, originalProxy);
    assert.equal(row.exit_ip, '198.51.100.10');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.raw.close();
    await rm(dir, { recursive: true, force: true });
  }
});
