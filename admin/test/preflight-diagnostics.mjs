import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createPreflightDiagnostics } from '../server/dola/preflight-diagnostics.js';

const EVENTS = ['requestfailed', 'response', 'pageerror'];

test('snapshot has only the fixed public fields and defaults', () => {
  const recorder = createPreflightDiagnostics({ clock: () => 100 });
  assert.deepEqual(Object.keys(recorder), ['mark', 'attach', 'snapshot', 'dispose']);
  assert.deepEqual(recorder.snapshot(), {
    version: 1,
    phase: 'launch',
    elapsedMs: 0,
    phaseElapsedMs: 0,
    seconds: null,
    reason: '',
    network: { failedRequests: 0, httpErrors: 0 },
    page: { errors: 0, lastErrorKind: '' },
  });
});

test('only the eight allowed phases change the phase and its timer', () => {
  let time = 100;
  const recorder = createPreflightDiagnostics({ clock: () => time });
  for (const phase of ['launch', 'context', 'navigate', 'bootstrap', 'entry', 'model', 'duration', 'verified']) {
    time += 10;
    recorder.mark(phase);
    assert.equal(recorder.snapshot().phase, phase);
    assert.equal(recorder.snapshot().phaseElapsedMs, 0);
  }
  for (const invalid of [undefined, null, '', 'LAUNCH', 'submit', '__proto__', 1, {}, Symbol('phase')]) {
    time += 1;
    recorder.mark(invalid);
    assert.equal(recorder.snapshot().phase, 'verified');
  }
  assert.equal(recorder.snapshot().phaseElapsedMs, 9);
});

test('seconds only accepts the four numeric durations without coercion', () => {
  for (const seconds of [10, 15, 20, 30]) {
    assert.equal(createPreflightDiagnostics({ seconds }).snapshot().seconds, seconds);
  }
  for (const seconds of [undefined, null, 0, 5, 40, 10.1, '10', '30', NaN, Infinity, {}, 10n, Symbol('seconds')]) {
    assert.equal(createPreflightDiagnostics({ seconds }).snapshot().seconds, null);
  }
});

test('reason allows only uppercase ASCII codes of at most 80 characters', () => {
  const recorder = createPreflightDiagnostics();
  for (const reason of ['', 'BOOTSTRAP_FAILED', 'HTTP_503', 'A'.repeat(80)]) {
    assert.equal(recorder.snapshot(reason).reason, reason);
  }
  for (const reason of [undefined, null, 1, {}, Symbol('reason'), 'A'.repeat(81),
    'lowercase', 'UPPER CASE', 'HTTP-503', 'ERROR\n', 'ERROR\r', 'ERROR\u2028', '错误', 'Ａ']) {
    assert.equal(recorder.snapshot(reason).reason, '');
  }
});

test('counts failures and HTTP errors, mapping only safe error names', () => {
  const page = new EventEmitter();
  const recorder = createPreflightDiagnostics();
  recorder.attach(page);
  page.emit('requestfailed');
  for (const status of [200, 302, 399, 400, 404, 500, 599, 600, 999, -1, NaN, Infinity, 401.5, '500']) {
    page.emit('response', { status: () => status });
  }
  let count = 0;
  for (const [error, kind] of [
    [new TypeError('synthetic'), 'type_error'],
    [{ name: 'ReferenceError' }, 'reference_error'],
    [new Error('synthetic'), 'other'],
    [{ name: 'type_error' }, 'other'],
    [undefined, 'other'],
  ]) {
    page.emit('pageerror', error);
    assert.deepEqual(recorder.snapshot().page, { errors: ++count, lastErrorKind: kind });
  }
  assert.deepEqual(recorder.snapshot().network, { failedRequests: 1, httpErrors: 4 });
  recorder.dispose();
});

test('event secrets and original errors are neither accessed nor serialized', () => {
  // This is fabricated test data, never a real credential or browser payload.
  const sentinel = 'synthetic-private-value=not-a-real-secret';
  const accessed = [];
  const forbid = field => () => { accessed.push(field); throw new Error(sentinel); };
  const request = new Proxy({}, { get: forbid('request') });
  const response = new Proxy({ status: () => 503 }, {
    get(target, property) {
      if (property === 'status') return target.status;
      return forbid('response metadata')();
    },
  });
  const error = new Proxy({ name: 'TypeError' }, {
    get(target, property) {
      if (property === 'name') return target.name;
      return forbid('error text')();
    },
  });
  const page = new EventEmitter();
  const recorder = createPreflightDiagnostics({ seconds: sentinel, clock: () => 0 });
  recorder.attach(page);
  page.emit('requestfailed', request);
  page.emit('response', response);
  page.emit('pageerror', error);
  recorder.mark(sentinel);
  const snapshot = recorder.snapshot(sentinel);
  assert.deepEqual(accessed, []);
  assert.equal(JSON.stringify(snapshot).includes(sentinel), false);
  assert.deepEqual(snapshot, {
    version: 1, phase: 'launch', elapsedMs: 0, phaseElapsedMs: 0, seconds: null, reason: '',
    network: { failedRequests: 1, httpErrors: 1 },
    page: { errors: 1, lastErrorKind: 'type_error' },
  });
  recorder.dispose();
});

test('all three event counters saturate at 9999', () => {
  const page = new EventEmitter();
  const recorder = createPreflightDiagnostics();
  recorder.attach(page);
  for (let i = 0; i < 10005; i += 1) {
    page.emit('requestfailed');
    page.emit('response', { status: () => 500 });
    page.emit('pageerror', { name: 'TypeError' });
  }
  page.emit('pageerror', { name: 'ReferenceError' });
  assert.deepEqual(recorder.snapshot().network, { failedRequests: 9999, httpErrors: 9999 });
  assert.deepEqual(recorder.snapshot().page, { errors: 9999, lastErrorKind: 'reference_error' });
  recorder.dispose();
});

test('elapsed times follow phases, ignore clock rollback and clamp long durations', () => {
  let time = 1000;
  const recorder = createPreflightDiagnostics({ clock: () => time });
  time = 1200;
  recorder.mark('navigate');
  time = 1450.9;
  assert.equal(recorder.snapshot().elapsedMs, 450);
  assert.equal(recorder.snapshot().phaseElapsedMs, 250);
  time = 500;
  assert.equal(recorder.snapshot().elapsedMs, 450);
  assert.equal(recorder.snapshot().phaseElapsedMs, 250);
  time = Number.MAX_VALUE;
  assert.equal(recorder.snapshot().elapsedMs, 600000);
  assert.equal(recorder.snapshot().phaseElapsedMs, 600000);
});

test('invalid values, throwing and missing clocks remain finite and bounded', () => {
  let value = -100;
  let fail = false;
  const recorder = createPreflightDiagnostics({ clock: () => {
    if (fail) throw new Error('synthetic clock failure');
    return value;
  } });
  value = -50;
  assert.equal(recorder.snapshot().elapsedMs, 50);
  for (value of [NaN, Infinity, -Infinity, undefined, null, '100', {}, 10n, Symbol('time')]) {
    assert.equal(recorder.snapshot().elapsedMs, 50);
  }
  fail = true;
  recorder.mark('entry');
  assert.equal(recorder.snapshot().elapsedMs, 50);
  assert.equal(recorder.snapshot().phaseElapsedMs, 0);
  for (const clock of [null, false, {}, () => NaN, () => { throw new Error('synthetic'); }]) {
    const badClockRecorder = createPreflightDiagnostics({ clock });
    badClockRecorder.mark('duration');
    assert.equal(badClockRecorder.snapshot().elapsedMs, 0);
    assert.equal(badClockRecorder.snapshot().phaseElapsedMs, 0);
    badClockRecorder.dispose();
  }
  let extreme = -Number.MAX_VALUE;
  const overflow = createPreflightDiagnostics({ clock: () => extreme });
  extreme = Number.MAX_VALUE;
  assert.equal(overflow.snapshot().elapsedMs, 600000);
});

test('snapshot objects are detached from internal state', () => {
  const recorder = createPreflightDiagnostics({ clock: () => 0 });
  const first = recorder.snapshot();
  first.phase = 'invalid';
  first.network.failedRequests = 9999;
  first.page.errors = 9999;
  first.page.lastErrorKind = 'unsafe';
  const second = recorder.snapshot();
  assert.equal(second.phase, 'launch');
  assert.deepEqual(second.network, { failedRequests: 0, httpErrors: 0 });
  assert.deepEqual(second.page, { errors: 0, lastErrorKind: '' });
});

test('duplicate attach is harmless, dispose removes only owned listeners and freezes records', () => {
  let time = 0;
  let clockReads = 0;
  const recorder = createPreflightDiagnostics({ clock: () => { clockReads += 1; return time; } });
  const pages = [new EventEmitter(), new EventEmitter()];
  const foreignListener = () => {};
  pages[0].on('response', foreignListener);
  for (const page of pages) {
    recorder.attach(page);
    recorder.attach(page);
    assert.equal(page.listenerCount('requestfailed'), 1);
    assert.equal(page.listenerCount('pageerror'), 1);
    page.emit('requestfailed');
  }
  const queued = EVENTS.map(event => pages[1].listeners(event)[0]);
  assert.equal(recorder.snapshot().network.failedRequests, 2);
  time = 40;
  recorder.dispose();
  const frozen = recorder.snapshot();
  const readsAtDisposal = clockReads;
  time = 1000;
  recorder.dispose();
  recorder.mark('verified');
  const extra = new EventEmitter();
  recorder.attach(extra);
  queued[0]();
  queued[1]({ status: () => { assert.fail('disposed callback must not read status'); } });
  queued[2]({ get name() { assert.fail('disposed callback must not read error'); } });
  for (const page of [...pages, extra]) {
    page.emit('requestfailed');
    page.emit('response', { status: () => 500 });
    page.emit('pageerror', new TypeError('synthetic'));
    assert.equal(page.listenerCount('requestfailed'), 0);
    assert.equal(page.listenerCount('pageerror'), 0);
  }
  assert.deepEqual(pages[0].listeners('response'), [foreignListener]);
  assert.equal(pages[1].listenerCount('response'), 0);
  assert.equal(extra.listenerCount('response'), 0);
  assert.deepEqual(recorder.snapshot(), frozen);
  assert.equal(clockReads, readsAtDisposal);
});

test('missing calls, page methods and event payloads are tolerated', () => {
  const recorder = createPreflightDiagnostics();
  recorder.mark();
  recorder.attach();
  for (const page of [null, {}, false, 1, { on: 1 }, { on() { assert.fail('must have removal API'); } },
    { get on() { throw new Error('synthetic'); } }]) {
    assert.doesNotThrow(() => recorder.attach(page));
  }
  const page = new EventEmitter();
  recorder.attach(page);
  for (const response of [undefined, null, {}, { status: 503 },
    { get status() { throw new Error('synthetic'); } },
    { status() { throw new Error('synthetic'); } }]) {
    assert.doesNotThrow(() => page.emit('response', response));
  }
  page.emit('pageerror', { get name() { throw new Error('synthetic'); } });
  assert.deepEqual(recorder.snapshot().network, { failedRequests: 0, httpErrors: 0 });
  assert.deepEqual(recorder.snapshot().page, { errors: 1, lastErrorKind: 'other' });
  assert.doesNotThrow(() => recorder.dispose());
});

test('removeListener is supported when off is absent or throws', () => {
  for (const off of [undefined, () => { throw new Error('synthetic'); }]) {
    const page = new EventEmitter();
    page.off = off;
    const recorder = createPreflightDiagnostics();
    recorder.attach(page);
    page.emit('requestfailed');
    assert.equal(recorder.snapshot().network.failedRequests, 1);
    recorder.dispose();
    for (const event of EVENTS) assert.equal(page.listenerCount(event), 0);
  }
});

test('partially failed registration cleans up and disposal tolerates broken removal', () => {
  const page = new EventEmitter();
  page.on = function (event, handler) {
    EventEmitter.prototype.on.call(this, event, handler);
    if (event === 'response') throw new Error('synthetic registration failure');
    return this;
  };
  const recorder = createPreflightDiagnostics();
  assert.doesNotThrow(() => recorder.attach(page));
  for (const event of EVENTS) assert.equal(page.listenerCount(event), 0);
  recorder.dispose();

  const brokenPage = new EventEmitter();
  brokenPage.off = brokenPage.removeListener = () => { throw new Error('synthetic removal failure'); };
  const brokenRecorder = createPreflightDiagnostics({ clock: () => 0 });
  brokenRecorder.attach(brokenPage);
  assert.doesNotThrow(() => brokenRecorder.dispose());
  const frozen = brokenRecorder.snapshot();
  brokenPage.emit('requestfailed');
  brokenPage.emit('response', { status: () => 500 });
  brokenPage.emit('pageerror', new Error('synthetic'));
  assert.deepEqual(brokenRecorder.snapshot(), frozen);
  assert.doesNotThrow(() => brokenRecorder.dispose());
});
