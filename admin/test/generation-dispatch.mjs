// Execute the real gateway handler with synthetic dependencies. No browser/network/disk upload.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { sanitizePreflightDiagnostic } from '../server/dola/preflight-diagnostics.js';

const source = readFileSync(new URL('../server/routes/gateway.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export default router;?/m, '').replace(/\bexport /g, '');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture({ chargeError = false, startResult = true, withImages = true, createError = null } = {}) {
  const handlers = new Map(), events = [], audits = [], createdTasks = [], upload = deferred();
  const router = { use() {}, get() {}, post: (url, fn) => handlers.set(url, fn) };
  const box = {
    express: { Router: () => router }, Date, console,
    sanitizePreflightDiagnostic,
    findUnsettledPrompt: () => null,
    getSetting: (key, fallback) => key === 'gateway_prompt_cooldown_seconds' ? '0' : fallback,
    db: { prepare: sql => {
      assert.match(sql, /SELECT \* FROM tokens WHERE value/);
      return { get: () => ({ id: 1, status: 'active', points: 10 }) };
    } },
    validateReferenceImages: async () => withImages ? [{ filename: 'synthetic.png' }] : [],
    referenceImagePoolStats: () => ({ ready: true }),
    createVideoTask: async options => {
      assert.equal(options.deferStart, true); events.push('create-deferred');
      if (createError) throw createError;
      const task = { id: 1, status: 'queued', owner_token_id: 1 };
      createdTasks.push(task);
      return task;
    },
    saveReferenceImages: async () => { events.push('upload-start'); await upload.promise; events.push('upload-done'); },
    chargeVideoTask: () => {
      events.push('charge'); if (chargeError) throw Object.assign(new Error('synthetic insufficient funds'), { status: 402 });
      return { balance: 9, chargeRef: 'gen-1' };
    },
    startVideoTask: () => { events.push('start'); return startResult; },
    cancelVideoTask: () => events.push('cancel'),
    cleanupReferenceImages: async () => events.push('cleanup'),
    settleFailedVideoRefund: () => events.push('refund-check'),
    audit: (...args) => audits.push(args),
  };
  vm.createContext(box); vm.runInContext(source, box);
  const response = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(data) { this.data = data; return this; } };
  return { events, audits, createdTasks, upload, response, run: () => handlers.get('/gen')({ body: { token: 'synthetic', prompt: 'synthetic' }, headers: {}, query: {} }, response) };
}

test('slow reference upload completes before charging and starting the worker', async () => {
  const h = fixture(); const work = h.run(); await flush();
  assert.deepEqual(h.events, ['create-deferred', 'upload-start']);
  h.upload.resolve(); await work;
  assert.deepEqual(h.events, ['create-deferred', 'upload-start', 'upload-done', 'charge', 'start']);
  assert.equal(h.response.statusCode, 202);
});
test('upload failure cancels without charge/start', async () => {
  const h = fixture(); const work = h.run(); await flush(); h.upload.reject(new Error('synthetic write failure')); await work;
  assert.equal(h.response.statusCode, 500); assert.deepEqual(h.events, ['create-deferred', 'upload-start', 'cancel', 'cleanup']);
});
test('billing failure cancels without start', async () => {
  const h = fixture({ chargeError: true }); h.upload.resolve(); await h.run();
  assert.equal(h.response.statusCode, 402); assert.equal(h.events.includes('start'), false); assert.ok(h.events.includes('cancel'));
});
test('cancelled-before-dispatch task settles internal refund without a second submission', async () => {
  const h = fixture({ startResult: false }); h.upload.resolve(); await h.run();
  assert.equal(h.response.statusCode, 409); assert.equal(h.events.filter(v => v === 'start').length, 1);
  assert.deepEqual(h.events.slice(-3), ['cancel', 'refund-check', 'cleanup']);
});
test('text-only task also starts after confirmed charge', async () => {
  const h = fixture({ withImages: false }); await h.run();
  assert.deepEqual(h.events, ['create-deferred', 'charge', 'start']); assert.equal(h.response.statusCode, 202);
});

// Normalize objects created inside the gateway VM without importing the app or DB.
const plain = value => JSON.parse(JSON.stringify(value));

function assertPreflightRejected(h, error, diagnostic) {
  assert.equal(h.response.statusCode, error.status || 409);
  assert.deepEqual(h.events, ['create-deferred'], 'no upload, charge, worker start or task cleanup');
  assert.deepEqual(h.createdTasks, [], 'failed admission must not create a task');
  assert.equal(h.audits.length, 1, 'emit exactly one rejection audit');
  const [request, action, resource, id, details] = h.audits[0];
  assert.equal(request.body.prompt, 'synthetic');
  assert.equal(action, 'gateway.gen.preflight_rejected');
  assert.equal(resource, 'generation_attempt');
  assert.equal(id, '');
  assert.deepEqual(plain(details), {
    code: error.code, seconds: 10, mode: 'standard', diagnostic,
    taskCreated: false, charged: false,
  });
  assert.deepEqual(plain(h.response.data), {
    ok: false, message: error.message, code: error.code, diagnostic,
  });
}

for (const [code, status] of [['GENERATION_PREFLIGHT_FAILED', undefined], ['GENERATION_PREFLIGHT_TIMEOUT', 504]]) {
  test(`${code} is audited once, sanitized and rejected before any task or billing side effects`, async () => {
    const secret = 'synthetic-extra-value=not-a-real-secret';
    const diagnostic = {
      version: 1, phase: 'model', seconds: 10, elapsedMs: 1800, phaseElapsedMs: 250,
      reason: 'MODEL_OPTION_NOT_CONFIRMED',
      network: { failedRequests: 3, httpErrors: 2, url: secret, headers: { authorization: secret }, body: secret },
      page: { errors: 1, lastErrorKind: 'type_error', message: secret, stack: secret },
      url: secret, cookie: secret, apiKey: secret, request: { body: secret },
    };
    const error = Object.assign(new Error('只读预检未通过，任务未提交'), { code, status, diagnostic, extra: secret });
    const h = fixture({ createError: error });
    await h.run();
    const expected = {
      version: 1, phase: 'model', seconds: 10, elapsedMs: 1800, phaseElapsedMs: 250,
      reason: 'MODEL_OPTION_NOT_CONFIRMED',
      network: { failedRequests: 3, httpErrors: 2 }, page: { errors: 1, lastErrorKind: 'type_error' },
    };
    assertPreflightRejected(h, error, expected);
    assert.notEqual(h.response.data.diagnostic, diagnostic, 'rebuild diagnostic from the whitelist');
    assert.equal(JSON.stringify(h.audits).includes(secret), false);
    assert.equal(JSON.stringify(h.response.data).includes(secret), false);
  });
}

test('preflight diagnostic values are bounded and unsafe allowed-field contents are removed', async () => {
  const secret = 'synthetic-field-value=not-a-real-secret';
  const error = Object.assign(new Error('只读预检未通过'), {
    code: 'GENERATION_PREFLIGHT_FAILED',
    diagnostic: {
      version: 1, phase: 'duration', seconds: secret, elapsedMs: 900000, phaseElapsedMs: -5,
      reason: secret, network: { failedRequests: 20000, httpErrors: NaN },
      page: { errors: 2.9, lastErrorKind: secret },
    },
  });
  const h = fixture({ createError: error, withImages: false });
  await h.run();
  assertPreflightRejected(h, error, {
    version: 1, phase: 'duration', seconds: null, elapsedMs: 600000, phaseElapsedMs: 0,
    reason: '', network: { failedRequests: 9999, httpErrors: 0 }, page: { errors: 2, lastErrorKind: '' },
  });
  assert.equal(JSON.stringify(h.audits).includes(secret), false);
  assert.equal(JSON.stringify(h.response.data).includes(secret), false);
});

test('preflight failure without a diagnostic still returns a rejection and one audit', async () => {
  const error = Object.assign(new Error('只读预检未完成'), { code: 'GENERATION_PREFLIGHT_FAILED' });
  const h = fixture({ createError: error });
  await h.run();
  assertPreflightRejected(h, error, null);
});
