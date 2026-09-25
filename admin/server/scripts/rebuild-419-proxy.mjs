/**
 * 给 419 重建代理（默认**只演练不写入**，加 --write 才真写）。
 *
 * 依据：409-412 用的是同一家出口代理（as.udealproxy.com:6666），
 * 用户名里只有 session 段不同（b/c/d/e），419 之前用的是 session-f。
 * 所以从一条现役代理派生同密码的 session-f，再**实测连通性和出口 IP**。
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRITE = process.argv.includes('--write');
const SRC_ID = Number(process.env.SRC_ID || 412);
const TARGET_ID = Number(process.env.TARGET_ID || 419);
const SESSION = process.env.SESSION || 'f';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const db = new DatabaseSync(join(ROOT, 'server', 'data', 'admin.db'));

const src = db.prepare('SELECT id, label, proxy FROM dola_accounts WHERE id=?').get(SRC_ID);
const tgt = db.prepare('SELECT id, label, proxy, exit_ip FROM dola_accounts WHERE id=?').get(TARGET_ID);
if (!src?.proxy) { console.log(JSON.stringify({ error: '源账号没有代理', src: SRC_ID })); process.exit(1); }

const swapSession = (url, sess) => url.replace(/(-session-)([a-z0-9]+)/i, `$1${sess}`);
const candidate = swapSession(src.proxy, SESSION);
const masked = String(candidate).replace(/\/\/([^:]+):[^@]+@/, '//$1:***@');

// ---- 只读实测：能不能通、出口 IP 是多少 ----
const { fetchVia } = await import('../dola/proxy.js');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
let probe = { ok: false };
try {
  const started = Date.now();
  const res = await fetchVia('https://api.ipify.org?format=json', { headers: { 'user-agent': UA } }, candidate);
  const json = await res.json().catch(() => ({}));
  probe = { ok: res.status === 200, http: res.status, exitIp: json?.ip ?? null, ms: Date.now() - started };
} catch (e) {
  probe = { ok: false, error: String(e?.message || e).slice(0, 160) };
}

let dola = { ok: false };
try {
  const res = await fetchVia('https://www.dola.com/chat/', { headers: { 'user-agent': UA } }, candidate);
  dola = { ok: res.status === 200, http: res.status };
} catch (e) {
  dola = { ok: false, error: String(e?.message || e).slice(0, 160) };
}

const out = {
  mode: WRITE ? 'WRITE' : 'DRY-RUN',
  source: { id: src.id, label: src.label },
  target: { id: tgt.id, label: tgt.label, currentProxyEmpty: !tgt.proxy || String(tgt.proxy).trim() === '' },
  candidateMasked: masked,
  probe,
  dola,
  readyToWrite: probe.ok && dola.ok,
};

if (WRITE && out.readyToWrite) {
  db.prepare('UPDATE dola_accounts SET proxy=?, exit_ip=?, updated_at=? WHERE id=?')
    .run(candidate, probe.exitIp || null, new Date().toISOString(), TARGET_ID);
  const after = db.prepare('SELECT id, proxy, exit_ip FROM dola_accounts WHERE id=?').get(TARGET_ID);
  out.written = { id: after.id, exitIp: after.exit_ip, proxyLen: String(after.proxy || '').length };
} else if (WRITE) {
  out.skippedWrite = '实测未通过，拒绝写入';
}

console.log(JSON.stringify(out, null, 2));
process.exit(0);
