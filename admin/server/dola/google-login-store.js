import { createHash } from 'node:crypto';
import { matchesGoogleIdentity, normalizeEmail } from './google-login-core.js';
import { missingRequired } from './provider.js';
import { storedLoginProxy } from './google-login-proxy.js';
import { isIP } from 'node:net';

const busy = (db, id) => db.prepare("SELECT id FROM dola_videos WHERE account_id=? AND status IN ('queued','submitting','generating','resolving') LIMIT 1").get(id);

export function createGoogleAccountStore(db, { registry = null } = {}) {
  const find = email => db.prepare('SELECT * FROM dola_accounts WHERE lower(label)=?').all(normalizeEmail(email));
  const store = {
    lookupAccount(email) {
      const found = find(email);
      if (found.length > 1) return { blocked: true };
      const row = found[0];
      if (!row) return null;
      return { ...row, blocked: row.status === 'disabled' || Boolean(busy(db, row.id)) };
    },
    storeAccount({ email, identity, cookies, profile, snapshot, ownerId, loginProxy, exitIp, manual = false, sessionVerified = false, loginMethod = 'password' }) {
      const identityValid = loginMethod === 'manual'
        ? manual === true && identity == null && sessionVerified === true
        : manual !== true && matchesGoogleIdentity(identity, email);
      if (!identityValid || !profile?.ok || !(profile.entityId || profile.id)
          || missingRequired(cookies || {}).length) throw new Error('login_not_verified');
      const rows = find(email);
      if (rows.length > 1) throw new Error('ambiguous_account');
      const row = rows[0];
      if (Boolean(row) !== Boolean(snapshot) || (row && (row.id !== snapshot.id || row.cookie_hash !== snapshot.cookie_hash
          || row.proxy !== snapshot.proxy || row.updated_at !== snapshot.updated_at || row.status === 'disabled' || busy(db, row.id)))) {
        throw new Error('account_changed_during_login');
      }
      // 直连登录时 loginProxy 是 DIRECT_LOGIN_PROXY 哨兵，落库统一成空串
      // （出口 IP 由 exit_ip 记录）。其余情况仍然 fail-closed。
      const proxy = storedLoginProxy(loginProxy);
      if (row?.proxy && row.proxy !== proxy) throw new Error('login_proxy_changed');
      const verifiedIp = isIP(exitIp || '') ? exitIp : row?.exit_ip || null;
      const id = String(profile.entityId || profile.id);
      if (row?.sec_user_id && row.sec_user_id !== id) throw new Error('account_identity_changed');
      const other = db.prepare('SELECT id FROM dola_accounts WHERE sec_user_id=? AND id<>?').get(id, row?.id || -1);
      if (other) throw new Error('identity_already_in_pool');
      const names = Object.keys(cookies).sort();
      const hash = createHash('sha256').update(names.map(n => `${n}=${cookies[n]}`).join(';')).digest('hex').slice(0, 32);
      const cookie = JSON.stringify(cookies);
      const at = new Date().toISOString();
      let accountId = row?.id;
      if (row) {
        db.prepare(`UPDATE dola_accounts SET cookie=?,cookie_hash=?,cookie_names=?,proxy=?,exit_ip=?,status='valid',
          native_15s_state='unknown',native_15s_at=NULL,native_15s_note='',
          native_30s_state='unknown',native_30s_at=NULL,native_30s_note='',
          reference_image_state='unknown',reference_image_at=NULL,reference_image_note='',
          account_hint=?,sec_user_id=?,membership=?,last_check_at=?,last_error='',updated_at=? WHERE id=?`)
          .run(cookie, hash, names.join(','), proxy, verifiedIp, profile.nickname || profile.userName || '', id,
            profile.membershipLevel || '', at, at, row.id);
      } else {
        accountId = Number(db.prepare(`INSERT INTO dola_accounts
          (label,cookie,cookie_hash,cookie_names,proxy,exit_ip,status,account_hint,sec_user_id,membership,last_check_at,imported_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,'valid',?,?,?,?,?,?,?)`).run(normalizeEmail(email), cookie, hash, names.join(','), proxy, verifiedIp,
          profile.nickname || profile.userName || '', id, profile.membershipLevel || '', at, ownerId, at, at).lastInsertRowid);
      }
      registry?.bind(normalizeEmail(email), accountId);
      db.prepare(`INSERT INTO audit_logs (user_id,username,action,target_type,target_id,detail,created_at)
        VALUES (?,?,'dola.google_login_import','dola_account',?,?,?)`)
        .run(ownerId, 'google-login', String(accountId), manual
          ? '手动登录 Dola 会话核验通过；邮箱为用户标注，未保存密码' : 'Google 身份和 Dola 会话核验通过，未保存密码', at);
      return { id: accountId };
    },
  };
  const persist = store.storeAccount;
  store.storeAccount = input => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = persist(input);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  return store;
}
