/**
 * Isolated contract/regression tests; this suite never demonstrates real login.
 * Run: node --test admin/test/google-login.mjs
 *
 * Every backend import follows a fresh ADMIN_DB and synthetic JWT/seed setup.
 * Routes run in memory, drivers are injected fakes, and network/process entry
 * points fail closed. No existing database, browser profile, or credential is
 * read. Failed safety contracts remain ordinary failing tests, never TODOs.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, mock, test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import childProcess from 'node:child_process';

const EMAIL = 'synthetic-one@example.test';
const PASSWORD = 'synthetic-password-only|with-separator';
const RAW = `${EMAIL}|${PASSWORD}`;
const QUEUED_RAW = `${RAW}\nsynthetic-two@example.test|synthetic-queued-two\nsynthetic-three@example.test|synthetic-queued-three`;
const OWNER = 101;
const OTHER = 202;
const OLD_AT = '2001-01-01T00:00:00.000Z';
const CLOCK = Date.parse('2026-09-19T00:00:00.000Z');
const SYNTHETIC_TOKEN = 'synthetic-google-access-token-not-real';
const SYNTHETIC_PROXY = 'http://synthetic-proxy:synthetic-proxy-password@proxy.example.test:8080';
const RECOVERY_EMAIL = 'synthetic-private-recovery@example.test';
const VERIFICATION_URL = 'https://verification.example.invalid/otp?token=synthetic-verification-secret';
const GOOGLE_SESSION_URL = 'https://gapi.mailsapi.com/google/login?uid=synthetic-google-link-secret';
const blocked = [];
let tempDirectory, db, auth, core, createGoogleAccountStore, createGoogleLoginRouter;
let requireLoginProxy, createLoginProxyResolver;
let ownerUser, otherUser, readerUser, disabledUser, sequence = 0;

function deny(label) {
  return () => {
    // Never retain arguments: a future accidental call could contain a secret.
    blocked.push(label);
    throw new Error(`Isolated Google-login test blocked ${label}`);
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, label, timeout = 1200) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(2);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

const identity = (email = EMAIL, overrides = {}) => ({
  email, sub: 'synthetic-google-sub', email_verified: true, ...overrides,
});
const cookies = (suffix = 'one') => ({ ttwid: `synthetic-ttwid-${suffix}`, odin_tt: `synthetic-odin-${suffix}` });
const ready = (email = EMAIL, overrides = {}) => ({
  kind: 'ready', identity: identity(email), cookies: cookies(),
  profile: { ok: true, entityId: 'synthetic-dola-entity', nickname: 'Synthetic fixture', membershipLevel: 'free' },
  ...overrides,
});

function assertPublic(batch) {
  assert.deepEqual(Object.keys(batch).sort(), ['createdAt', 'currentIndex', 'id', 'items', 'status']);
  for (const item of batch.items) {
    assert.deepEqual(Object.keys(item).sort(), (item.accountId
      ? ['accountId', 'email', 'message', 'status'] : ['email', 'message', 'status']));
  }
  const serialized = JSON.stringify(batch);
  for (const secret of [PASSWORD, SYNTHETIC_TOKEN, 'synthetic-private-cookie', 'synthetic-proxy-password']) {
    assert.ok(!serialized.includes(secret), 'Public batches must exclude synthetic credential sentinels');
  }
}

function fakeSession(next = { kind: 'waiting_user' }) {
  return {
    next, inspectCalls: 0, closeCalls: 0,
    async inspect() { this.inspectCalls++; return typeof this.next === 'function' ? this.next() : this.next; },
    async close() { this.closeCalls++; },
  };
}

function managerFixture(t, options = {}) {
  const fixture = { now: CLOCK, opens: [], sessions: [], writes: [], gates: [] };
  const { open, lookupAccount = () => null, storeAccount, ...managerOptions } = options;
  fixture.manager = new core.GoogleLoginManager({
    clock: () => fixture.now, timeoutMs: 5000, pollMs: 60_000,
    lookupAccount,
    storeAccount: value => {
      fixture.writes.push(value);
      return storeAccount ? storeAccount(value) : { id: 301 + fixture.writes.length };
    },
    driver: {
      async open(secret, snapshot, { signal, onStage } = {}) {
        assert.match(secret.email, /^synthetic-[^@]+@example\.test$/);
        assert.match(secret.password, /^synthetic-/);
        assert.ok(signal instanceof AbortSignal);
        fixture.opens.push({ secret, snapshot, signal, onStage });
        const session = fakeSession();
        fixture.sessions.push(session);
        return open ? open({ secret, snapshot, signal, onStage, session, fixture }) : session;
      },
    },
    ...managerOptions,
  });
  fixture.gate = () => {
    const gate = deferred();
    fixture.gates.push(gate);
    return gate;
  };
  t.after(async () => {
    const closing = fixture.manager.close();
    for (const gate of fixture.gates) gate.resolve();
    await closing;
    // Drain continuations of cancelled fake opens/checks before the next test.
    for (let i = 0; i < 4; i++) await immediate();
    assert.equal(fixture.manager.active, null);
    for (const { secret } of fixture.opens) assert.equal(secret.password, '');
  });
  return fixture;
}

async function started(fixture, raw = RAW, ownerId = OWNER) {
  const batch = fixture.manager.create(raw, ownerId);
  await waitFor(() => fixture.manager.batches.get(batch.id)?.items[0]?.status === 'waiting_user', 'fake login to wait');
  return fixture.manager.batches.get(batch.id);
}

async function done(fixture, batch) {
  await waitFor(() => batch.status === 'done', 'batch completion');
  assert.equal(fixture.manager.active, null);
  for (const item of batch.items) assert.equal(Object.hasOwn(item, 'password'), false);
  return fixture.manager.public(batch);
}

function assertCredentialsErased(batch) {
  for (const item of batch.items) {
    assert.equal(Object.hasOwn(item, 'password'), false);
    assert.ok(!item.pendingSecret?.password);
  }
}

async function stopped(fixture, batch) {
  await waitFor(() => fixture.manager.active === null, 'batch to stop without another login');
  assert.ok(['done', 'cancelled', 'failed'].includes(batch.status), 'Stopped batch must have a terminal status');
  assertCredentialsErased(batch);
  return fixture.manager.public(batch);
}

async function challenge(fixture, batch, reason = 'security') {
  fixture.sessions[0].next = { kind: 'waiting_user', reason };
  await fixture.manager.inspect(batch, batch.items[0]);
  assert.equal(batch.securityPaused, true);
  assert.equal(batch.items[0].status, 'waiting_user');
  assert.ok(batch.pauseTimer, 'Security pause needs a bounded whole-batch timer');
}

function seedAccount(options = {}) {
  const n = ++sequence;
  const row = {
    label: EMAIL, cookie: JSON.stringify(cookies(`old-${n}`)), cookie_hash: `synthetic-old-hash-${n}`,
    cookie_names: 'odin_tt,ttwid', status: 'valid', sec_user_id: 'synthetic-dola-entity',
    proxy: SYNTHETIC_PROXY,
    credits: 73, credits_source: 'synthetic-verified-balance', credits_at: OLD_AT,
    converted_credits: 21, counted_at: OLD_AT, quota_remaining: 2, quota_total: 4,
    quota_at: OLD_AT, quota_source: 'synthetic-receipt', exit_ip: '192.0.2.20',
    last_used_at: OLD_AT, cooldown_until: '2099-01-01T00:00:00.000Z', note: 'synthetic keep note',
    imported_by: OWNER, created_at: OLD_AT, updated_at: OLD_AT, ...options,
  };
  const fields = Object.keys(row);
  const result = db.prepare(`INSERT INTO dola_accounts (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`)
    .run(...Object.values(row));
  return Number(result.lastInsertRowid);
}

const accountRow = id => db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(id);
const storeInput = (overrides = {}) => ({
  ...ready(), email: EMAIL, ownerId: OWNER, snapshot: null, loginProxy: SYNTHETIC_PROXY, ...overrides,
});
const poolState = () => ({
  accounts: db.prepare('SELECT * FROM dola_accounts ORDER BY id').all(),
  audit: db.prepare('SELECT * FROM audit_logs ORDER BY id').all(),
});

function rejectWithoutWrite(store, input, expected) {
  const beforeState = poolState();
  assert.throws(() => store.storeAccount(input), expected);
  assert.deepEqual(poolState(), beforeState, 'Rejected import must not mutate accounts or audit');
}

function seedUser(name, permissions, status = 'active') {
  const role = db.prepare('INSERT INTO roles (code,name,permissions,created_at) VALUES (?,?,?,?)')
    .run(name, name, JSON.stringify(permissions), OLD_AT);
  const user = db.prepare('INSERT INTO users (username,password_hash,role_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(name, 'synthetic-unused-password-hash', Number(role.lastInsertRowid), status, OLD_AT, OLD_AT);
  const id = Number(user.lastInsertRowid);
  return { id, token: auth.signJwt({ uid: id }) };
}

// Real auth + Router middleware, but no HTTP listener or transport is involved.
async function route(router, {
  method = 'GET', url = '/batches/current', user = ownerUser, token = user?.token,
  body, remoteAddress = '127.0.0.1', headers = {},
} = {}) {
  const req = {
    method, url, originalUrl: url, baseUrl: '', body,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    socket: { remoteAddress },
  };
  const result = await new Promise((resolve, reject) => {
    const response = {
      statusCode: 200, headers: {},
      set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(value) { resolve({ status: this.statusCode, headers: this.headers, body: value, req }); return this; },
    };
    auth.authMiddleware(req, response, () => router.handle(req, response, error => {
      reject(error || new Error('Fixture route was not handled'));
    }));
  });
  return result;
}

function readOnlyRouteFixture(t) {
  const beforeState = poolState();
  const profiles = db.prepare('SELECT * FROM dola_login_profiles ORDER BY id').all();
  const changes = () => db.prepare('SELECT total_changes() AS n').get().n;
  const beforeChanges = changes();
  const attempts = [];
  const getManager = t.mock.fn(() => { throw new Error('Read-only route must not resolve a manager'); });
  const prepare = db.prepare;
  const prepareGuard = t.mock.method(db, 'prepare', sql => {
    // Auth legitimately SELECTs the synthetic user. Any audit, reservation or
    // write attempt must fail the test, even if implementation catches it.
    if (!/^\s*SELECT\b/i.test(sql)) {
      attempts.push('non-SELECT prepare');
      throw new Error('Read-only route attempted a database mutation');
    }
    return prepare(sql);
  });
  const execGuard = t.mock.method(db, 'exec', () => {
    attempts.push('exec');
    throw new Error('Read-only route attempted database exec');
  });
  t.after(() => {
    prepareGuard.mock.restore();
    execGuard.mock.restore();
    assert.equal(getManager.mock.callCount(), 0, 'Preview/validation must not instantiate the manager');
    assert.deepEqual(attempts, [], 'No audit, profile reservation or database write may be attempted');
    assert.equal(changes(), beforeChanges, 'No writes, including writes later rolled back');
    assert.deepEqual(poolState(), beforeState);
    assert.deepEqual(db.prepare('SELECT * FROM dola_login_profiles ORDER BY id').all(), profiles);
    assert.deepEqual(blocked, [], 'No DNS, network, process or browser call may be attempted');
  });
  return createGoogleLoginRouter(getManager);
}

function assertPreviewRedacted(response, extraSecrets = []) {
  const serialized = JSON.stringify({ body: response.body, headers: response.headers });
  for (const secret of [PASSWORD, RECOVERY_EMAIL, VERIFICATION_URL, GOOGLE_SESSION_URL,
    'synthetic-verification-secret', 'synthetic-google-link-secret', SYNTHETIC_TOKEN, ...extraSecrets]) {
    assert.ok(!serialized.includes(secret), 'Preview must not disclose synthetic credential sentinels');
  }
}

describe('isolated Google login contracts (synthetic only)', { concurrency: false, timeout: 30_000 }, () => {
  before(async () => {
    tempDirectory = await realpath(await mkdtemp(join(tmpdir(), 'google-login-test-')));
    // Deliberately overwrite without reading/copying any existing secret env.
    process.env.ADMIN_DB = join(tempDirectory, 'fresh.sqlite');
    process.env.ADMIN_JWT_SECRET = randomBytes(32).toString('hex');
    process.env.ADMIN_INIT_PASSWORD = 'synthetic-seed-password-only';
    process.env.DOLA_BASE = 'https://google-login-fixture.invalid';
    process.env.DOLA_AUTO_MAINTENANCE = 'false';
    mock.method(globalThis, 'fetch', deny('fetch'));
    for (const [object, methods] of [
      [http, ['request', 'get']], [https, ['request', 'get']],
      [net, ['connect', 'createConnection']], [net.Socket.prototype, ['connect']],
      [tls, ['connect']],
      [dns, ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']],
      [dnsPromises, ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']],
      [childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
    ]) for (const method of methods) mock.method(object, method, deny(method));
    syncBuiltinESMExports();

    core = await import('../server/dola/google-login-core.js');
    const database = await import('../server/db.js');
    assert.equal(database.DB_PATH, process.env.ADMIN_DB, 'Refuse an already-loaded non-fixture database');
    db = await database.initDb();
    assert.equal(db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file, process.env.ADMIN_DB);
    assert.equal(db.prepare('SELECT count(*) AS n FROM dola_accounts').get().n, 0);
    auth = await import('../server/auth.js');
    ({ createGoogleAccountStore } = await import('../server/dola/google-login-store.js'));
    ({ requireLoginProxy, createLoginProxyResolver } = await import('../server/dola/google-login-proxy.js'));
    const browser = await import('../server/dola/google-login-browser.js');
    mock.method(browser.googleBrowserDriver, 'open', deny('real browser driver'));
    ({ createGoogleLoginRouter } = await import('../server/routes/dola-google-login.js'));
    ownerUser = seedUser('synthetic-login-owner', ['dola:import']);
    otherUser = seedUser('synthetic-login-other', ['dola:import']);
    readerUser = seedUser('synthetic-login-reader', ['dola:list']);
    disabledUser = seedUser('synthetic-login-disabled', ['dola:import'], 'disabled');
  });

  beforeEach(() => {
    assert.equal(db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file, process.env.ADMIN_DB);
    db.exec('DELETE FROM dola_videos; DELETE FROM dola_accounts; DELETE FROM audit_logs;');
  });

  after(async () => {
    try {
      assert.deepEqual(blocked, [], 'No network, process, or real-browser calls may be attempted');
      if (db) {
        assert.equal(db.prepare('SELECT count(*) AS n FROM dola_videos').get().n, 0);
        assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
        assert.equal(db.prepare('SELECT count(*) AS n FROM credit_conversions').get().n, 0);
        assert.equal(db.prepare('SELECT count(*) AS n FROM point_transactions').get().n, 0);
      }
    } finally {
      db?.raw.close();
      mock.restoreAll();
      syncBuiltinESMExports();
      // This is only the exact directory returned by this suite's mkdtemp.
      if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test('parse: escaped @, normalization, CRLF/blank lines, and first separator preserve password', () => {
    assert.equal(core.normalizeEmail(' Synthetic-One\\@Example.TEST '), EMAIL);
    assert.deepEqual(core.parseGoogleAccounts(` \r\n Synthetic-One\\@Example.TEST |${PASSWORD} \r\n\n`), [
      { email: EMAIL, password: `${PASSWORD} ` },
    ]);
  });

  test('parse: exactly 20 accepted; 21 rejected without account/password disclosure', () => {
    const entries = Array.from({ length: 21 }, (_, n) => `synthetic-${n}@example.test|${PASSWORD}`);
    assert.equal(core.parseGoogleAccounts(entries.slice(0, 20).join('\n')).length, 20);
    assert.throws(() => core.parseGoogleAccounts(entries.join('\n')), e => e.status === 400 && /20/.test(e.message)
      && !e.message.includes(PASSWORD) && !e.message.includes('@example.test'));
  });

  test('parse: duplicates include case and escaped-at variants', () => {
    for (const second of [EMAIL, 'SYNTHETIC-ONE@EXAMPLE.TEST', 'Synthetic-One\\@example.test']) {
      assert.throws(() => core.parseGoogleAccounts(`${RAW}\n${second}|synthetic-second-password`),
        e => e.status === 400 && /第 2 行.*重复/.test(e.message) && !e.message.includes(EMAIL));
    }
  });

  test('parse: invalid separators, sizes, missing fields and control characters fail with redacted errors', () => {
    const cases = [undefined, null, {}, 17, '', '  \n\r\n', 'x'.repeat(32769),
      EMAIL, `${EMAIL},synthetic-no-pipe`, `${EMAIL}:synthetic-no-pipe`, `${EMAIL}\tsynthetic-no-pipe`,
      `|${PASSWORD}`, `${EMAIL}|`, `bad@@example.test|${PASSWORD}`, `not-an-email|${PASSWORD}`,
      `${'a'.repeat(255)}@example.test|${PASSWORD}`, `${EMAIL}|${'p'.repeat(1025)}`,
      ...['\0', '\t', '\r', '\x1f', '\x7f'].map(control => `${EMAIL}|${PASSWORD}${control}`)];
    for (const value of cases) assert.throws(() => core.parseGoogleAccounts(value), e => e.status === 400
      && !e.message.includes(PASSWORD) && !e.message.includes(EMAIL));
  });

  test('origin cookie filter: only exact Dola domains; Google/lookalikes cannot overwrite Dola values', () => {
    const exported = [
      { domain: '.google.com', name: 'ttwid', value: 'synthetic-google-cookie-before' },
      ...['dola.com', '.dola.com', 'www.dola.com', '.www.dola.com'].map((domain, n) => ({ domain, name: `dola_${n}`, value: `synthetic-dola-${n}` })),
      { domain: '.dola.com', name: 'ttwid', value: 'synthetic-dola-only' },
      ...['accounts.google.com', '.google.com', 'openidconnect.googleapis.com', 'evil.dola.com',
        'dola.com.evil.test', 'evil-dola.com', 'www.dola.com:443', 'https://www.dola.com', '', undefined]
        .map(domain => ({ domain, name: 'ttwid', value: 'synthetic-google-cookie-after' })),
      { domain: '.dola.com', name: '', value: 'synthetic-empty-name' },
      { domain: '.dola.com', name: 'empty_value', value: '' },
    ];
    const original = structuredClone(exported);
    assert.deepEqual(core.dolaCookieMap(exported), {
      dola_0: 'synthetic-dola-0', dola_1: 'synthetic-dola-1', dola_2: 'synthetic-dola-2', dola_3: 'synthetic-dola-3',
      ttwid: 'synthetic-dola-only',
    });
    assert.deepEqual(exported, original);
    assert.deepEqual(core.dolaCookieMap(null), {});
    assert.deepEqual(core.dolaCookieMap([]), {});
  });

  test('userinfo: requires verified boolean, nonempty sub, and matching normalized email', () => {
    assert.equal(core.matchesGoogleIdentity(identity(' Synthetic-One\\@EXAMPLE.TEST '), EMAIL), true);
    for (const candidate of [null, {}, identity(EMAIL, { email_verified: false }),
      identity(EMAIL, { email_verified: 'true' }), identity(EMAIL, { email_verified: 1 }),
      identity(EMAIL, { email_verified: undefined }), identity(EMAIL, { sub: '' }),
      identity(EMAIL, { sub: null }), identity(EMAIL, { sub: undefined }),
      identity('synthetic-other@example.test'), identity(undefined, { email: undefined })]) {
      assert.equal(core.matchesGoogleIdentity(candidate, EMAIL), false);
    }
  });

  test('containsOAuthToken: exact JSON field values and decoded form values match', () => {
    const token = `${SYNTHETIC_TOKEN}+/=&%`;
    for (const body of [
      JSON.stringify({ access_token: token }),
      JSON.stringify({ oauth: { credentials: [{ access_token: token }] } }),
      new URLSearchParams({ provider: 'google', access_token: token }).toString(),
    ]) assert.equal(core.containsOAuthToken(body, token), true);
    // A field name cannot establish token ownership; only its full value can.
    assert.equal(core.containsOAuthToken(JSON.stringify({ [token]: 'synthetic-unrelated' }), token), false);
    assert.equal(core.containsOAuthToken(new URLSearchParams({ [token]: 'synthetic-unrelated' }).toString(), token), false);
  });

  test('containsOAuthToken: rejects substrings, bearer strings, serialized text, malformed and missing input', () => {
    const token = SYNTHETIC_TOKEN;
    const falseValues = [`prefix-${token}`, `${token}-suffix`, `Bearer ${token}`, ` ${token} `,
      `https://example.test/callback#access_token=${token}`, JSON.stringify({ access_token: token })];
    for (const value of falseValues) {
      assert.equal(core.containsOAuthToken(JSON.stringify({ access_token: value }), token), false);
      assert.equal(core.containsOAuthToken(new URLSearchParams({ access_token: value }).toString(), token), false);
    }
    for (const body of [undefined, null, {}, [], '', token, '{malformed-json', 'access_token=synthetic-other']) {
      assert.equal(core.containsOAuthToken(body, token), false);
    }
    for (const tokenValue of [undefined, null, '']) {
      assert.equal(core.containsOAuthToken(JSON.stringify({ access_token: tokenValue }), tokenValue), false);
    }
  });

  test('containsOAuthToken: a top-level JSON string is not a JSON field value', () => {
    assert.equal(core.containsOAuthToken(JSON.stringify(SYNTHETIC_TOKEN), SYNTHETIC_TOKEN), false,
      'A bare JSON string must not prove an OAuth request field binding');
  });

  test('authSessionMarkers: reads exact marker names from Set-Cookie without decoding or truncating values', () => {
    const headers = [
      { name: 'Set-Cookie', value: 'sessionid=synthetic-session==; Path=/; Secure; HttpOnly' },
      { name: 'SET-COOKIE', value: 'sessionid_ss=synthetic%2Fsession+; SameSite=None; Secure' },
      { name: 'set-cookie', value: 'sid_tt=synthetic-sid; Expires=Wed, 21 Oct 2037 07:28:00 GMT' },
      { name: 'cookie', value: 'sessionid=synthetic-request-cookie' },
      { name: 'x-set-cookie', value: 'sessionid=synthetic-wrong-header' },
      ...['x_sessionid', 'sessionid_extra', 'sessionid_ss_extra', 'sid_tt_extra', 'ttwid', 'odin_tt']
        .map(name => ({ name: 'set-cookie', value: `${name}=synthetic-unrelated` })),
      { name: 'set-cookie', value: 'sessionid=; Max-Age=0' },
    ];
    const original = structuredClone(headers);
    assert.deepEqual(core.authSessionMarkers(headers), {
      sessionid: 'synthetic-session==', sessionid_ss: 'synthetic%2Fsession+', sid_tt: 'synthetic-sid',
    });
    assert.deepEqual(headers, original);
    assert.deepEqual(core.authSessionMarkers([]), {});
    assert.deepEqual(core.authSessionMarkers(null), {});
  });

  test('authSessionMarkers: cookie-name case must not be folded into a different session cookie', () => {
    const markers = core.authSessionMarkers([{ name: 'Set-Cookie', value: 'SESSIONID=synthetic-session' }]);
    assert.equal(Object.hasOwn(markers, 'sessionid'), false, 'SESSIONID is not the sessionid cookie');
    assert.equal(core.matchesSessionBinding({ sessionid: 'synthetic-session' }, markers), false);
  });

  test('matchesSessionBinding: every nonempty marker must have the exact cookie name and value', () => {
    const markers = { sessionid: 'synthetic-session==', sid_tt: 'synthetic%2Fsid+' };
    const jar = { ...markers, ttwid: 'synthetic-unrelated-cookie' };
    assert.equal(core.matchesSessionBinding(jar, markers), true);
    for (const candidate of [null, {}, { sessionid: markers.sessionid },
      { ...jar, sessionid: `${markers.sessionid}-suffix` }, { ...jar, sessionid: ` ${markers.sessionid}` },
      { ...jar, sid_tt: 'synthetic/sid+' }, { ...jar, sid_tt: markers.sid_tt.toUpperCase() },
      { SESSIONID: markers.sessionid, sid_tt: markers.sid_tt },
    ]) assert.equal(core.matchesSessionBinding(candidate, markers), false);
    assert.equal(core.matchesSessionBinding(jar, null), false);
    assert.equal(core.matchesSessionBinding(jar, {}), false);
    assert.equal(core.matchesSessionBinding({ sessionid: 123 }, { sessionid: '123' }), false);
    assert.deepEqual(jar, { ...markers, ttwid: 'synthetic-unrelated-cookie' });
  });

  test('matchesSessionBinding: absent/empty marker values cannot authenticate a missing/empty cookie', () => {
    for (const value of [undefined, null, '']) {
      assert.equal(core.matchesSessionBinding({ sessionid: value }, { sessionid: value }), false,
        'Empty marker values do not establish a session binding');
    }
  });

  test('isGoogleAuthExchange: exact Dola login paths require top-level Google platform and full token', () => {
    for (const path of ['/passport/web/auth/login_only/', '/passport/web/auth/login/']) {
      for (const body of [
        JSON.stringify({ platform_app_id: 2085, access_token: SYNTHETIC_TOKEN }),
        new URLSearchParams({ platform_app_id: '2085', access_token: SYNTHETIC_TOKEN }).toString(),
      ]) assert.equal(core.isGoogleAuthExchange(`https://www.dola.com${path}`, body, SYNTHETIC_TOKEN), true);
    }
    const body = JSON.stringify({ platform_app_id: 2085, access_token: SYNTHETIC_TOKEN });
    for (const url of ['https://www.dola.com/chat/', 'https://www.dola.com/alice/profile/self_brief',
      'https://www.dola.com/passport/web/auth/login_only/extra', 'https://www.dola.com/passport/web/auth/login_extra/',
      'https://www.dola.com.evil.test/passport/web/auth/login_only/',
      'https://accounts.google.com/passport/web/auth/login_only/', 'http://www.dola.com/passport/web/auth/login_only/',
      'not-a-url', '',
    ]) assert.equal(core.isGoogleAuthExchange(url, body, SYNTHETIC_TOKEN), false);
  });

  test('isGoogleAuthExchange: unrelated POST values, nested tokens and wrong platform cannot bind a session', () => {
    const url = 'https://www.dola.com/passport/web/auth/login_only/';
    const invalid = [
      { platform_app_id: 2085, access_token: `${SYNTHETIC_TOKEN}-suffix` },
      { platform_app_id: 2085, access_token: `Bearer ${SYNTHETIC_TOKEN}` },
      { platform_app_id: 2085, note: SYNTHETIC_TOKEN },
      { platform_app_id: 2085, oauth: { access_token: SYNTHETIC_TOKEN } },
      { oauth: { platform_app_id: 2085, access_token: SYNTHETIC_TOKEN } },
      { platform_app_id: 2084, access_token: SYNTHETIC_TOKEN },
      { platform_app_id: '20850', access_token: SYNTHETIC_TOKEN },
      { platform: { platform_app_id: 2085 }, access_token: SYNTHETIC_TOKEN },
      { access_token: SYNTHETIC_TOKEN },
    ];
    for (const value of invalid) assert.equal(core.isGoogleAuthExchange(url, JSON.stringify(value), SYNTHETIC_TOKEN), false);
    for (const body of [undefined, null, '', '{malformed-json', JSON.stringify(SYNTHETIC_TOKEN),
      new URLSearchParams({ platform_app_id: '2084', access_token: SYNTHETIC_TOKEN }).toString(),
      new URLSearchParams({ platform_app_id: '2085', 'oauth[access_token]': SYNTHETIC_TOKEN }).toString(),
      new URLSearchParams({ platform_app_id: '2085', access_token: `${SYNTHETIC_TOKEN}-suffix` }).toString(),
    ]) assert.equal(core.isGoogleAuthExchange(url, body, SYNTHETIC_TOKEN), false);
    assert.equal(core.isGoogleAuthExchange(url, JSON.stringify({ platform_app_id: 2085, access_token: '' }), ''), false);
  });

  test('authExchangeSucceeded: top-level success and nonempty data are both required', () => {
    assert.equal(core.authExchangeSucceeded({ message: 'success', data: { synthetic_marker: 'synthetic-session' } }), true);
    for (const value of [undefined, null, {}, { message: 'success' },
      { message: 'success', data: null }, { message: 'success', data: {} },
      { message: 'success', data: [] }, { message: 'success', data: '' },
      { message: 'error', data: { synthetic_marker: 'synthetic-session' } },
      { message: 'SUCCESS', data: { synthetic_marker: 'synthetic-session' } },
      { data: { message: 'success', synthetic_marker: 'synthetic-session' } },
      { result: { message: 'success', data: { synthetic_marker: 'synthetic-session' } } },
    ]) assert.equal(core.authExchangeSucceeded(value), false);
  });

  test('requireLoginProxy: valid supported proxy URLs retain their exact raw value', () => {
    for (const raw of [SYNTHETIC_PROXY, 'https://synthetic-proxy:synthetic%40password@Proxy.Example.TEST:8443',
      'socks5://synthetic-proxy:synthetic%2Fpassword@proxy.example.test:1080',
      'socks5h://synthetic-proxy:synthetic-password@proxy.example.test:1080',
    ]) assert.equal(requireLoginProxy(raw), raw);
  });

  test('requireLoginProxy: blank, ftp, malformed and unsafe URLs fail generically without credential disclosure', () => {
    for (const raw of [undefined, null, {}, '', '  ', 'synthetic-malformed-proxy',
      'ftp://synthetic-proxy:synthetic-proxy-password@proxy.example.test:21',
      'http://synthetic-proxy:synthetic-proxy-password@', 'socks5://',
      'http://proxy.example.test:99999', `${SYNTHETIC_PROXY}/unexpected-path`, `${SYNTHETIC_PROXY}?token=synthetic-query`,
      `${SYNTHETIC_PROXY}#synthetic-fragment`, ` ${SYNTHETIC_PROXY}`, `${SYNTHETIC_PROXY}\n`,
      'http://synthetic-proxy:synthetic%0Apassword@proxy.example.test:8080',
    ]) assert.throws(() => requireLoginProxy(raw), error => error.message === 'login_proxy_required');
  });

  test('proxy resolver: no configured IPWeb template fails without opening a driver or modifying the pool', async t => {
    const resolver = createLoginProxyResolver(db);
    const beforeState = poolState();
    assert.throws(() => resolver.resolveProxy(EMAIL, null), { message: 'ipweb_proxy_not_configured' });
    assert.throws(() => resolver.resolveProxy(EMAIL, { proxy: '' }), { message: 'ipweb_proxy_not_configured' });
    const f = managerFixture(t, { resolveProxy: resolver.resolveProxy });
    const created = f.manager.create(RAW, OWNER);
    const result = await done(f, f.manager.batches.get(created.id));
    assert.equal(result.items[0].status, 'failed');
    assert.equal(f.opens.length, 0);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(poolState(), beforeState);
    assertPublic(result);
  });

  test('proxy resolver: non-valid, non-IPWeb, lookalike and malformed templates cannot enable a direct fallback', () => {
    const validShape = 'socks5://B_900001_KR___30_Ab000001:synthetic-template-password@gate2.ipweb.cc:7778';
    for (const status of ['disabled', 'invalid', 'unknown']) seedAccount({ status, proxy: validShape });
    for (const proxy of [SYNTHETIC_PROXY, validShape.replace('gate2.ipweb.cc', 'gate2.ipweb.cc.evil.test'),
      validShape.replace(':7778', ':7779'), validShape.replace('B_900001_KR___30_Ab000001', 'synthetic-malformed-user'),
      validShape.replace('socks5:', 'ftp:'), validShape.replace('synthetic-template-password', ''),
    ]) seedAccount({ proxy });
    const beforeState = poolState();
    assert.throws(() => createLoginProxyResolver(db).resolveProxy(EMAIL, null), { message: 'ipweb_proxy_not_configured' });
    assert.deepEqual(poolState(), beforeState);
  });

  test('proxy resolver: a valid bound proxy is reused exactly and an invalid bound proxy is not replaced', () => {
    const resolver = createLoginProxyResolver(db);
    const account = { id: 19, proxy: SYNTHETIC_PROXY };
    assert.equal(resolver.resolveProxy(EMAIL, account), SYNTHETIC_PROXY);
    seedAccount({ proxy: 'socks5://B_900001_KR___30_Ab000001:synthetic-template-password@gate2.ipweb.cc:7778' });
    const beforeState = poolState();
    assert.equal(resolver.resolveProxy(EMAIL, account), SYNTHETIC_PROXY);
    for (const proxy of ['ftp://proxy.example.test:21', 'synthetic-malformed-proxy', '   ']) {
      assert.throws(() => resolver.resolveProxy(EMAIL, { proxy }), { message: 'login_proxy_required' });
    }
    assert.deepEqual(account, { id: 19, proxy: SYNTHETIC_PROXY });
    assert.deepEqual(poolState(), beforeState);
  });

  test('proxy resolver: newest valid template yields stable normalized-email SID and independent account proxies', () => {
    const prefix = 'socks5://B_900001_US_1474_10748_';
    const suffix = ':synthetic-template%40password@gate1.ipweb.cc:7778';
    seedAccount({ proxy: `${prefix}5_Ab000001${suffix}`, updated_at: '2001-01-01T00:00:00.000Z' });
    seedAccount({ proxy: `${prefix}17_Ab000002${suffix}`, updated_at: '2002-01-01T00:00:00.000Z' });
    seedAccount({ status: 'disabled', proxy: `${prefix}30_Ab000003${suffix}` });
    seedAccount({ proxy: 'synthetic-malformed-newer-template' });
    const resolver = createLoginProxyResolver(db);
    const beforeState = poolState();
    const sid = createHash('sha256').update(EMAIL).digest('hex').slice(0, 8);
    const expected = `${prefix}17_${sid}${suffix}`;
    const normalizedVariants = [EMAIL, ' SYNTHETIC-ONE@EXAMPLE.TEST ', 'Synthetic-One\\@Example.TEST'];
    for (const email of normalizedVariants) assert.equal(resolver.resolveProxy(email, null), expected);
    const secondEmail = 'synthetic-two@example.test';
    const otherSid = createHash('sha256').update(secondEmail).digest('hex').slice(0, 8);
    assert.equal(resolver.resolveProxy(secondEmail, { proxy: '' }), `${prefix}17_${otherSid}${suffix}`);
    assert.notEqual(sid, otherSid);
    assert.notEqual(resolver.resolveProxy(secondEmail, null), expected);
    assert.equal(createLoginProxyResolver(db).resolveProxy(EMAIL, null), expected);
    assert.deepEqual(poolState(), beforeState);
  });

  test('proxy resolver -> manager -> store: synthetic login keeps the same resolved IPWeb proxy throughout', async t => {
    seedAccount({ label: 'synthetic-template@example.test', sec_user_id: 'synthetic-template-entity',
      proxy: 'socks5://B_900001_KR___30_Ab000001:synthetic-template-password@gate2.ipweb.cc:7778' });
    const resolver = createLoginProxyResolver(db);
    const store = createGoogleAccountStore(db);
    const expected = resolver.resolveProxy(EMAIL, null);
    const f = managerFixture(t, { ...store, resolveProxy: resolver.resolveProxy });
    const batch = await started(f);
    assert.equal(f.opens[0].snapshot.proxy, expected);
    assert.equal(batch.items[0].loginProxy, expected);
    f.sessions[0].next = ready();
    await f.manager.inspect(batch, batch.items[0]);
    const result = await done(f, batch);
    assert.equal(result.items[0].status, 'succeeded');
    assert.equal(f.writes[0].loginProxy, expected);
    assert.equal(accountRow(result.items[0].accountId).proxy, expected);
    assert.ok(!JSON.stringify(result).includes('synthetic-template-password'));
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_logs').all()).includes('synthetic-template-password'));
    assertPublic(result);
  });

  test('manager: resolved proxy reaches driver and store without altering the account snapshot or public data', async t => {
    const snapshot = { id: 77, proxy: '', cookie: 'synthetic-private-cookie' };
    const resolutions = [];
    const f = managerFixture(t, {
      lookupAccount: () => snapshot,
      resolveProxy: (email, account) => { resolutions.push({ email, account }); return SYNTHETIC_PROXY; },
    });
    const batch = await started(f);
    assert.deepEqual(resolutions, [{ email: EMAIL, account: snapshot }]);
    assert.deepEqual(f.opens[0].snapshot, { ...snapshot, proxy: SYNTHETIC_PROXY });
    assert.equal(snapshot.proxy, '');
    assert.equal(batch.items[0].loginProxy, SYNTHETIC_PROXY);
    assertPublic(f.manager.public(batch));
    f.sessions[0].next = ready();
    await f.manager.inspect(batch, batch.items[0]);
    await done(f, batch);
    assert.equal(f.writes[0].loginProxy, SYNTHETIC_PROXY);
    assert.equal(f.writes[0].snapshot, snapshot);
    assert.equal(snapshot.proxy, '');
  });

  test('manager: proxy resolver failure never opens a browser or falls back to a direct connection', async t => {
    const f = managerFixture(t, { resolveProxy: () => { throw new Error(`synthetic-proxy-unavailable ${SYNTHETIC_PROXY}`); } });
    const created = f.manager.create(RAW, OWNER);
    const result = await done(f, f.manager.batches.get(created.id));
    assert.equal(result.items[0].status, 'failed');
    assert.equal(f.opens.length, 0);
    assert.equal(f.writes.length, 0);
    assertPublic(result);
  });

  test('manager: only one active batch (409), with owner-scoped current/action', async t => {
    const f = managerFixture(t);
    const batch = await started(f);
    for (const owner of [OWNER, OTHER]) assert.throws(() => f.manager.create(RAW, owner), e => e.status === 409);
    assert.equal(f.manager.current(OTHER), null);
    for (const action of ['check', 'skip', 'cancel']) {
      await assert.rejects(f.manager.action(batch.id, OTHER, action), e => e.status === 404);
    }
    await assert.rejects(f.manager.action('synthetic-missing-id', OWNER, 'check'), e => e.status === 404);
    await assert.rejects(f.manager.action(batch.id, OWNER, 'synthetic-unknown-action'), e => e.status === 400);
    assert.equal(f.manager.active, batch);
    assert.equal(f.sessions[0].closeCalls, 0);
    assertPublic(f.manager.current(OWNER));
  });

  test('security pause: all challenge reasons latch a ten-minute default deadline only once', async t => {
    for (const reason of ['captcha', 'security', 'browser_blocked', 'otp_identity', 'otp_fetch_failed',
      'otp_refresh_exhausted', 'otp_not_accepted', 'otp_step_changed']) {
      const f = managerFixture(t);
      assert.equal(f.manager.manualTimeoutMs, 600_000);
      const batch = await started(f, QUEUED_RAW);
      f.now += 1000;
      await challenge(f, batch, reason);
      const deadline = f.now + 600_000;
      const timer = batch.pauseTimer;
      assert.equal(batch.pauseDeadlineAt, deadline);
      assert.equal(batch.items[0].deadlineAt, deadline);
      f.now += 2000;
      // Repeated challenges and intervening pending states must not restore
      // automatic mode or extend the credential retention deadline.
      for (const next of [{ kind: 'waiting_user', reason }, { kind: 'pending' },
        { kind: 'waiting_user', reason: 'browser_blocked' }]) {
        f.sessions[0].next = next;
        await f.manager.inspect(batch, batch.items[0]);
        assert.equal(batch.securityPaused, true);
        assert.equal(batch.items[0].status, 'waiting_user');
        assert.equal(batch.pauseDeadlineAt, deadline);
        assert.equal(batch.items[0].deadlineAt, deadline);
        assert.equal(batch.pauseTimer, timer);
      }
      assertPublic(f.manager.public(batch));
      await f.manager.action(batch.id, OWNER, 'cancel');
    }
  });

  test('security pause: the last account finishes immediately instead of retaining a paused batch', async t => {
    const f = managerFixture(t);
    const batch = await started(f);
    await challenge(f, batch);
    const pauseTimer = batch.pauseTimer;
    const clear = t.mock.method(globalThis, 'clearTimeout');
    f.sessions[0].next = ready();
    await f.manager.inspect(batch, batch.items[0]);
    assert.equal(batch.status, 'done');
    assert.equal(f.manager.active, null);
    assert.equal(batch.items[0].status, 'succeeded');
    assert.ok(clear.mock.calls.some(call => call.arguments[0] === pauseTimer));
    assertCredentialsErased(batch);
  });

  for (const outcome of ['ready', 'failed', 'skip']) test(`security pause: ${outcome} closes only the current account and leaves the queue paused`, async t => {
    const f = managerFixture(t);
    const batch = await started(f, QUEUED_RAW);
    await challenge(f, batch);
    if (outcome === 'skip') await f.manager.action(batch.id, OWNER, 'skip');
    else {
      f.sessions[0].next = outcome === 'ready' ? ready() : { kind: 'failed' };
      await f.manager.inspect(batch, batch.items[0]);
    }
    for (let i = 0; i < 3; i++) await immediate();
    assert.equal(batch.status, 'paused');
    assert.equal(f.manager.active, batch);
    assert.equal(batch.securityPaused, true);
    assert.equal(batch.currentIndex, 0);
    assert.deepEqual(batch.items.map(item => item.status), [outcome === 'ready' ? 'succeeded' : outcome === 'skip' ? 'cancelled' : 'failed', 'queued', 'queued']);
    assert.equal(batch.items[1].password, 'synthetic-queued-two');
    assert.equal(batch.items[2].password, 'synthetic-queued-three');
    assert.equal(f.opens.length, 1);
    assert.equal(f.sessions[0].closeCalls, 1);
    assert.equal(f.writes.length, outcome === 'ready' ? 1 : 0);
    assert.throws(() => f.manager.create(RAW, OWNER), error => error.status === 409);
    assertPublic(f.manager.public(batch));
  });

  test('security pause: check cannot resume; explicit resume clears the latch/timer and opens exactly one next account', async t => {
    const f = managerFixture(t);
    const batch = await started(f, QUEUED_RAW);
    await challenge(f, batch, 'captcha');
    const pauseTimer = batch.pauseTimer;
    const clear = t.mock.method(globalThis, 'clearTimeout');
    await f.manager.action(batch.id, OWNER, 'skip');
    await immediate();
    assert.equal(batch.status, 'paused');
    for (let i = 0; i < 3; i++) await f.manager.action(batch.id, OWNER, 'check');
    await immediate();
    assert.equal(f.opens.length, 1);
    assert.equal(batch.status, 'paused');
    assert.equal(batch.securityPaused, true);
    await f.manager.action(batch.id, OWNER, 'resume');
    const repeats = await Promise.allSettled(Array.from({ length: 3 }, () => f.manager.action(batch.id, OWNER, 'resume')));
    for (const result of repeats) if (result.status === 'rejected') assert.equal(result.reason.status, 409);
    await waitFor(() => f.sessions[1]?.inspectCalls, 'one explicitly resumed account');
    await immediate();
    assert.equal(f.opens.length, 2);
    assert.equal(batch.currentIndex, 1);
    assert.equal(batch.items[2].status, 'queued');
    assert.ok(!batch.securityPaused);
    assert.ok(clear.mock.calls.some(call => call.arguments[0] === pauseTimer), 'Resume must clear the batch pause timer');
    assertPublic(f.manager.public(batch));
  });

  test('security pause: resume is owner-protected and blocked before the current account terminates', async t => {
    const f = managerFixture(t);
    const batch = await started(f, QUEUED_RAW);
    await challenge(f, batch);
    await assert.rejects(f.manager.action(batch.id, OTHER, 'resume'), error => error.status === 404);
    await assert.rejects(f.manager.action(batch.id, OWNER, 'resume'), error => error.status === 409);
    assert.equal(f.sessions[0].closeCalls, 0);
    assert.equal(f.opens.length, 1);
    await f.manager.action(batch.id, OWNER, 'skip');
    await immediate();
    await assert.rejects(f.manager.action(batch.id, OTHER, 'resume'), error => error.status === 404);
    assert.equal(batch.status, 'paused');
    assert.equal(batch.securityPaused, true);
    assert.equal(f.opens.length, 1);
  });

  test('security pause: a terminal status alone cannot resume while current-session cleanup is pending', async t => {
    const f = managerFixture(t);
    const batch = await started(f, QUEUED_RAW);
    await challenge(f, batch);
    const gate = f.gate();
    f.sessions[0].close = async () => { f.sessions[0].closeCalls++; await gate.promise; };
    const skipping = f.manager.action(batch.id, OWNER, 'skip');
    await waitFor(() => f.sessions[0].closeCalls === 1, 'held cleanup');
    assert.equal(batch.items[0].status, 'cancelled');
    await assert.rejects(f.manager.action(batch.id, OWNER, 'resume'), error => error.status === 409);
    await immediate();
    assert.equal(f.opens.length, 1);
    gate.resolve();
    await skipping;
    await immediate();
    assert.equal(batch.status, 'paused');
    await f.manager.action(batch.id, OWNER, 'resume');
    await waitFor(() => f.sessions[1]?.inspectCalls, 'resume after cleanup');
    assert.equal(f.opens.length, 2);
  });

  test('security pause: bounded expiry stops a pending inspection, clears the queue and rejects its stale ready result', async t => {
    const f = managerFixture(t, { manualTimeoutMs: 50 });
    const batch = await started(f, QUEUED_RAW);
    await challenge(f, batch, 'browser_blocked');
    const gate = f.gate();
    f.sessions[0].next = async () => { await gate.promise; return ready(); };
    const inspecting = f.manager.inspect(batch, batch.items[0]);
    f.now = batch.pauseDeadlineAt + 1;
    await stopped(f, batch);
    assert.deepEqual(batch.items.map(item => item.status), ['failed', 'cancelled', 'cancelled']);
    assert.equal(f.sessions[0].closeCalls, 1);
    assert.equal(f.opens[0].signal.aborted, true);
    gate.resolve();
    await inspecting;
    await immediate();
    assert.equal(f.writes.length, 0);
    assert.equal(f.opens.length, 1);
    assertCredentialsErased(batch);
  });

  test('security pause: ready returned after the manual deadline cannot beat the expiry callback', async t => {
    const f = managerFixture(t, { manualTimeoutMs: 5000 });
    const batch = await started(f, QUEUED_RAW);
    await challenge(f, batch);
    const gate = f.gate();
    f.sessions[0].next = async () => { await gate.promise; return ready(); };
    const inspecting = f.manager.inspect(batch, batch.items[0]);
    f.now = batch.pauseDeadlineAt;
    gate.resolve();
    await inspecting;
    await stopped(f, batch);
    assert.equal(f.writes.length, 0);
    assert.equal(f.opens.length, 1);
    assert.deepEqual(batch.items.map(item => item.status), ['failed', 'cancelled', 'cancelled']);
  });

  test('security pause: whole-batch timer erases a paused queue even after the current account succeeded', async t => {
    const f = managerFixture(t, { manualTimeoutMs: 50 });
    const batch = await started(f, QUEUED_RAW);
    await challenge(f, batch);
    f.sessions[0].next = ready();
    await f.manager.inspect(batch, batch.items[0]);
    await immediate();
    assert.equal(batch.status, 'paused');
    f.now = batch.pauseDeadlineAt + 1;
    await stopped(f, batch);
    assert.deepEqual(batch.items.map(item => item.status), ['succeeded', 'cancelled', 'cancelled']);
    assert.equal(f.sessions[0].closeCalls, 1);
    assert.equal(f.opens.length, 1);
    assert.equal(f.writes.length, 1);
  });

  test('security pause: cancel clears the pause timer and queued passwords and discards an in-flight result', async t => {
    const f = managerFixture(t);
    const batch = await started(f, QUEUED_RAW);
    await challenge(f, batch);
    const pauseTimer = batch.pauseTimer;
    const clear = t.mock.method(globalThis, 'clearTimeout');
    const gate = f.gate();
    f.sessions[0].next = async () => { await gate.promise; return ready(); };
    const inspecting = f.manager.inspect(batch, batch.items[0]);
    const cancelled = await f.manager.action(batch.id, OWNER, 'cancel');
    assert.ok(clear.mock.calls.some(call => call.arguments[0] === pauseTimer), 'Cancel must clear the batch pause timer');
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(batch.items.map(item => item.status), ['cancelled', 'cancelled', 'cancelled']);
    assertCredentialsErased(batch);
    gate.resolve();
    await inspecting;
    await immediate();
    assert.equal(f.manager.active, null);
    assert.equal(f.writes.length, 0);
    assert.equal(f.opens.length, 1);
    assert.equal(f.sessions[0].closeCalls, 1);
    assertPublic(cancelled);
  });

  test('manager: ordinary five-minute expiry erases and stops the queued remainder', async t => {
    const f = managerFixture(t, { timeoutMs: 300_000 });
    const batch = await started(f, QUEUED_RAW);
    f.now += 300_000;
    await f.manager.inspect(batch, batch.items[0]);
    await stopped(f, batch);
    await immediate();
    assert.deepEqual(batch.items.map(item => item.status), ['failed', 'cancelled', 'cancelled']);
    assert.equal(f.opens.length, 1);
    assert.equal(f.writes.length, 0);
    assert.equal(f.sessions[0].closeCalls, 1);
  });

  for (const failure of ['browser', 'proxy']) test(`manager: ${failure} startup failure stops the queue before any later credentials are submitted`, async t => {
    const fail = () => { throw new Error(`synthetic-${failure}-startup-failure ${PASSWORD}`); };
    const f = managerFixture(t, failure === 'browser' ? { open: fail } : { resolveProxy: fail });
    const created = f.manager.create(QUEUED_RAW, OWNER);
    const batch = f.manager.batches.get(created.id);
    await stopped(f, batch);
    await immediate();
    assert.deepEqual(batch.items.map(item => item.status), ['failed', 'cancelled', 'cancelled']);
    assert.equal(f.opens.length, failure === 'browser' ? 1 : 0);
    assert.equal(f.writes.length, 0);
    assertPublic(f.manager.public(batch));
  });

  test('challenge classifier: identifier CAPTCHA, ordinary password, OTP and blocked-browser classifications', async () => {
    const { classifyGoogleChallenge } = await import('../server/dola/google-login-challenge.js');
    const cases = [
      [{}, null],
      [{ pathname: '/v3/signin/identifier', text: 'Sign in with your email' }, null],
      [{ pathname: '/v3/signin/challenge/pwd', text: 'Enter your password' }, null],
      [{ pathname: '/v3/signin/challenge/pwd/', text: '输入密码' }, null],
      [{ pathname: '/v3/signin/identifier', text: 'Enter the characters you see' }, 'captcha'],
      [{ pathname: '/v3/signin/identifier', text: '请输入图片中的字符' }, 'captcha'],
      [{ pathname: '/v3/signin/identifier', text: 'Sign in', captchaVisible: true }, 'captcha'],
      [{ pathname: '/v3/signin/challenge/totp', text: 'Enter a verification code' }, 'security'],
      [{ pathname: '/v3/signin/challenge/ipp', text: 'Verify your identity' }, 'security'],
      [{ pathname: '/v3/signin/identifier', text: '2-step verification' }, 'security'],
      [{ pathname: '/v3/signin/rejected', text: '' }, 'browser_blocked'],
      [{ pathname: '/v3/signin/identifier', text: 'This browser or app may not be secure' }, 'browser_blocked'],
    ];
    for (const [input, expected] of cases) assert.equal(classifyGoogleChallenge(input), expected);
  });

  // A small locator fixture, not a browser: only requested synthetic elements
  // exist and only visibility/attribute reads are supported (no input methods).
  function challengePage(pathname, elements = []) {
    return {
      url: () => `https://accounts.google.com${pathname}`,
      locator(selectors) {
        const requested = new Set(selectors.split(','));
        const selected = elements.filter(element => requested.has(element.selector));
        return {
          count: async () => selected.length,
          nth(index) {
            const element = selected[index];
            assert.ok(element, 'Detector must use an existing synthetic element');
            return {
              isVisible: async () => element.visible,
              getAttribute: async name => {
                assert.equal(name, 'autocomplete');
                return element.autocomplete ?? null;
              },
            };
          },
        };
      },
    };
  }

  test('challenge DOM: hidden reCAPTCHA frames and hidden OTP fields do not flag an ordinary password page', async () => {
    const { detectGoogleChallenge } = await import('../server/dola/google-login-challenge.js');
    const page = challengePage('/v3/signin/challenge/pwd', [
      { selector: 'iframe[src*="/recaptcha/"]', visible: false },
      { selector: 'input[autocomplete="one-time-code"]', visible: false, autocomplete: 'one-time-code' },
    ]);
    assert.equal(await detectGoogleChallenge(page, 'Enter your password'), null);
    assert.equal(await detectGoogleChallenge(challengePage('/v3/signin/challenge/pwd'), '输入密码'), null);
  });

  test('challenge DOM: a visible CAPTCHA on the identifier page is detected without reading or solving it', async () => {
    const { detectGoogleChallenge } = await import('../server/dola/google-login-challenge.js');
    for (const selector of ['input[name="ca"]', 'img[src*="/Captcha"]', 'iframe[title*="reCAPTCHA"]']) {
      const page = challengePage('/v3/signin/identifier', [
        { selector: 'iframe[src*="/recaptcha/"]', visible: false },
        { selector, visible: true },
      ]);
      assert.equal(await detectGoogleChallenge(page, 'Sign in'), 'captcha');
    }
  });

  test('challenge DOM: visible OTP is security even on identifier, and blocked-browser text is retained', async () => {
    const { detectGoogleChallenge } = await import('../server/dola/google-login-challenge.js');
    const page = challengePage('/v3/signin/identifier', [
      { selector: 'iframe[src*="/recaptcha/"]', visible: false },
      { selector: 'input[autocomplete="one-time-code"]', visible: true, autocomplete: 'one-time-code' },
    ]);
    assert.equal(await detectGoogleChallenge(page, 'Enter your code'), 'security');
    assert.equal(await detectGoogleChallenge(challengePage('/v3/signin/identifier'), 'This browser or app may not be secure'), 'browser_blocked');
  });

  test('slow typing: waits for the visible form, types sequentially, and checks the entered value', async () => {
    const { typeGoogleCredentialSlowly } = await import('../server/dola/google-login-browser.js');
    const events = [];
    let value = '';
    const page = { url: () => 'https://accounts.google.com/v3/signin/identifier', waitForTimeout: async ms => events.push(['wait', ms]) };
    const input = {
      waitFor: async options => events.push(['visible', options.state]),
      click: async () => events.push(['click']),
      fill: async text => { value = text; events.push(['clear', text]); },
      pressSequentially: async (text, options) => { value = text; events.push(['type', options.delay]); },
      inputValue: async () => value,
    };
    await typeGoogleCredentialSlowly(page, input, EMAIL);
    assert.deepEqual(events, [['visible', 'visible'], ['wait', 800], ['click'], ['clear', ''], ['type', 140], ['wait', 700]]);
    assert.equal(value, EMAIL);
    events.length = 0;
    await assert.rejects(typeGoogleCredentialSlowly({ ...page, url: () => 'https://example.test/' }, input, PASSWORD));
    assert.deepEqual(events, [], 'No input on an unexpected origin');
    await assert.rejects(typeGoogleCredentialSlowly(page, { ...input, inputValue: async () => '' }, EMAIL));
  });

  test('manager: shutdown waits for an in-progress skip cleanup and rejects new batches', async t => {
    const f = managerFixture(t);
    const batch = await started(f);
    const gate = f.gate();
    let closing = false;
    f.sessions[0].close = async () => { closing = true; await gate.promise; };
    const skipped = f.manager.action(batch.id, OWNER, 'skip');
    await waitFor(() => closing, 'skip cleanup');
    let stopped = false;
    const shutdown = f.manager.close().then(() => { stopped = true; });
    await immediate();
    assert.equal(stopped, false);
    assert.throws(() => f.manager.create(RAW, OWNER), e => e.status === 503);
    gate.resolve();
    await Promise.all([skipped, shutdown]);
    assert.equal(stopped, true);
    assert.equal(f.writes.length, 0);
  });

  test('manager: public data excludes passwords, sessions, snapshots, cookies and tokens', async t => {
    const snapshot = { id: 12, cookie: 'synthetic-private-cookie', proxy: 'synthetic-proxy-password' };
    const f = managerFixture(t, { lookupAccount: () => snapshot });
    const created = f.manager.create(`${RAW}\nsynthetic-two@example.test|synthetic-queued-password`, OWNER);
    assertPublic(created);
    await waitFor(() => f.sessions[0]?.inspectCalls, 'initial inspection');
    const batch = f.manager.batches.get(created.id);
    assertPublic(f.manager.public(batch));
    assert.equal(Object.hasOwn(batch.items[0], 'password'), false);
    assert.equal(f.opens[0].secret.password, '');
    f.sessions[0].next = ready(EMAIL, { accessToken: SYNTHETIC_TOKEN });
    await f.manager.inspect(batch, batch.items[0]);
    assertPublic(f.manager.public(batch));
    assert.equal(f.writes[0].ownerId, OWNER);
    assert.equal(f.writes[0].snapshot, snapshot);
    assert.equal(Object.hasOwn(f.writes[0], 'password'), false);
    await f.manager.action(batch.id, OWNER, 'cancel');
    for (const item of batch.items) assert.equal(Object.hasOwn(item, 'password'), false);
  });

  test('preview: only the current owner can view and stale pictures are discarded after cancellation', async t => {
    const f = managerFixture(t);
    const batch = await started(f);
    f.sessions[0].preview = async () => Buffer.from('synthetic-masked-image');
    await assert.rejects(f.manager.preview(batch.id, OTHER), e => e.status === 404);
    assert.equal((await f.manager.preview(batch.id, OWNER)).toString(), 'synthetic-masked-image');
    const gate = f.gate();
    f.sessions[0].preview = async () => { await gate.promise; return Buffer.from('synthetic-stale-image'); };
    const pending = f.manager.preview(batch.id, OWNER);
    const rejected = assert.rejects(pending, e => e.status === 409);
    await f.manager.action(batch.id, OWNER, 'cancel');
    gate.resolve();
    await rejected;
    await assert.rejects(f.manager.preview(batch.id, OWNER), e => e.status === 409);
  });

  test('manager: verified success stores once, closes and clears credentials', async t => {
    const f = managerFixture(t, { open: ({ session }) => { session.next = ready(); return session; } });
    const batch = f.manager.create(RAW, OWNER);
    const internal = f.manager.batches.get(batch.id);
    const result = await done(f, internal);
    assert.equal(result.items[0].status, 'succeeded');
    assert.equal(result.items[0].accountId, 302);
    assert.equal(f.writes.length, 1);
    assert.equal(f.sessions[0].closeCalls, 1);
    assert.equal(f.opens[0].snapshot, null, 'Without an injected resolver, keep the original fake driver account argument');
    assert.equal(f.opens[0].secret.password, '');
    await f.manager.action(batch.id, OWNER, 'check');
    await immediate();
    assert.equal(f.writes.length, 1);
    assertPublic(result);
  });

  for (const [label, candidate] of [
    ['mismatched email', identity('synthetic-other@example.test')],
    ['unverified email', identity(EMAIL, { email_verified: false })],
    ['missing sub', identity(EMAIL, { sub: '' })],
  ]) test(`manager: ${label} never enters the pool`, async t => {
    const f = managerFixture(t, { open: ({ session }) => { session.next = ready(EMAIL, { identity: candidate }); return session; } });
    const created = f.manager.create(RAW, OWNER);
    const result = await done(f, f.manager.batches.get(created.id));
    assert.equal(result.items[0].status, 'failed');
    assert.equal(f.writes.length, 0);
    assert.equal(f.sessions[0].closeCalls, 1);
  });

  test('manager: blocked lookup fails without invoking the driver', async t => {
    const f = managerFixture(t, { lookupAccount: () => ({ blocked: true }) });
    const created = f.manager.create(RAW, OWNER);
    const result = await done(f, f.manager.batches.get(created.id));
    assert.equal(result.items[0].status, 'failed');
    assert.equal(f.opens.length, 0);
    assert.equal(f.writes.length, 0);
    assertPublic(result);
  });

  test('diagnostics: async boot reports phases before returning a session without refreshing the deadline', async t => {
    let gate;
    const f = managerFixture(t, { open: async ({ onStage, session }) => {
      onStage('session_restore');
      await gate.promise;
      session.next = { kind: 'pending' };
      return session;
    } });
    gate = f.gate();
    const created = f.manager.create(RAW, OWNER);
    const batch = f.manager.batches.get(created.id);
    await waitFor(() => f.opens.length, 'boot callback');
    const item = batch.items[0];
    const deadline = item.deadlineAt, timer = item.expiryTimer;
    assert.equal(item.session, undefined);
    assert.equal(item.status, 'opening');
    assert.equal(item.stage, 'session_restore');
    assert.match(item.message, /恢复已保存会话/);
    for (const [stage, label] of [
      ['browser_launch', /启动独立浏览器/], ['proxy_check', /检查代理连通性/],
      ['dola_home', /打开 Dola 首页/], ['dola_login_button', /点击 Dola 登录入口/],
      ['dola_google_button', /点击 Google 登录入口/],
    ]) {
      f.now += 100;
      f.opens[0].onStage(stage);
      assert.equal(item.stage, stage);
      assert.equal(item.status, 'opening');
      assert.match(f.manager.public(batch).items[0].message, label);
      assert.equal(item.deadlineAt, deadline);
      assert.equal(item.expiryTimer, timer);
      assertPublic(f.manager.public(batch));
    }
    gate.resolve();
    await waitFor(() => f.sessions[0].inspectCalls, 'first inspection');
    assert.equal(item.status, 'signing_in');
    assert.match(item.message, /Google 登录入口/);
    assert.equal(item.stage, 'dola_google_button');
    assert.equal(f.writes.length, 0);
  });

  test('diagnostics: every allowed inspection phase and existing OTP progress remains readable', async t => {
    const f = managerFixture(t);
    const batch = await started(f), item = batch.items[0];
    const deadline = item.deadlineAt, timer = item.expiryTimer;
    for (const [stage, label] of [
      ['session_restore', /恢复已保存会话/], ['browser_launch', /启动独立浏览器/],
      ['proxy_check', /检查代理连通性/], ['dola_home', /打开 Dola 首页/],
      ['dola_login_button', /点击 Dola 登录入口/], ['dola_google_button', /点击 Google 登录入口/],
      ['google_redirect', /等待跳转至 Google/], ['google_email', /填写 Google 邮箱/],
      ['google_password', /填写 Google 密码/], ['google_recovery', /填写 Google 恢复邮箱/],
      ['email_otp', /邮件验证码验证/], ['authenticator_otp', /验证器动态码验证/],
      ['google_identity', /核验 Google 身份/], ['dola_binding', /确认 Dola 登录绑定/],
      ['dola_session', /核验 Dola 会话/], ['session_save', /保存登录会话/],
      ['otp_submitted', /动态码已提交/], ['otp_waiting_refresh', /等待刷新间隔/],
      ['otp_same_code', /同一个动态码/],
    ]) {
      f.sessions[0].next = { kind: 'pending', stage };
      await f.manager.inspect(batch, item);
      assert.equal(item.stage, stage);
      assert.match(item.message, label);
      assert.equal(item.deadlineAt, deadline);
      assert.equal(item.expiryTimer, timer);
      assert.equal(item.status, 'signing_in');
      assertPublic(f.manager.public(batch));
    }
    f.sessions[0].next = { kind: 'waiting_user', reason: 'security', stage: 'authenticator_otp' };
    await f.manager.inspect(batch, item);
    assert.match(item.message, /Google 要求安全验证.*当前阶段：验证器动态码验证/);
    const pauseDeadline = item.deadlineAt, pauseTimer = batch.pauseTimer;
    f.now += 1000;
    f.opens[0].onStage('email_otp');
    assert.equal(item.deadlineAt, pauseDeadline);
    assert.equal(batch.pauseTimer, pauseTimer);
    assert.equal(item.status, 'waiting_user');
    assert.equal(batch.status, 'waiting_user');
    assert.equal(f.writes.length, 0);
  });

  test('diagnostics: cancellation during boot freezes the phase, message and deadlines', async t => {
    let gate;
    const f = managerFixture(t, { open: async ({ onStage, session }) => {
      onStage('dola_home');
      await gate.promise;
      onStage('google_password');
      return session;
    } });
    gate = f.gate();
    const created = f.manager.create(QUEUED_RAW, OWNER);
    await waitFor(() => f.opens.length, 'held boot');
    const batch = f.manager.batches.get(created.id), item = batch.items[0];
    await f.manager.action(batch.id, OWNER, 'cancel');
    const snapshot = f.manager.public(batch), deadline = item.deadlineAt;
    f.opens[0].onStage('google_email');
    gate.resolve();
    await waitFor(() => f.sessions[0].closeCalls, 'cancelled boot cleanup');
    assert.deepEqual(f.manager.public(batch), snapshot);
    assert.equal(item.stage, 'dola_home');
    assert.equal(item.deadlineAt, deadline);
    assert.equal(f.sessions[0].inspectCalls, 0);
    assert.equal(f.writes.length, 0);
    assertCredentialsErased(batch);
  });

  test('diagnostics: old item callbacks and inspection results cannot change the next account', async t => {
    const f = managerFixture(t);
    const batch = await started(f, QUEUED_RAW), item = batch.items[0];
    f.opens[0].onStage('dola_login_button');
    const gate = f.gate();
    f.sessions[0].next = async () => { await gate.promise; return { kind: 'pending', stage: 'google_password' }; };
    const inspecting = f.manager.inspect(batch, item);
    await f.manager.action(batch.id, OWNER, 'skip');
    await waitFor(() => f.sessions[1]?.inspectCalls, 'next account');
    const snapshot = f.manager.public(batch), deadline = batch.items[1].deadlineAt;
    f.opens[0].onStage('session_save');
    gate.resolve();
    await inspecting;
    assert.equal(item.stage, 'dola_login_button');
    assert.equal(batch.items[1].stage, undefined);
    assert.equal(batch.items[1].deadlineAt, deadline);
    assert.deepEqual(f.manager.public(batch), snapshot);
    assert.equal(f.writes.length, 0);
  });

  test('diagnostics: expired boot callbacks are ignored before and after the timeout is processed', async t => {
    let gate;
    const f = managerFixture(t, { open: async ({ onStage, session }) => {
      onStage('dola_home');
      await gate.promise;
      return session;
    } });
    gate = f.gate();
    const created = f.manager.create(QUEUED_RAW, OWNER);
    await waitFor(() => f.opens.length, 'held boot');
    const batch = f.manager.batches.get(created.id), item = batch.items[0];
    const snapshot = f.manager.public(batch), deadline = item.deadlineAt;
    f.now = deadline;
    f.opens[0].onStage('google_password');
    assert.equal(item.stage, 'dola_home');
    assert.equal(item.deadlineAt, deadline);
    assert.deepEqual(f.manager.public(batch), snapshot);
    await f.manager.expire(batch, item);
    const expired = f.manager.public(batch);
    assert.match(item.message, /^等待登录超过 5 分钟.*没有继续尝试其他账号；最后阶段：打开 Dola 首页$/);
    f.opens[0].onStage('google_email');
    gate.resolve();
    await waitFor(() => f.sessions[0].closeCalls, 'expired boot cleanup');
    assert.deepEqual(f.manager.public(batch), expired);
    assert.equal(f.sessions[0].inspectCalls, 0);
    assertCredentialsErased(batch);
  });

  for (const security of [false, true]) test(`diagnostics: ${security ? 'ten' : 'five'}-minute expiry preserves its cause and last live phase`, async t => {
    const f = managerFixture(t, { timeoutMs: 300_000 });
    const batch = await started(f, QUEUED_RAW), item = batch.items[0];
    f.sessions[0].next = security
      ? { kind: 'waiting_user', reason: 'security', stage: 'authenticator_otp' }
      : { kind: 'pending', stage: 'dola_google_button' };
    await f.manager.inspect(batch, item);
    assert.equal(item.deadlineAt - f.now, security ? 600_000 : 300_000);
    const gate = f.gate();
    f.sessions[0].next = async () => { await gate.promise; return ready(EMAIL, { stage: 'session_save' }); };
    const inspecting = f.manager.inspect(batch, item);
    f.now = item.deadlineAt;
    gate.resolve();
    await inspecting;
    await done(f, batch);
    assert.match(item.message, security
      ? /^安全验证等待超过 10 分钟.*没有继续尝试其他账号；最后阶段：验证器动态码验证$/
      : /^等待登录超过 5 分钟.*没有继续尝试其他账号；最后阶段：查找并点击 Google 登录入口$/);
    assert.equal(item.stage, security ? 'authenticator_otp' : 'dola_google_button');
    assert.deepEqual(batch.items.map(entry => entry.status), ['failed', 'cancelled', 'cancelled']);
    assert.equal(f.writes.length, 0);
    assertCredentialsErased(batch);
    assertPublic(f.manager.public(batch));
  });

  test('diagnostics: unknown stages/reasons, inherited keys and raw secrets are never retained or displayed', async t => {
    const f = managerFixture(t);
    const batch = await started(f), item = batch.items[0];
    const unsafe = [PASSWORD, EMAIL, RECOVERY_EMAIL, VERIFICATION_URL, GOOGLE_SESSION_URL,
      '654321', '<input value="synthetic-DOM-secret">', 'unknown_phase', '__proto__', 'constructor', 'toString',
      '', null, undefined, 42, ['google_password'], { [Symbol.toPrimitive]() { throw new Error(PASSWORD); } }];
    for (const stage of unsafe) f.opens[0].onStage(stage);
    assert.equal(Object.hasOwn(item, 'stage'), false);
    f.sessions[0].next = { kind: 'pending', stage: 'dola_login_button' };
    await f.manager.inspect(batch, item);
    for (const value of unsafe) {
      f.opens[0].onStage(value);
      for (const kind of ['pending', 'waiting_user']) {
        f.sessions[0].next = { kind, stage: value, reason: value, message: PASSWORD, error: VERIFICATION_URL };
        await f.manager.inspect(batch, item);
        assert.equal(item.stage, 'dola_login_button');
        assert.equal(typeof item.message, 'string');
        assert.match(item.message, /当前阶段：查找并点击 Dola 登录入口/);
        for (const raw of unsafe.filter(value => typeof value === 'string' && value)) assert.ok(!item.message.includes(raw));
        assert.equal(Object.hasOwn(item, 'reason'), false);
        assertPublic(f.manager.public(batch));
      }
    }
    assert.equal(f.writes.length, 0);
  });

  for (const [reason, expected] of [
    ['browser_closed', /^登录窗口已关闭/], ['credentials_rejected', /^Google 拒绝了账号或密码/],
    ['identity_mismatch', /^返回的 Google 账号与输入邮箱不一致/],
    [undefined, /^登录未完成/], [PASSWORD, /^登录未完成/], ['__proto__', /^登录未完成/],
    ['constructor', /^登录未完成/], [{ toString() { throw new Error(PASSWORD); } }, /^登录未完成/],
  ]) test(`diagnostics: failed reason ${typeof reason === 'string' && ['browser_closed', 'credentials_rejected', 'identity_mismatch'].includes(reason) ? reason : 'unknown'} uses only safe fixed text`, async t => {
    const f = managerFixture(t, { open: ({ onStage, session }) => {
      onStage('dola_home');
      session.next = { kind: 'failed', stage: 'dola_google_button', reason, message: PASSWORD, error: VERIFICATION_URL };
      return session;
    } });
    const created = f.manager.create(RAW, OWNER), batch = f.manager.batches.get(created.id);
    const result = await done(f, batch);
    assert.match(result.items[0].message, expected);
    assert.match(result.items[0].message, /；最后阶段：查找并点击 Google 登录入口$/);
    assert.equal(batch.items[0].stage, 'dola_google_button');
    assert.equal(f.writes.length, 0);
    assert.equal(f.sessions[0].closeCalls, 1);
    assertPublic(result);
    assert.ok(!result.items[0].message.includes(VERIFICATION_URL));
  });

  test('diagnostics: boot and inspect exceptions retain the last phase without exposing raw errors', async t => {
    const opening = managerFixture(t, { open: ({ onStage }) => {
      onStage('proxy_check');
      throw new Error(VERIFICATION_URL);
    } });
    const created = opening.manager.create(QUEUED_RAW, OWNER);
    const failed = await done(opening, opening.manager.batches.get(created.id));
    assert.match(failed.items[0].message, /登录窗口启动失败.*最后阶段：检查代理连通性/);
    assert.ok(!failed.items[0].message.includes(VERIFICATION_URL));
    const checking = managerFixture(t);
    const batch = await started(checking), item = batch.items[0];
    checking.opens[0].onStage('dola_home');
    checking.sessions[0].next = () => { throw new Error(PASSWORD); };
    await checking.manager.inspect(batch, item);
    assert.match(item.message, /暂未确认登录身份.*当前阶段：打开 Dola 首页/);
    assertPublic(checking.manager.public(batch));
  });

  test('manager: raw open/inspect/store errors never reach public state', async t => {
    const unsafeError = () => new Error(`${PASSWORD} ${SYNTHETIC_TOKEN} https://example.test/#secret=synthetic-private-cookie`);
    const opening = managerFixture(t, { open: () => { throw unsafeError(); } });
    const first = opening.manager.create(RAW, OWNER);
    const failed = await done(opening, opening.manager.batches.get(first.id));
    assert.equal(failed.items[0].status, 'failed');
    assertPublic(failed);

    const checking = managerFixture(t, { storeAccount: () => { throw unsafeError(); } });
    const batch = await started(checking);
    checking.sessions[0].next = () => { throw unsafeError(); };
    await checking.manager.inspect(batch, batch.items[0]);
    assertPublic(checking.manager.public(batch));
    assert.equal(batch.items[0].status, 'waiting_user');
    checking.sessions[0].next = ready();
    await checking.manager.inspect(batch, batch.items[0]);
    assertPublic(checking.manager.public(batch));
    assert.equal(batch.items[0].status, 'failed');
    assert.equal(batch.items[0].accountId, undefined);
  });

  test('manager: failed browser result closes without saving', async t => {
    const f = managerFixture(t, { open: ({ session }) => { session.next = { kind: 'failed', error: PASSWORD }; return session; } });
    const created = f.manager.create(RAW, OWNER);
    const result = await done(f, f.manager.batches.get(created.id));
    assert.equal(result.items[0].status, 'failed');
    assert.equal(f.writes.length, 0);
    assert.equal(f.sessions[0].closeCalls, 1);
    assertPublic(result);
  });

  test('manager: cancellation during inspection discards late ready result and clears queued passwords', async t => {
    const f = managerFixture(t);
    const batch = await started(f, `${RAW}\nsynthetic-two@example.test|synthetic-queued-password`);
    const gate = f.gate();
    f.sessions[0].next = async () => { await gate.promise; return ready(); };
    const inspecting = f.manager.inspect(batch, batch.items[0]);
    await waitFor(() => batch.items[0].busy, 'held inspection');
    const cancelled = await f.manager.action(batch.id, OWNER, 'cancel');
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(cancelled.items.map(item => item.status), ['cancelled', 'cancelled']);
    for (const item of batch.items) assert.equal(Object.hasOwn(item, 'password'), false);
    gate.resolve();
    await inspecting;
    await immediate();
    assert.equal(f.writes.length, 0);
    assert.equal(f.opens.length, 1);
    assert.equal(f.sessions[0].closeCalls, 1);
    assert.equal(f.opens[0].signal.aborted, true);
    assert.equal(f.manager.active, null);
    assertPublic(cancelled);
  });

  test('manager: cancelled in-flight inspection blocks a new batch until pending persistence settles', async t => {
    const f = managerFixture(t);
    const batch = await started(f, `${RAW}\nsynthetic-two@example.test|synthetic-pending`);
    const gate = f.gate();
    f.sessions[0].next = async () => { await gate.promise; return ready(); };
    const inspecting = f.manager.inspect(batch, batch.items[0]);
    await f.manager.action(batch.id, OWNER, 'cancel');
    for (const item of batch.items) assert.equal(Object.hasOwn(item, 'password'), false);
    assert.throws(() => f.manager.create(RAW, OWNER), e => e.status === 409);
    gate.resolve();
    await inspecting;
    await immediate();
    assert.equal(f.writes.length, 0);
    const next = f.manager.create(RAW, OWNER);
    assert.notEqual(next.id, batch.id);
  });

  test('manager: shutdown waits for a late inspection/cache operation without importing it', async t => {
    const f = managerFixture(t);
    const batch = await started(f);
    const gate = f.gate();
    f.sessions[0].next = async () => { await gate.promise; return ready(); };
    const inspecting = f.manager.inspect(batch, batch.items[0]);
    let stopped = false;
    const closing = f.manager.close().then(() => { stopped = true; });
    await immediate();
    assert.equal(stopped, false);
    gate.resolve();
    await Promise.all([inspecting, closing]);
    assert.equal(stopped, true);
    assert.equal(f.writes.length, 0);
  });

  test('manager: cancellation during open closes late session without inspection/import', async t => {
    let gate;
    const f = managerFixture(t, { open: async ({ session }) => { await gate.promise; return session; } });
    gate = f.gate();
    const created = f.manager.create(RAW, OWNER);
    await waitFor(() => f.opens.length === 1, 'held driver open');
    await f.manager.action(created.id, OWNER, 'cancel');
    gate.resolve();
    await waitFor(() => f.sessions[0].closeCalls === 1, 'late session close');
    assert.equal(f.sessions[0].inspectCalls, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(f.opens[0].secret.password, '');
  });

  test('manager: cancelling a pending open clears its password before the driver resolves', async t => {
    let gate;
    const f = managerFixture(t, { open: async ({ session }) => { await gate.promise; return session; } });
    gate = f.gate();
    const created = f.manager.create(RAW, OWNER);
    await waitFor(() => f.opens.length === 1, 'held driver open');
    await f.manager.action(created.id, OWNER, 'cancel');
    assert.equal(f.opens[0].signal.aborted, true);
    assert.equal(f.opens[0].secret.password, '', 'Cancellation must erase the pending driver input immediately');
  });

  test('manager: timeout closes a waiting session without importing', async t => {
    const f = managerFixture(t);
    const batch = await started(f);
    f.now += 5000;
    await f.manager.inspect(batch, batch.items[0]);
    const result = await done(f, batch);
    assert.equal(result.items[0].status, 'failed');
    assert.match(result.items[0].message, /超过/);
    assert.equal(f.writes.length, 0);
    assert.equal(f.sessions[0].closeCalls, 1);
    assert.equal(f.opens[0].secret.password, '');
  });

  test('manager: a ready result arriving after the timeout must not be imported', async t => {
    const f = managerFixture(t);
    const batch = await started(f);
    const gate = f.gate();
    f.sessions[0].next = async () => { await gate.promise; return ready(); };
    const inspecting = f.manager.inspect(batch, batch.items[0]);
    f.now += 5001;
    gate.resolve();
    await inspecting;
    const result = await done(f, batch);
    assert.equal(f.writes.length, 0, 'Late ready result crossed the timeout import boundary');
    assert.equal(result.items[0].status, 'failed');
  });

  test('manager: timeout progresses while an inspection remains pending', async t => {
    const f = managerFixture(t, { timeoutMs: 30, pollMs: 5 });
    const batch = await started(f);
    const gate = f.gate();
    f.sessions[0].next = async () => { await gate.promise; return ready(); };
    void f.manager.inspect(batch, batch.items[0]);
    await waitFor(() => batch.items[0].status === 'failed', 'expiry during held inspection');
    assert.equal(batch.items[0].status, 'failed', 'Busy inspection must not suppress expiry');
    assert.equal(f.opens[0].signal.aborted, true);
    assert.equal(f.writes.length, 0);
  });

  test('manager: pending driver open is also subject to the configured timeout', async t => {
    let gate;
    const f = managerFixture(t, {
      pollMs: 5, timeoutMs: 20,
      open: async ({ session }) => { await gate.promise; return session; },
    });
    gate = f.gate();
    const created = f.manager.create(RAW, OWNER);
    await waitFor(() => f.opens.length === 1, 'held driver open');
    f.now += 21;
    await delay(50); // Give the real polling interval several turns; clock is injected.
    const item = f.manager.batches.get(created.id).items[0];
    assert.equal(item.status, 'failed', 'Open must time out even before a session handle exists');
    assert.equal(f.opens[0].secret.password, '');
  });

  test('manager: skip closes before advancing in input order and ignores stale result', async t => {
    const events = [];
    const f = managerFixture(t, { open: ({ secret, session }) => {
      events.push(`open:${secret.email}`);
      session.close = async () => { session.closeCalls++; events.push(`close:${secret.email}`); };
      return session;
    } });
    const second = 'synthetic-two@example.test';
    const third = 'synthetic-three@example.test';
    const batch = await started(f, `${RAW}\n${second}|synthetic-second\n${third}|synthetic-third`);
    const gate = f.gate();
    f.sessions[0].next = async () => { await gate.promise; return ready(); };
    const stale = f.manager.inspect(batch, batch.items[0]);
    await f.manager.action(batch.id, OWNER, 'skip');
    assert.equal(f.opens[0].signal.aborted, true);
    await waitFor(() => f.sessions[1]?.inspectCalls, 'second item');
    gate.resolve();
    await stale;
    assert.equal(f.writes.length, 0);
    f.sessions[1].next = ready(second);
    await f.manager.inspect(batch, batch.items[1]);
    await waitFor(() => f.sessions[2]?.inspectCalls, 'third item');
    await f.manager.action(batch.id, OWNER, 'skip');
    const result = await done(f, batch);
    assert.deepEqual(events, [`open:${EMAIL}`, `close:${EMAIL}`, `open:${second}`, `close:${second}`, `open:${third}`, `close:${third}`]);
    assert.deepEqual(result.items.map(item => item.status), ['cancelled', 'succeeded', 'cancelled']);
    assert.deepEqual(f.writes.map(write => write.email), [second]);
  });

  test('manager: repeated checks do not run concurrent inspections or duplicate writes', async t => {
    const f = managerFixture(t);
    const batch = await started(f);
    const gate = f.gate();
    f.sessions[0].next = async () => { await gate.promise; return ready(); };
    const pending = f.manager.inspect(batch, batch.items[0]);
    const calls = f.sessions[0].inspectCalls;
    await Promise.all(Array.from({ length: 6 }, () => f.manager.action(batch.id, OWNER, 'check')));
    await immediate();
    assert.equal(f.sessions[0].inspectCalls, calls);
    gate.resolve();
    await pending;
    await done(f, batch);
    assert.equal(f.writes.length, 1);
  });

  test('manager: close cancels active work, erases queue, clears metadata and is repeatable', async t => {
    const f = managerFixture(t);
    const batch = await started(f, `${RAW}\nsynthetic-two@example.test|synthetic-queued-password`);
    await f.manager.close();
    await f.manager.close();
    assert.equal(f.manager.batches.size, 0);
    assert.equal(f.manager.current(OWNER), null);
    assert.equal(f.manager.active, null);
    assert.equal(f.sessions[0].closeCalls, 1);
    assert.deepEqual(batch.items.map(item => item.status), ['cancelled', 'cancelled']);
    for (const item of batch.items) assert.equal(Object.hasOwn(item, 'password'), false);
    assert.equal(f.writes.length, 0);
  });

  test('manager: failing session close does not block the next account', async t => {
    const f = managerFixture(t, { open: ({ session }) => {
      session.next = { kind: 'failed' };
      session.close = async () => { session.closeCalls++; throw new Error(PASSWORD); };
      return session;
    } });
    const created = f.manager.create(`${RAW}\nsynthetic-two@example.test|synthetic-second-password`, OWNER);
    const result = await done(f, f.manager.batches.get(created.id));
    assert.equal(f.opens.length, 2);
    assert.deepEqual(result.items.map(item => item.status), ['failed', 'failed']);
    assertPublic(result);
  });

  test('manager: shutdown waits for a pending open and for its late session to close', async t => {
    let openGate, closeGate;
    const f = managerFixture(t, { open: async ({ session }) => {
      session.close = async () => { session.closeCalls++; await closeGate.promise; };
      await openGate.promise;
      return session;
    } });
    openGate = f.gate();
    closeGate = f.gate();
    f.manager.create(RAW, OWNER);
    await waitFor(() => f.opens.length === 1, 'held driver open before shutdown');
    let settled = false;
    const closing = f.manager.close().then(() => { settled = true; });
    try {
      await immediate();
      assert.equal(settled, false, 'Shutdown returned while driver.open was still pending');
      assert.equal(f.opens[0].signal.aborted, true);
      assert.equal(f.opens[0].secret.password, '');
      openGate.resolve();
      await waitFor(() => f.sessions[0].closeCalls === 1, 'late session closing');
      assert.equal(settled, false, 'Shutdown returned before the late session finished closing');
      closeGate.resolve();
      await closing;
      assert.equal(f.sessions[0].inspectCalls, 0);
      assert.equal(f.writes.length, 0);
      assert.equal(f.manager.batches.size, 0);
    } finally {
      openGate.resolve();
      closeGate.resolve();
      await closing;
    }
  });

  test('store: new verified account saves only filtered Dola cookies, no Google/password/profile secrets', () => {
    const store = createGoogleAccountStore(db);
    const exported = [
      ...Object.entries(cookies()).map(([name, value]) => ({ domain: '.dola.com', name, value })),
      { domain: '.google.com', name: 'SID', value: 'synthetic-google-SID' },
      { domain: 'accounts.google.com', name: 'ttwid', value: 'synthetic-google-overwrite' },
    ];
    // Domain filtering belongs to dolaCookieMap; the SQL store receives its map.
    const input = storeInput({ email: ' Synthetic-One\\@EXAMPLE.TEST ', cookies: core.dolaCookieMap(exported),
      password: PASSWORD, accessToken: SYNTHETIC_TOKEN, googleCookies: exported.slice(-2),
      identity: identity(EMAIL, { access_token: SYNTHETIC_TOKEN, refresh_token: 'synthetic-refresh-token' }),
      profile: { ...ready().profile, raw: { password: PASSWORD, googleToken: SYNTHETIC_TOKEN } },
    });
    const saved = store.storeAccount(input);
    const row = accountRow(saved.id);
    assert.equal(row.label, EMAIL);
    assert.equal(row.status, 'valid');
    assert.equal(row.imported_by, OWNER);
    assert.equal(row.proxy, SYNTHETIC_PROXY);
    assert.equal(row.sec_user_id, 'synthetic-dola-entity');
    assert.deepEqual(JSON.parse(row.cookie), cookies());
    assert.equal(row.cookie_names, 'odin_tt,ttwid');
    const canonical = Object.entries(cookies()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(';');
    assert.equal(row.cookie_hash, createHash('sha256').update(canonical).digest('hex').slice(0, 32));
    assert.equal(row.credits, null);
    const logs = db.prepare('SELECT * FROM audit_logs').all();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].user_id, OWNER);
    assert.equal(logs[0].target_id, String(saved.id));
    const persisted = JSON.stringify(poolState());
    for (const sentinel of [PASSWORD, SYNTHETIC_TOKEN, 'synthetic-google-SID', 'synthetic-google-overwrite',
      'synthetic-refresh-token', 'synthetic-google-sub']) assert.ok(!persisted.includes(sentinel), 'Google secret persisted');
    assert.ok(!JSON.stringify(logs).includes('synthetic-ttwid'));
  });

  test('store: refuses missing/unverified Google identity, Dola profile, or required cookies', () => {
    const store = createGoogleAccountStore(db);
    const invalid = [
      { identity: null }, { identity: identity('synthetic-other@example.test') },
      { identity: identity(EMAIL, { email_verified: 'true' }) }, { identity: identity(EMAIL, { sub: '' }) },
      { profile: null }, { profile: { ok: false, entityId: 'synthetic-dola-entity' } }, { profile: { ok: true } },
      { cookies: {} }, { cookies: { ttwid: 'synthetic-only' } }, { cookies: { odin_tt: 'synthetic-only' } },
    ];
    for (const patch of invalid) rejectWithoutWrite(store, storeInput(patch), /login_not_verified/);
  });

  test('store: disabled and duplicate labels are blocked by lookup and import', () => {
    const store = createGoogleAccountStore(db);
    assert.equal(store.lookupAccount(EMAIL), null);
    seedAccount({ status: 'disabled' });
    const snapshot = store.lookupAccount(' SYNTHETIC-ONE\\@example.test ');
    assert.equal(snapshot.blocked, true);
    rejectWithoutWrite(store, storeInput({ snapshot }), /account_changed_during_login/);
    seedAccount({ label: 'SYNTHETIC-ONE@EXAMPLE.TEST' });
    assert.equal(store.lookupAccount(EMAIL).blocked, true);
    rejectWithoutWrite(store, storeInput({ snapshot }), /ambiguous_account/);
  });

  test('store: active video states block lookup/import; terminal states do not', () => {
    const store = createGoogleAccountStore(db);
    const id = seedAccount();
    for (const status of ['queued', 'submitting', 'generating', 'resolving']) {
      db.exec('DELETE FROM dola_videos');
      db.prepare('INSERT INTO dola_videos (account_id,status,created_at,updated_at) VALUES (?,?,?,?)').run(id, status, OLD_AT, OLD_AT);
      const snapshot = store.lookupAccount(EMAIL);
      assert.equal(snapshot.blocked, true);
      rejectWithoutWrite(store, storeInput({ snapshot }), /account_changed_during_login/);
    }
    for (const status of ['ready', 'failed', 'cancelled']) {
      db.prepare('UPDATE dola_videos SET status=?').run(status);
      assert.equal(store.lookupAccount(EMAIL).blocked, false);
    }
    db.exec('DELETE FROM dola_videos');
  });

  test('store: refuses changed account identity and another account owning the Dola ID', () => {
    const store = createGoogleAccountStore(db);
    seedAccount({ sec_user_id: 'synthetic-different-entity' });
    rejectWithoutWrite(store, storeInput({ snapshot: store.lookupAccount(EMAIL) }), /account_identity_changed/);
    db.exec('DELETE FROM dola_accounts');
    seedAccount({ label: 'synthetic-other@example.test' });
    rejectWithoutWrite(store, storeInput(), /identity_already_in_pool/);
  });

  for (const [field, changed] of [
    ['cookie_hash', 'synthetic-changed-hash'], ['proxy', 'http://changed.example.test:8080'],
    ['updated_at', '2002-02-02T00:00:00.000Z'], ['status', 'disabled'],
  ]) test(`store: snapshot rejects changed ${field} without any write`, () => {
    const store = createGoogleAccountStore(db);
    const id = seedAccount();
    const snapshot = store.lookupAccount(EMAIL);
    db.prepare(`UPDATE dola_accounts SET ${field}=? WHERE id=?`).run(changed, id);
    rejectWithoutWrite(store, storeInput({ snapshot }), /account_changed_during_login/);
  });

  test('store: snapshot rejects account appearing, disappearing, replacement ID, or newly busy account', () => {
    const store = createGoogleAccountStore(db);
    let id = seedAccount();
    rejectWithoutWrite(store, storeInput(), /account_changed_during_login/);
    const snapshot = store.lookupAccount(EMAIL);
    db.exec('DELETE FROM dola_accounts');
    rejectWithoutWrite(store, storeInput({ snapshot }), /account_changed_during_login/);
    id = seedAccount({ cookie_hash: snapshot.cookie_hash });
    rejectWithoutWrite(store, storeInput({ snapshot }), /account_changed_during_login/);
    const fresh = store.lookupAccount(EMAIL);
    db.prepare('INSERT INTO dola_videos (account_id,status,created_at,updated_at) VALUES (?,?,?,?)')
      .run(id, 'generating', OLD_AT, OLD_AT);
    rejectWithoutWrite(store, storeInput({ snapshot: fresh }), /account_changed_during_login/);
    db.exec('DELETE FROM dola_videos');
  });

  test('store: refresh preserves proxy, balance, conversions, quotas and existing ownership', () => {
    const store = createGoogleAccountStore(db);
    const id = seedAccount({ status: 'invalid', last_error: 'synthetic-expired' });
    const beforeRow = accountRow(id);
    const saved = store.storeAccount(storeInput({ snapshot: store.lookupAccount(EMAIL), ownerId: OTHER }));
    assert.equal(saved.id, id);
    const row = accountRow(id);
    const preserved = ['label', 'proxy', 'credits', 'credits_source', 'credits_at', 'converted_credits', 'counted_at',
      'quota_remaining', 'quota_total', 'quota_at', 'quota_source', 'exit_ip', 'last_used_at', 'cooldown_until',
      'note', 'imported_by', 'created_at'];
    for (const field of preserved) assert.equal(row[field], beforeRow[field], `Unexpected change to ${field}`);
    assert.equal(row.status, 'valid');
    assert.equal(row.last_error, '');
    assert.deepEqual(JSON.parse(row.cookie), cookies());
    assert.notEqual(row.cookie_hash, beforeRow.cookie_hash);
    assert.notEqual(row.updated_at, OLD_AT);
    assert.equal(db.prepare('SELECT count(*) AS n FROM dola_accounts').get().n, 1);
    assert.equal(db.prepare('SELECT user_id FROM audit_logs').get().user_id, OTHER);
  });

  test('store: profile.id fallback and cookie hash ordering are stable', () => {
    const store = createGoogleAccountStore(db);
    const input = storeInput({ profile: { ok: true, id: 'synthetic-dola-entity', userName: 'Synthetic fallback' } });
    const { id } = store.storeAccount(input);
    const first = accountRow(id);
    store.storeAccount({ ...input, snapshot: store.lookupAccount(EMAIL), cookies: { odin_tt: cookies().odin_tt, ttwid: cookies().ttwid } });
    assert.equal(accountRow(id).cookie_hash, first.cookie_hash);
    assert.equal(accountRow(id).account_hint, 'Synthetic fallback');
  });

  test('store: missing or invalid login proxy cannot create a directly connected account', () => {
    const store = createGoogleAccountStore(db);
    for (const loginProxy of [undefined, null, '', '  ', 'ftp://proxy.example.test:21', 'synthetic-malformed-proxy']) {
      rejectWithoutWrite(store, storeInput({ loginProxy }), error => error instanceof Error
        && !error.message.includes('synthetic-proxy-password'));
    }
  });

  test('store: refresh fills an empty proxy and preserves existing balances', () => {
    const store = createGoogleAccountStore(db);
    const id = seedAccount({ proxy: '' });
    const beforeRow = accountRow(id);
    const result = store.storeAccount(storeInput({ snapshot: store.lookupAccount(EMAIL) }));
    assert.equal(result.id, id);
    assert.equal(accountRow(id).proxy, SYNTHETIC_PROXY);
    for (const field of ['credits', 'credits_source', 'credits_at', 'converted_credits', 'counted_at',
      'quota_remaining', 'quota_at', 'quota_source']) assert.equal(accountRow(id)[field], beforeRow[field]);
  });

  test('store: a nonempty bound proxy cannot be silently replaced or cleared', () => {
    const store = createGoogleAccountStore(db);
    seedAccount();
    const snapshot = store.lookupAccount(EMAIL);
    for (const loginProxy of ['', 'http://synthetic-new:synthetic-new-password@new.example.test:8080']) {
      rejectWithoutWrite(store, storeInput({ snapshot, loginProxy }), error => error instanceof Error);
    }
    assert.equal(store.lookupAccount(EMAIL).proxy, SYNTHETIC_PROXY);
  });

  test('store: saves valid exit IPs and preserves the previous IP when the optional observation is absent or invalid', () => {
    const store = createGoogleAccountStore(db);
    const { id } = store.storeAccount(storeInput({ exitIp: '192.0.2.31' }));
    assert.equal(accountRow(id).exit_ip, '192.0.2.31');
    store.storeAccount(storeInput({ snapshot: store.lookupAccount(EMAIL), exitIp: '2001:db8::31' }));
    assert.equal(accountRow(id).exit_ip, '2001:db8::31');
    for (const exitIp of [undefined, null, '', 'synthetic-not-an-ip', '192.0.2.999']) {
      store.storeAccount(storeInput({ snapshot: store.lookupAccount(EMAIL), exitIp }));
      assert.equal(accountRow(id).exit_ip, '2001:db8::31');
      assert.equal(accountRow(id).proxy, SYNTHETIC_PROXY);
    }
  });

  for (const existing of [false, true]) test(`store: audit failure rolls back ${existing ? 'refresh' : 'new account'} atomically`, () => {
    const store = createGoogleAccountStore(db);
    if (existing) seedAccount({ status: 'invalid' });
    const input = storeInput({ snapshot: store.lookupAccount(EMAIL) });
    db.exec(`CREATE TEMP TRIGGER synthetic_google_audit_failure BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'dola.google_login_import'
      BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;`);
    try {
      rejectWithoutWrite(store, input, /synthetic audit failure/);
    } finally {
      db.exec('DROP TRIGGER synthetic_google_audit_failure');
    }
  });

  test('route: 401 for anonymous/invalid/expired/disabled; 403 without dola:import', async () => {
    let calls = 0;
    const router = createGoogleLoginRouter(() => { calls++; throw new Error('Manager must not be resolved'); });
    const endpoints = [
      { url: '/batches/current' }, { method: 'POST', url: '/batches', body: { raw: RAW } },
      { method: 'POST', url: '/preview', body: { raw: RAW } },
      { method: 'POST', url: '/batches/synthetic-id/action', body: { action: 'cancel' } },
    ];
    for (const endpoint of endpoints) {
      for (const token of [null, 'synthetic-invalid-jwt', auth.signJwt({ uid: ownerUser.id }, -1), disabledUser.token,
        auth.signJwt({ uid: 999_999 })]) {
        const response = await route(router, { ...endpoint, token });
        assert.equal(response.status, 401);
        assert.ok(!JSON.stringify(response.body).includes(PASSWORD));
      }
      assert.equal((await route(router, { ...endpoint, user: readerUser })).status, 403);
    }
    assert.equal(calls, 0);
    assert.deepEqual(poolState(), { accounts: [], audit: [] });
  });

  test('route: preview returns only email/method/booleans without manager, audit, writes or browser', async t => {
    seedAccount(); // A preview must also leave an existing synthetic account untouched.
    const router = readOnlyRouteFixture(t);
    const raw = [
      ` Synthetic-One\\@EXAMPLE.TEST |${PASSWORD}`,
      `synthetic-recovery@example.test----${PASSWORD}----${RECOVERY_EMAIL}`,
      `synthetic-verification@example.test----${PASSWORD}----${RECOVERY_EMAIL}----${VERIFICATION_URL}`,
      `synthetic-link@example.test----${PASSWORD}----no----${GOOGLE_SESSION_URL}`,
    ].join('\r\n');
    const expected = { ok: true, items: [
      { email: EMAIL, loginMethod: 'password', hasRecoveryEmail: false, hasVerificationUrl: false },
      { email: 'synthetic-recovery@example.test', loginMethod: 'password', hasRecoveryEmail: true, hasVerificationUrl: false },
      { email: 'synthetic-verification@example.test', loginMethod: 'password', hasRecoveryEmail: true, hasVerificationUrl: true },
      { email: 'synthetic-link@example.test', loginMethod: 'google_link', hasRecoveryEmail: false, hasVerificationUrl: false },
    ] };
    for (const options of [{}, { manual: false }]) {
      const body = { raw, ...options, ownerId: otherUser.id };
      const response = await route(router, { method: 'POST', url: '/preview', body });
      assert.equal(response.status, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(response.body, expected, 'No secrets, account IDs, profile IDs or extra fields');
      assert.equal(response.req.body, body);
      assert.equal(Object.hasOwn(body, 'raw'), false);
      assertPreviewRedacted(response);
    }
    const body = { raw: ` Synthetic-One\\@EXAMPLE.TEST \nsynthetic-manual@example.test`, manual: true };
    const response = await route(router, { method: 'POST', url: '/preview', body });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, items: [EMAIL, 'synthetic-manual@example.test'].map(email => ({
      email, loginMethod: 'manual', hasRecoveryEmail: false, hasVerificationUrl: false,
    })) });
    assert.equal(Object.hasOwn(body, 'raw'), false);
    assertPreviewRedacted(response);
  });

  test('route: preview rejects remote peers despite forwarded headers and accepts only local socket forms', async t => {
    const router = readOnlyRouteFixture(t);
    for (const remoteAddress of ['203.0.113.10', '::ffff:203.0.113.10', '2001:db8::1',
      '192.168.1.10', '127.0.0.2', 'localhost', null]) {
      const response = await route(router, {
        method: 'POST', url: '/preview', body: { raw: RAW }, remoteAddress,
        headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '::1',
          forwarded: 'for=127.0.0.1;proto=https', 'x-forwarded-proto': 'https' },
      });
      assert.equal(response.status, 403);
      assert.equal(response.body.ok, false);
      assert.equal(response.headers['cache-control'], 'no-store');
      assertPreviewRedacted(response, [EMAIL]);
    }
    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const body = { raw: RAW };
      const response = await route(router, { method: 'POST', url: '/preview', body, remoteAddress });
      assert.equal(response.status, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(Object.hasOwn(body, 'raw'), false);
      assertPreviewRedacted(response);
    }
  });

  test('route: malformed preview is redacted, returns no partial items and erases body.raw', async t => {
    const router = readOnlyRouteFixture(t);
    const malformed = [
      undefined, null, {}, [], 17, '', ' \n\r\n', 'x'.repeat(32769),
      EMAIL, `${EMAIL},${PASSWORD}`, `${EMAIL}|`, `bad@@example.test|${PASSWORD}`,
      `${RAW}\0`, `${RAW}\nSYNTHETIC-ONE@EXAMPLE.TEST|${PASSWORD}`,
      `${EMAIL}----${PASSWORD}----synthetic-invalid-recovery`,
      `${EMAIL}----${PASSWORD}----${RECOVERY_EMAIL}----http://verification.example.invalid/?token=synthetic-verification-secret`,
      `${EMAIL}----${PASSWORD}----no----https://gapi.mailsapi.com/google/login?uid=synthetic-google-link-secret&extra=1`,
      `${RAW}\nsynthetic-invalid-second-line-${SYNTHETIC_TOKEN}`,
    ];
    for (const body of [...malformed.map(raw => ({ raw })), { raw: RAW, manual: true }, undefined, null, {}]) {
      const response = await route(router, { method: 'POST', url: '/preview', body });
      assert.equal(response.status, 400);
      assert.deepEqual(Object.keys(response.body).sort(), ['message', 'ok']);
      assert.equal(response.body.ok, false);
      assert.equal(typeof response.body.message, 'string');
      assert.ok(response.body.message.length > 0);
      assert.equal(response.headers['cache-control'], 'no-store');
      if (body) assert.equal(Object.hasOwn(body, 'raw'), false);
      assertPreviewRedacted(response, [EMAIL, 'bad@@example.test', 'synthetic-invalid-recovery']);
    }
  });

  test('route: preview and batches reject non-boolean manual before manager resolution and erase raw', async t => {
    const router = readOnlyRouteFixture(t);
    for (const url of ['/preview', '/batches']) {
      for (const manual of [null, 'true', 'false', '', 0, 1, [], {}, [true], SYNTHETIC_TOKEN]) {
        const body = { raw: RAW, manual };
        const response = await route(router, { method: 'POST', url, body });
        assert.equal(response.status, 400);
        assert.deepEqual(response.body, { ok: false, message: '登录方式无效' });
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.equal(Object.hasOwn(body, 'raw'), false);
        assertPreviewRedacted(response, [EMAIL]);
      }
    }
  });

  test('route: batches forwards manual booleans and authenticated owner, erases raw and redacts audit', async () => {
    const calls = [];
    const batch = { id: 'synthetic-batch-id', status: 'running', items: [{ email: EMAIL, status: 'queued' }] };
    const manager = {
      current(ownerId) { calls.push(['current', ownerId]); return batch; },
      create(raw, ownerId, options) { calls.push(['create', raw, ownerId, options]); return batch; },
      async action(id, ownerId, action) { calls.push(['action', id, ownerId, action]); return batch; },
    };
    const router = createGoogleLoginRouter(() => manager);
    for (const options of [{}, { manual: false }, { manual: true }]) {
      const body = { raw: options.manual ? EMAIL : RAW, ownerId: otherUser.id, ...options };
      const created = await route(router, { method: 'POST', url: '/batches', body });
      assert.equal(created.status, 201);
      assert.equal(Object.hasOwn(body, 'raw'), false);
      assert.equal(created.headers['cache-control'], 'no-store');
      assert.ok(!JSON.stringify(created.body).includes(PASSWORD));
    }
    assert.equal((await route(router)).status, 200);
    assert.equal((await route(router, { method: 'POST', url: '/batches/synthetic-batch-id/action', body: { action: 'cancel', ownerId: otherUser.id } })).status, 200);
    assert.deepEqual(calls, [
      ['create', RAW, ownerUser.id, { manual: false }],
      ['create', RAW, ownerUser.id, { manual: false }],
      ['create', EMAIL, ownerUser.id, { manual: true }],
      ['current', ownerUser.id], ['action', batch.id, ownerUser.id, 'cancel'],
    ]);
    const logs = db.prepare('SELECT * FROM audit_logs ORDER BY id').all();
    assert.equal(logs.length, 4);
    for (const log of logs) assert.equal(log.user_id, ownerUser.id);
    assert.ok(!JSON.stringify(logs).includes(PASSWORD));
  });

  test('route: remote peer rejected even with forged loopback forwarded header; loopback forms accepted', async () => {
    let calls = 0;
    const router = createGoogleLoginRouter(() => ({ current() { calls++; return null; } }));
    for (const remoteAddress of ['203.0.113.10', '::ffff:203.0.113.10', '2001:db8::1', undefined]) {
      // Explicit null is used for a missing socket address because the helper has a loopback default.
      const response = await route(router, { remoteAddress: remoteAddress ?? null, headers: { 'x-forwarded-for': '127.0.0.1' } });
      assert.equal(response.status, 403);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    assert.equal(calls, 0);
    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      assert.equal((await route(router, { remoteAddress })).status, 200);
    }
    assert.equal(calls, 3);
  });

  test('route: real manager enforces batch 409 and cross-owner 404 with synthetic driver', async t => {
    const f = managerFixture(t);
    const router = createGoogleLoginRouter(() => f.manager);
    const first = await route(router, { method: 'POST', url: '/batches', body: { raw: RAW, ownerId: otherUser.id } });
    assert.equal(first.status, 201);
    assertPublic(first.body.batch);
    const conflictBody = { raw: RAW };
    const second = await route(router, { method: 'POST', url: '/batches', user: otherUser, body: conflictBody });
    assert.equal(second.status, 409);
    assert.equal(Object.hasOwn(conflictBody, 'raw'), false);
    assert.equal((await route(router, { user: otherUser })).body.batch, null);
    const actionUrl = `/batches/${first.body.batch.id}/action`;
    assert.equal((await route(router, { method: 'POST', url: actionUrl, user: otherUser, body: { action: 'cancel' } })).status, 404);
    const cancelled = await route(router, { method: 'POST', url: actionUrl, body: { action: 'cancel' } });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.batch.status, 'cancelled');
    assert.equal(f.writes.length, 0);
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_logs').all()).includes(PASSWORD));
  });

  test('route: malformed input is redacted/erased; unexpected manager errors become generic 500', async t => {
    const f = managerFixture(t);
    const realRouter = createGoogleLoginRouter(() => f.manager);
    const body = { raw: `${EMAIL},synthetic-no-pipe` };
    const invalid = await route(realRouter, { method: 'POST', url: '/batches', body });
    assert.equal(invalid.status, 400);
    assert.equal(Object.hasOwn(body, 'raw'), false);
    assert.ok(!JSON.stringify(invalid.body).includes(PASSWORD));
    const fail = () => { throw new Error(`${PASSWORD} ${SYNTHETIC_TOKEN}`); };
    const brokenRouter = createGoogleLoginRouter(() => ({ create: fail, action: fail }));
    const failedBody = { raw: RAW };
    for (const request of [
      { method: 'POST', url: '/batches', body: failedBody },
      { method: 'POST', url: '/batches/synthetic-id/action', body: { action: 'check' } },
    ]) {
      const response = await route(brokenRouter, request);
      assert.equal(response.status, 500);
      assert.ok(!JSON.stringify(response.body).includes(PASSWORD));
      assert.ok(!JSON.stringify(response.body).includes(SYNTHETIC_TOKEN));
    }
    assert.equal(Object.hasOwn(failedBody, 'raw'), false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit_logs').get().n, 0);
  });
});
