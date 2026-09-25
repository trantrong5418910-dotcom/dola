/**
 * 把一个浏览器导出的 Dola cookie「正式上号」——**全程走 HTTP 路由**，不留手工改库，
 * 这样审计日志（audit_logs）能完整留痕，和手工 SQL 改库是两个性质。
 *
 * 步骤：
 *   ⓪ 身份查重（全值 sha256）—— 拒绝把「池里已有的身份」再灌一行
 *   ① POST /api/dola/accounts/import      （显式 label，绝不用自动编号）
 *   ② POST /api/dola/accounts/:id/proxy   （从现役账号派生同密码的新 session 出口）
 *   ③ POST /api/dola/accounts/:id/proxy/verify-persist （实测出口 IP 并写回）
 *   ④ POST /api/dola/accounts/:id/action {action:'check'}（这才是把 status 置 valid 的地方）
 *   ⑤ 复查账号池能否被选中
 *
 * ⚠️ 为什么 import 必须传显式 label：
 *    routes/dola.js 的自动编号是 `inserted+skipped+invalid+1`，**每次导入从 1 重新数**。
 *    用 labelPrefix='新号' 导入第 1 个账号会生成「新号001」，而它已经存在（id=408），
 *    于是走「同 label → 原地刷新」分支，**静默覆盖 408 的 cookie**。
 *
 * ⚠️ 为什么身份查重要哈希全值：
 *    flow_cur_user_sec_id 是 base64 结构化数据，前 16 字符 `Kz9bAGEdJCBsLCAy` 在所有账号间
 *    完全相同（编码头）。截前缀比较会得出「全是同一个号」的假结论 —— 已经踩过一次。
 *
 * 用法：
 *   node server/scripts/onboard-ck.mjs <cookie.json> [label]            # 演练
 *   node server/scripts/onboard-ck.mjs <cookie.json> 新号006 --write    # 真做
 *   node server/scripts/onboard-ck.mjs '' 新号006 --write --id=420      # 只补/换代理+校验（跳过导入）
 * 环境变量：SRC_ID（从哪个账号派生代理，默认 412）、SESSION（session 字母，默认 g）
 *
 * ⚠️ session 标识不是随便取的：#412 的同一个代理账号下，session-b…f 都正常，
 *    但 a / g / 1 会卡到 10 秒超时（或 HTTP Tunneling 502）。
 *    换 session 前先用 server/scripts/probe-sessions.mjs 探测一遍。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const ADMIN = '/www/wwwroot/dola.fei85.cn/admin';
const BASE = 'http://127.0.0.1:8788';
const CK_PATH = process.argv[2];
const LABEL = process.argv[3] || '新号006';
const WRITE = process.argv.includes('--write');
const SRC_ID = Number(process.env.SRC_ID || 412);
const SESSION = process.env.SESSION || 'g';
const FORCE = process.argv.includes('--force');
// --id=N：跳过「解析/查重/导入」，直接对已有账号做「换代理 + 核验 + 校验」
const ONLY_ID = Number((process.argv.find((a) => a.startsWith('--id=')) || '').split('=')[1] || 0);

if (!CK_PATH && !ONLY_ID) { console.log('用法: node onboard-ck.mjs <cookie.json> [label] [--write]  |  ... --write --id=420'); process.exit(1); }

const { signJwt } = await import(`${ADMIN}/server/auth.js`);
const { parseCookies } = await import(`${ADMIN}/server/dola/provider.js`);
const H = { authorization: `Bearer ${signJwt({ uid: 1 }, 1)}`, 'content-type': 'application/json' };
const show = (j) => JSON.stringify(j, null, 2);
const sha = (v) => createHash('sha256').update(String(v ?? '')).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new DatabaseSync(join(ADMIN, 'server', 'data', 'admin.db'), { readOnly: true });

let NEW_ID = ONLY_ID;
let r, j;   // ②③④⑤ 段复用，故声明在外层（否则 --id 模式下未声明就赋值会 ReferenceError）

// ───────────────────────── ⓪ 身份查重 ─────────────────────────
if (!ONLY_ID) {
const text = readFileSync(CK_PATH, 'utf8');
const cookies = parseCookies(text);
const names = Object.keys(cookies);
console.log(`=== ⓪ 解析结果：${names.length} 个 cookie ===`);
if (!names.length) { console.log('解析不出 cookie，中止'); process.exit(1); }

for (const need of ['ttwid', 'odin_tt', 'flow_cur_user_sec_id']) {
  console.log(`  ${need}: ${cookies[need] ? '有' : '❌ 没有'}`);
}

const newFlow = cookies.flow_cur_user_sec_id;
const newFlowHash = newFlow ? sha(newFlow) : null;
const rows = db.prepare('SELECT id, label, cookie FROM dola_accounts').all();
const dupes = [];
for (const r of rows) {
  const c = parseCookies(r.cookie);
  if (newFlowHash && c.flow_cur_user_sec_id && sha(c.flow_cur_user_sec_id) === newFlowHash) dupes.push(r);
}
console.log(`\n=== ⓪ 身份查重（flow_cur_user_sec_id 全值哈希）===`);
console.log(`  待导入  flow_cur_user_sec_id sha256: ${newFlowHash ? newFlowHash.slice(0, 16) : '(缺失)'}`);
console.log(`  国家: ${cookies.flow_user_country || '(无)'}`);
console.log(dupes.length
  ? `  ❌ 与池内账号重复：${dupes.map((d) => `#${d.id} ${d.label}`).join(', ')}`
  : '  ✅ 池内没有同身份账号');

const labelRows = db.prepare('SELECT id, label FROM dola_accounts WHERE label = ?').all(LABEL);
console.log(`  label「${LABEL}」占用情况：${labelRows.length ? '❌ 已被 #' + labelRows.map((r) => r.id).join('/') + ' 占用' : '✅ 未占用'}`);

if (dupes.length && !FORCE) { console.log('\n身份重复，拒绝导入（确要刷新已有账号请直接重导它的 label；强行导入加 --force）'); process.exit(1); }
if (labelRows.length) { console.log('\nlabel 重复会触发「原地刷新」覆盖那个账号；换个 label 或加 --force'); process.exit(1); }

if (!WRITE) { console.log('\n(演练模式，未做任何写操作。加 --write 才执行)'); process.exit(0); }

// ───────────────────────── ① 导入 ─────────────────────────
console.log('\n=== ① POST /api/dola/accounts/import ===');
r = await fetch(`${BASE}/api/dola/accounts/import`, {
  method: 'POST', headers: H,
  body: JSON.stringify({
    items: [{ raw: text, label: LABEL }],
    note: `2026-09-25 新导出（浏览器 profile: Dola-2）；已做同身份查重`,
    source: 'ck-tool-20260925',
  }),
});
let j = await r.json();
console.log(`HTTP ${r.status}  ${show(j)}`);
if (r.status !== 201 || !j.inserted) { console.log('导入未成功，中止'); process.exit(1); }
NEW_ID = Number(j.ids[0]);
console.log(`→ 新账号 id = ${NEW_ID}`);
} else {
  console.log(`=== 跳过导入，直接对已有账号 #${NEW_ID} 做「换代理 + 核验 + 校验」===`);
  if (!WRITE) { console.log('(演练模式：--id 模式下演练不做任何事。加 --write 才执行)'); process.exit(0); }
}

// ───────────────────────── ② 派生并设置代理 ─────────────────────────
console.log(`\n=== ② 从 #${SRC_ID} 派生代理（session → ${SESSION}）并设置 ===`);
const src = db.prepare('SELECT id, label, proxy FROM dola_accounts WHERE id=?').get(SRC_ID);
if (!src?.proxy) { console.log(`源账号 #${SRC_ID} 没有代理，中止（账号已导入，需要手工配代理）`); process.exit(1); }
const derived = String(src.proxy).replace(/(-session-)([a-z0-9]+)/i, `$1${SESSION}`);
console.log(`  派生后（脱敏）: ${derived.replace(/\/\/([^:]+):[^@]+@/, '//$1:***@')}`);
r = await fetch(`${BASE}/api/dola/accounts/${NEW_ID}/proxy`, {
  method: 'POST', headers: H, body: JSON.stringify({ proxy: derived }),
});
console.log(`HTTP ${r.status}  ${show(await r.json())}`);

// ───────────────────────── ③ 核验出口 IP ─────────────────────────
console.log('\n=== ③ 核验出口 IP（写回 exit_ip）===');
r = await fetch(`${BASE}/api/dola/accounts/${NEW_ID}/proxy/verify-persist`, { method: 'POST', headers: H });
console.log(`HTTP ${r.status}  ${show(await r.json())}`);

// ───────────────────────── ④ 触发 dola_check ─────────────────────────
console.log('\n=== ④ 触发账号校验（dola_check，这一步才会把 status 置 valid）===');
r = await fetch(`${BASE}/api/dola/accounts/${NEW_ID}/action`, {
  method: 'POST', headers: H, body: JSON.stringify({ action: 'check' }),
});
console.log(`HTTP ${r.status}  ${show(await r.json())}`);

const dbPoll = new DatabaseSync(join(ADMIN, 'server', 'data', 'admin.db'), { readOnly: true });
let final = null;
for (let i = 0; i < 30; i++) {
  await sleep(3000);
  final = dbPoll.prepare('SELECT id,label,status,sec_user_id,membership,last_error,last_check_at FROM dola_accounts WHERE id=?').get(NEW_ID);
  if (final && final.status !== 'unknown') break;
}
console.log(`  校验后状态: ${show(final)}`);

// ───────────────────────── ⑤ 复查能否被选中 ─────────────────────────
console.log('\n=== ⑤ 账号池可选中性（seconds=10）===');
r = await fetch(`${BASE}/api/dola/route?seconds=10`, { headers: H });
j = await r.json().catch(() => ({}));
console.log(`HTTP ${r.status}`);
for (const a of (j.accounts || j.candidates || [])) {
  console.log(`  #${a.id} ${a.label} selectable=${a.selectable ?? '?'} reason=${a.reason ?? ''} exitIp=${a.exitIp ?? a.exit_ip ?? ''}`);
}
console.log(show(j).slice(0, 1200));
