/**
 * Offline contracts for the real parser + registry + manager + account store.
 * Run: node --test test/account-login-integration.mjs
 * Only :memory: SQLite and injected fake drivers are used. The optional router
 * checks evaluate its actual factory with injected auth/audit dependencies; they
 * do not import appDB, auth initialization or the production browser driver.
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { setImmediate as immediate } from 'node:timers/promises';
import vm from 'node:vm';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import Database from 'better-sqlite3';
import express from 'express';

const OWNER = 101;
const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const EMAIL = 'synthetic-main@example.test';
const SECOND = 'synthetic-second@example.test';
const THIRD = 'synthetic-third@example.test';
const RECOVERY = 'synthetic-recovery@example.test';
const PASSWORD = 'synthetic-private-password|with|pipes';
const GOOGLE = 'https://gapi.mailsapi.com/google/login?uid=synthetic-private-uid';
const VERIFY = 'https://codes.example.test/api?token=synthetic-private-token';
const PROXY = 'http://synthetic-proxy:synthetic-proxy-password@proxy.example.test:8080';
const SECRET_FIELDS = ['password', 'recoveryEmail', 'googleSessionUrl', 'verificationUrl'];
const LOGIN_SECRETS = [PASSWORD, RECOVERY, GOOGLE, VERIFY, 'synthetic-private-uid', 'synthetic-private-token'];
const PUBLIC_SECRETS = [...LOGIN_SECRETS, PROXY, 'synthetic-proxy-password', 'synthetic-cookie', 'synthetic-google-sub'];
const formats = [
  ['legacy', email => `${email}|${PASSWORD}`, 'password'],
  ['three fields', email => `${email}----${PASSWORD}----${RECOVERY}`, 'password'],
  ['Google link', email => `${email}----${PASSWORD}----no----${GOOGLE}`, 'google_link'],
  ['verification URL', email => `${email}----${PASSWORD}----${RECOVERY}----${VERIFY}`, 'password'],
];
const mixed = [formats[2][1](EMAIL), formats[3][1](SECOND), formats[1][1](THIRD)].join('\n');
let GoogleLoginManager, createGoogleAccountStore, createLoginProfileRegistry, LOGIN_REGISTRY_SCHEMA, parse;
let importGuard;
const blocked = [];
const deny = label => () => { blocked.push(label); throw new Error(`Offline fixture blocked ${label}`); };

before(async () => {
  // Fail before any future transitive import can initialize application storage.
  importGuard = registerHooks({ load(url, context, nextLoad) {
    if (/\/server\/(?:db|auth|audit)\.js$/.test(url) || /\/google-login-browser\.js$/.test(url)) {
      return deny('application database or browser module')();
    }
    return nextLoad(url, context);
  } });
  mock.method(globalThis, 'fetch', deny('fetch'));
  for (const [object, methods] of [
    [http, ['request', 'get']], [https, ['request', 'get']],
    [net, ['connect', 'createConnection']], [net.Socket.prototype, ['connect']],
    [net.Server.prototype, ['listen']], [tls, ['connect']],
    [dns, ['lookup', 'resolve', 'resolve4', 'resolve6']],
    [dns.promises, ['lookup', 'resolve', 'resolve4', 'resolve6']],
    [childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
  ]) for (const method of methods) mock.method(object, method, deny(method));
  syncBuiltinESMExports();
  ({ GoogleLoginManager } = await import('../server/dola/google-login-core.js'));
  ({ createGoogleAccountStore } = await import('../server/dola/google-login-store.js'));
  ({ createLoginProfileRegistry, LOGIN_REGISTRY_SCHEMA } = await import('../server/dola/account-login-registry.js'));
  ({ parseAccountLoginEntries: parse } = await import('../server/dola/account-login-format.js'));
});

after(() => {
  try { assert.deepEqual(blocked, [], 'No database initialization, real driver, process or network attempt is allowed'); }
  finally { importGuard?.deregister(); mock.restoreAll(); syncBuiltinESMExports(); }
});

const FIXTURE_SCHEMA = `
  CREATE TABLE dola_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT, cookie TEXT, cookie_hash TEXT, cookie_names TEXT,
    proxy TEXT, exit_ip TEXT, status TEXT, account_hint TEXT, sec_user_id TEXT, membership TEXT,
    last_check_at TEXT, last_error TEXT DEFAULT '', imported_by INTEGER, created_at TEXT, updated_at TEXT,
    native_15s_state TEXT DEFAULT 'unknown', native_15s_at TEXT, native_15s_note TEXT DEFAULT '',
    native_30s_state TEXT DEFAULT 'unknown', native_30s_at TEXT, native_30s_note TEXT DEFAULT '',
    reference_image_state TEXT DEFAULT 'unknown', reference_image_at TEXT, reference_image_note TEXT DEFAULT ''
  );
  CREATE TABLE dola_videos (id INTEGER PRIMARY KEY, account_id INTEGER, status TEXT);
  CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, user_id INTEGER, username TEXT, action TEXT,
    target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT);
`;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, label) {
  for (let n = 0; n < 500; n++) {
    if (predicate()) return;
    await immediate();
  }
  assert.fail(`Fixture did not reach ${label}`);
}

function ready(email = EMAIL, { manual = false, ...overrides } = {}) {
  return { kind: 'ready', manual, sessionVerified: true,
    identity: manual ? null : { email, sub: 'synthetic-google-sub', email_verified: true },
    cookies: { ttwid: 'synthetic-cookie-ttwid', odin_tt: 'synthetic-cookie-odin' },
    profile: { ok: true, entityId: `synthetic-entity-${email}`, nickname: 'Synthetic account' },
    ...overrides };
}

function fixture(t, { onOpen, next = { kind: 'waiting_user' } } = {}) {
  const db = new Database(':memory:');
  db.exec(FIXTURE_SCHEMA);
  db.exec(LOGIN_REGISTRY_SCHEMA);
  assert.equal(db.prepare('PRAGMA database_list').get().file, '');
  const registry = createLoginProfileRegistry(db);
  const store = createGoogleAccountStore(db, { registry });
  const f = { db, registry, store, now: NOW, opens: [], sessions: [], writes: [], gates: [] };
  f.gate = () => { const gate = deferred(); f.gates.push(gate); return gate; };
  f.manager = new GoogleLoginManager({
    ...store, reserveProfiles: entries => registry.reserve(entries), resolveProxy: () => PROXY,
    clock: () => f.now, timeoutMs: 60_000, manualTimeoutMs: 120_000, pollMs: 60_000,
    storeAccount(input) { f.writes.push(input); return store.storeAccount(input); },
    driver: { async open(secret, snapshot, { signal }) {
      const session = { next, closeCalls: 0, inspectCalls: 0,
        async inspect() { this.inspectCalls++; return typeof this.next === 'function' ? this.next() : this.next; },
        async close() { this.closeCalls++; },
        async preview() { return Buffer.from('synthetic screenshot'); },
      };
      f.opens.push({ secret, snapshot, signal });
      f.sessions.push(session);
      if (onOpen) await onOpen({ secret, snapshot, signal, session, f });
      return session;
    } },
  });
  t.after(async () => {
    try {
      const closing = f.manager.close();
      for (const gate of f.gates) gate.resolve();
      await closing;
      await immediate();
      assert.equal(f.manager.active, null);
      for (const { secret } of f.opens) for (const key of SECRET_FIELDS) assert.equal(secret[key], '');
      assert.equal(db.prepare('SELECT count(*) AS n FROM dola_videos').get().n, 0);
    } finally { db.close(); }
  });
  return f;
}

function noSecrets(value, secrets = PUBLIC_SECRETS) {
  const text = JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false, 'Synthetic secret escaped its private boundary');
}

function assertPublic(batch) {
  assert.deepEqual(Object.keys(batch).sort(), ['createdAt', 'currentIndex', 'id', 'items', 'status']);
  for (const item of batch.items) {
    const keys = ['accountCode', 'email', 'loginMethod', 'message', 'status'];
    if (item.accountId) keys.push('accountId');
    assert.deepEqual(Object.keys(item).sort(), keys.sort());
  }
  noSecrets(batch);
}

function assertErased(f, batch) {
  for (const item of batch.items) {
    for (const key of SECRET_FIELDS) {
      assert.equal(Object.hasOwn(item, key), false, `${key} retained by a batch item`);
      assert.ok(!item.pendingSecret?.[key], `${key} retained by pending driver open`);
    }
    assert.equal(Object.hasOwn(item, 'loginProxy'), false);
    assert.equal(Object.hasOwn(item, 'accountSnapshot'), false);
  }
  for (const { secret } of f.opens) for (const key of SECRET_FIELDS) assert.equal(secret[key], '');
  noSecrets(batch);
  assertPublic(f.manager.public(batch));
}

function create(f, raw = mixed, options = {}) {
  const publicBatch = f.manager.create(raw, OWNER, options);
  assertPublic(publicBatch);
  return f.manager.batches.get(publicBatch.id);
}

async function waiting(f, raw = mixed, options = {}) {
  const batch = create(f, raw, options);
  await waitFor(() => batch.items[0].status === 'waiting_user' && !batch.items[0].busy, 'waiting session');
  assertPublic(f.manager.current(OWNER));
  return batch;
}

async function settled(f, batch) {
  await waitFor(() => batch.status === 'done' && f.manager.pending.size === 0, 'completed batch');
  assertErased(f, batch);
  return f.manager.public(batch);
}

function poolState(f) {
  return {
    accounts: f.db.prepare('SELECT * FROM dola_accounts ORDER BY id').all(),
    profiles: f.db.prepare('SELECT * FROM dola_login_profiles ORDER BY id').all(),
    audit: f.db.prepare('SELECT * FROM audit_logs ORDER BY id').all(),
  };
}

function manualInput(f, email = EMAIL, overrides = {}) {
  return { ...ready(email, { manual: true }), email, loginMethod: 'manual', ownerId: OWNER,
    snapshot: f.store.lookupAccount(email), loginProxy: PROXY, ...overrides };
}

function rejectUnchanged(f, input, reason) {
  const before = poolState(f);
  assert.throws(() => f.store.storeAccount(input), reason);
  assert.deepEqual(poolState(f), before, 'Rejected identity must not alter account, binding or audit');
}

test('manager + registry + store: all four automatic input forms reach the driver and bind stable profiles', async t => {
  const rows = formats.map(([, format], i) => format(`synthetic-${i}@example.test`));
  const parsed = parse(rows.join('\n'));
  const f = fixture(t, { onOpen({ secret, session, f }) {
    const index = f.opens.length - 1;
    for (const key of ['email', 'loginMethod', ...SECRET_FIELDS]) assert.equal(secret[key], parsed[index][key]);
    assert.equal(secret.profileId, index + 1);
    assert.equal(secret.accountCode, `A0${index + 1}`);
    session.next = ready(secret.email);
  } });
  const batch = create(f, rows.join('\n'));
  const publicBatch = await settled(f, batch);
  assert.deepEqual(publicBatch.items.map(item => item.status), Array(4).fill('succeeded'));
  assert.deepEqual(publicBatch.items.map(item => item.accountCode), ['A01', 'A02', 'A03', 'A04']);
  for (const item of publicBatch.items) assert.equal(f.registry.lookup(item.email).accountId, item.accountId);
  noSecrets(poolState(f), LOGIN_SECRETS);
});

test('reordered automatic imports and later manual login reuse the same codes and account IDs', async t => {
  const f = fixture(t, { onOpen({ secret, session }) { session.next = ready(secret.email, { manual: secret.loginMethod === 'manual' }); } });
  const first = await settled(f, create(f, mixed));
  const original = new Map(first.items.map(item => [item.email, { code: item.accountCode, id: item.accountId }]));
  const second = await settled(f, create(f, [formats[1][1](THIRD), formats[2][1](EMAIL), formats[3][1](SECOND)].join('\n')));
  const manual = await settled(f, create(f, ` ${SECOND.toUpperCase().replace('@', '\\@')} \n${EMAIL}\n${THIRD}`, { manual: true }));
  for (const result of [second, manual]) for (const item of result.items) {
    assert.equal(item.status, 'succeeded');
    assert.equal(item.accountCode, original.get(item.email).code);
    assert.equal(item.accountId, original.get(item.email).id);
  }
  assert.ok(manual.items.every(item => item.loginMethod === 'manual' && /标注/.test(item.message)));
  assert.equal(poolState(f).accounts.length, 3);
  assert.equal(poolState(f).profiles.length, 3);
});

test('manual creation accepts a non-Google address and sends no credential values to the driver', async t => {
  const email = 'synthetic-owner@outlook.com';
  const f = fixture(t, { onOpen({ secret, session }) {
    assert.equal(secret.loginMethod, 'manual');
    for (const key of SECRET_FIELDS) assert.equal(secret[key], '');
    session.next = ready(email, { manual: true });
  } });
  const result = await settled(f, create(f, email, { manual: true }));
  assert.equal(result.items[0].status, 'succeeded');
  assert.equal(f.registry.lookup(email).accountCode, 'A01');
  assert.match(poolState(f).audit[0].detail, /用户标注/);
});

test('oversized legacy passwords fail before reservation or driver start', async t => {
  const f = fixture(t);
  assert.throws(() => f.manager.create(`${EMAIL}|${PASSWORD.padEnd(1025, 'p')}`, OWNER), /1024/);
  assert.equal(poolState(f).profiles.length, 0);
  await immediate();
  assert.equal(f.opens.length, 0);
});

test('create/current/check/cancel public state never exposes input, cookies, tokens or proxy credentials', async t => {
  const f = fixture(t);
  const batch = await waiting(f);
  f.sessions[0].next = () => { throw new Error(PUBLIC_SECRETS.join(' ')); };
  await f.manager.inspect(batch, batch.items[0]);
  assertPublic(f.manager.current(OWNER));
  assertPublic(await f.manager.action(batch.id, OWNER, 'check'));
  assertPublic(await f.manager.action(batch.id, OWNER, 'cancel'));
  assertErased(f, batch);
  assert.equal(f.writes.length, 0);
});

test('cancel before driver open clears every secret in all queued formats', async t => {
  const f = fixture(t);
  const batch = create(f);
  await f.manager.action(batch.id, OWNER, 'cancel');
  assertErased(f, batch);
  await immediate();
  assert.equal(f.opens.length, 0);
});

for (const action of ['cancel', 'timeout']) {
  test(`${action} during pending driver open clears all four secret fields before the open resolves`, async t => {
    let gate;
    const f = fixture(t, { async onOpen() { await gate.promise; } });
    gate = f.gate();
    const batch = create(f);
    await waitFor(() => f.opens.length === 1, 'pending driver open');
    assert.equal(f.opens[0].secret.googleSessionUrl, GOOGLE);
    if (action === 'cancel') await f.manager.action(batch.id, OWNER, 'cancel');
    else { f.now = batch.items[0].deadlineAt; await f.manager.expire(batch, batch.items[0]); }
    assertErased(f, batch);
    assert.equal(f.opens[0].signal.aborted, true);
    assert.equal(f.opens.length, 1);
    gate.resolve();
    await waitFor(() => f.manager.pending.size === 0, 'late driver cleanup');
    assert.equal(f.sessions[0].closeCalls, 1);
    assert.equal(f.sessions[0].inspectCalls, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(poolState(f).accounts.length, 0);
  });
}

test('cancel erases secrets before waiting for slow session close', async t => {
  const f = fixture(t);
  const batch = await waiting(f);
  const gate = f.gate();
  f.sessions[0].close = async () => { f.sessions[0].closeCalls++; await gate.promise; };
  const cancellation = f.manager.action(batch.id, OWNER, 'cancel');
  assertErased(f, batch);
  gate.resolve();
  await cancellation;
  assert.equal(f.opens.length, 1);
});

for (const reason of [undefined, 'security']) {
  test(`${reason || 'ordinary'} timeout clears active and queued credentials without opening the next account`, async t => {
    const f = fixture(t, { next: { kind: 'waiting_user', reason } });
    const batch = await waiting(f);
    if (reason) assert.equal(batch.securityPaused, true);
    f.now = batch.items[0].deadlineAt;
    await f.manager.inspect(batch, batch.items[0]);
    await settled(f, batch);
    assert.deepEqual(batch.items.map(item => item.status), ['failed', 'cancelled', 'cancelled']);
    assert.equal(f.opens.length, 1);
    assert.equal(f.sessions[0].closeCalls, 1);
    assert.equal(f.writes.length, 0);
  });
}

test('a ready result arriving after cancel cannot store an account or restore erased secrets', async t => {
  const f = fixture(t);
  const batch = await waiting(f);
  const gate = f.gate();
  f.sessions[0].next = async () => { await gate.promise; return ready(); };
  const inspection = f.manager.inspect(batch, batch.items[0]);
  await f.manager.action(batch.id, OWNER, 'cancel');
  assertErased(f, batch);
  gate.resolve();
  await inspection;
  assert.equal(f.writes.length, 0);
  assert.equal(poolState(f).accounts.length, 0);
});

test('driver startup errors are redacted and erase the rest of the batch', async t => {
  const f = fixture(t, { onOpen() { throw new Error(PUBLIC_SECRETS.join(' ')); } });
  const batch = create(f);
  await settled(f, batch);
  assert.deepEqual(batch.items.map(item => item.status), ['failed', 'cancelled', 'cancelled']);
  assert.equal(f.writes.length, 0);
});

for (const [label, format] of formats) {
  for (const identityPresent of [false, true]) {
    test(`${label}: a manual-ready result cannot bypass Google mode (identity=${identityPresent})`, async t => {
      const result = ready(EMAIL, { manual: true });
      if (identityPresent) result.identity = ready().identity;
      const f = fixture(t, { next: result });
      const batch = create(f, format(EMAIL));
      await settled(f, batch);
      assert.equal(batch.items[0].status, 'failed');
      assert.equal(f.writes.length, 0, 'Manager must reject before calling the store');
      assert.equal(poolState(f).accounts.length, 0);
      assert.equal(f.registry.lookup(EMAIL).accountId, null);
    });
  }
}

for (const [label, patch] of [
  ['missing manual marker', { manual: false }],
  ['unverified session', { sessionVerified: false }],
  ['Google identity on manual result', { identity: ready().identity }],
  ['unverified profile', { profile: { ok: false, entityId: 'synthetic-entity' } }],
  ['missing Dola identity', { profile: { ok: true } }],
]) {
  test(`manual manager rejects ${label}`, async t => {
    const f = fixture(t, { next: { ...ready(EMAIL, { manual: true }), ...patch } });
    const batch = create(f, EMAIL, { manual: true });
    await settled(f, batch);
    assert.equal(batch.items[0].status, 'failed');
    assert.equal(f.writes.length, 0);
  });
}

test('store independently rejects manual results submitted under password or Google-link mode', t => {
  const f = fixture(t);
  f.registry.reserve([{ email: EMAIL }]);
  for (const loginMethod of ['password', 'google_link']) {
    rejectUnchanged(f, manualInput(f, EMAIL, { loginMethod }), /login_not_verified/);
    rejectUnchanged(f, manualInput(f, EMAIL, { loginMethod, identity: ready().identity }), /login_not_verified/);
  }
});

test('manual store requires verified session, profile and complete Dola cookies', t => {
  const f = fixture(t);
  f.registry.reserve([{ email: EMAIL }]);
  for (const patch of [
    { manual: false }, { manual: 'true' }, { sessionVerified: false }, { sessionVerified: 1 },
    { identity: ready().identity }, { profile: null }, { profile: { ok: false, entityId: 'synthetic-id' } },
    { profile: { ok: true } }, { cookies: {} }, { cookies: { ttwid: 'synthetic-cookie-only' } },
  ]) rejectUnchanged(f, manualInput(f, EMAIL, patch), /login_not_verified/);
});

test('manual store preserves the bound account ID and requires the same verified sec_user_id', t => {
  const f = fixture(t);
  f.registry.reserve([{ email: EMAIL }]);
  const saved = f.store.storeAccount(manualInput(f));
  assert.equal(f.registry.lookup(EMAIL).accountId, saved.id);
  const repeated = f.store.storeAccount(manualInput(f));
  assert.equal(repeated.id, saved.id);
  rejectUnchanged(f, manualInput(f, EMAIL, { profile: { ok: true, entityId: 'synthetic-different-identity' } }), /account_identity_changed/);
  assert.equal(poolState(f).accounts[0].sec_user_id, ready().profile.entityId);
});

test('manual store rejects a Dola identity already bound to a different display email', t => {
  const f = fixture(t);
  f.registry.reserve([{ email: EMAIL }, { email: SECOND }]);
  f.store.storeAccount(manualInput(f));
  rejectUnchanged(f, manualInput(f, SECOND, { profile: ready().profile }), /identity_already_in_pool/);
  assert.equal(f.registry.lookup(SECOND).accountId, null);
});

test('manual store accepts verified profile.id fallback and rejects subsequent identity substitution', t => {
  const f = fixture(t);
  f.registry.reserve([{ email: EMAIL }]);
  const saved = f.store.storeAccount(manualInput(f, EMAIL, { profile: { ok: true, id: 'synthetic-fallback-id' } }));
  assert.equal(f.db.prepare('SELECT sec_user_id FROM dola_accounts WHERE id=?').get(saved.id).sec_user_id, 'synthetic-fallback-id');
  rejectUnchanged(f, manualInput(f), /account_identity_changed/);
});

test('manual store rolls back account insertion and audit if registry binding conflicts', t => {
  const f = fixture(t);
  f.registry.reserve([{ email: EMAIL }]);
  f.registry.bind(EMAIL, 999);
  rejectUnchanged(f, manualInput(f), /已绑定其他账号/);
  assert.equal(poolState(f).accounts.length, 0);
  assert.equal(f.registry.lookup(EMAIL).accountId, 999);
});

test('manual store rejects changed snapshots before updating an existing identity', t => {
  const f = fixture(t);
  f.registry.reserve([{ email: EMAIL }]);
  f.store.storeAccount(manualInput(f));
  const stale = manualInput(f);
  f.db.prepare('UPDATE dola_accounts SET cookie_hash=? WHERE label=?').run('synthetic-new-cookie-hash', EMAIL);
  rejectUnchanged(f, stale, /account_changed_during_login/);
});

// Evaluate the unmodified router factory, excluding imports and lazy service
// initialization. Real Express dispatch is invoked directly, with no listener.
function isolatedRouter(getManager = deny('preview service creation')) {
  const path = new URL('../server/routes/dola-google-login.js', import.meta.url);
  const source = readFileSync(path, 'utf8');
  const start = source.indexOf('export function createGoogleLoginRouter(');
  const end = source.indexOf('export default createGoogleLoginRouter()', start);
  assert.ok(start >= 0 && end > start, 'Router factory extraction must fail closed if its contract moves');
  const audits = [];
  const createRouter = vm.runInNewContext(`${source.slice(start, end).replace(/^export /, '')}\ncreateGoogleLoginRouter;`, {
    express, parseAccountLoginEntries: parse,
    requireAuth(req, res, next) { return req.user ? next() : res.status(401).json({ ok: false }); },
    requirePerm(permission) { return (req, res, next) => req.user.permissions.includes(permission) ? next() : res.status(403).json({ ok: false }); },
    audit(...args) { audits.push(args); },
  }, { filename: path.pathname });
  return { router: createRouter(getManager), audits };
}

async function route(router, { method = 'POST', url = '/preview', body,
  user = { id: OWNER, permissions: ['dola:import'] }, remoteAddress = '127.0.0.1' } = {}) {
  const req = { method, url, originalUrl: url, baseUrl: '', headers: {}, body, user, socket: { remoteAddress } };
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, headers: {},
      set(key, value) { this.headers[key.toLowerCase()] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(value) { resolve({ status: this.statusCode, headers: this.headers, body: JSON.parse(JSON.stringify(value)), req }); return this; },
    };
    router.handle(req, res, error => reject(error || new Error('Fixture route was not handled')));
  });
}

test('isolated preview route returns only primary email/method/booleans, scrubs raw, and never resolves the manager', async () => {
  const { router, audits } = isolatedRouter();
  const response = await route(router, { body: { raw: mixed } });
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.body.items, [
    { email: EMAIL, loginMethod: 'google_link', hasRecoveryEmail: false, hasVerificationUrl: false },
    { email: SECOND, loginMethod: 'password', hasRecoveryEmail: true, hasVerificationUrl: true },
    { email: THIRD, loginMethod: 'password', hasRecoveryEmail: true, hasVerificationUrl: false },
  ]);
  assert.equal(Object.hasOwn(response.req.body, 'raw'), false);
  assert.equal(audits.length, 0);
  noSecrets(response.body);
});

test('isolated preview route accepts explicit manual mode and rejects nonboolean mode values', async () => {
  const { router } = isolatedRouter();
  const manual = await route(router, { body: { raw: EMAIL, manual: true } });
  assert.deepEqual(manual.body.items, [{ email: EMAIL, loginMethod: 'manual', hasRecoveryEmail: false, hasVerificationUrl: false }]);
  for (const mode of ['true', 'false', 1, null, {}]) {
    const response = await route(router, { body: { raw: mixed, manual: mode } });
    assert.equal(response.status, 400);
    assert.equal(Object.hasOwn(response.req.body, 'raw'), false);
    noSecrets(response.body);
  }
});

test('isolated preview route returns redacted validation errors and always deletes raw input', async () => {
  const { router } = isolatedRouter();
  for (const raw of [`${EMAIL}----${PASSWORD}----no----${GOOGLE}&bad=synthetic-private-token`, `${EMAIL}|${PASSWORD.padEnd(1025, 'p')}`]) {
    const response = await route(router, { body: { raw } });
    assert.equal(response.status, 400);
    assert.match(response.body.message, /^第 1 行：/);
    assert.equal(Object.hasOwn(response.req.body, 'raw'), false);
    noSecrets(response.body);
  }
});

test('isolated preview rejects URL sizes unsupported by the browser validator', async () => {
  const { router } = isolatedRouter();
  for (const [third, url] of [['no', GOOGLE], [RECOVERY, VERIFY]]) {
    const boundary = url.padEnd(8192, 'u');
    const accepted = await route(router, { body: { raw: `${EMAIL}----${PASSWORD}----${third}----${boundary}` } });
    assert.equal(accepted.status, 200);
    const rejected = await route(router, { body: { raw: `${EMAIL}----${PASSWORD}----${third}----${boundary}u` } });
    assert.equal(rejected.status, 400);
    assert.equal(Object.hasOwn(rejected.req.body, 'raw'), false);
    noSecrets(rejected.body);
  }
});

test('isolated preview route keeps permission and local-address middleware ahead of the parser', async () => {
  const { router } = isolatedRouter();
  for (const [options, expected] of [[{ user: null }, 401], [{ user: { id: OWNER, permissions: [] } }, 403],
    [{ remoteAddress: '192.0.2.1' }, 403]]) {
    const response = await route(router, { ...options, body: { raw: mixed } });
    assert.equal(response.status, expected);
    noSecrets(response.body);
  }
});

test('manager preview is owner-scoped; isolated route passes owner/id and encodes only the fake image', async t => {
  const f = fixture(t);
  const batch = await waiting(f);
  await assert.rejects(() => f.manager.preview(batch.id, OWNER + 1), error => error.status === 404);
  const { router } = isolatedRouter(() => f.manager);
  const response = await route(router, { method: 'GET', url: `/batches/${batch.id}/preview` });
  assert.equal(response.status, 200);
  assert.equal(response.body.image, `data:image/png;base64,${Buffer.from('synthetic screenshot').toString('base64')}`);
  noSecrets(response.body);
  await f.manager.action(batch.id, OWNER, 'cancel');
  await assert.rejects(() => f.manager.preview(batch.id, OWNER), error => error.status === 409);
});
