/**
 * Pure saved-session contract tests. Run: node --test test/google-login-restore.mjs
 * Only the pure restore helper/core/observations modules are imported. No provider,
 * browser, cache, database, account files, or real network calls are used.
 * Safety regressions are normal failing tests, not skipped/TODO expectations.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifySavedDolaSession } from '../server/dola/google-login-restore.js';

const EMAIL = 'synthetic-restore@example.test';
const DOLA_ID = 'synthetic-dola-id';
const OPTIONS = Object.freeze({ proxy: 'http://proxy.example.invalid:8080', timeout: 15000 });
const EXPECTED_COOKIES = Object.freeze({ ttwid: 'synthetic-ttwid', odin_tt: 'synthetic-odin' });

function fixture() {
  return {
    saved: {
      identity: { email: EMAIL, email_verified: true, sub: 'synthetic-google-sub' },
      dolaId: DOLA_ID,
      cookies: [
        { domain: '.dola.com', name: 'ttwid', value: EXPECTED_COOKIES.ttwid },
        { domain: 'www.dola.com', name: 'odin_tt', value: EXPECTED_COOKIES.odin_tt },
        { domain: '.google.com', name: 'synthetic_google_cookie', value: 'synthetic-google-state' },
        { domain: 'dola.com.example.invalid', name: 'unrelated', value: 'synthetic-unrelated' },
      ],
    },
    email: EMAIL,
    account: { sec_user_id: DOLA_ID },
    options: OPTIONS,
    session: { valid: true, pullStatus: 200, pullCode: 0, launchStatus: 200, launchCode: 0 },
    profile: { ok: true, status: 200, code: 0, entityId: DOLA_ID },
  };
}

async function run(input = fixture()) {
  const calls = [];
  const endpointInputs = [];
  const result = await verifySavedDolaSession(input.saved, input.email, input.account, {
    options: input.options,
    missingRequired(cookies) {
      calls.push('missingRequired');
      assert.ok(!Object.hasOwn(cookies, 'synthetic_google_cookie'));
      assert.ok(!Object.hasOwn(cookies, 'unrelated'));
      return ['ttwid', 'odin_tt'].filter(name => !cookies[name]);
    },
    async checkSession(cookies, options) {
      calls.push('checkSession');
      endpointInputs.push({ cookies, options });
      if (input.throwAt === 'checkSession') throw new Error('synthetic-private-error');
      return input.session;
    },
    async fetchProfile(cookies, options) {
      calls.push('fetchProfile');
      endpointInputs.push({ cookies, options });
      if (input.throwAt === 'fetchProfile') throw new Error('synthetic-private-error');
      return input.profile;
    },
  });
  // Assert outside the helper so its fail-closed catch cannot swallow test failures.
  for (const { cookies, options } of endpointInputs) {
    assert.deepEqual(cookies, EXPECTED_COOKIES);
    assert.strictEqual(options, input.options);
    assert.equal(options.proxy, OPTIONS.proxy);
  }
  return { result, calls };
}

test('valid saved identity plus live same-ID Dola session is reused on the supplied proxy', async () => {
  const input = fixture();
  const before = structuredClone(input.saved);
  const { result, calls } = await run(input);
  assert.deepEqual(result, {
    kind: 'reused',
    result: {
      kind: 'ready', identity: input.saved.identity, cookies: EXPECTED_COOKIES,
      profile: input.profile, sessionReused: true, loginStateSaved: true,
    },
  });
  assert.deepEqual(calls, ['missingRequired', 'checkSession', 'fetchProfile']);
  assert.deepEqual(input.saved, before, 'restoring must not rewrite the identity receipt');
});

test('same live profile.id is accepted when entityId is absent and no account snapshot ID exists', async () => {
  const input = fixture();
  input.account = null;
  delete input.profile.entityId;
  input.profile.id = DOLA_ID;
  assert.equal((await run(input)).result.kind, 'reused');
});

for (const [name, change] of [
  ['account sec_user_id mismatch', input => { input.account.sec_user_id = 'different-dola-id'; }],
  ['wrong email', input => { input.email = 'different@example.test'; }],
  ['unverified Google identity', input => { input.saved.identity.email_verified = false; }],
  ['missing Google subject', input => { delete input.saved.identity.sub; }],
  ['missing cached Dola ID', input => { delete input.saved.dolaId; }],
  ['missing proxy', input => { input.options = { timeout: 15000 }; }],
  ['empty proxy', input => { input.options = { proxy: '' }; }],
  ['missing options', input => { input.options = undefined; }],
]) {
  test(`${name} is blocked before any injected calls`, async () => {
    const input = fixture();
    change(input);
    const { result, calls } = await run(input);
    assert.deepEqual(result, { kind: 'blocked' });
    assert.deepEqual(calls, []);
  });
}

test('live Dola profile mismatch is blocked rather than silently relogging', async () => {
  const input = fixture();
  input.profile.entityId = 'different-live-dola-id';
  const { result, calls } = await run(input);
  assert.deepEqual(result, { kind: 'blocked' });
  assert.deepEqual(calls, ['missingRequired', 'checkSession', 'fetchProfile']);
});

test('unknown session response is blocked, not treated as explicit expiry', async () => {
  const input = fixture();
  input.session = { valid: false, pullStatus: 200, pullCode: 710010202, launchStatus: 200, launchCode: 710010202 };
  input.profile = { ok: false, status: 200, code: 710010202 };
  assert.deepEqual((await run(input)).result, { kind: 'blocked' });
});

test('network failure of all session/profile checks is blocked', async () => {
  const input = fixture();
  input.session = { valid: false, pullStatus: 0, pullCode: null, launchStatus: 0, launchCode: null };
  input.profile = { ok: false, status: 0, code: null };
  assert.deepEqual((await run(input)).result, { kind: 'blocked' });
});

for (const endpoint of ['pull', 'launch']) {
  test(`${endpoint} network failure stays blocked even when other checks make session.valid true`, async () => {
    const input = fixture();
    input.session[`${endpoint}Status`] = 0;
    input.session[`${endpoint}Code`] = null;
    // checkSession can report valid=true from the other successful endpoint.
    // A successful profile must not erase the unknown-network stop condition.
    assert.deepEqual((await run(input)).result, { kind: 'blocked' });
  });
}

for (const code of [710012001, 710012014]) {
  test(`explicit invalid session code ${code} permits normal OAuth reverification`, async () => {
    const input = fixture();
    input.session = { valid: false, pullStatus: 200, pullCode: code, launchStatus: 200, launchCode: code };
    input.profile = { ok: false, status: 200, code };
    assert.deepEqual((await run(input)).result, { kind: 'relogin' });
  });
}

test('contradictory expired-session and successful-profile evidence is blocked', async () => {
  const input = fixture();
  input.session.valid = false;
  input.session.pullCode = 710012001;
  assert.deepEqual((await run(input)).result, { kind: 'blocked' });
});

test('missing required Dola cookies permits relogin without contacting either injected endpoint', async () => {
  const input = fixture();
  input.saved.cookies = input.saved.cookies.filter(cookie => cookie.name !== 'ttwid');
  const { result, calls } = await run(input);
  assert.deepEqual(result, { kind: 'relogin' });
  assert.deepEqual(calls, ['missingRequired']);
});

test('no saved state permits normal login without calling either injected endpoint', async () => {
  const input = fixture();
  input.saved = null;
  const { result, calls } = await run(input);
  assert.deepEqual(result, { kind: 'relogin' });
  assert.deepEqual(calls, []);
});

for (const endpoint of ['checkSession', 'fetchProfile']) {
  test(`${endpoint} exception is blocked without exposing raw error details`, async () => {
    const input = fixture();
    input.throwAt = endpoint;
    const { result, calls } = await run(input);
    assert.deepEqual(result, { kind: 'blocked' });
    assert.deepEqual(calls, endpoint === 'checkSession'
      ? ['missingRequired', 'checkSession'] : ['missingRequired', 'checkSession', 'fetchProfile']);
  });
}
