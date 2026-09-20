/** Local operator import: named files only, existing records are never overwritten.
 * node scripts/import-verified-dola-cookies.mjs --commit <absolute cookie files...>
 * Without --commit, performs proxy/session checks only. Never logs credentials.
 */
import fs from 'node:fs';
import { mkdtemp, chmod } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { checkSession, fetchProfile, missingRequired } from '../server/dola/provider.js';
import { accountHealth } from '../server/dola/account-observations.js';
import { createLoginProxyResolver, requireLoginProxy } from '../server/dola/google-login-proxy.js';
import { dolaCookieMap } from '../server/dola/google-login-core.js';
import { fetchVia } from '../server/dola/proxy.js';

export function commitVerifiedCookies(db, entries) {
  const at = new Date().toISOString();
  return db.transaction(() => {
    const ids = [];
    for (const item of entries) {
      const { email, cookies, profile, proxy, exitIp, checkedAt, session } = item;
      const identity = String(profile?.entityId || profile?.id || '');
      if (!email || !identity || !isIP(exitIp || '') || !Number.isFinite(checkedAt)
          || Date.now() - checkedAt > 300000 || checkedAt > Date.now()
          || missingRequired(cookies || {}).length || accountHealth(session || {}, profile || {}).kind !== 'valid'
          || ![session?.pullStatus, session?.launchStatus, profile?.status].every(status => status === 200)) throw new Error('unverified_entry');
      requireLoginProxy(proxy);
      const names = Object.keys(cookies).sort();
      const hash = createHash('sha256').update(names.map(name => `${name}=${cookies[name]}`).join(';')).digest('hex').slice(0, 32);
      if (db.prepare('SELECT id FROM dola_accounts WHERE lower(label)=? OR sec_user_id=? OR cookie_hash=?')
        .get(email.toLowerCase(), identity, hash)) throw new Error('existing_account_conflict');
      const result = db.prepare(`INSERT INTO dola_accounts
        (label,account_hint,cookie,cookie_hash,cookie_names,status,proxy,exit_ip,sec_user_id,membership,last_check_at,note,created_at,updated_at)
        VALUES (?,?,?,?,?,'valid',?,?,?,?,?,?,?,?)`).run(email, profile.nickname || profile.userName || '', JSON.stringify(cookies),
        hash, names.join(','), proxy, exitIp, identity, profile.membershipLevel || '', new Date(checkedAt).toISOString(),
        '经用户确认从桌面 Cookie 文件导入；通过绑定 IPWeb 核验；未重新提交密码', at, at);
      const id = Number(result.lastInsertRowid);
      db.prepare(`INSERT INTO audit_logs (user_id,username,action,target_type,target_id,detail,ip,created_at)
        VALUES (NULL,'local-cookie-import','dola.cookie_file_import','dola_account',?,?, '127.0.0.1',?)`)
        .run(String(id), '用户明确确认导入；Cookie 与同次核验使用的 IPWeb 原子绑定；不记录凭据', at);
      ids.push({ id, email });
    }
    return ids;
  }).immediate();
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const files = args.filter(arg => arg !== '--commit');
  if (!files.length || files.length > 20 || files.some(file => !path.isAbsolute(file))) throw new Error('explicit_files_required');
  const dbPath = fileURLToPath(new URL('../server/data/admin.db', import.meta.url));
  const db = new Database(dbPath, { fileMustExist: true, readonly: !commit });
  const resolver = createLoginProxyResolver(db);
  const verified = [];
  try {
    for (const file of files) {
      const name = path.basename(file);
      try {
        const info = fs.lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) throw new Error('invalid_file');
        const email = /^Dola_([^\s@|]+@[^\s@|]+\.[^\s@|]+)_Cookies\.json$/.exec(name)?.[1].toLowerCase();
        if (!email || db.prepare('SELECT id FROM dola_accounts WHERE lower(label)=?').get(email)) throw new Error('existing_or_invalid_label');
        const json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        const source = Array.isArray(json) ? json : json.cookies;
        if (!Array.isArray(source)) throw new Error('invalid_cookie_file');
        const cookies = dolaCookieMap(source);
        if (missingRequired(cookies).length) throw new Error('missing_cookie');
        const proxy = resolver.resolveProxy(email, null);
        const ipResponse = await fetchVia('https://ipinfo.io/json', { redirect: 'error', signal: AbortSignal.timeout(15000) }, proxy);
        const ipInfo = ipResponse.ok ? await ipResponse.json() : null;
        if (!isIP(ipInfo?.ip || '')) throw new Error('proxy_unverified');
        const session = await checkSession(cookies, { proxy, timeout: 15000 });
        const profile = await fetchProfile(cookies, { proxy, timeout: 15000 });
        const healthy = accountHealth(session, profile).kind === 'valid'
          && [session.pullStatus, session.launchStatus, profile.status].every(status => status === 200);
        if (!healthy || !(profile.entityId || profile.id)) throw new Error('session_unverified');
        verified.push({ email, cookies, proxy, exitIp: ipInfo.ip, profile, session, checkedAt: Date.now() });
        console.log(JSON.stringify({ file: name, verified: true, proxyBound: true, written: false }));
      } catch { console.log(JSON.stringify({ file: name, verified: false, written: false, message: '未通过核验或存在记录冲突，已跳过' })); }
    }
    if (!commit || !verified.length) {
      console.log(JSON.stringify({ verified: verified.length, inserted: 0, dryRun: !commit })); return;
    }
    // A recoverable private snapshot precedes the single atomic insert transaction.
    const backupDir = await mkdtemp(path.join(tmpdir(), 'dola-before-cookie-import-'));
    await chmod(backupDir, 0o700);
    const backup = path.join(backupDir, 'admin.db');
    await db.backup(backup);
    await chmod(backup, 0o600);
    const ids = commitVerifiedCookies(db, verified);
    console.log(JSON.stringify({ inserted: ids.length, accounts: ids, backup, skipped: files.length - ids.length }));
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('导入未完成；错误详情及凭据已省略，没有覆盖已有账号'); process.exitCode = 1; });
}
