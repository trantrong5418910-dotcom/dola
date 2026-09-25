/**
 * 只读探测：udealproxy 轮换代理支持哪些 session 标识。
 *
 * 背景：#409–#419 用 session-b…f 都正常（各有独立出口 IP），
 * 但给 #420 派生的 session-g 在 HTTP Tunneling 阶段被上游回 502。
 * 需要先搞清「session 标识是不是只能在某个固定集合里选」，再决定新号怎么配代理。
 *
 * 只读：只发一个 ipify 请求，不写库、不打印口令。
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const ADMIN = '/www/wwwroot/dola.fei85.cn/admin';
const SRC_ID = Number(process.env.SRC_ID || 412);

const db = new DatabaseSync(join(ADMIN, 'server', 'data', 'admin.db'), { readOnly: true });
const src = db.prepare('SELECT id, proxy FROM dola_accounts WHERE id=?').get(SRC_ID);
if (!src?.proxy) { console.log(JSON.stringify({ error: '源账号无代理', id: SRC_ID })); process.exit(1); }

const { fetchVia } = await import(`${ADMIN}/server/dola/proxy.js`);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const candidates = (process.env.SESSIONS || 'a,g,h,i,j,k,0,1,2,aa,gg,ga').split(',').map((s) => s.trim()).filter(Boolean);

const existing = new Map(db.prepare('SELECT id,label,proxy FROM dola_accounts').all()
  .map((r) => [/-session-([a-z0-9]+)/i.exec(String(r.proxy || ''))?.[1], `${r.id} ${r.label}`]));

const results = [];
for (const s of candidates) {
  const url = String(src.proxy).replace(/(-session-)([a-z0-9]+)/i, `$1${s}`);
  const t0 = Date.now();
  let out;
  try {
    const res = await fetchVia('https://api.ipify.org?format=json', { headers: { 'user-agent': UA } }, url);
    const j = await res.json().catch(() => ({}));
    out = { session: s, http: res.status, exitIp: j?.ip ?? null, ms: Date.now() - t0 };
  } catch (e) {
    out = { session: s, http: 0, exitIp: null, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 120) };
  }
  out.usedBy = existing.get(s) || null;
  out.usable = out.http === 200 && Boolean(out.exitIp);
  results.push(out);
  console.log(JSON.stringify(out));
}

const ok = results.filter((r) => r.usable && !r.usedBy);
console.log('\n=== 可用且未被占用 ===');
console.log(ok.length ? ok.map((r) => `${r.session}(${r.exitIp})`).join(', ') : '(无)');
