/**
 * Isolated automatic-maintenance regressions.
 * Run from any directory: node --test /absolute/path/to/admin/test/maintenance.mjs
 *
 * Only a fresh mkdtemp SQLite database and synthetic cookies/JWTs are used.
 * DOLA_BASE is set before backend imports; HTTP is restricted to two local test
 * servers and a read-only upstream endpoint allowlist. No main server, browser,
 * generator, existing smoke suite, or existing account database is imported.
 */
import strictAssert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay, setImmediate as immediate } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const LAUNCH = '/alice/user/launch';
const PULL = '/alice/user/config/pull';
const PROFILE = '/alice/profile/self_brief';
const SUBSCRIPTION = '/alice/commerce/sale/subscription/entry/config/';
const MODEL_CONFIG = '/alice/slot/action_bar_v3/get_item_conf';
const BRIEF_LIST = '/alice/slot/action_bar_v3/brief_list';
const UPSTREAM_PATHS = new Set([LAUNCH, PULL, PROFILE, SUBSCRIPTION, MODEL_CONFIG, BRIEF_LIST]);
const OLD_AT = '2001-01-01T00:00:00.000Z';
const FIXED_AT = '2026-09-19T12:00:00.000Z';
const ENV_KEYS = ['ADMIN_DB', 'ADMIN_JWT_SECRET', 'ADMIN_INIT_PASSWORD', 'DOLA_BASE', 'DOLA_AUTO_MAINTENANCE'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let assertionCount = 0;
// Count actual executed node:assert calls, including parameter matrices and
// isolation checks, separately from node:test's count of named test cases.
const assert = Object.fromEntries(['ok', 'equal', 'deepEqual', 'notEqual', 'match', 'fail'].map(method => [
  method, (...args) => { assertionCount++; return strictAssert[method](...args); },
]));
const scenarios = new Map();
const requests = [];
const blockedRequests = [];
const fixtureErrors = [];
let tempDirectory, fakeServer, apiServer, fakeBase, apiBase, db, jobs, maintenance, observations;
let auth, adminToken, readerToken, stopMaintenance;
let sequence = 0, totalUpstreamRequests = 0, totalJobs = 0;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, label, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await delay(5);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function healthyResponse(endpoint) {
  if (endpoint === LAUNCH) return { code: 0, data: { user_info: { user_id: 'synthetic-user' } } };
  if (endpoint === PROFILE) return {
    code: 0, data: { profile_brief: { id: 'synthetic-user', entity_id: 'synthetic-entity', nickname: 'Fixture' } },
  };
  if (endpoint === SUBSCRIPTION) return { code: 0, data: { subs_status: 'free', has_active_subscription: false } };
  return { code: 0, data: {} };
}

async function handleFakeDola(req, res) {
  const endpoint = new URL(req.url, fakeBase).pathname;
  const key = /(?:^|;\s*)ttwid=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const scenario = scenarios.get(key);
  assert.ok(UPSTREAM_PATHS.has(endpoint), `Unexpected upstream endpoint: ${endpoint}`);
  assert.equal(req.method, 'POST');
  assert.ok(scenario, 'Only explicitly constructed synthetic cookies may reach the fixture');
  assert.match(req.headers.cookie, /odin_tt=synthetic-/);
  for await (const _chunk of req) { /* Consume the local request body. */ }
  const occurrence = (scenario.counts.get(endpoint) || 0) + 1;
  scenario.counts.set(endpoint, occurrence);
  requests.push({ key, endpoint, occurrence });
  totalUpstreamRequests++;
  if (scenario.hold?.endpoint === endpoint && scenario.hold.occurrence === occurrence) {
    scenario.hold.entered = true;
    await scenario.hold.gate.promise;
  }
  const override = scenario.responses?.[endpoint];
  if (override?.disconnect) { res.destroy(); return; }
  const response = override?.body ?? healthyResponse(endpoint);
  res.writeHead(override?.status ?? 200, { 'content-type': 'application/json', connection: 'close' });
  res.end(typeof response === 'string' ? response : JSON.stringify(response));
}

function setting(key, value) {
  assert.equal(db.prepare('UPDATE settings SET value=? WHERE key=?').run(String(value), key).changes, 1);
}

function account(options = {}, scenarioOptions = {}) {
  const key = `synthetic-${++sequence}`;
  const scenario = { ...scenarioOptions, counts: new Map() };
  scenarios.set(key, scenario);
  const cookie = options.cookie ?? `ttwid=${key}; odin_tt=synthetic-session-${sequence}`;
  const row = {
    label: key, cookie, cookie_hash: createHash('sha256').update(cookie).digest('hex').slice(0, 32),
    cookie_names: 'ttwid,odin_tt', status: 'valid', proxy: '', credits: 37,
    credits_source: 'previous verified balance', credits_at: OLD_AT,
    quota_remaining: null, quota_at: null, quota_source: null,
    created_at: OLD_AT, updated_at: OLD_AT, ...options,
  };
  const fields = Object.keys(row);
  const result = db.prepare(`INSERT INTO dola_accounts (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`)
    .run(...Object.values(row));
  const id = Number(result.lastInsertRowid);
  return { id, key, cookie, scenario, read: () => db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(id) };
}

function hold(endpoint = PROFILE, occurrence = 1) {
  return { endpoint, occurrence, entered: false, gate: deferred() };
}

function track(job) {
  totalJobs++;
  return job;
}

function createCheck(ids, { automatic = true, type = 'dola_check', concurrency = 1 } = {}) {
  return track(jobs.createJob({ type, ids, concurrency, payload: { autoMaintenance: automatic } }));
}

async function finished(job) {
  const result = await waitFor(() => {
    const current = jobs.getJob(job.id);
    return current && !['queued', 'running'].includes(current.status) ? current : null;
  }, `job ${job.id} to finish`);
  assert.equal(result.status, 'done', JSON.stringify(result));
  assert.equal(result.done, result.total, JSON.stringify(result));
  assert.equal(result.ok_count + result.fail_count, result.total);
  assert.equal(result.result.details.length, result.total);
  return result;
}

function balance(row) {
  return { credits: row.credits, source: row.credits_source, at: row.credits_at };
}

function quota(row) {
  return { remaining: row.quota_remaining, total: row.quota_total, at: row.quota_at, source: row.quota_source };
}

async function api(endpoint, { token = adminToken, method = 'GET', body } = {}) {
  const response = await fetch(`${apiBase}${endpoint}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

describe('isolated Dola automatic maintenance', { concurrency: false }, () => {
  before(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'dola-maintenance-test-'));
    process.env.ADMIN_DB = join(tempDirectory, 'isolated.sqlite');
    process.env.ADMIN_JWT_SECRET = randomBytes(32).toString('hex');
    process.env.ADMIN_INIT_PASSWORD = 'synthetic-test-password-only';
    process.env.DOLA_AUTO_MAINTENANCE = 'true';
    fakeServer = createServer((req, res) => {
      handleFakeDola(req, res).catch(error => {
        fixtureErrors.push(error.message);
        res.writeHead(500, { connection: 'close' });
        res.end('fixture failure');
      });
    });
    fakeBase = await listen(fakeServer);
    process.env.DOLA_BASE = fakeBase;
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const allowed = url.origin === fakeBase
        ? UPSTREAM_PATHS.has(url.pathname)
        : url.origin === apiBase && (
          ['/api/settings', '/api/dola/accounts', '/api/dola/accounts/import', '/api/dola/maintenance/run'].includes(url.pathname)
          || /^\/api\/dola\/accounts\/\d+\/action$/.test(url.pathname)
        );
      if (!allowed) {
        blockedRequests.push(`${url.origin}${url.pathname}`);
        throw new Error('Maintenance test blocked a non-fixture request');
      }
      const headers = new Headers(init.headers);
      headers.set('connection', 'close');
      return originalFetch(input, { ...init, headers, redirect: 'error' });
    };

    // All backend modules must be imported after the isolation environment exists.
    const database = await import('../server/db.js');
    assert.equal(database.DB_PATH, process.env.ADMIN_DB);
    db = await database.initDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dola_accounts').get().n, 0);
    jobs = await import('../server/jobs.js');
    maintenance = await import('../server/routes/dola.js');
    observations = await import('../server/dola/account-observations.js');
    const provider = await import('../server/dola/provider.js');
    assert.equal(provider.DOLA_BASE, fakeBase);
    auth = await import('../server/auth.js');
    const { default: express } = await import('express');
    const { default: settingsRouter } = await import('../server/routes/settings.js');
    const app = express();
    app.use(express.json());
    app.use(auth.authMiddleware);
    app.use('/api/dola', maintenance.default);
    app.use('/api/settings', settingsRouter);
    apiServer = createServer(app);
    apiBase = await listen(apiServer);
    const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
    adminToken = auth.signJwt({ uid: adminId });
    const role = db.prepare('INSERT INTO roles (code,name,permissions,created_at) VALUES (?,?,?,?)')
      .run('maintenance-test-reader', 'Fixture reader', JSON.stringify(['setting:view', 'dola:list']), OLD_AT);
    const reader = db.prepare('INSERT INTO users (username,password_hash,role_id,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run('maintenance-test-reader', 'synthetic-unused-password-hash', role.lastInsertRowid, OLD_AT, OLD_AT);
    readerToken = auth.signJwt({ uid: Number(reader.lastInsertRowid) });
  });

  beforeEach(() => {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").get().n, 0);
    db.exec('DELETE FROM dola_videos; DELETE FROM jobs; DELETE FROM dola_accounts; DELETE FROM audit_logs;');
    scenarios.clear();
    requests.length = 0;
    process.env.DOLA_AUTO_MAINTENANCE = 'true';
    for (const [key, value] of Object.entries({
      dola_auto_maintenance_enabled: true, dola_auto_cleanup_invalid: true, dola_auto_quota_probe: true,
      dola_auto_maintenance_interval_minutes: 180, dola_check_concurrency: 2,
      dola_http_timeout: 1, dola_use_browser: false,
    })) setting(key, value);
  });

  afterEach(async () => {
    stopMaintenance?.();
    stopMaintenance = undefined;
    for (const scenario of scenarios.values()) scenario.hold?.gate.resolve();
    await waitFor(() => db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").get().n === 0,
      'all test jobs to drain');
    // Let jobs.kick's final queued setImmediate settle before resetting fixtures.
    await immediate();
    assert.deepEqual(blockedRequests, [], 'No external or generation endpoint is permitted');
    assert.deepEqual(fixtureErrors, [], 'Every upstream call must match a synthetic fixture');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credit_conversions').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM point_transactions').get().n, 0);
  });

  after(async () => {
    stopMaintenance?.();
    for (const scenario of scenarios.values()) scenario.hold?.gate.resolve();
    try {
      if (db) await waitFor(() => db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").get().n === 0,
        'final job cleanup');
    } finally {
      await Promise.all([closeServer(apiServer), closeServer(fakeServer)]);
      db?.raw.close();
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    }
    console.log(`Assertions executed (including fixture/isolation checks): ${assertionCount}`);
    console.log(`Isolation evidence: ${totalJobs} tracked jobs, ${totalUpstreamRequests} local upstream requests, `
      + `${blockedRequests.length} forbidden requests, ${fixtureErrors.length} fixture errors; temporary DB removed and servers closed.`);
  });

  describe('pure observations', () => {
    for (const code of [710012001, 710012014]) {
      for (const source of ['pull', 'launch', 'profile']) {
        test(`explicit expiry ${code} from ${source} requires HTTP 200`, () => {
          const session = { valid: false, pullStatus: 200, pullCode: 0, launchStatus: 200, launchCode: 0 };
          const profile = { ok: false, status: 200, code: 710010202 };
          if (source === 'profile') profile.code = code;
          else session[`${source}Code`] = code;
          assert.equal(observations.accountHealth(session, profile).kind, 'invalid');
          if (source === 'profile') profile.status = 500;
          else session[`${source}Status`] = 500;
          assert.equal(observations.accountHealth(session, profile).kind, 'unknown');
        });
      }
    }

    test('conflicting expiry and a healthy profile stay unknown; consistent health is valid', () => {
      const session = { valid: false, pullStatus: 200, pullCode: 710012001, launchStatus: 200, launchCode: 0 };
      assert.equal(observations.accountHealth(session, { ok: true, status: 200, code: 0 }).kind, 'unknown');
      assert.equal(observations.accountHealth({ ...session, valid: true, pullCode: 0 },
        { ok: true, status: 200, code: 0 }).kind, 'valid');
    });

    test('explicit account balance paths accept positive values and genuine zero', () => {
      for (const endpoint of [LAUNCH, PROFILE, SUBSCRIPTION]) {
        for (const prefix of ['data', 'data.user_info', 'data.profile_brief', 'data.credit_info', 'data.credits_info']) {
          for (const field of ['credit_balance', 'remaining_credits', 'available_credits', 'credits_remaining', 'credits_available']) {
            for (const value of [0, 17]) {
              const hit = { field: `${prefix}.${field}`, value };
              assert.deepEqual(observations.creditBalanceFromHits([hit], endpoint), hit, `${endpoint}: ${hit.field}=${value}`);
            }
          }
        }
        for (const field of ['data.credit_info.balance', 'data.credits_info.balance']) {
          assert.deepEqual(observations.creditBalanceFromHits([{ field, value: 0 }], endpoint), { field, value: 0 });
        }
      }
    });

    test('model prices, offers, arbitrary nested fields and unsupported endpoints are not balances', () => {
      const fields = [
        'data.model.credit_balance', 'data.model_config.credit_balance', 'data.cost.remaining_credits',
        'data.price.available_credits', 'data.credit_multiplier', 'data.total_credits', 'data.used_credits',
        'data.daily_limit', 'data.quota_remaining', 'data.balance', 'data.credit',
        'data.offers.credit_balance', 'data.offers.credit_info.balance', 'data.subscription.credit_balance',
        'data.user_info.offers.remaining_credits', 'data.profile_brief.credit_info.balance',
        'data.user_info.credit_balance.extra', 'payload.data.credit_balance', 'credit_balance',
        'data.items[0].remaining_credits',
      ];
      for (const field of fields) {
        for (const value of [0, 99]) {
          assert.equal(observations.creditBalanceFromHits([{ field, value }], PROFILE), null, field);
        }
      }
      for (const value of [-1, NaN, Infinity, '0', null, undefined]) {
        assert.equal(observations.creditBalanceFromHits([{ field: 'data.credit_balance', value }], PROFILE), null);
      }
      for (const endpoint of [MODEL_CONFIG, BRIEF_LIST, PULL, '/unrecognized']) {
        assert.equal(observations.creditBalanceFromHits([{ field: 'data.credit_balance', value: 10 }], endpoint), null, endpoint);
      }
      const valid = { field: 'data.credit_info.balance', value: 0 };
      assert.deepEqual(observations.creditBalanceFromHits([
        { field: 'data.offers.credit_balance', value: 999 }, valid,
      ], PROFILE), valid);
    });

    test('receipt parsing distinguishes true zero from absent remaining/cost', () => {
      for (const [raw, expected] of [
        ['今日剩余 0 个视频生成额度，消耗 2 个视频生成额度', { remaining: 0, cost: 2 }],
        ['今日剩余12个视频生成额度\n消耗 0 个视频生成额度', { remaining: 12, cost: 0 }],
        ['消耗2个视频生成额度', { remaining: null, cost: 2 }],
        ['今日剩余 4 个视频生成额度', { remaining: 4, cost: null }],
        ['生成成功', { remaining: null, cost: null }],
        ['', { remaining: null, cost: null }],
        [null, { remaining: null, cost: null }],
      ]) assert.deepEqual(observations.parseVideoQuotaReceipt(raw), expected);
    });

    test('only a same-day, nonfuture generation receipt confirms quota; zero is confirmed', () => {
      const fresh = { quota_remaining: 0, quota_at: FIXED_AT, quota_source: 'generation_receipt' };
      assert.deepEqual(observations.quotaObservation(fresh, FIXED_AT), { state: 'confirmed', remaining: 0 });
      for (const patch of [
        { quota_at: '2026-09-18T23:59:59.999Z' }, { quota_at: '2026-09-19T12:00:00.001Z' },
        { quota_at: null }, { quota_source: null }, { quota_source: 'legacy_default' },
      ]) assert.deepEqual(observations.quotaObservation({ ...fresh, ...patch }, FIXED_AT), { state: 'stale', remaining: null });
      for (const value of [null, undefined, -1, NaN, Infinity, '0']) {
        assert.deepEqual(observations.quotaObservation({ ...fresh, quota_remaining: value }, FIXED_AT),
          { state: 'unknown', remaining: null });
      }
    });

    test('quota summary excludes cooling, invalid, disabled and unknown accounts', () => {
      const row = { status: 'valid', quota_remaining: 2, quota_at: FIXED_AT, quota_source: 'generation_receipt' };
      const rows = [row, { ...row, quota_remaining: 0 },
        { ...row, quota_remaining: 1, cooldown_until: FIXED_AT },
        { ...row, quota_remaining: 100, cooldown_until: '2026-09-19T12:01:00.000Z' },
        ...['invalid', 'disabled', 'unknown'].map(status => ({ ...row, status, quota_remaining: 100 })),
        { ...row, quota_at: OLD_AT }, { ...row, quota_source: null }, { ...row, quota_remaining: null }];
      assert.deepEqual(observations.summarizeQuota(rows, FIXED_AT),
        { quotaRemaining: 3, quotaKnown: 3, quotaUnknown: 3, quotaStale: 2 });
      assert.deepEqual(observations.summarizeQuota([{ ...row, quota_remaining: 0 }], FIXED_AT),
        { quotaRemaining: 0, quotaKnown: 1, quotaUnknown: 0, quotaStale: 0 });
      assert.deepEqual(observations.summarizeQuota([{ ...row, quota_at: OLD_AT }], FIXED_AT),
        { quotaRemaining: null, quotaKnown: 0, quotaUnknown: 1, quotaStale: 1 });
      assert.deepEqual(observations.summarizeQuota([], FIXED_AT),
        { quotaRemaining: null, quotaKnown: 0, quotaUnknown: 0, quotaStale: 0 });
    });
  });

  describe('real handlers against a local fake Dola', () => {
    for (const code of [710012001, 710012014]) {
      test(`HTTP 200 expiry ${code} quarantines without deleting or changing cookie/balance`, async () => {
        const acc = account({}, { responses: { [PROFILE]: { body: { code, msg: 'Session expired' } } } });
        const previous = acc.read();
        const result = await finished(createCheck([acc.id]));
        const current = acc.read();
        assert.equal(result.fail_count, 1);
        assert.equal(current.status, 'invalid');
        assert.equal(current.cookie, previous.cookie);
        assert.equal(current.cookie_hash, previous.cookie_hash);
        assert.deepEqual(balance(current), balance(previous));
        assert.notEqual(current.last_check_at, previous.last_check_at);
        assert.match(current.last_error, new RegExp(String(code)));
      });
    }

    for (const [name, response] of [
      ['HTTP 500 even with an expiry-shaped code', { status: 500, body: { code: 710012014 } }],
      ['unknown business error', { body: { code: 710010202 } }],
      ['rate-limit business code', { body: { code: 710022002 } }],
      ['HTTP 429', { status: 429, body: { code: 710022002 } }],
      ['non-JSON upstream response', { body: '<html>temporary failure</html>' }],
      ['connection failure', { disconnect: true }],
    ]) {
      test(`${name} preserves a valid account and its prior balance timestamp`, async () => {
        const acc = account({}, { responses: { [PROFILE]: response } });
        const previous = acc.read();
        const result = await finished(createCheck([acc.id]));
        assert.equal(result.fail_count, 1);
        assert.equal(acc.read().status, 'valid');
        assert.equal(acc.read().cookie, previous.cookie);
        assert.deepEqual(balance(acc.read()), balance(previous));
        assert.ok(acc.read().last_error);
      });
    }

    test('contradictory successful profile and expired session preserve the prior valid state', async () => {
      const acc = account({}, { responses: { [PULL]: { body: { code: 710012001 } } } });
      const result = await finished(createCheck([acc.id]));
      assert.equal(result.fail_count, 1);
      assert.equal(acc.read().status, 'valid');
      assert.match(acc.read().last_error, /不一致/);
    });

    test('cleanup switch prevents invalid quarantine while retaining the expiry evidence and cookie', async () => {
      setting('dola_auto_cleanup_invalid', false);
      const acc = account({}, { responses: { [PROFILE]: { body: { code: 710012014 } } } });
      await finished(createCheck([acc.id]));
      assert.equal(acc.read().status, 'unknown');
      assert.equal(acc.read().cookie, acc.cookie);
      assert.match(acc.read().last_error, /710012014/);
    });

    test('missing required synthetic cookie is quarantined without HTTP or deletion', async () => {
      const acc = account({ cookie: 'ttwid=synthetic-incomplete' });
      const result = await finished(createCheck([acc.id]));
      assert.equal(result.fail_count, 1);
      assert.equal(acc.read().status, 'invalid');
      assert.equal(acc.read().cookie, acc.cookie);
      assert.match(acc.read().last_error, /odin_tt/);
      assert.equal(requests.length, 0);
    });

    for (const type of ['dola_check', 'dola_credits']) {
      test(`disabled accounts are untouched by ${type}, even when explicitly queued`, async () => {
        const acc = account({ status: 'disabled' });
        const previous = acc.read();
        await finished(createCheck([acc.id], { type }));
        assert.deepEqual(acc.read(), previous);
        assert.equal(requests.length, 0);
      });
    }

    for (const phase of ['health', 'automatic credits']) {
      test(`disable during ${phase} discards the in-flight result`, async () => {
        const paused = hold(PROFILE, phase === 'health' ? 1 : 2);
        const acc = account({}, { hold: paused, responses: {
          [PROFILE]: { body: { ...healthyResponse(PROFILE), data: { ...healthyResponse(PROFILE).data, credit_balance: 900 } } },
        } });
        const job = createCheck([acc.id]);
        await waitFor(() => paused.entered, `paused ${phase} response`);
        const disabled = await api(`/api/dola/accounts/${acc.id}/action`, { method: 'POST', body: { action: 'disable' } });
        assert.equal(disabled.status, 200);
        const disabledRow = acc.read();
        assert.equal(disabledRow.status, 'disabled');
        paused.gate.resolve();
        await finished(job);
        assert.deepEqual(acc.read(), disabledRow, 'No field may be overwritten by an older in-flight result');
      });
    }

    test('replacing a cookie during health verification discards the old result', async () => {
      const paused = hold();
      const acc = account({}, { hold: paused });
      const job = createCheck([acc.id]);
      await waitFor(() => paused.entered, 'paused profile response');
      db.prepare('UPDATE dola_accounts SET cookie=?, cookie_hash=?, status=? WHERE id=?')
        .run('ttwid=synthetic-replacement; odin_tt=synthetic-replacement', 'synthetic-replacement-hash', 'unknown', acc.id);
      const replaced = acc.read();
      paused.gate.resolve();
      await finished(job);
      assert.deepEqual(acc.read(), replaced);
    });

    for (const type of ['dola_check', 'dola_credits']) {
      test(`${type}: absent balance and misleading model/offer costs preserve credits/source/timestamp`, async () => {
        const misleading = {
          offers: { credit_balance: 999 }, model_config: { remaining_credits: 700 },
          cost: { available_credits: 12 }, daily_limit: 4, total_credits: 1000,
          profile_brief: { credit_info: { balance: 888 } },
        };
        const responses = Object.fromEntries([...UPSTREAM_PATHS].map(endpoint => [endpoint, {
          body: { code: 0, data: { ...healthyResponse(endpoint).data, ...misleading,
            ...(endpoint === MODEL_CONFIG ? { credit_balance: 12345 } : {}) } },
        }]));
        const acc = account({}, { responses });
        const previous = acc.read();
        const result = await finished(createCheck([acc.id], { type }));
        assert.equal(result.ok_count, type === 'dola_check' ? 1 : 0);
        assert.equal(acc.read().status, 'valid');
        assert.deepEqual(balance(acc.read()), balance(previous));
        assert.equal(acc.read().cookie, previous.cookie);
        assert.ok(requests.some(r => r.endpoint === MODEL_CONFIG), 'The credit probe must actually run');
      });
    }

    test('a never-observed balance stays null with no invented observation timestamp', async () => {
      const acc = account({ credits: null, credits_source: null, credits_at: null });
      assert.equal((await finished(createCheck([acc.id]))).ok_count, 1);
      assert.deepEqual(balance(acc.read()), { credits: null, source: null, at: null });
      assert.equal(acc.read().status, 'valid');
    });

    for (const endpoint of [LAUNCH, PROFILE]) {
      test(`a genuine zero from ${endpoint} updates the old balance and observation timestamp`, async () => {
        const acc = account({}, { responses: { [endpoint]: {
          body: { code: 0, data: { ...healthyResponse(endpoint).data, credit_info: { balance: 0 } } },
        } } });
        if (endpoint === LAUNCH) setting('dola_auto_quota_probe', false);
        const previous = acc.read();
        assert.equal((await finished(createCheck([acc.id]))).ok_count, 1);
        assert.equal(acc.read().credits, 0);
        assert.notEqual(acc.read().credits_at, previous.credits_at);
        assert.ok(Number.isFinite(Date.parse(acc.read().credits_at)));
        assert.match(acc.read().credits_source, /credit_info\.balance/);
        assert.equal(acc.read().status, 'valid');
      });
    }

    test('disabled quota probing performs only health calls and keeps prior credit observation', async () => {
      setting('dola_auto_quota_probe', false);
      const acc = account();
      const previous = acc.read();
      await finished(createCheck([acc.id]));
      assert.deepEqual(requests.map(r => r.endpoint), [LAUNCH, PULL, PROFILE, SUBSCRIPTION]);
      assert.deepEqual(balance(acc.read()), balance(previous));
    });

    for (const status of ['queued', 'submitting', 'generating', 'resolving']) {
      test(`maintenance skips an account with a ${status} video row without starting generation`, async () => {
        const acc = account();
        const previous = acc.read();
        db.prepare('INSERT INTO dola_videos (account_id,status,created_at,updated_at) VALUES (?,?,?,?)')
          .run(acc.id, status, OLD_AT, OLD_AT);
        const result = await finished(createCheck([acc.id]));
        assert.equal(result.ok_count, 1);
        assert.deepEqual(acc.read(), previous);
        assert.equal(requests.length, 0);
      });
    }

    test('stale receipt displays unknown and maintenance never refills or refreshes it', async () => {
      const acc = account({ quota_remaining: 0, quota_total: 4, quota_at: OLD_AT, quota_source: 'generation_receipt' });
      const previous = acc.read();
      await finished(createCheck([acc.id]));
      assert.deepEqual(quota(acc.read()), quota(previous));
      const response = await api('/api/dola/accounts');
      assert.equal(response.status, 200);
      const item = response.body.items.find(row => row.id === acc.id);
      assert.equal(item.quotaState, 'stale');
      assert.equal(item.quotaKnown, false);
      assert.equal(item.quotaAvailable, null);
      assert.equal(item.quota_remaining, 0);
      assert.equal(response.body.summary.quotaRemaining, null);
      assert.equal(response.body.summary.quotaUnknown, 1);
      assert.equal(response.body.summary.quotaStale, 1);
    });

    test('HTTP account summary includes only fresh, available, valid quota observations', async () => {
      const current = new Date().toISOString();
      const base = { quota_remaining: 2, quota_at: current, quota_source: 'generation_receipt' };
      account(base);
      account({ ...base, quota_remaining: 0 });
      account({ ...base, quota_remaining: 1, cooldown_until: OLD_AT });
      account({ ...base, quota_remaining: 100, cooldown_until: new Date(Date.now() + 60_000).toISOString() });
      for (const status of ['invalid', 'disabled', 'unknown']) account({ ...base, quota_remaining: 100, status });
      account({ ...base, quota_at: OLD_AT });
      account({ ...base, quota_source: null });
      account({ ...base, quota_remaining: null });
      const response = await api('/api/dola/accounts');
      assert.equal(response.status, 200);
      const summary = response.body.summary;
      assert.deepEqual({ remaining: summary.quotaRemaining, known: summary.quotaKnown, unknown: summary.quotaUnknown, stale: summary.quotaStale },
        { remaining: 3, known: 3, unknown: 3, stale: 2 });
      for (const row of response.body.items) {
        assert.equal(row.hasCookie, true);
        assert.match(row.cookie, /^\*\*\*/);
        assert.notEqual(row.cookie, db.prepare('SELECT cookie FROM dola_accounts WHERE id=?').get(row.id).cookie);
      }
      assert.equal(requests.length, 0);
    });
  });

  describe('review regressions: re-import and in-flight writes', () => {
    test('same-label re-import refreshes the cookie in place and keeps a disabled account disabled', async () => {
      const acc = account({ status: 'disabled', label: 'synthetic-reimport-account', note: 'retain-note' });
      const previous = acc.read();
      const newCookie = 'ttwid=synthetic-new-import; odin_tt=synthetic-new-session';
      const response = await api('/api/dola/accounts/import', { method: 'POST', body: {
        items: [{ label: previous.label, raw: newCookie }],
      } });
      assert.equal(response.status, 201);
      assert.equal(response.body.inserted, 0);
      assert.equal(response.body.refreshed, 1);
      assert.deepEqual(response.body.refreshedIds, [acc.id]);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dola_accounts').get().n, 1);
      const current = acc.read();
      assert.equal(current.status, 'disabled');
      assert.equal(current.label, previous.label);
      assert.equal(current.note, previous.note);
      assert.deepEqual(JSON.parse(current.cookie), { ttwid: 'synthetic-new-import', odin_tt: 'synthetic-new-session' });
      assert.notEqual(current.cookie_hash, previous.cookie_hash);
      assert.deepEqual(balance(current), balance(previous));
      assert.equal(maintenance.enqueueDolaMaintenance().skipped, 'empty');
      assert.equal(requests.length, 0);
    });

    test('disable then same-label re-import during a check cannot be undone by its old response', async () => {
      const paused = hold();
      const acc = account({}, { hold: paused });
      const job = createCheck([acc.id]);
      await waitFor(() => paused.entered, 'profile response before disabling and re-importing');
      assert.equal((await api(`/api/dola/accounts/${acc.id}/action`, {
        method: 'POST', body: { action: 'disable' },
      })).status, 200);
      const response = await api('/api/dola/accounts/import', { method: 'POST', body: {
        items: [{ label: acc.read().label, raw: 'ttwid=synthetic-reimport-flight; odin_tt=synthetic-reimport-flight' }],
      } });
      assert.equal(response.status, 201);
      assert.equal(response.body.refreshed, 1);
      const imported = acc.read();
      assert.equal(imported.status, 'disabled');
      paused.gate.resolve();
      await finished(job);
      assert.deepEqual(acc.read(), imported);
    });

    for (const phase of ['launch balance', 'automatic credit probe', 'manual credit probe']) {
      for (const change of ['manual set_credits', 'same-millisecond value only', 'timestamp only', 'source only']) {
        test(`${phase}: an in-flight response preserves a newer ${change} snapshot`, async t => {
          const isLaunch = phase === 'launch balance';
          const isManual = phase === 'manual credit probe';
          const paused = hold(isLaunch ? LAUNCH : PROFILE, phase === 'automatic credit probe' ? 2 : 1);
          const endpoint = isLaunch ? LAUNCH : PROFILE;
          const initial = { status: 'unknown', last_check_at: OLD_AT, last_error: 'previous health error' };
          if (change === 'same-millisecond value only') {
            initial.credits_source = '手动录入';
            initial.credits_at = FIXED_AT;
            t.mock.timers.enable({ apis: ['Date'], now: Date.parse(FIXED_AT) });
          }
          if (change === 'timestamp only') initial.credits_source = '手动录入';
          const acc = account(initial, { hold: paused, responses: { [endpoint]: {
            body: { code: 0, data: { ...healthyResponse(endpoint).data, credit_balance: 900 } },
          } } });
          // Isolate launch's write guard from a subsequent, newly started probe.
          if (isLaunch) setting('dola_auto_quota_probe', false);
          const original = acc.read();
          const job = createCheck([acc.id], { type: isManual ? 'dola_credits' : 'dola_check', automatic: !isManual });
          try {
            await waitFor(() => paused.entered, `${phase} before changing the balance`);
            if (change === 'source only') {
              // Exercise each member of the snapshot independently. An unchanged
              // value/timestamp must not hide a different observation source.
              db.prepare('UPDATE dola_accounts SET credits_source=? WHERE id=?')
                .run('newer synthetic observation source', acc.id);
            } else {
              const response = await api(`/api/dola/accounts/${acc.id}/action`, {
                method: 'POST', body: { action: 'set_credits', credits: change === 'timestamp only' ? 37 : 91 },
              });
              assert.equal(response.status, 200);
            }
            const newer = balance(acc.read());
            const changedFields = Object.keys(newer).filter(key => newer[key] !== balance(original)[key]);
            if (change === 'same-millisecond value only') assert.deepEqual(changedFields, ['credits']);
            if (change === 'timestamp only') assert.deepEqual(changedFields, ['at']);
            if (change === 'source only') assert.deepEqual(changedFields, ['source']);
            if (change === 'manual set_credits') assert.deepEqual(changedFields, ['credits', 'source', 'at']);
            paused.gate.resolve();
            const result = await finished(job);
            assert.deepEqual(balance(acc.read()), newer, 'An older network response must preserve all three newer balance fields');
            if (!isManual) {
              assert.equal(result.ok_count, 1, 'Discarding stale credits must not discard successful health verification');
              assert.equal(acc.read().status, 'valid');
              assert.equal(acc.read().account_hint, 'Fixture');
              assert.equal(acc.read().last_error, '');
              assert.notEqual(acc.read().last_check_at, OLD_AT);
            }
          } finally {
            paused.gate.resolve();
            if (change === 'same-millisecond value only') t.mock.timers.reset();
          }
        });
      }

      test(`${phase}: an unchanged null balance snapshot still accepts the first observation`, async () => {
        const isLaunch = phase === 'launch balance';
        const isManual = phase === 'manual credit probe';
        const endpoint = isLaunch ? LAUNCH : PROFILE;
        const acc = account({ credits: null, credits_at: null, credits_source: null }, { responses: { [endpoint]: {
          body: { code: 0, data: { ...healthyResponse(endpoint).data, credit_balance: 73 } },
        } } });
        if (isLaunch) setting('dola_auto_quota_probe', false);
        const result = await finished(createCheck([acc.id], { type: isManual ? 'dola_credits' : 'dola_check', automatic: !isManual }));
        assert.equal(result.ok_count, 1, 'Snapshot comparisons must be null-safe');
        assert.equal(acc.read().credits, 73);
        assert.match(acc.read().credits_source, /credit_balance/);
        assert.ok(Number.isFinite(Date.parse(acc.read().credits_at)));
      });
    }

    for (const [beforeValue, afterValue, expectedStatus] of [[true, false, 'unknown'], [false, true, 'invalid']]) {
      test(`cleanup switch ${beforeValue} -> ${afterValue} during the network request controls quarantine`, async () => {
        setting('dola_auto_cleanup_invalid', beforeValue);
        const paused = hold();
        const acc = account({}, { hold: paused, responses: { [PROFILE]: { body: { code: 710012014 } } } });
        const previous = acc.read();
        const job = createCheck([acc.id]);
        await waitFor(() => paused.entered, 'expiry response before changing cleanup policy');
        const response = await api('/api/settings', { method: 'PUT', body: { dola_auto_cleanup_invalid: afterValue } });
        assert.equal(response.status, 200);
        paused.gate.resolve();
        const result = await finished(job);
        assert.equal(result.fail_count, 1);
        assert.equal(acc.read().status, expectedStatus);
        assert.equal(acc.read().cookie, previous.cookie);
        assert.deepEqual(balance(acc.read()), balance(previous));
        assert.match(acc.read().last_error, /710012014/);
        assert.notEqual(acc.read().last_check_at, previous.last_check_at);
      });
    }
  });

  describe('maintenance queue and scheduler', () => {
    test('cancelling the already-selected next batch still dispatches the following queued batch', async () => {
      const gate = deferred();
      const executions = [];
      jobs.registerJobHandler('maintenance_cancel_fixture', async item => {
        executions.push(item);
        if (item === 'first') await gate.promise;
        return { ok: true, message: `synthetic ${item}` };
      });
      const first = track(jobs.createJob({ type: 'maintenance_cancel_fixture', ids: ['first'] }));
      await waitFor(() => executions.includes('first'), 'first synthetic batch to start');
      const cancelled = track(jobs.createJob({ type: 'maintenance_cancel_fixture', ids: ['cancelled'] }));
      const following = track(jobs.createJob({ type: 'maintenance_cancel_fixture', ids: ['following'] }));
      try {
        // Both initial kicks must observe the occupied queue and return. Then
        // finish the first job through microtasks, cancelling its selected next
        // job before the setImmediate that will dispatch that job can run.
        await immediate();
        await immediate();
        assert.equal(jobs.getJob(cancelled.id).status, 'queued');
        assert.equal(jobs.getJob(following.id).status, 'queued');
        gate.resolve();
        for (let turn = 0; turn < 50 && jobs.getJob(first.id).status !== 'done'; turn++) await Promise.resolve();
        assert.equal(jobs.getJob(first.id).status, 'done');
        assert.equal(jobs.cancelJob(cancelled.id).status, 'cancelled');
        await waitFor(() => jobs.getJob(following.id).status === 'done', 'dispatch after a cancelled selected batch', 1000);
        await finished(first);
        await finished(following);
        assert.deepEqual(executions, ['first', 'following']);
        assert.equal(jobs.getJob(cancelled.id).done, 0);
        assert.equal(jobs.getJob(cancelled.id).status, 'cancelled');
      } finally {
        gate.resolve();
        // If this regression returns, cancel only stranded fixture jobs so one
        // failed assertion cannot contaminate subsequent tests or leave handles.
        for (const job of [cancelled, following]) {
          if (jobs.getJob(job.id).status === 'queued') jobs.cancelJob(job.id);
        }
      }
    });

    test('empty or entirely disabled pools do not create jobs', () => {
      assert.deepEqual(maintenance.enqueueDolaMaintenance(), { created: false, skipped: 'empty', job: null });
      account({ status: 'disabled' });
      assert.deepEqual(maintenance.enqueueDolaMaintenance(), { created: false, skipped: 'empty', job: null });
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
    });

    test('automatic and environment switches suppress scheduling; an explicit manual run can force one', async () => {
      const enabled = account();
      const disabled = account({ status: 'disabled' });
      const previous = disabled.read();
      setting('dola_auto_maintenance_enabled', false);
      assert.equal(maintenance.getDolaMaintenanceState().enabled, false);
      assert.equal(maintenance.enqueueDolaMaintenance().skipped, 'disabled');
      setting('dola_auto_maintenance_enabled', true);
      process.env.DOLA_AUTO_MAINTENANCE = 'false';
      assert.equal(maintenance.getDolaMaintenanceState().enabled, false);
      assert.equal(maintenance.enqueueDolaMaintenance().skipped, 'disabled');
      const result = maintenance.enqueueDolaMaintenance('manual', { force: true });
      assert.equal(result.created, true);
      assert.deepEqual(result.job.payload.ids, [enabled.id]);
      await finished(track(result.job));
      assert.deepEqual(disabled.read(), previous);
    });

    test('duplicate queued and running maintenance requests reuse one job', async () => {
      const paused = hold(LAUNCH);
      account({}, { hold: paused });
      const first = maintenance.enqueueDolaMaintenance('test');
      assert.equal(first.created, true);
      track(first.job);
      for (const state of ['queued', 'running']) {
        if (state === 'running') await waitFor(() => paused.entered, 'running maintenance');
        const duplicate = maintenance.enqueueDolaMaintenance('duplicate', { force: true });
        assert.equal(duplicate.created, false);
        assert.equal(duplicate.skipped, 'already_running');
        assert.equal(duplicate.job.id, first.job.id);
        assert.equal(duplicate.job.status, state);
        assert.equal(maintenance.getDolaMaintenanceState().activeJob.id, first.job.id);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1);
      }
      paused.gate.resolve();
      await finished(first.job);
      assert.equal(maintenance.getDolaMaintenanceState().activeJob, null);
      assert.equal(maintenance.getDolaMaintenanceState().lastJob.id, first.job.id);
    });

    for (const type of ['dola_check', 'dola_credits']) {
      test(`an existing manual ${type} prevents duplicate automatic work`, async () => {
        const paused = hold(type === 'dola_check' ? LAUNCH : PROFILE);
        const acc = account({}, { hold: paused });
        const manual = createCheck([acc.id], { type, automatic: false });
        await waitFor(() => paused.entered, 'manual job to hold the queue');
        const result = maintenance.enqueueDolaMaintenance();
        assert.equal(result.created, false);
        assert.equal(result.skipped, 'already_running');
        assert.equal(result.job.id, manual.id);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1);
        paused.gate.resolve();
        await finished(manual);
      });
    }

    test('manual batches wait behind automatic maintenance while its configured workers run concurrently', async () => {
      setting('dola_auto_quota_probe', false);
      const holds = [hold(LAUNCH), hold(LAUNCH), hold(LAUNCH)];
      const automaticAccounts = holds.map(paused => account({}, { hold: paused }));
      const automatic = maintenance.enqueueDolaMaintenance('concurrency-test');
      assert.equal(automatic.created, true);
      track(automatic.job);
      await waitFor(() => holds[0].entered && holds[1].entered, 'two concurrent workers in the first batch');
      assert.equal(holds[2].entered, false, 'The configured concurrency of two must be respected');
      const manualAccount = account();
      const manual = createCheck([manualAccount.id], { automatic: false });
      const credits = createCheck([manualAccount.id], { type: 'dola_credits', automatic: false });
      await immediate();
      await immediate();
      assert.equal(jobs.getJob(manual.id).status, 'queued');
      assert.equal(jobs.getJob(credits.id).status, 'queued');
      assert.equal(requests.filter(r => r.key === manualAccount.key).length, 0);
      holds[0].gate.resolve();
      await waitFor(() => holds[2].entered, 'third account after the first worker is free');
      assert.equal(jobs.getJob(manual.id).status, 'queued');
      assert.equal(jobs.getJob(credits.id).status, 'queued');
      holds[1].gate.resolve();
      holds[2].gate.resolve();
      for (const job of [automatic.job, manual, credits]) await finished(job);
      const lastAutomaticRequest = requests.findLastIndex(r => automaticAccounts.some(acc => acc.key === r.key));
      const firstManualRequest = requests.findIndex(r => r.key === manualAccount.key);
      assert.ok(firstManualRequest > lastAutomaticRequest, 'All automatic HTTP work must finish before manual work starts');
    });

    test('scheduler waits 15 seconds, observes the interval, respects disabling, and can be stopped', async t => {
      setting('dola_auto_maintenance_interval_minutes', 15);
      const acc = account({ quota_remaining: 0, quota_at: OLD_AT, quota_source: 'generation_receipt' });
      const oldQuota = quota(acc.read());
      t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
      try {
        const started = Date.now();
        stopMaintenance = maintenance.startDolaMaintenance();
        assert.equal(Date.parse(maintenance.getDolaMaintenanceState().nextRunAt), started + 15_000);
        t.mock.timers.tick(14_999);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
        t.mock.timers.tick(1);
        const first = maintenance.getDolaMaintenanceState().activeJob;
        assert.ok(first);
        await finished(track(first));
        assert.deepEqual(quota(acc.read()), oldQuota);
        t.mock.timers.tick(15 * 60_000 - 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1);
        t.mock.timers.tick(1);
        const second = maintenance.getDolaMaintenanceState().activeJob;
        assert.ok(second);
        assert.notEqual(second.id, first.id);
        await finished(track(second));
        assert.deepEqual(quota(acc.read()), oldQuota);
        setting('dola_auto_maintenance_enabled', false);
        t.mock.timers.tick(15 * 60_000);
        assert.equal(maintenance.getDolaMaintenanceState().nextRunAt, null);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 2);
        stopMaintenance();
        setting('dola_auto_maintenance_enabled', true);
        t.mock.timers.tick(30 * 60_000);
        assert.equal(maintenance.getDolaMaintenanceState().nextRunAt, null);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 2);
      } finally {
        stopMaintenance?.();
        stopMaintenance = undefined;
        t.mock.timers.reset();
      }
    });
  });

  describe('settings and manual-maintenance HTTP authorization', () => {
    for (const [label, token, expected] of [['anonymous', null, 401], ['read-only user', 'reader', 403]]) {
      test(`${label} cannot modify settings or trigger maintenance`, async () => {
        account();
        const actualToken = token === 'reader' ? readerToken : token;
        const previous = db.prepare('SELECT key,value,updated_at FROM settings ORDER BY key').all();
        const response = await api('/api/settings', {
          token: actualToken, method: 'PUT', body: { dola_auto_maintenance_enabled: false },
        });
        assert.equal(response.status, expected);
        assert.deepEqual(db.prepare('SELECT key,value,updated_at FROM settings ORDER BY key').all(), previous);
        assert.equal((await api('/api/dola/maintenance/run', { token: actualToken, method: 'POST', body: {} })).status, expected);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
        assert.equal(requests.length, 0);
      });
    }

    test('settings require login and permit a reader with setting:view', async () => {
      assert.equal((await api('/api/settings', { token: null })).status, 401);
      const response = await api('/api/settings', { token: readerToken });
      assert.equal(response.status, 200);
      assert.ok(response.body.items.some(item => item.key === 'dola_auto_maintenance_enabled'));
    });

    for (const value of [14, 1441, 15.5, 'not-a-number', '', null]) {
      test(`invalid maintenance interval ${JSON.stringify(value)} rejects the whole patch`, async () => {
        const previous = db.prepare('SELECT key,value,updated_at FROM settings ORDER BY key').all();
        const response = await api('/api/settings', { method: 'PUT', body: {
          dola_auto_maintenance_enabled: false, dola_auto_maintenance_interval_minutes: value,
        } });
        assert.equal(response.status, 400);
        assert.deepEqual(db.prepare('SELECT key,value,updated_at FROM settings ORDER BY key').all(), previous);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n, 0);
      });
    }

    for (const key of ['dola_auto_maintenance_enabled', 'dola_auto_cleanup_invalid', 'dola_auto_quota_probe']) {
      test(`${key} rejects invalid switch values without partial writes`, async () => {
        const previous = db.prepare('SELECT key,value,updated_at FROM settings ORDER BY key').all();
        for (const value of ['yes', 1, null]) {
          const response = await api('/api/settings', { method: 'PUT', body: {
            dola_auto_maintenance_interval_minutes: 15, [key]: value,
          } });
          assert.equal(response.status, 400);
          assert.deepEqual(db.prepare('SELECT key,value,updated_at FROM settings ORDER BY key').all(), previous);
        }
      });
    }

    test('valid settings persist at both interval bounds and appear in maintenance state', async () => {
      for (const minutes of [15, 180, 1440]) {
        const response = await api('/api/settings', { method: 'PUT', body: {
          dola_auto_maintenance_interval_minutes: minutes, dola_auto_maintenance_enabled: false,
          dola_auto_cleanup_invalid: 'false', dola_auto_quota_probe: true,
        } });
        assert.equal(response.status, 200);
        const state = maintenance.getDolaMaintenanceState();
        assert.equal(state.enabled, false);
        assert.equal(state.cleanupInvalid, false);
        assert.equal(state.quotaProbe, true);
        assert.equal(state.intervalMinutes, minutes);
      }
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='setting.update'").get().n, 3);
    });

    test('authorized manual run works when automatic maintenance is off and writes an audit record', async () => {
      const acc = account();
      setting('dola_auto_maintenance_enabled', false);
      const response = await api('/api/dola/maintenance/run', { method: 'POST', body: {} });
      assert.equal(response.status, 201);
      assert.equal(response.body.created, true);
      assert.equal(response.body.job.payload.reason, 'manual');
      assert.deepEqual(response.body.job.payload.ids, [acc.id]);
      await finished(track(response.body.job));
      const audit = db.prepare("SELECT * FROM audit_logs WHERE action='dola.maintenance_run'").get();
      assert.ok(audit);
      assert.equal(audit.target_id, String(response.body.job.id));
      assert.equal(audit.user_id, response.body.job.created_by);
    });
  });
});
