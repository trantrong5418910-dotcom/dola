/**
 * Run: node --test test/login-session-vault.mjs
 * Synthetic data only. Every vault has an explicit isolated mkdtemp directory;
 * no default/production cache, browser, network, keychain or process is used.
 */
import assert from 'node:assert/strict';
import { after, before, describe, mock, test } from 'node:test';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';

const EMAIL = 'synthetic-vault@example.test';
const OTHER = 'synthetic-other@example.test';
const PROXY = 'socks5://vault-user:synthetic-proxy-secret@proxy.example.test:1080';
const START = Date.parse('2026-09-20T00:00:00.000Z');
const WEEK = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 1024 * 1024;
const MAGIC = Buffer.from('DOLAVLT1');
const hash = value => createHash('sha256').update(value).digest('hex');
const aad = (email = EMAIL, proxy = PROXY) => Buffer.from(JSON.stringify(['DolaLogin/session-vault', 1, hash(email), hash(proxy)]));
const blocked = [];
let createLoginSessionVault;

const cookie = (patch = {}) => ({
  name: 'sessionid', value: 'synthetic-cookie-secret', domain: '.dola.com', path: '/',
  expires: -1, httpOnly: true, secure: true, sameSite: 'None', ...patch,
});
const storage = (origin = 'https://www.dola.com', localStorage = [{ name: 'synthetic-token', value: 'synthetic-storage-secret' }]) => ({ origin, localStorage });
const payload = (patch = {}) => ({
  identity: { sub: 'synthetic-google-sub', email: EMAIL, email_verified: true },
  dolaId: 'synthetic-dola-id', cookies: [cookie()], origins: [storage()], ...patch,
});

async function fixture(t) {
  // Cleanup uses this exact mkdtemp result, never a configured/default path.
  const parent = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'login-session-vault-test-'));
  const directory = join(parent, 'encrypted-sessions');
  const f = { parent, directory, file: join(directory, `${hash(EMAIL)}.enc`), key: join(directory, 'master.key'), now: START };
  f.vault = createLoginSessionVault({ directory, clock: () => f.now });
  f.record = async (path = f.file, email = EMAIL, proxy = PROXY) => {
    const bytes = await fs.readFile(path);
    const decipher = createDecipheriv('aes-256-gcm', await fs.readFile(f.key), bytes.subarray(8, 20));
    decipher.setAAD(aad(email, proxy));
    decipher.setAuthTag(bytes.subarray(20, 36));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(36)), decipher.final()]).toString('utf8'));
  };
  f.encode = async record => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await fs.readFile(f.key), iv);
    cipher.setAAD(aad());
    const bytes = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(record))), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), bytes]);
  };
  t.after(async () => {
    await fs.chmod(parent, 0o700);
    const info = await fs.lstat(directory).catch(() => null);
    if (info?.isDirectory() && !info.isSymbolicLink()) await fs.chmod(directory, 0o700);
    await fs.rm(parent, { recursive: true, force: true });
  });
  return f;
}

async function failure(promise) {
  await assert.rejects(promise, error => {
    assert.equal(error.constructor, Error);
    assert.equal(error.message, 'login_session_vault_save_failed');
    assert.equal(error.cause, undefined);
    assert.deepEqual(Object.keys(error), []);
    assert.ok(!String(error.stack).includes('synthetic-proxy-secret'));
    return true;
  });
}

describe('encrypted login session vault (isolated, offline)', { concurrency: false, timeout: 30_000 }, () => {
  before(async () => {
    const deny = label => () => { blocked.push(label); throw new Error(`Blocked ${label}`); };
    mock.method(globalThis, 'fetch', deny('fetch'));
    for (const [object, methods] of [
      [http, ['request', 'get']], [https, ['request', 'get']],
      [net, ['connect', 'createConnection']], [net.Socket.prototype, ['connect']], [tls, ['connect']],
      [childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
      [console, ['log', 'warn', 'error', 'info', 'debug']],
    ]) for (const method of methods) mock.method(object, method, deny(method));
    syncBuiltinESMExports();
    ({ createLoginSessionVault } = await import('../server/dola/login-session-vault.js'));
  });
  after(() => {
    try { assert.deepEqual(blocked, [], 'Vault must not log, access the network/keychain or start processes'); }
    finally { mock.restoreAll(); syncBuiltinESMExports(); }
  });

  test('construction/load/hasRecord/clear do not create a missing directory or key', async t => {
    const f = await fixture(t);
    assert.deepEqual(await fs.readdir(f.parent), []);
    assert.equal(await f.vault.hasRecord(EMAIL), false);
    assert.equal(await f.vault.load(EMAIL, PROXY), null);
    assert.equal(await f.vault.clear(EMAIL), false);
    assert.deepEqual(await fs.readdir(f.parent), []);
    await fs.mkdir(f.directory, { mode: 0o700 });
    assert.equal(await f.vault.hasRecord(EMAIL), false);
    assert.equal(await f.vault.load(EMAIL, PROXY), null);
    assert.deepEqual(await fs.readdir(f.directory), []);
  });

  test('AES-256-GCM round trip, normalized account filename, exact private modes and random IV', async t => {
    const f = await fixture(t);
    await f.vault.save(' Synthetic-Vault\\@EXAMPLE.TEST ', PROXY, payload());
    assert.deepEqual((await fs.readdir(f.directory)).sort(), [`${hash(EMAIL)}.enc`, 'master.key'].sort());
    assert.equal((await fs.lstat(f.directory)).mode & 0o7777, 0o700);
    for (const path of [f.key, f.file]) {
      const info = await fs.lstat(path);
      assert.equal(info.mode & 0o7777, 0o600);
      assert.equal(info.uid, process.geteuid());
      assert.equal(info.nlink, 1);
    }
    const key = await fs.readFile(f.key);
    assert.equal(key.length, 32);
    const first = await fs.readFile(f.file);
    assert.deepEqual(first.subarray(0, 8), MAGIC);
    assert.ok(first.length <= MAX_BYTES);
    for (const secret of [EMAIL, PROXY, 'synthetic-proxy-secret', 'synthetic-google-sub', 'synthetic-dola-id',
      'synthetic-cookie-secret', 'synthetic-token', 'synthetic-storage-secret', 'cookies', 'origins']) {
      assert.equal(first.includes(Buffer.from(secret)), false);
      assert.equal(key.includes(Buffer.from(secret)), false);
    }
    assert.deepEqual(await f.record(), { version: 1, savedAt: START, accountHash: hash(EMAIL), proxyHash: hash(PROXY), session: payload() });
    assert.deepEqual(await f.vault.load(' SYNTHETIC-VAULT@EXAMPLE.TEST ', PROXY), payload());
    assert.equal(await f.vault.hasRecord('SYNTHETIC-VAULT@EXAMPLE.TEST'), true);
    await f.vault.save(EMAIL, PROXY, payload());
    const second = await fs.readFile(f.file);
    assert.notDeepEqual(second.subarray(8, 20), first.subarray(8, 20));
    assert.notDeepEqual(second, first);
    assert.deepEqual(await fs.readFile(f.key), key, 'Saving never rotates the master key');
    const another = await fixture(t);
    await another.vault.save(EMAIL, PROXY, payload());
    assert.notDeepEqual(await fs.readFile(another.key), key);
  });

  test('only exact Dola and Google cookie domains survive; partitioned cookies are excluded', async t => {
    const f = await fixture(t);
    const allowed = ['dola.com', '.dola.com', 'www.dola.com', '.www.dola.com', 'google.com', '.google.com', 'accounts.google.com', '.accounts.google.com', 'a.accounts.google.com'];
    const rejected = ['auth.dola.com', 'dola.com.evil.test', 'google.com.evil.test', 'evilgoogle.com', 'googleapis.com',
      'https://google.com', 'google.com:443', 'google.com.', '..google.com', 'bad..google.com', '__proto__.google.com', ' google.com'];
    const cookies = [...allowed, ...rejected].map((domain, i) => cookie({ domain, name: `test_${i}` }));
    cookies.push(cookie({ partitionKey: 'https://google.com' }), cookie({ partitionKey: undefined }),
      cookie({ partitionKey: { topLevelSite: 'https://google.com' } }), cookie({ partitioned: true }), cookie({ partitionKeyOpaque: true }));
    await f.vault.save(EMAIL, PROXY, payload({ cookies }));
    assert.deepEqual((await f.vault.load(EMAIL, PROXY)).cookies.map(item => item.domain), allowed);
  });

  test('storage exact-origin allowlist and all field allowlists discard unrelated secrets without invoking getters', async t => {
    const f = await fixture(t);
    const allowed = ['https://www.dola.com', 'https://dola.com', 'https://accounts.google.com'];
    const rejected = ['http://www.dola.com', 'https://www.dola.com/', 'https://www.dola.com:443', 'https://auth.dola.com',
      'https://google.com', 'https://mail.google.com', 'https://accounts.google.com.evil.test', 'https://WWW.DOLA.COM'];
    const extras = { password: 'synthetic-password-secret', recoveryEmail: 'synthetic-recovery@example.test',
      verificationUrl: 'https://example.test/synthetic-verify-secret', OAuthURL: 'https://example.test/synthetic-oauth-secret',
      access_token: 'synthetic-extra-token', indexedDB: 'synthetic-db-secret', sessionStorage: 'synthetic-session-storage' };
    const origins = [...allowed, ...rejected].map(origin => ({ ...storage(origin), ...extras,
      localStorage: [{ name: 'key', value: 'synthetic-retained-value', ...extras }] }));
    const input = payload({ ...extras, identity: { ...payload().identity, ...extras }, cookies: [{ ...cookie(), ...extras }], origins });
    Object.defineProperty(input, 'unusedSecret', { enumerable: true, get() { throw new Error('Must not inspect unknown fields'); } });
    await f.vault.save(EMAIL, PROXY, input);
    const expected = payload({ origins: allowed.map(origin => storage(origin, [{ name: 'key', value: 'synthetic-retained-value' }])) });
    assert.deepEqual(await f.vault.load(EMAIL, PROXY), expected);
    const decoded = await f.record();
    assert.deepEqual(decoded.session, expected);
    for (const secret of Object.values(extras)) assert.ok(!JSON.stringify(decoded).includes(secret));
  });

  test('manual sessions allow identity:null but require dolaId; nonmanual identity must be verified and match', async t => {
    const f = await fixture(t);
    const manual = payload({ identity: null, manual: true });
    await f.vault.save(EMAIL, PROXY, manual);
    assert.deepEqual(await f.vault.load(EMAIL, PROXY), manual);
    const prior = await fs.readFile(f.file);
    for (const input of [payload({ identity: null }), payload({ manual: false }), payload({ manual: true, identity: undefined }),
      payload({ manual: true, identity: null, dolaId: '' }), payload({ identity: { ...payload().identity, email: OTHER } }),
      payload({ identity: { ...payload().identity, email_verified: false } }), payload({ identity: { ...payload().identity, sub: '' } })]) {
      await failure(f.vault.save(EMAIL, PROXY, input));
    }
    assert.deepEqual(await fs.readFile(f.file), prior);
  });

  test('email/proxy validation is bounded and secret-safe, with no I/O on invalid input', async t => {
    const f = await fixture(t);
    for (const email of ['', '../account@example.test', 'a@@example.test', '.a@example.test', 'a..b@example.test',
      'a@example', 'a@-example.test', 'a@example..test', 'a\0@example.test', 'x'.repeat(65) + '@example.test', null, {}]) {
      await failure(f.vault.save(email, PROXY, payload()));
      assert.equal(await f.vault.load(email, PROXY), null);
      assert.equal(await f.vault.hasRecord(email), true);
    }
    for (const proxy of ['', 'direct', 'file:///tmp/test', 'socks5://proxy.example.test/path',
      `${PROXY}?secret=yes`, `${PROXY}#secret`, ` ${PROXY}`, 'http://user:%00@proxy.example.test',
      'http://user:%zz@proxy.example.test', 'http://proxy.example.test\\bad', 'x'.repeat(4097), null]) {
      await failure(f.vault.save(EMAIL, proxy, payload()));
      assert.equal(await f.vault.load(EMAIL, proxy), null);
    }
    assert.deepEqual(await fs.readdir(f.parent), []);
  });

  test('500 cookies and 1000 storage entries are supported, and every retained field/count/total has a limit', async t => {
    const f = await fixture(t);
    const cookies = Array.from({ length: 500 }, (_, i) => cookie({ name: `cookie_${i}` }));
    const localStorage = Array.from({ length: 1000 }, (_, i) => ({ name: `storage_${i}`, value: 'v' }));
    const full = payload({ cookies, origins: [storage('https://dola.com', localStorage)] });
    await f.vault.save(EMAIL, PROXY, full);
    assert.deepEqual(await f.vault.load(EMAIL, PROXY), full);
    const prior = await fs.readFile(f.file);
    const badCookies = [cookie({ name: 'x'.repeat(257) }), cookie({ value: 'x'.repeat(16385) }),
      cookie({ value: '中'.repeat(6000) }), cookie({ value: 'bad;value' }), cookie({ path: 'x' }),
      cookie({ path: '/' + 'x'.repeat(2048) }), cookie({ domain: 'x'.repeat(255) }),
      cookie({ expires: Infinity }), cookie({ expires: -2 }), cookie({ secure: 'true' }), cookie({ sameSite: 'Bad' })];
    const invalid = [payload({ cookies: [...cookies, cookie()] }), ...badCookies.map(item => payload({ cookies: [item] })),
      payload({ dolaId: 'x'.repeat(513) }), payload({ identity: { ...payload().identity, sub: 'x'.repeat(513) } }),
      payload({ origins: Array.from({ length: 1001 }, () => storage('https://other.example.test')) }),
      payload({ origins: [storage('https://dola.com', [...localStorage, { name: 'extra', value: 'x' }])] }),
      payload({ origins: [storage('https://dola.com', [{ name: 'x'.repeat(1025), value: 'x' }])] }),
      payload({ origins: [storage('https://dola.com', [{ name: 'x', value: 'x'.repeat(65537) }])] }),
      payload({ origins: [storage(), storage()] }),
      payload({ origins: [storage('https://dola.com', [{ name: 'x', value: 'a' }, { name: 'x', value: 'b' }])] }),
      payload({ cookies: Array.from({ length: 70 }, (_, i) => cookie({ name: `large_${i}`, value: 'x'.repeat(16384) })) }),
      payload({ origins: [storage('https://dola.com', Array.from({ length: 16 }, (_, i) => ({ name: `large_${i}`, value: 'x'.repeat(65536) })))] }),
    ];
    for (const input of invalid) await failure(f.vault.save(EMAIL, PROXY, input));
    assert.deepEqual(await fs.readFile(f.file), prior);
  });

  test('tampering with header, IV, tag or ciphertext; truncation and plaintext all fail closed', async t => {
    const f = await fixture(t);
    await f.vault.save(EMAIL, PROXY, payload());
    const original = await fs.readFile(f.file);
    const mutations = [Buffer.alloc(0), original.subarray(0, 35), Buffer.from(JSON.stringify(payload()))];
    for (const position of [0, 8, 20, 36, original.length - 1]) {
      const bytes = Buffer.from(original); bytes[position] ^= 1; mutations.push(bytes);
    }
    for (const bytes of mutations) {
      await fs.writeFile(f.file, bytes);
      assert.equal(await f.vault.hasRecord(EMAIL), true, 'Corruption must block legacy fallback');
      assert.equal(await f.vault.load(EMAIL, PROXY), null);
    }
    await fs.writeFile(f.file, original);
    assert.deepEqual(await f.vault.load(EMAIL, PROXY), payload());
  });

  test('aggregate size is rejected during entry validation before traversing a huge storage array', async t => {
    const f = await fixture(t);
    const entries = Array.from({ length: 1000 }, (_, i) => ({ name: `large_${i}`, value: 'x'.repeat(65536) }));
    let traversedPastLimit = false;
    Object.defineProperty(entries, 100, { get() { traversedPastLimit = true; return { name: 'later', value: '' }; } });
    await failure(f.vault.save(EMAIL, PROXY, payload({ origins: [storage('https://dola.com', entries)] })));
    assert.equal(traversedPastLimit, false);
    assert.deepEqual(await fs.readdir(f.parent), []);
  });

  test('AAD prevents cross-account and exact-proxy replay, including manual sessions', async t => {
    const f = await fixture(t);
    const manual = payload({ manual: true, identity: null });
    await f.vault.save(EMAIL, PROXY, manual);
    const otherPath = join(f.directory, `${hash(OTHER)}.enc`);
    await fs.writeFile(otherPath, await fs.readFile(f.file), { mode: 0o600 });
    assert.equal(await f.vault.hasRecord(OTHER), true);
    assert.equal(await f.vault.load(OTHER, PROXY), null);
    for (const proxy of [PROXY.replace('vault-user', 'other-user'), PROXY.replace('synthetic-proxy-secret', 'other-password'),
      PROXY.replace('proxy.example.test', 'other.example.test'), PROXY + '/', PROXY.replace('socks5:', 'socks5h:')]) {
      assert.equal(await f.vault.load(EMAIL, proxy), null);
    }
    assert.deepEqual(await f.vault.load(EMAIL, PROXY), manual);
  });

  test('seven-day TTL expires at the boundary; future and malformed authenticated timestamps are rejected', async t => {
    const f = await fixture(t);
    await f.vault.save(EMAIL, PROXY, payload());
    f.now = START + WEEK - 1;
    assert.deepEqual(await f.vault.load(EMAIL, PROXY), payload());
    f.now = START + WEEK;
    assert.equal(await f.vault.load(EMAIL, PROXY), null);
    assert.equal(await f.vault.hasRecord(EMAIL), true);
    f.now = START - 1;
    assert.equal(await f.vault.load(EMAIL, PROXY), null);
    f.now = START;
    const record = await f.record();
    for (const savedAt of [-1, START + 1, START + 0.5, '2026-09-20', null, Number.MAX_SAFE_INTEGER + 1]) {
      await fs.writeFile(f.file, await f.encode({ ...record, savedAt }));
      assert.equal(await f.vault.load(EMAIL, PROXY), null);
    }
    f.now = NaN;
    await failure(f.vault.save(EMAIL, PROXY, payload()));
  });

  test('authenticated malformed schemas and identity bindings are rejected too', async t => {
    const f = await fixture(t);
    await f.vault.save(EMAIL, PROXY, payload());
    const record = await f.record();
    for (const bad of [{ ...record, version: 2 }, { ...record, accountHash: hash(OTHER) }, { ...record, proxyHash: hash('other') },
      { ...record, password: 'synthetic-unwanted' }, { ...record, session: { ...record.session, recoveryEmail: OTHER } },
      { ...record, session: payload({ identity: { ...payload().identity, email: OTHER } }) },
      { ...record, session: payload({ cookies: [cookie({ partitionKey: 'https://dola.com' })] }) },
      { ...record, session: payload({ cookies: [cookie({ domain: 'other.example.test' })] }) },
      { ...record, session: payload({ origins: [storage('https://mail.google.com')] }) }]) {
      await fs.writeFile(f.file, await f.encode(bad));
      assert.equal(await f.vault.load(EMAIL, PROXY), null);
      assert.equal(await f.vault.hasRecord(EMAIL), true);
    }
  });

  test('missing, changed, malformed or oversized master keys never fall back to plaintext or get silently repaired', async t => {
    const f = await fixture(t);
    await f.vault.save(EMAIL, PROXY, payload());
    const key = await fs.readFile(f.key), record = await fs.readFile(f.file);
    await fs.unlink(f.key);
    assert.equal(await f.vault.load(EMAIL, PROXY), null);
    assert.equal(await f.vault.hasRecord(EMAIL), true);
    await failure(f.vault.save(EMAIL, PROXY, payload()));
    assert.equal(await fs.lstat(f.key).catch(() => null), null);
    for (const bad of [Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33), Buffer.alloc(MAX_BYTES + 1)]) {
      await fs.writeFile(f.key, bad, { mode: 0o600 });
      assert.equal(await f.vault.load(EMAIL, PROXY), null);
      await failure(f.vault.save(EMAIL, PROXY, payload()));
      assert.deepEqual(await fs.readFile(f.key), bad);
    }
    await fs.writeFile(f.key, randomBytes(32));
    assert.equal(await f.vault.load(EMAIL, PROXY), null);
    assert.equal(await f.vault.hasRecord(EMAIL), true);
    assert.deepEqual(await fs.readFile(f.file), record);
    await fs.writeFile(f.key, key);
    assert.deepEqual(await f.vault.load(EMAIL, PROXY), payload());
  });

  test('oversized records are not read, replaced or cleared; a file growing during read is bounded', async t => {
    const f = await fixture(t);
    await f.vault.save(EMAIL, PROXY, payload());
    const original = await fs.readFile(f.file);
    await fs.writeFile(f.file, Buffer.alloc(MAX_BYTES + 1));
    const realOpen = fs.open;
    const guard = t.mock.method(fs, 'open', async (...args) => {
      assert.notEqual(args[0], f.file, 'Oversize must be rejected before open');
      return realOpen(...args);
    });
    assert.equal(await f.vault.load(EMAIL, PROXY), null);
    assert.equal(await f.vault.hasRecord(EMAIL), true);
    await failure(f.vault.save(EMAIL, PROXY, payload()));
    assert.equal(await f.vault.clear(EMAIL), false);
    guard.mock.restore();
    await fs.writeFile(f.file, original);
    let inspected = false;
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === f.file) {
        const read = handle.read.bind(handle);
        handle.read = async (buffer, offset, length, position) => {
          assert.ok(buffer.length <= MAX_BYTES + 1);
          if (!inspected) { inspected = true; await fs.writeFile(f.file, Buffer.alloc(MAX_BYTES + 2)); }
          return read(buffer, offset, length, position);
        };
      }
      return handle;
    });
    assert.equal(await f.vault.load(EMAIL, PROXY), null);
    assert.equal(inspected, true);
  });

  test('unsafe root/key/record modes fail closed and are never silently chmodded', async t => {
    const f = await fixture(t);
    await f.vault.save(EMAIL, PROXY, payload());
    for (const [path, mode] of [[f.directory, 0o755], [f.directory, 0o1700], [f.file, 0o644], [f.file, 0o660],
      [f.file, 0o700], [f.key, 0o644], [f.key, 0o400]]) {
      await fs.chmod(path, mode);
      assert.equal(await f.vault.hasRecord(EMAIL), true);
      assert.equal(await f.vault.load(EMAIL, PROXY), null);
      await failure(f.vault.save(EMAIL, PROXY, payload()));
      if (path !== f.key) assert.equal(await f.vault.clear(EMAIL), false);
      assert.equal((await fs.lstat(path)).mode & 0o7777, mode);
      await fs.chmod(path, path === f.directory ? 0o700 : 0o600);
    }
    assert.deepEqual(await f.vault.load(EMAIL, PROXY), payload());
  });

  test('foreign uid from lstat or opened fd is rejected with correct modes', async t => {
    const f = await fixture(t);
    await f.vault.save(EMAIL, PROXY, payload());
    const realLstat = fs.lstat, realOpen = fs.open;
    for (const path of [f.directory, f.file, f.key]) {
      const override = t.mock.method(fs, 'lstat', async (...args) => {
        const info = await realLstat(...args);
        if (args[0] === path) info.uid += 1;
        return info;
      });
      assert.equal(await f.vault.hasRecord(EMAIL), true);
      assert.equal(await f.vault.load(EMAIL, PROXY), null);
      await failure(f.vault.save(EMAIL, PROXY, payload()));
      if (path !== f.key) assert.equal(await f.vault.clear(EMAIL), false);
      override.mock.restore();
    }
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === f.key) {
        const stat = handle.stat.bind(handle);
        handle.stat = async () => { const info = await stat(); info.uid += 1; return info; };
      }
      return handle;
    });
    assert.equal(await f.vault.load(EMAIL, PROXY), null);
    await failure(f.vault.save(EMAIL, PROXY, payload()));
  });

  test('symlink roots and ancestor paths are refused without writing through them', async t => {
    const f = await fixture(t);
    const target = join(f.parent, 'target');
    await fs.mkdir(target, { mode: 0o700 });
    await fs.writeFile(join(target, 'sentinel'), 'synthetic-unchanged', { mode: 0o600 });
    await fs.symlink(target, f.directory);
    for (const directory of [f.directory, join(f.directory, 'nested')]) {
      const vault = createLoginSessionVault({ directory, clock: () => START });
      assert.equal(await vault.hasRecord(EMAIL), true);
      assert.equal(await vault.load(EMAIL, PROXY), null);
      await failure(vault.save(EMAIL, PROXY, payload()));
      assert.equal(await vault.clear(EMAIL), false);
    }
    assert.deepEqual(await fs.readdir(target), ['sentinel']);
    assert.equal(await fs.readFile(join(target, 'sentinel'), 'utf8'), 'synthetic-unchanged');
  });

  test('symlink/hardlink records and keys are refused, including dangling links', async t => {
    const f = await fixture(t);
    await f.vault.save(EMAIL, PROXY, payload());
    for (const path of [f.file, f.key]) {
      const target = join(f.parent, path === f.key ? 'key-target' : 'record-target');
      await fs.rename(path, target);
      const original = await fs.readFile(target);
      for (const link of [fs.symlink, fs.link]) {
        await link(target, path);
        assert.equal(await f.vault.hasRecord(EMAIL), true);
        assert.equal(await f.vault.load(EMAIL, PROXY), null);
        await failure(f.vault.save(EMAIL, PROXY, payload()));
        if (path === f.file) assert.equal(await f.vault.clear(EMAIL), false);
        assert.deepEqual(await fs.readFile(target), original);
        await fs.unlink(path);
      }
      await fs.symlink(join(f.parent, 'absent-target'), path);
      assert.equal(await f.vault.hasRecord(EMAIL), true);
      assert.equal(await f.vault.load(EMAIL, PROXY), null);
      await failure(f.vault.save(EMAIL, PROXY, payload()));
      await fs.unlink(path);
      await fs.rename(target, path);
    }
  });

  test('non-file records/keys and a non-directory root fail conservatively', async t => {
    const f = await fixture(t);
    await fs.writeFile(f.directory, 'synthetic-not-directory', { mode: 0o600 });
    assert.equal(await f.vault.hasRecord(EMAIL), true);
    await failure(f.vault.save(EMAIL, PROXY, payload()));
    await fs.unlink(f.directory);
    await f.vault.save(EMAIL, PROXY, payload());
    for (const path of [f.file, f.key]) {
      const bytes = await fs.readFile(path);
      await fs.unlink(path);
      await fs.mkdir(path, { mode: 0o700 });
      assert.equal(await f.vault.hasRecord(EMAIL), true);
      assert.equal(await f.vault.load(EMAIL, PROXY), null);
      await failure(f.vault.save(EMAIL, PROXY, payload()));
      await fs.rmdir(path);
      await fs.writeFile(path, bytes, { mode: 0o600 });
    }
  });

  test('hasRecord conservatively blocks fallback on inspection errors and confirms missing account only', async t => {
    const f = await fixture(t);
    await f.vault.save(EMAIL, PROXY, payload());
    assert.equal(await f.vault.hasRecord(OTHER), false);
    const realLstat = fs.lstat;
    for (const code of ['EACCES', 'EPERM', 'EIO', 'ELOOP', 'ENOTDIR']) {
      const override = t.mock.method(fs, 'lstat', async (...args) => {
        if (args[0] === f.file) throw Object.assign(new Error('synthetic-sensitive-filesystem-error'), { code });
        return realLstat(...args);
      });
      assert.equal(await f.vault.hasRecord(EMAIL), true);
      override.mock.restore();
    }
    assert.equal(await f.vault.clear(EMAIL), true);
    assert.equal(await f.vault.hasRecord(EMAIL), false);
    assert.deepEqual(await fs.readdir(f.directory), ['master.key']);
  });

  test('exclusive private staging is fsynced, key publication never overwrites, and record rename is atomic', async t => {
    const f = await fixture(t);
    const realOpen = fs.open, realLink = fs.link, realRename = fs.rename;
    const synced = new Set();
    let publishes = 0, renames = 0;
    t.mock.method(fs, 'open', async (path, flags, mode) => {
      const handle = await realOpen(path, flags, mode);
      assert.equal(flags & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
      if (String(path).endsWith('.tmp')) {
        assert.equal(flags & constants.O_EXCL, constants.O_EXCL);
        assert.equal(flags & constants.O_CREAT, constants.O_CREAT);
        assert.equal(mode, 0o600);
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await sync(); synced.add(path); };
      }
      return handle;
    });
    t.mock.method(fs, 'link', async (from, to) => {
      assert.equal(to, f.key);
      assert.equal(synced.has(from), true);
      assert.equal((await fs.readFile(from)).length, 32);
      publishes++;
      return realLink(from, to);
    });
    t.mock.method(fs, 'rename', async (from, to) => {
      assert.equal(to, f.file);
      assert.equal(synced.has(from), true);
      const staged = await fs.readFile(from);
      assert.deepEqual(staged.subarray(0, 8), MAGIC);
      assert.ok(!staged.includes(Buffer.from('synthetic-cookie-secret')));
      if (renames === 1) assert.deepEqual(await f.vault.load(EMAIL, PROXY), payload());
      renames++;
      return realRename(from, to);
    });
    await f.vault.save(EMAIL, PROXY, payload());
    const next = payload({ dolaId: 'synthetic-next-id' });
    await f.vault.save(EMAIL, PROXY, next);
    assert.deepEqual(await f.vault.load(EMAIL, PROXY), next);
    assert.equal(publishes, 1);
    assert.equal(renames, 2);
    assert.deepEqual((await fs.readdir(f.directory)).sort(), [`${hash(EMAIL)}.enc`, 'master.key'].sort());
  });

  test('failed atomic rename preserves previous data and cleans only its own staging file', async t => {
    const f = await fixture(t);
    await f.vault.save(EMAIL, PROXY, payload());
    const original = await fs.readFile(f.file);
    const unrelated = join(f.directory, '.unrelated.tmp');
    await fs.writeFile(unrelated, 'synthetic-other-writer', { mode: 0o600 });
    t.mock.method(fs, 'rename', async () => { throw new Error(PROXY); });
    await failure(f.vault.save(EMAIL, PROXY, payload({ dolaId: 'synthetic-next-id' })));
    assert.deepEqual(await fs.readFile(f.file), original);
    assert.deepEqual((await fs.readdir(f.directory)).sort(), ['.unrelated.tmp', `${hash(EMAIL)}.enc`, 'master.key'].sort());
  });

  test('failed key publication leaves no partial key or record and reports only a generic error', async t => {
    const f = await fixture(t);
    t.mock.method(fs, 'link', async () => { throw new Error(PROXY); });
    await failure(f.vault.save(EMAIL, PROXY, payload()));
    assert.deepEqual(await fs.readdir(f.directory), []);
    assert.equal(await f.vault.hasRecord(EMAIL), false);
  });

  test('cancellation before save creates nothing; cancellation after record fsync preserves previous snapshot', async t => {
    const f = await fixture(t);
    const controller = new AbortController(); controller.abort(PROXY);
    await failure(f.vault.save(EMAIL, PROXY, payload(), { signal: controller.signal }));
    assert.deepEqual(await fs.readdir(f.parent), []);
    await f.vault.save(EMAIL, PROXY, payload());
    const original = await fs.readFile(f.file);
    const during = new AbortController(), realOpen = fs.open;
    let aborted = false;
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await sync(); aborted = true; during.abort(PROXY); };
      }
      return handle;
    });
    await failure(f.vault.save(EMAIL, PROXY, payload({ dolaId: 'synthetic-next-id' }), { signal: during.signal }));
    assert.equal(aborted, true);
    assert.deepEqual(await fs.readFile(f.file), original);
    assert.deepEqual((await fs.readdir(f.directory)).sort(), [`${hash(EMAIL)}.enc`, 'master.key'].sort());
  });

  test('cancellation during initial key staging publishes neither key nor record', async t => {
    const f = await fixture(t);
    const controller = new AbortController(), realOpen = fs.open;
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await sync(); controller.abort(); };
      }
      return handle;
    });
    await failure(f.vault.save(EMAIL, PROXY, payload(), { signal: controller.signal }));
    assert.deepEqual(await fs.readdir(f.directory), []);
  });

  test('replacing the root during staging aborts commit and never deletes from the replacement', async t => {
    const f = await fixture(t);
    await f.vault.save(EMAIL, PROXY, payload());
    const moved = join(f.parent, 'original-root');
    const realOpen = fs.open;
    let replaced = false;
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          if (!replaced) {
            replaced = true;
            await fs.rename(f.directory, moved);
            await fs.mkdir(f.directory, { mode: 0o700 });
            await fs.writeFile(join(f.directory, 'sentinel'), 'synthetic-unchanged', { mode: 0o600 });
          }
        };
      }
      return handle;
    });
    await failure(f.vault.save(EMAIL, PROXY, payload({ dolaId: 'synthetic-next-id' })));
    assert.equal(replaced, true);
    assert.deepEqual(await fs.readdir(f.directory), ['sentinel']);
    assert.equal(await fs.readFile(join(f.directory, 'sentinel'), 'utf8'), 'synthetic-unchanged');
    const originalVault = createLoginSessionVault({ directory: moved, clock: () => START });
    assert.deepEqual(await originalVault.load(EMAIL, PROXY), payload());
  });

  test('concurrent first saves from separate vault instances publish exactly one complete master key', async t => {
    const f = await fixture(t), count = 16;
    const realLink = fs.link;
    let arrived = 0, release, winners = 0;
    const allReady = new Promise(resolve => { release = resolve; });
    t.mock.method(fs, 'link', async (...args) => {
      if (args[1] === f.key) {
        arrived++;
        if (arrived === count) release();
        await allReady;
        await realLink(...args);
        winners++;
        return;
      }
      return realLink(...args);
    });
    const accounts = Array.from({ length: count }, (_, i) => {
      const email = `synthetic-${i}@example.test`;
      return { email, session: payload({ identity: { ...payload().identity, email }, dolaId: `synthetic-id-${i}` }),
        vault: createLoginSessionVault({ directory: f.directory, clock: () => START }) };
    });
    const results = await Promise.allSettled(accounts.map(({ email, session, vault }) => vault.save(email, PROXY, session)));
    assert.deepEqual(results.map(item => item.status), Array(count).fill('fulfilled'));
    assert.equal(winners, 1);
    assert.equal((await fs.readFile(f.key)).length, 32);
    assert.equal((await fs.lstat(f.key)).nlink, 1);
    assert.equal((await fs.readdir(f.directory)).length, count + 1);
    for (const { email, session, vault } of accounts) assert.deepEqual(await vault.load(email, PROXY), session);
  });

  test('concurrent updates of one account leave a complete decryptable record and no staging debris', async t => {
    const f = await fixture(t);
    await f.vault.save(EMAIL, PROXY, payload());
    const key = await fs.readFile(f.key);
    const sessions = Array.from({ length: 8 }, (_, i) => payload({ dolaId: `synthetic-update-${i}` }));
    await Promise.all(sessions.map(session => createLoginSessionVault({ directory: f.directory, clock: () => START }).save(EMAIL, PROXY, session)));
    const loaded = await f.vault.load(EMAIL, PROXY);
    assert.ok(sessions.some(session => session.dolaId === loaded?.dolaId));
    assert.deepEqual(await fs.readFile(f.key), key);
    assert.deepEqual((await fs.readdir(f.directory)).sort(), [`${hash(EMAIL)}.enc`, 'master.key'].sort());
  });

  test('a concurrent atomic replacement can retire the inode returned by lstat without failing a valid save', async t => {
    const f = await fixture(t);
    await f.vault.save(EMAIL, PROXY, payload());
    const key = await fs.readFile(f.key);
    const sibling = createLoginSessionVault({ directory: f.directory, clock: () => START });
    const realLstat = fs.lstat;
    let recordStats = 0, retired = false;
    t.mock.method(fs, 'lstat', async (...args) => {
      if (args[0] === f.file && ++recordStats === 2) {
        // Deterministically return the same metadata lstat can observe when
        // another writer retires this inode during the filesystem call.
        const old = await fs.open(f.file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await sibling.save(EMAIL, PROXY, payload({ dolaId: 'synthetic-concurrent-id' }));
          const info = await old.stat();
          assert.equal(info.nlink, 0);
          retired = true;
          return info;
        } finally { await old.close(); }
      }
      return realLstat(...args);
    });
    const next = payload({ dolaId: 'synthetic-final-id' });
    await f.vault.save(EMAIL, PROXY, next);
    assert.equal(retired, true);
    assert.deepEqual(await f.vault.load(EMAIL, PROXY), next);
    assert.deepEqual(await fs.readFile(f.key), key);
    assert.deepEqual((await fs.readdir(f.directory)).sort(), [`${hash(EMAIL)}.enc`, 'master.key'].sort());
  });

  test('retrying a retired inode still rejects an unsafe replacement and preserves its bytes', async t => {
    for (const replacement of ['unsafe-mode', 'foreign-owner', 'symlink', 'hardlink', 'oversized', 'root-symlink']) {
      await t.test(replacement, async t => {
        const f = await fixture(t);
        await f.vault.save(EMAIL, PROXY, payload());
        const sentinel = join(f.parent, 'replacement-sentinel');
        const bytes = replacement === 'oversized' ? Buffer.alloc(MAX_BYTES + 1) : Buffer.from('synthetic-untouched');
        await fs.writeFile(sentinel, bytes, { mode: 0o600 });
        const realLstat = fs.lstat;
        let recordStats = 0, retired = false;
        t.mock.method(fs, 'lstat', async (...args) => {
          if (args[0] === f.file && ++recordStats === 2) {
            const old = await fs.open(f.file, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              await fs.unlink(f.file);
              if (replacement === 'symlink') await fs.symlink(sentinel, f.file);
              else if (replacement === 'hardlink') await fs.link(sentinel, f.file);
              else if (replacement === 'root-symlink') {
                const moved = join(f.parent, 'retired-root');
                await fs.rename(f.directory, moved);
                await fs.symlink(moved, f.directory);
              } else await fs.writeFile(f.file, bytes, { mode: replacement === 'unsafe-mode' ? 0o644 : 0o600 });
              const info = await old.stat();
              assert.equal(info.nlink, 0);
              retired = true;
              return info;
            } finally { await old.close(); }
          }
          const info = await realLstat(...args);
          if (args[0] === f.file && retired && replacement === 'foreign-owner') info.uid += 1;
          return info;
        });
        await failure(f.vault.save(EMAIL, PROXY, payload({ dolaId: 'synthetic-rejected-id' })));
        assert.equal(retired, true);
        assert.deepEqual(await fs.readFile(sentinel), bytes);
        if (replacement !== 'root-symlink') assert.deepEqual(await fs.readFile(f.file), bytes);
        assert.equal(await f.vault.hasRecord(EMAIL), true);
      });
    }
  });

  test('persistent zero-link metadata is bounded and never accepted as a safe target', async t => {
    const f = await fixture(t);
    await f.vault.save(EMAIL, PROXY, payload());
    const prior = await fs.readFile(f.file), realLstat = fs.lstat;
    let attempts = 0;
    t.mock.method(fs, 'lstat', async (...args) => {
      const info = await realLstat(...args);
      if (args[0] === f.file) { attempts++; info.nlink = 0; }
      return info;
    });
    await failure(f.vault.save(EMAIL, PROXY, payload()));
    assert.ok(attempts > 1 && attempts <= 16);
    assert.deepEqual(await fs.readFile(f.file), prior);
    assert.deepEqual((await fs.readdir(f.directory)).sort(), [`${hash(EMAIL)}.enc`, 'master.key'].sort());
  });

  test('clear affects only the normalized account and preserves the other account and master key', async t => {
    const f = await fixture(t);
    const other = payload({ identity: { ...payload().identity, email: OTHER }, dolaId: 'synthetic-other-id' });
    await f.vault.save(EMAIL, PROXY, payload());
    await f.vault.save(OTHER, PROXY, other);
    const key = await fs.readFile(f.key);
    assert.equal(await f.vault.clear(' Synthetic-Vault\\@EXAMPLE.TEST '), true);
    assert.equal(await f.vault.clear(EMAIL), false);
    assert.equal(await f.vault.hasRecord(EMAIL), false);
    assert.equal(await f.vault.load(EMAIL, PROXY), null);
    assert.deepEqual(await f.vault.load(OTHER, PROXY), other);
    assert.deepEqual(await fs.readFile(f.key), key);
    assert.deepEqual((await fs.readdir(f.directory)).sort(), [`${hash(OTHER)}.enc`, 'master.key'].sort());
  });
});
