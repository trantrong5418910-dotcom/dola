/**
 * Isolated reference-image pool readiness (no browser, no live Dola).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-pool-'));
const dbPath = path.join(dir, 'fixture.db');
process.env.ADMIN_DB = dbPath;
process.env.ADMIN_INIT_PASSWORD = 'fixture-only-not-a-user-password';

const dbMod = await import('../server/db.js');
const database = await dbMod.initDb();
const { referenceImagePoolStats } = await import('../server/dola/generator.js');

test('referenceImagePoolStats stays closed on an empty pool', () => {
  // Clear seeded accounts if any.
  database.prepare('DELETE FROM dola_accounts').run();
  const stats = referenceImagePoolStats();
  assert.equal(stats.ready, false);
  assert.equal(stats.eligible, 0);
  assert.equal('exitIp' in stats, false);
});

test('referenceImagePoolStats opens only for available + proxy + exclusive verified exit', () => {
  database.prepare('DELETE FROM dola_accounts').run();
  const at = new Date().toISOString();
  database.prepare(`INSERT INTO dola_accounts
    (label, cookie, cookie_hash, status, proxy, exit_ip, reference_image_state, created_at, updated_at)
    VALUES ('fixture','fixture-cookie','fixture-hash','valid',?,?, 'available', ?, ?)`).run(
    'http://127.0.0.1:9', '198.51.100.20', at, at,
  );
  const open = referenceImagePoolStats();
  assert.equal(open.ready, true);
  assert.equal(open.eligible, 1);
  assert.equal(open.available, 1);
  assert.equal(JSON.stringify(open).includes('fixture-cookie'), false);
  assert.equal(JSON.stringify(open).includes('198.51.100.20'), false);

  database.prepare(`INSERT INTO dola_accounts
    (label, cookie, cookie_hash, status, proxy, exit_ip, reference_image_state, created_at, updated_at)
    VALUES ('fixture-2','fixture-cookie-2','fixture-hash-2','valid',?,?, 'available', ?, ?)`).run(
    'http://127.0.0.1:10', '198.51.100.20', at, at,
  );
  const shared = referenceImagePoolStats();
  assert.equal(shared.ready, false);
  assert.ok((shared.availableSharedExitIp ?? shared.sharedExitIpRows ?? 0) >= 1);

  database.prepare('DELETE FROM dola_accounts').run();
  fs.rmSync(dir, { recursive: true, force: true });
});
