/** Execute the actual provider function with browser/timer doubles; no network/credentials. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createPreflightDiagnostics } from '../server/dola/preflight-diagnostics.js';
const source = readFileSync(new URL('../server/dola/provider.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('export async function probeNativeVideoViaBrowser('),
  source.indexOf('export async function probeNativeThirtySecondViaBrowser(')).replace('export ', '');
function fixture({ expireAt = '', error = null, errorPhase = 'model', prepareGate = null } = {}) {
  const calls = { routes: [], handlers: new Map(), order: [], closed: 0, cleared: 0, prepared: 0, timerEvents: [] }, timers = [];
  const activeTimers = new Map();
  let now = 1000;
  const page = Object.assign(new EventEmitter(), {
    goto: async () => { calls.order.push('navigate'); now += 10; }, waitForLoadState: async () => {},
  });
  const ctx = { route: async (pattern, handler) => { calls.routes.push(pattern); calls.handlers.set(pattern, handler); }, addCookies: async () => {}, newPage: async () => page, close: async () => {} };
  const browser = { newContext: async options => { calls.contextOptions = options; return ctx; }, close: async () => { calls.closed++; } };
  function expire() {
    const timer = timers[0];
    assert.ok(activeTimers.has(timer.id), 'deadline must still be active when it fires');
    activeTimers.delete(timer.id);
    timer.fired = true;
    now = 1000 + timer.delay;
    calls.timerEvents.push('fire');
    timer.fn();
  }
  const box = {
    createPreflightDiagnostics: options => createPreflightDiagnostics({ ...options, clock: () => now }),
    Date: { now: () => now },
    DOLA_BASE: 'https://example.invalid', DOLA_HEADERS: { 'user-agent': 'synthetic' },
    observeVideoComposerBootstrap: observed => { assert.equal(observed, page); calls.order.push('observe'); },
    nativeCapabilityState: e => e.code === 'NATIVE_CAPABILITY_UNAVAILABLE' ? 'unavailable' : 'unknown',
    loadPlaywright: async () => ({ chromium: { executablePath: () => '/synthetic/chromium', launch: async () => {
      assert.equal(activeTimers.size, 1, 'deadline is armed before browser launch');
      now += 10;
      if (expireAt === 'launch') expire();
      return browser;
    } } }),
    prepareNativeVideoComposer: async (_page, options) => {
      calls.prepared++;
      assert.equal(activeTimers.size, 1, 'deadline remains armed during composer preparation');
      if (prepareGate) await prepareGate;
      for (const phase of ['bootstrap', 'entry', 'model', 'duration', 'verified']) {
        options.onPhase(phase);
        now += 5;
        if ((error || expireAt === 'prepare') && phase === errorPhase) break;
      }
      if (expireAt === 'prepare') expire();
      if (error) throw error;
      return { model: options.model, seconds: options.seconds };
    },
    setTimeout: (fn, delay) => {
      const timer = { id: timers.length + 1, fn, delay, fired: false, cleared: false };
      timers.push(timer); activeTimers.set(timer.id, timer); calls.timerEvents.push('schedule');
      return timer.id;
    },
    clearTimeout: id => {
      const timer = timers.find(timer => timer.id === id);
      assert.ok(timer, 'clear the actual deadline handle');
      assert.equal(timer.cleared, false, 'clear the deadline exactly once');
      timer.cleared = true; activeTimers.delete(id); calls.cleared++; calls.timerEvents.push('clear');
    },
  };
  vm.createContext(box); vm.runInContext(code, box);
  return { calls, timers, activeTimers, page, run: () => box.probeNativeVideoViaBrowser({ synthetic: 'only' }, {
    seconds: 10, proxy: { server: 'http://example.invalid' }, proxyUrl: 'http://example.invalid', timeout: 1000,
  }) };
}

function assertFinished(h, { fired = false } = {}) {
  assert.equal(h.timers.length, 1, 'only one whole-probe deadline');
  assert.equal(h.timers[0].delay, 1000);
  assert.equal(h.timers[0].fired, fired);
  assert.equal(h.timers[0].cleared, true);
  assert.equal(h.calls.cleared, 1);
  assert.equal(h.activeTimers.size, 0, 'no deadline survives the probe');
  assert.deepEqual(h.calls.timerEvents, fired ? ['schedule', 'fire', 'clear'] : ['schedule', 'clear']);
  for (const event of ['requestfailed', 'response', 'pageerror']) {
    assert.equal(h.page.listenerCount(event), 0, 'diagnostics listeners are disposed');
  }
}

function assertDiagnostic(result, { phase, reason, elapsedMs, phaseElapsedMs }) {
  assert.deepEqual(result.diagnostic, {
    version: 1, phase, seconds: 10, elapsedMs, phaseElapsedMs, reason,
    network: { failedRequests: 0, httpErrors: 0 }, page: { errors: 0, lastErrorKind: '' },
  });
}

test('read-only provider blocks generation requests and cleans up browser/timer', async () => {
  const h = fixture(), result = await h.run();
  assert.equal(result.ok, true); assert.equal(result.seconds, 10);
  assert.ok(h.calls.routes.includes('**/chat/completion**')); assert.equal(h.calls.closed, 1); assert.equal(h.calls.cleared, 1);
  assert.equal(h.calls.contextOptions.serviceWorkers, 'block', 'read-only routes must not be hidden behind a service worker');
  assert.deepEqual(h.calls.order, ['observe', 'navigate'], 'never miss a fast bootstrap response');
  assertDiagnostic(result, { phase: 'verified', reason: '', elapsedMs: 45, phaseElapsedMs: 5 });
  assertFinished(h);
});
test('read-only probe also blocks POST on chat page paths while allowing navigation', async () => {
  const h = fixture(); await h.run();
  const handle = h.calls.handlers.get('**/chat/**');
  assert.equal(typeof handle, 'function');
  for (const method of ['POST', 'GET']) {
    const actions = [];
    await handle({ request: () => ({ method: () => method }), abort: () => actions.push('abort'), continue: () => actions.push('continue') });
    assert.deepEqual(actions, [method === 'POST' ? 'abort' : 'continue']);
  }
  assertFinished(h);
});
for (const expireAt of ['launch', 'prepare']) {
  test(`whole-probe deadline cannot be accepted as available: ${expireAt}`, async () => {
    const h = fixture({ expireAt }), result = await h.run();
    assert.equal(result.ok, false); assert.equal(result.state, 'unknown'); assert.ok(h.calls.closed >= 1); assert.equal(h.calls.cleared, 1);
    assert.equal(result.reason, 'VIDEO_PREPARATION_TIMEOUT');
    assertDiagnostic(result, {
      phase: expireAt === 'launch' ? 'launch' : 'model', reason: 'VIDEO_PREPARATION_TIMEOUT',
      elapsedMs: 1000, phaseElapsedMs: expireAt === 'launch' ? 1000 : 970,
    });
    assert.equal(h.calls.prepared, expireAt === 'launch' ? 0 : 1);
    assertFinished(h, { fired: true });
  });
}
test('known model diagnostics are retained, unexpected exceptions stay sanitized', async () => {
  const safe = Object.assign(new Error('模型能力探测未完成'), { code: 'NATIVE_CAPABILITY_UNKNOWN', reason: 'MODEL_OPTION_NOT_CONFIRMED' });
  const known = fixture({ error: safe }), result = await known.run();
  assert.equal(result.reason, safe.reason); assert.equal(result.error, safe.message);
  assertDiagnostic(result, { phase: 'model', reason: safe.reason, elapsedMs: 35, phaseElapsedMs: 5 });
  assertFinished(known);
  const unknown = fixture({ error: new Error('SYNTHETIC_SECRET') }), unexpected = await unknown.run();
  assert.ok(!JSON.stringify(unexpected).includes('SYNTHETIC_SECRET'));
  assert.equal(unexpected.reason, null);
  assertDiagnostic(unexpected, { phase: 'model', reason: 'VIDEO_PROBE_ERROR', elapsedMs: 35, phaseElapsedMs: 5 });
  assertFinished(unknown);
});

test('duration rejection retains its phase and reason while releasing the deadline', async () => {
  const error = Object.assign(new Error('原生时长不可用'), {
    code: 'NATIVE_CAPABILITY_UNAVAILABLE', reason: 'DURATION_OPTION_NOT_CONFIRMED',
  });
  const h = fixture({ error, errorPhase: 'duration' }), result = await h.run();
  assert.equal(result.ok, false);
  assert.equal(result.state, 'unavailable');
  assert.equal(result.reason, error.reason);
  assertDiagnostic(result, { phase: 'duration', reason: error.reason, elapsedMs: 40, phaseElapsedMs: 5 });
  assertFinished(h);
});

test('deadline stays active while composer preparation is pending and is cleared on completion', async () => {
  let release;
  const prepareGate = new Promise(resolve => { release = resolve; });
  const h = fixture({ prepareGate }), work = h.run();
  try {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
    assert.equal(h.calls.prepared, 1);
    assert.equal(h.activeTimers.size, 1);
    assert.equal(h.calls.cleared, 0);
    assert.equal(h.calls.closed, 0);
    assert.deepEqual(h.calls.timerEvents, ['schedule']);
  } finally {
    release();
    await work;
  }
  assert.equal((await work).ok, true);
  assertFinished(h);
});
