/**
 * Run: node --test admin/test/google-login-cache.mjs
 * Only fresh temporary directories, reserved test identities and synthetic
 * proxy/cookie values. Never instantiate the default user cache directory.
 */
import assert from 'node:assert/strict';
import { before, after, describe, test, mock } from 'node:test';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';

const EMAIL = 'synthetic-cache@example.test';
const PROXY = 'socks5://B_900001_KR___30_Ab000001:synthetic-proxy-password@gate2.ipweb.cc:7778';
const START = Date.parse('2026-09-19T00:00:00.000Z');
const WEEK = 7 * 24 * 60 * 60 * 1000;
const LIMIT = 512 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const blocked = [];
let createGoogleLoginCache;

const cookie = (patch = {}) => ({
  name: 'sessionid', value: 'synthetic-dola-session', domain: '.dola.com', path: '/',
  expires: -1, httpOnly: true, secure: true, sameSite: 'None', ...patch,
});
const payload = (patch = {}) => ({
  identity: { sub: 'synthetic-google-sub', email: EMAIL, email_verified: true },
  dolaId: 'synthetic-dola-id',
  cookies: [cookie(), cookie({ name: 'SID', value: 'synthetic-google-session', domain: '.google.com' })],
  ...patch,
});

async function fixture(t) {
  const parent = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'google-login-cache-test-')));
  const directory = join(parent, 'sessions');
  const f = { parent, directory, now: START, file: join(directory, `${hash(EMAIL)}.json`) };
  f.cache = createGoogleLoginCache({ directory, clock: () => f.now });
  f.record = async () => JSON.parse(await fs.readFile(f.file, 'utf8'));
  f.tamper = async mutate => {
    const record = await f.record();
    mutate(record);
    await fs.writeFile(f.file, JSON.stringify(record));
  };
  t.after(async () => {
    // Restore test-created modes so even deliberate 000/unsafe mode fixtures
    // can be removed. This parent is only the exact mkdtemp result above.
    await fs.chmod(parent, 0o700);
    const info = await fs.lstat(directory).catch(() => null);
    if (info?.isDirectory() && !info.isSymbolicLink()) await fs.chmod(directory, 0o700);
    await fs.rm(parent, { recursive: true, force: true });
  });
  return f;
}

async function genericFailure(promise) {
  await assert.rejects(promise, error => {
    assert.equal(error.message, 'google_login_cache_save_failed');
    assert.equal(error.cause, undefined);
    return true;
  });
}

describe('private Google login cache (synthetic, network blocked)', { concurrency: false, timeout: 30_000 }, () => {
  before(async () => {
    const deny = label => () => { blocked.push(label); throw new Error(`Blocked ${label}`); };
    mock.method(globalThis, 'fetch', deny('fetch'));
    for (const [object, methods] of [
      [http, ['request', 'get']], [https, ['request', 'get']],
      [net, ['connect', 'createConnection']], [net.Socket.prototype, ['connect']], [tls, ['connect']],
      [childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
    ]) for (const method of methods) mock.method(object, method, deny(method));
    syncBuiltinESMExports();
    ({ createGoogleLoginCache } = await import('../server/dola/google-login-cache.js'));
  });

  after(() => {
    try { assert.deepEqual(blocked, [], 'Cache must never invoke a network or browser/process entry point'); }
    finally { mock.restoreAll(); syncBuiltinESMExports(); }
  });

  test('missing cache loads null and clear returns false without creating directories', async t => {
    const f = await fixture(t);
    assert.equal(await f.cache.load(EMAIL, PROXY), null);
    assert.equal(await f.cache.clear(EMAIL), false);
    assert.deepEqual(await fs.readdir(f.parent), []);
  });

  test('round trip uses a hashed normalized filename, version 1, private modes and exact proxy hash', async t => {
    const f = await fixture(t);
    await f.cache.save(' Synthetic-Cache\\@EXAMPLE.TEST ', PROXY, payload());
    assert.deepEqual(await fs.readdir(f.directory), [`${hash(EMAIL)}.json`]);
    assert.equal((await fs.lstat(f.directory)).mode & 0o7777, 0o700);
    assert.equal((await fs.lstat(f.file)).mode & 0o7777, 0o600);
    const stored = await f.record();
    assert.equal(stored.version, 1);
    assert.equal(stored.savedAt, START);
    assert.equal(stored.proxyHash, hash(PROXY));
    assert.equal(stored.identity.email, EMAIL);
    assert.deepEqual(await f.cache.load('SYNTHETIC-CACHE@EXAMPLE.TEST', PROXY), payload());
    assert.equal(await f.cache.clear(' Synthetic-Cache\\@example.test '), true);
    assert.equal(await f.cache.load(EMAIL, PROXY), null);
    assert.deepEqual(await fs.readdir(f.directory), []);
  });

  test('save keeps only exact Dola hosts and Google hosts, rejecting lookalikes and prototype-style domains', async t => {
    const f = await fixture(t);
    const allowed = ['dola.com', '.dola.com', 'www.dola.com', '.www.dola.com', 'google.com', '.google.com',
      'accounts.google.com', '.accounts.google.com', 'a.accounts.google.com'];
    const rejected = ['auth.dola.com', 'dola.com.evil.test', 'google.com.evil.test', 'evilgoogle.com',
      'googleapis.com', 'https://google.com', 'google.com:443', 'google.com.', '..google.com',
      'bad..google.com', '__proto__.google.com', 'constructor.google.com.evil.test', 'google.com/evil', ' google.com'];
    const cookies = [...allowed, ...rejected].map((domain, n) => cookie({ domain, name: `synthetic_${n}` }));
    await f.cache.save(EMAIL, PROXY, payload({ cookies }));
    assert.deepEqual((await f.cache.load(EMAIL, PROXY)).cookies.map(item => item.domain), allowed);
    assert.deepEqual((await f.record()).cookies.map(item => item.domain), allowed);
  });

  test('allowlisted fields exclude passwords, OAuth URLs/tokens, origins, storage, autofill and prototype keys', async t => {
    const f = await fixture(t);
    const extras = JSON.parse('{"password":"synthetic-password-leak","access_token":"synthetic-oauth-token-leak","refreshToken":"synthetic-refresh-leak","oauthURL":"https://example.test/#synthetic-oauth-url-leak","origins":[{"localStorage":"synthetic-localstorage-leak"}],"autofill":"synthetic-autofill-leak","__proto__":{"polluted":"synthetic-proto-leak"}}');
    const input = payload({ ...extras,
      identity: { ...payload().identity, ...extras },
      cookies: [{ ...cookie(), ...extras, url: 'https://example.test/synthetic-url-leak' }],
    });
    const original = structuredClone(input);
    await f.cache.save(EMAIL, PROXY, input);
    const raw = await fs.readFile(f.file, 'utf8');
    for (const sentinel of ['synthetic-password-leak', 'synthetic-oauth-token-leak', 'synthetic-refresh-leak',
      'synthetic-oauth-url-leak', 'synthetic-localstorage-leak', 'synthetic-autofill-leak', 'synthetic-proto-leak',
      'synthetic-url-leak', 'synthetic-proxy-password', PROXY]) assert.ok(!raw.includes(sentinel));
    const stored = await f.record();
    assert.deepEqual(Object.keys(stored).sort(), ['cookies', 'dolaId', 'identity', 'proxyHash', 'savedAt', 'version']);
    assert.deepEqual(stored.identity, payload().identity);
    assert.deepEqual(stored.cookies, [cookie()]);
    assert.equal({}.polluted, undefined);
    assert.deepEqual(input, original);
  });

  test('partitioned cookies are skipped rather than widened into unpartitioned cookies', async t => {
    const f = await fixture(t);
    await f.cache.save(EMAIL, PROXY, payload({ cookies: [
      cookie(),
      cookie({ value: 'synthetic-partitioned-session', partitionKey: 'https://google.com' }),
      cookie({ name: 'SID', domain: '.google.com', value: 'synthetic-partitioned-google', partitionKey: { topLevelSite: 'https://dola.com' } }),
      cookie({ value: 'synthetic-null-partition', partitionKey: null }),
    ] }));
    assert.deepEqual((await f.record()).cookies, [cookie()]);
    assert.deepEqual((await f.cache.load(EMAIL, PROXY)).cookies, [cookie()]);
    await f.tamper(record => { record.cookies[0].partitionKey = 'https://google.com'; });
    assert.equal(await f.cache.load(EMAIL, PROXY), null, 'A cached unknown partitionKey must fail strict load validation');
  });

  test('invalid identity, empty subject/Dola ID, or mismatched email cannot overwrite a valid cache', async t => {
    const f = await fixture(t);
    await f.cache.save(EMAIL, PROXY, payload());
    const before = await fs.readFile(f.file, 'utf8');
    for (const patch of [
      { identity: null }, { identity: { ...payload().identity, email_verified: false } },
      { identity: { ...payload().identity, email_verified: 'true' } },
      { identity: { ...payload().identity, sub: '' } }, { identity: { ...payload().identity, sub: '  ' } },
      { identity: { ...payload().identity, sub: {} } },
      { identity: { ...payload().identity, email: 'synthetic-other@example.test' } },
      { dolaId: '' }, { dolaId: null },
    ]) await genericFailure(f.cache.save(EMAIL, PROXY, payload(patch)));
    assert.equal(await fs.readFile(f.file, 'utf8'), before);
    assert.deepEqual(await fs.readdir(f.directory), [`${hash(EMAIL)}.json`]);
  });

  test('invalid, missing and different exact proxies load null; failed saves preserve the old proxy binding', async t => {
    const f = await fixture(t);
    await f.cache.save(EMAIL, PROXY, payload());
    for (const proxy of [undefined, '', ' ', 'ftp://proxy.example.test:21', 'synthetic-malformed-proxy']) {
      assert.equal(await f.cache.load(EMAIL, proxy), null);
      await genericFailure(f.cache.save(EMAIL, proxy, payload()));
    }
    for (const proxy of [PROXY.replace('Ab000001', 'Ab000002'), PROXY.replace('socks5:', 'socks5h:'), `${PROXY}/`]) {
      assert.equal(await f.cache.load(EMAIL, proxy), null);
    }
    assert.deepEqual(await f.cache.load(EMAIL, PROXY), payload());
  });

  test('load fails closed for wrong version/identity/proxy hash, unexpected fields, malformed JSON and future dates', async t => {
    const f = await fixture(t);
    for (const mutate of [
      record => { record.version = 2; },
      record => { record.identity.email = 'synthetic-other@example.test'; },
      record => { record.identity.email = EMAIL.toUpperCase(); },
      record => { record.identity.email_verified = false; },
      record => { record.identity.sub = ''; },
      record => { record.dolaId = ''; },
      record => { record.proxyHash = 'synthetic-not-a-sha256'; },
      record => { record.savedAt = START + 1; },
      record => { record.savedAt = String(START); },
      record => { record.origins = [{ localStorage: 'synthetic-poison' }]; },
      record => { record.identity.password = 'synthetic-poison'; },
      record => { record.cookies[0].domain = '.google.com.evil.test'; },
      record => { record.cookies[0].token = 'synthetic-poison'; },
      record => { Object.defineProperty(record, '__proto__', { value: { polluted: true }, enumerable: true }); },
    ]) {
      await f.cache.save(EMAIL, PROXY, payload());
      await f.tamper(mutate);
      assert.equal(await f.cache.load(EMAIL, PROXY), null);
    }
    await fs.writeFile(f.file, '{synthetic-invalid-json');
    assert.equal(await f.cache.load(EMAIL, PROXY), null);
    assert.equal({}.polluted, undefined);
  });

  test('seven-day TTL includes its boundary, rejects older state and does not refresh on read', async t => {
    const f = await fixture(t);
    await f.cache.save(EMAIL, PROXY, payload());
    f.now = START + WEEK;
    assert.deepEqual(await f.cache.load(EMAIL, PROXY), payload());
    assert.equal((await f.record()).savedAt, START);
    f.now++;
    assert.equal(await f.cache.load(EMAIL, PROXY), null);
    f.now = START - 1;
    assert.equal(await f.cache.load(EMAIL, PROXY), null);
  });

  test('safe cookie validation rejects unsafe shapes, inherited fields and invalid primitive values', async t => {
    const f = await fixture(t);
    const inherited = Object.create(cookie());
    for (const cookies of [null, {}, [null], [inherited], [cookie({ name: 'bad;name' })],
      [cookie({ value: 'synthetic\r\nInjected:1' })], [cookie({ value: {} })],
      [cookie({ path: 'relative' })], [cookie({ expires: Infinity })], [cookie({ expires: -2 })],
      [cookie({ secure: 'true' })], [cookie({ httpOnly: 1 })], [cookie({ sameSite: 'synthetic-invalid' })],
    ]) await genericFailure(f.cache.save(EMAIL, PROXY, payload({ cookies })));
    assert.deepEqual(await fs.readdir(f.parent), []);
  });

  test('500-cookie and 512-KiB limits apply to both saves and loads', async t => {
    const f = await fixture(t);
    const cookies = Array.from({ length: 500 }, (_, n) => cookie({ name: `synthetic_${n}` }));
    await f.cache.save(EMAIL, PROXY, payload({ cookies }));
    assert.equal((await f.cache.load(EMAIL, PROXY)).cookies.length, 500);
    const prior = await fs.readFile(f.file, 'utf8');
    await genericFailure(f.cache.save(EMAIL, PROXY, payload({ cookies: [...cookies, cookie()] })));
    await genericFailure(f.cache.save(EMAIL, PROXY, payload({ cookies: [cookie({ value: 'x'.repeat(LIMIT) })] })));
    assert.equal(await fs.readFile(f.file, 'utf8'), prior);
    await f.tamper(record => { record.cookies.push(cookie()); });
    assert.equal(await f.cache.load(EMAIL, PROXY), null);
    await fs.writeFile(f.file, ' '.repeat(LIMIT + 1));
    assert.equal(await f.cache.load(EMAIL, PROXY), null);
  });

  test('insecure root/file permissions fail closed without silently chmodding an existing entry', async t => {
    const f = await fixture(t);
    await f.cache.save(EMAIL, PROXY, payload());
    for (const [path, mode] of [[f.directory, 0o755], [f.file, 0o644], [f.file, 0o660], [f.file, 0o700]]) {
      await fs.chmod(path, mode);
      assert.equal(await f.cache.load(EMAIL, PROXY), null);
      await genericFailure(f.cache.save(EMAIL, PROXY, payload()));
      assert.equal(await f.cache.clear(EMAIL), false);
      assert.equal((await fs.lstat(path)).mode & 0o7777, mode);
      await fs.chmod(path, path === f.directory ? 0o700 : 0o600);
    }
    assert.deepEqual(await f.cache.load(EMAIL, PROXY), payload());
  });

  test('foreign ownership is rejected even with correct permission bits', async t => {
    const f = await fixture(t);
    await f.cache.save(EMAIL, PROXY, payload());
    const realLstat = fs.lstat;
    for (const path of [f.directory, f.file]) {
      const override = t.mock.method(fs, 'lstat', async (...args) => {
        const info = await realLstat(...args);
        if (args[0] === path) info.uid += 1;
        return info;
      });
      assert.equal(await f.cache.load(EMAIL, PROXY), null);
      await genericFailure(f.cache.save(EMAIL, PROXY, payload()));
      assert.equal(await f.cache.clear(EMAIL), false);
      override.mock.restore();
    }
    assert.deepEqual(await f.cache.load(EMAIL, PROXY), payload());
  });

  test('symlink cache root is rejected without accessing or modifying its target', async t => {
    const f = await fixture(t);
    const target = join(f.parent, 'synthetic-link-target');
    await fs.mkdir(target, { mode: 0o700 });
    const sentinel = join(target, 'synthetic-sentinel');
    await fs.writeFile(sentinel, 'synthetic-unchanged', { mode: 0o600 });
    await fs.symlink(target, f.directory);
    assert.equal(await f.cache.load(EMAIL, PROXY), null);
    await genericFailure(f.cache.save(EMAIL, PROXY, payload()));
    assert.equal(await f.cache.clear(EMAIL), false);
    assert.deepEqual(await fs.readdir(target), ['synthetic-sentinel']);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'synthetic-unchanged');
    assert.equal((await fs.lstat(f.directory)).isSymbolicLink(), true);
  });

  test('symlink and hardlink cache files are rejected without overwriting or deleting their targets', async t => {
    const f = await fixture(t);
    await f.cache.save(EMAIL, PROXY, payload());
    const target = join(f.parent, 'synthetic-file-target');
    await fs.rename(f.file, target);
    const prior = await fs.readFile(target, 'utf8');
    for (const makeLink of [fs.symlink, fs.link]) {
      await makeLink(target, f.file);
      assert.equal(await f.cache.load(EMAIL, PROXY), null);
      await genericFailure(f.cache.save(EMAIL, PROXY, payload()));
      assert.equal(await f.cache.clear(EMAIL), false);
      assert.equal(await fs.readFile(target, 'utf8'), prior);
      await fs.unlink(f.file);
    }
  });

  test('atomic replacement exposes only complete snapshots and uses exclusive private staging files', async t => {
    const f = await fixture(t);
    await f.cache.save(EMAIL, PROXY, payload());
    const replacement = payload({ dolaId: 'synthetic-dola-new', cookies: [cookie({ value: 'synthetic-new-session' })] });
    const realRename = fs.rename;
    const realOpen = fs.open;
    let inspected = false;
    t.mock.method(fs, 'open', async (path, flags, mode) => {
      if (String(path).endsWith('.tmp')) {
        assert.equal(flags & constants.O_EXCL, constants.O_EXCL);
        assert.equal(flags & constants.O_CREAT, constants.O_CREAT);
        assert.equal(flags & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
        assert.equal(mode, 0o600);
      }
      return realOpen(path, flags, mode);
    });
    t.mock.method(fs, 'rename', async (from, to) => {
      if (to === f.file) {
        inspected = true;
        assert.equal((await fs.lstat(from)).mode & 0o7777, 0o600);
        assert.deepEqual(await f.cache.load(EMAIL, PROXY), payload(), 'Old complete record remains readable before rename');
        assert.equal(JSON.parse(await fs.readFile(from, 'utf8')).dolaId, replacement.dolaId);
      }
      return realRename(from, to);
    });
    await f.cache.save(EMAIL, PROXY, replacement);
    assert.equal(inspected, true);
    assert.deepEqual(await f.cache.load(EMAIL, PROXY), replacement);
    assert.deepEqual(await fs.readdir(f.directory), [`${hash(EMAIL)}.json`]);
  });

  test('failed atomic rename removes only its staging file and preserves the previous record', async t => {
    const f = await fixture(t);
    await f.cache.save(EMAIL, PROXY, payload());
    const prior = await fs.readFile(f.file, 'utf8');
    const realRename = fs.rename;
    t.mock.method(fs, 'rename', async (from, to) => {
      if (to === f.file) throw new Error('synthetic-underlying-error-with-proxy-password');
      return realRename(from, to);
    });
    await genericFailure(f.cache.save(EMAIL, PROXY, payload({ dolaId: 'synthetic-new-id' })));
    assert.equal(await fs.readFile(f.file, 'utf8'), prior);
    assert.deepEqual(await fs.readdir(f.directory), [`${hash(EMAIL)}.json`]);
  });

  test('already-aborted save creates nothing and never deletes a previously saved record', async t => {
    const f = await fixture(t);
    const controller = new AbortController();
    controller.abort();
    await genericFailure(f.cache.save(EMAIL, PROXY, payload(), { signal: controller.signal }));
    assert.deepEqual(await fs.readdir(f.parent), []);
    await f.cache.save(EMAIL, PROXY, payload());
    const prior = await fs.readFile(f.file, 'utf8');
    await genericFailure(f.cache.save(EMAIL, PROXY, payload({ dolaId: 'synthetic-new-id' }), { signal: controller.signal }));
    assert.equal(await fs.readFile(f.file, 'utf8'), prior);
    assert.deepEqual(await fs.readdir(f.directory), [`${hash(EMAIL)}.json`]);
  });

  test('abort after staging and before rename leaves the previous snapshot intact and cleans its staging file', async t => {
    const f = await fixture(t);
    await f.cache.save(EMAIL, PROXY, payload());
    const prior = await fs.readFile(f.file, 'utf8');
    const controller = new AbortController();
    const realOpen = fs.open;
    let staged = false;
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const originalSync = handle.sync.bind(handle);
        handle.sync = async () => { await originalSync(); staged = true; controller.abort(); };
      }
      return handle;
    });
    await genericFailure(f.cache.save(EMAIL, PROXY, payload({ dolaId: 'synthetic-new-id' }), { signal: controller.signal }));
    assert.equal(staged, true);
    assert.equal(await fs.readFile(f.file, 'utf8'), prior);
    assert.deepEqual(await f.cache.load(EMAIL, PROXY), payload());
    assert.deepEqual(await fs.readdir(f.directory), [`${hash(EMAIL)}.json`]);
  });

  test('clear removes only the requested normalized email and leaves a different account untouched', async t => {
    const f = await fixture(t);
    const secondEmail = 'synthetic-other@example.test';
    const second = payload({ identity: { ...payload().identity, email: secondEmail }, dolaId: 'synthetic-other-dola' });
    await f.cache.save(EMAIL, PROXY, payload());
    await f.cache.save(secondEmail, PROXY, second);
    assert.equal(await f.cache.clear(EMAIL), true);
    assert.equal(await f.cache.load(EMAIL, PROXY), null);
    assert.deepEqual(await f.cache.load(secondEmail, PROXY), second);
    assert.deepEqual(await fs.readdir(f.directory), [`${hash(secondEmail)}.json`]);
  });
});
