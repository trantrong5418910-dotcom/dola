import { normalizeAccountLoginEmail } from './account-login-format.js';

// Identity metadata only. Removing an account must not remove its login profile.
// AUTOINCREMENT prevents reuse of IDs from deleted, committed profiles. Rolled
// back reservations never become durable and SQLite may reuse those IDs.
export const LOGIN_REGISTRY_SCHEMA = `CREATE TABLE IF NOT EXISTS dola_login_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  account_id INTEGER
);`;

function atomic(db, work) {
  db.exec('SAVEPOINT dola_login_registry');
  try {
    const result = work();
    db.exec('RELEASE SAVEPOINT dola_login_registry');
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT dola_login_registry');
    db.exec('RELEASE SAVEPOINT dola_login_registry');
    throw error;
  }
}

function profile(row) {
  return { email: row.email, profileId: row.id, accountCode: `A${String(row.id).padStart(2, '0')}` };
}

/** The caller installs LOGIN_REGISTRY_SCHEMA on its own database connection.
 * reserve returns only identity/code; lookup and bind also return accountId.
 * No database is opened here, and no credential field is read or persisted.
 */
export function createLoginProfileRegistry(db, { clock = () => new Date().toISOString() } = {}) {
  const select = db.prepare('SELECT id,email,account_id FROM dola_login_profiles WHERE email=?');
  const insert = db.prepare('INSERT INTO dola_login_profiles (email,created_at) VALUES (?,?)');
  const update = db.prepare('UPDATE dola_login_profiles SET account_id=? WHERE email=? AND account_id IS NULL');

  function lookup(email) {
    const row = select.get(normalizeAccountLoginEmail(email));
    return row ? { ...profile(row), accountId: row.account_id } : null;
  }

  return {
    reserve(entries) {
      if (!Array.isArray(entries)) throw new TypeError('账号列表格式不正确');
      const emails = entries.map(entry => normalizeAccountLoginEmail(entry?.email));
      return atomic(db, () => emails.map(email => {
        let row = select.get(email);
        if (!row) {
          insert.run(email, clock());
          row = select.get(email);
        }
        return profile(row);
      }));
    },
    lookup,
    bind(email, accountId) {
      const normalized = normalizeAccountLoginEmail(email);
      if (!Number.isSafeInteger(accountId) || accountId < 1) throw new TypeError('账号编号必须为正整数');
      return atomic(db, () => {
        const row = select.get(normalized);
        if (!row) throw new Error('登录档案不存在，请先预留编号');
        if (row.account_id !== null && row.account_id !== accountId) throw new Error('登录档案已绑定其他账号');
        if (row.account_id === null) update.run(accountId, normalized);
        return lookup(normalized);
      });
    },
  };
}
