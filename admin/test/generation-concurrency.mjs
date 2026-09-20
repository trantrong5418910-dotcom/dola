/** Isolated settings contract for the controlled generation concurrency and queue switches. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';

test('generation concurrency setting is present and bounded to 1..20', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dola-generation-concurrency-'));
  process.env.ADMIN_DB = join(dir, 'fixture.db');
  process.env.ADMIN_INIT_PASSWORD = 'fixture-only-password';
  process.env.ADMIN_JWT_SECRET = randomBytes(32).toString('hex');

  const database = await import('../server/db.js');
  const db = await database.initDb();
  const auth = await import('../server/auth.js');
  const { default: routes } = await import('../server/routes/settings.js');
  const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  const token = auth.signJwt({ uid: adminId });

  const app = express();
  app.use(express.json());
  app.use(auth.authMiddleware);
  app.use('/api/settings', routes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  try {
    const listed = await fetch(`${base}/api/settings`, { headers });
    assert.equal(listed.status, 200);
    const items = (await listed.json()).items;
    const item = items.find((row) => row.key === 'dola_gen_concurrency');
    assert.equal(item.value, '1');
    const queueItem = items.find((row) => row.key === 'dola_gen_queue_limit');
    assert.equal(queueItem.value, '6000');

    const accepted = await fetch(`${base}/api/settings`, {
      method: 'PUT', headers, body: JSON.stringify({ dola_gen_concurrency: '2' }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='dola_gen_concurrency'").get().value, '2');

    const queueAccepted = await fetch(`${base}/api/settings`, {
      method: 'PUT', headers, body: JSON.stringify({ dola_gen_queue_limit: '6000' }),
    });
    assert.equal(queueAccepted.status, 200);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='dola_gen_queue_limit'").get().value, '6000');

    for (const value of ['0', '21', '2.5', 'not-a-number']) {
      const rejected = await fetch(`${base}/api/settings`, {
        method: 'PUT', headers, body: JSON.stringify({ dola_gen_concurrency: value }),
      });
      assert.equal(rejected.status, 400);
    }
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='dola_gen_concurrency'").get().value, '2');

    for (const value of ['0', '6001', '2.5', 'not-a-number']) {
      const rejected = await fetch(`${base}/api/settings`, {
        method: 'PUT', headers, body: JSON.stringify({ dola_gen_queue_limit: value }),
      });
      assert.equal(rejected.status, 400);
    }
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='dola_gen_queue_limit'").get().value, '6000');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.raw.close();
    await rm(dir, { recursive: true, force: true });
  }
});
