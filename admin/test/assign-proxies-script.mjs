/** Exercise assign-proxies.mjs against a local fake admin API only. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import express from 'express';

function runScript(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: join(fileURLToPath(new URL('..', import.meta.url))),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('assign-proxies script batches and resumes only pending IDs without saving the password', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dola-proxy-script-'));
  const checkpoint = join(dir, 'proxy-progress.json');
  const batches = [];
  let attempt = 0;

  const app = express();
  app.use(express.json());
  app.post('/api/auth/login', (_req, res) => res.json({ ok: true, token: 'fixture-token' }));
  app.post('/api/dola/accounts/proxy/assign', (req, res) => {
    const ids = req.body.ids.map(Number);
    batches.push(ids);
    attempt++;
    const results = ids.map((id) => {
      // Leave ID 2 pending on the first run; the second process invocation succeeds.
      if (attempt <= 3 && id === 2) return { id, ok: false, message: 'synthetic failure' };
      return { id, ok: true, sid: `D${String(id).padStart(7, '0')}`, exitIp: `203.0.113.${id}` };
    });
    const failed = results.filter((x) => !x.ok).length;
    res.json({ ok: true, assigned: results.length - failed, skipped: 0, failed, total: ids.length, verified: true, results });
  });
  app.get('/api/dola/accounts/proxy/summary', (_req, res) => res.json({ ok: true, total: 7, withProxy: 6, distinctProxies: 6, hint: 'fixture' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const script = join(fileURLToPath(new URL('../scripts/assign-proxies.mjs', import.meta.url)));
  const args = [
    '--account', 'B_FIXTURE', '--password', 'synthetic-secret', '--country', 'JP',
    '--ids', '1,2,3,4,5', '--batch-size', '2', '--gap', '0', '--resume-file', checkpoint,
  ];

  try {
    const first = await runScript(script, args, { BASE: base, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'admin123' });
    assert.equal(first.code, 1);
    assert.deepEqual(batches, [[1, 2], [3, 4], [5]]);
    const savedAfterFailure = JSON.parse(await readFile(checkpoint, 'utf8'));
    assert.deepEqual(savedAfterFailure.pendingIds, [2]);
    assert.equal(savedAfterFailure.status, 'pending');
    assert.doesNotMatch(await readFile(checkpoint, 'utf8'), /synthetic-secret|password/i);

    const second = await runScript(script, args, { BASE: base, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'admin123' });
    assert.equal(second.code, 0);
    assert.deepEqual(batches, [[1, 2], [3, 4], [5], [2]]);
    const savedDone = JSON.parse(await readFile(checkpoint, 'utf8'));
    assert.deepEqual(savedDone.pendingIds, []);
    assert.equal(savedDone.status, 'done');
    assert.deepEqual(savedDone.completedIds.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
