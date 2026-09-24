import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { DatabaseSync } from 'node:sqlite';
import { LOGIN_REGISTRY_SCHEMA, createLoginProfileRegistry } from '../server/dola/account-login-registry.js';

const STAMP = '2026-09-20T12:00:00.000Z';
const entry = email => ({ email, password: 'synthetic-password', loginMethod: 'google_link',
  recoveryEmail: 'synthetic-recovery@example.test',
  googleSessionUrl: 'https://gapi.mailsapi.com/google/login?uid=synthetic-uid',
  verificationUrl: 'https://codes.example.test/?token=synthetic-token' });
const a = 'synthetic-a@example.test';
const b = 'synthetic-b@example.test';
const c = 'synthetic-c@example.test';
const result = (email, id) => ({ email, profileId: id, accountCode: `A${String(id).padStart(2, '0')}` });

function fixture(t, { clock = () => STAMP, Engine = Database } = {}) {
  const raw = new Engine(':memory:');
  t.after(() => raw.close());
  // Match the app's minimal adapter, including its lack of db.transaction.
  const db = { exec: sql => raw.exec(sql), prepare: sql => raw.prepare(sql) };
  db.exec(LOGIN_REGISTRY_SCHEMA);
  return { raw, db, registry: createLoginProfileRegistry(db, { clock }) };
}

test('schema is idempotent, AUTOINCREMENT and identity-only, with nullable binding', t => {
  const { db, registry } = fixture(t);
  db.exec(LOGIN_REGISTRY_SCHEMA);
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='dola_login_profiles'").get().sql, /AUTOINCREMENT/);
  assert.deepEqual(db.prepare('PRAGMA table_info(dola_login_profiles)').all().map(row => row.name),
    ['id', 'email', 'created_at', 'account_id']);
  assert.deepEqual(registry.reserve([entry(a)]), [result(a, 1)]);
  assert.deepEqual(db.prepare('SELECT * FROM dola_login_profiles').get(),
    { id: 1, email: a, created_at: STAMP, account_id: null });
  assert.throws(() => db.prepare('INSERT INTO dola_login_profiles(email,created_at) VALUES (?,?)').run(a, STAMP), /UNIQUE/);
  assert.throws(() => db.prepare('INSERT INTO dola_login_profiles(email,created_at) VALUES (?,?)').run(null, STAMP), /NOT NULL/);
});

test('reordered imports reuse stable codes and return results in input order', t => {
  const { registry } = fixture(t);
  assert.deepEqual(registry.reserve([entry(a), entry(b)]), [result(a, 1), result(b, 2)]);
  assert.deepEqual(registry.reserve([entry(b), entry(c), entry(a)]), [result(b, 2), result(c, 3), result(a, 1)]);
});

test('normalization is shared by reserve, lookup and bind', t => {
  const { registry } = fixture(t);
  assert.deepEqual(registry.reserve([entry(' SYNTHETIC-A\\@EXAMPLE.TEST '), entry(a)]), [result(a, 1), result(a, 1)]);
  assert.deepEqual(registry.lookup(' SYNTHETIC-A\\@EXAMPLE.TEST '), { ...result(a, 1), accountId: null });
  assert.deepEqual(registry.bind(' SYNTHETIC-A\\@EXAMPLE.TEST ', 7), { ...result(a, 1), accountId: 7 });
  assert.deepEqual(registry.reserve([entry(b)]), [result(b, 2)]);
});

test('credentials are neither inspected nor stored', t => {
  const { db, registry } = fixture(t);
  const input = { email: a };
  for (const field of ['password', 'loginMethod', 'recoveryEmail', 'googleSessionUrl', 'verificationUrl']) {
    Object.defineProperty(input, field, { get() { throw new Error('secret field was inspected'); } });
  }
  registry.reserve([input, entry(b)]);
  const stored = JSON.stringify(db.prepare('SELECT * FROM dola_login_profiles').all());
  for (const secret of ['synthetic-password', 'synthetic-recovery', 'https://', 'synthetic-uid', 'synthetic-token']) {
    assert.equal(stored.includes(secret), false);
  }
});

test('timestamps are set only at creation and are not rewritten on reuse or bind', t => {
  let calls = 0;
  const { db, registry } = fixture(t, { clock: () => { calls++; return STAMP; } });
  registry.reserve([entry(a), entry(b)]);
  registry.reserve([entry(b), entry(a)]);
  registry.bind(a, 50);
  assert.equal(calls, 2);
  assert.deepEqual(db.prepare('SELECT created_at FROM dola_login_profiles').all().map(row => row.created_at), [STAMP, STAMP]);
});

test('a fresh registry on the same connection preserves existing reservations', t => {
  const { db, registry } = fixture(t);
  registry.reserve([entry(a), entry(b)]);
  const reopened = createLoginProfileRegistry(db);
  assert.deepEqual(reopened.reserve([entry(b), entry(a), entry(c)]), [result(b, 2), result(a, 1), result(c, 3)]);
});

test('deleting the highest committed ID cannot cause code reuse', t => {
  const { db, registry } = fixture(t);
  registry.reserve([entry(a), entry(b)]);
  db.prepare('DELETE FROM dola_login_profiles WHERE email=?').run(b);
  assert.deepEqual(registry.reserve([entry(c)]), [result(c, 3)]);
  db.exec('DELETE FROM dola_login_profiles');
  assert.deepEqual(registry.reserve([entry(a)]), [result(a, 4)]);
});

test('account deletion does not delete its persistent profile or recycle its code', t => {
  const { db, registry } = fixture(t);
  db.exec('CREATE TABLE fixture_accounts(id INTEGER PRIMARY KEY); INSERT INTO fixture_accounts VALUES(42)');
  registry.reserve([entry(a)]);
  registry.bind(a, 42);
  db.exec('DELETE FROM fixture_accounts WHERE id=42');
  assert.deepEqual(registry.reserve([entry(a), entry(b)]), [result(a, 1), result(b, 2)]);
  assert.throws(() => registry.bind(a, 43), /已绑定其他账号/);
});

test('codes remain padded to at least two digits and do not truncate IDs above 99', t => {
  const { registry } = fixture(t);
  const rows = registry.reserve(Array.from({ length: 101 }, (_, i) => entry(`synthetic-${i}@example.test`)));
  assert.equal(rows[0].accountCode, 'A01');
  assert.equal(rows[9].accountCode, 'A10');
  assert.equal(rows[98].accountCode, 'A99');
  assert.equal(rows[99].accountCode, 'A100');
  assert.equal(rows[100].accountCode, 'A101');
});

test('lookup is read-only, returns null for missing email, and exposes binding only', t => {
  const { db, registry } = fixture(t);
  assert.equal(registry.lookup(a), null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM dola_login_profiles').get().n, 0);
  registry.reserve([entry(a)]);
  assert.deepEqual(registry.lookup(a), { ...result(a, 1), accountId: null });
});

test('bind requires a reservation, is idempotent for the same account, and rejects replacement', t => {
  const { registry } = fixture(t);
  assert.throws(() => registry.bind(a, 11), /不存在/);
  assert.equal(registry.lookup(a), null);
  registry.reserve([entry(a)]);
  assert.deepEqual(registry.bind(a, 11), { ...result(a, 1), accountId: 11 });
  assert.deepEqual(registry.bind(a, 11), { ...result(a, 1), accountId: 11 });
  assert.throws(() => registry.bind(a, 12), /已绑定其他账号/);
  assert.equal(registry.lookup(a).accountId, 11);
});

test('invalid binding IDs cannot clear or overwrite an existing binding', t => {
  const { registry } = fixture(t);
  registry.reserve([entry(a)]);
  registry.bind(a, 11);
  for (const id of [null, undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '11', {}, 11n]) {
    assert.throws(() => registry.bind(a, id), /正整数/);
  }
  assert.equal(registry.lookup(a).accountId, 11);
});

test('validated email values use SQL parameters, including legitimate apostrophes', t => {
  const { db, registry } = fixture(t);
  const quoted = "o'hara@example.test";
  assert.deepEqual(registry.reserve([entry(quoted)]), [result(quoted, 1)]);
  registry.bind(quoted, 17);
  assert.equal(registry.lookup(quoted).accountId, 17);
  const malicious = "x@example.test'; DROP TABLE dola_login_profiles; --";
  for (const email of [malicious, null, {}, 'a@@example.test', `${a}\n${b}`, ` ${a}\n`]) {
    for (const operation of [() => registry.reserve([entry(email)]), () => registry.lookup(email), () => registry.bind(email, 17)]) {
      assert.throws(operation, error => error.message === '邮箱格式不正确');
    }
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM dola_login_profiles').get().n, 1);
});

test('invalid reservation input causes no partial records', t => {
  const { registry } = fixture(t);
  for (const input of [undefined, null, {}, a, [entry(a), {}], [entry(a), null], [entry(a), entry('invalid')]]) {
    assert.throws(() => registry.reserve(input));
    assert.equal(registry.lookup(a), null);
  }
  assert.deepEqual(registry.reserve([]), []);
});

test('mid-batch clock failure rolls back all new records and sequence changes', t => {
  let calls = 0;
  const { db, registry } = fixture(t, { clock: () => {
    calls++;
    if (calls === 2) throw new Error('fixture clock failure');
    return STAMP;
  } });
  assert.throws(() => registry.reserve([entry(a), entry(b)]), /fixture clock failure/);
  assert.equal(registry.lookup(a), null);
  assert.equal(registry.lookup(b), null);
  assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='dola_login_profiles'").get(), undefined);
  assert.deepEqual(registry.reserve([entry(c)]), [result(c, 1)]);
});

test('mid-batch SQLite failure rolls back inserts while keeping previously committed profiles', t => {
  const { db, registry } = fixture(t);
  registry.reserve([entry(a)]);
  db.exec(`CREATE TRIGGER fixture_fail_insert BEFORE INSERT ON dola_login_profiles
    WHEN NEW.email='synthetic-c@example.test' BEGIN SELECT RAISE(ABORT,'fixture insert failure'); END;`);
  assert.throws(() => registry.reserve([entry(b), entry(c)]), /fixture insert failure/);
  assert.equal(registry.lookup(b), null);
  assert.deepEqual(registry.lookup(a), { ...result(a, 1), accountId: null });
  assert.deepEqual(registry.reserve([entry(b)]), [result(b, 2)]);
});

for (const [engineName, Engine] of [['better-sqlite3', Database], ['node:sqlite', DatabaseSync]]) {
  test(`${engineName}: outer rollback undoes successful nested reserve and bind`, t => {
    const { db, registry } = fixture(t, { Engine });
    registry.reserve([entry(a)]);
    db.exec('BEGIN');
    registry.reserve([entry(b)]);
    registry.bind(a, 9);
    db.exec('ROLLBACK');
    assert.equal(registry.lookup(a).accountId, null);
    assert.equal(registry.lookup(b), null);
    assert.deepEqual(registry.reserve([entry(c)]), [result(c, 2)]);
  });

  test(`${engineName}: failed nested reservation preserves the outer transaction and its writes`, t => {
    let fail = false;
    let calls = 0;
    const { db, registry } = fixture(t, { Engine, clock: () => {
      calls++;
      if (fail && calls === 3) throw new Error('fixture nested failure');
      return STAMP;
    } });
    db.exec('BEGIN');
    registry.reserve([entry(a)]);
    fail = true;
    assert.throws(() => registry.reserve([entry(b), entry(c)]), /fixture nested failure/);
    assert.equal(registry.lookup(b), null);
    assert.equal(registry.lookup(c), null);
    registry.bind(a, 21);
    assert.throws(() => registry.bind(a, 22), /已绑定其他账号/);
    db.exec('COMMIT');
    assert.deepEqual(registry.lookup(a), { ...result(a, 1), accountId: 21 });
    assert.deepEqual(registry.reserve([entry(b)]), [result(b, 2)]);
  });
}

test('registry savepoints can nest inside a caller-owned savepoint', t => {
  const { db, registry } = fixture(t);
  db.exec('SAVEPOINT caller');
  registry.reserve([entry(a)]);
  registry.bind(a, 25);
  db.exec('ROLLBACK TO SAVEPOINT caller');
  db.exec('RELEASE SAVEPOINT caller');
  assert.equal(registry.lookup(a), null);
});
