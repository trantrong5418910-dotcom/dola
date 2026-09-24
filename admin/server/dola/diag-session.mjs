/**
 * 会话在浏览器里为什么"登录不上"——聚焦探针。
 *
 *   node server/dola/diag-session.mjs --cookie-file ./Dola_xxx_Cookies.json
 *
 * 现场证据（diag-submit 拍到）：同一份 cookie 走 HTTP 接口 self_brief 返回 code=0，
 * 但浏览器打开 /chat/ 却弹出登录框、URL 变成 ?from_logout=1。
 * 这个脚本回答三个问题：
 *   ① 页面 document.cookie 里到底有没有 sessionid / sid_guard？
 *   ② 页面自己调的 /alice/user/launch 返回了什么（登没登录的权威判据）？
 *   ③ 有没有 console 报错 / localStorage 里缺了东西？
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCookies, getPlaywright, DOLA_HEADERS, guardLogoutRequests } from './provider.js';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const COOKIE_FILE = flag('cookie-file') || process.env.DOLA_COOKIE_FILE;
if (!COOKIE_FILE) { console.error('用法：node server/dola/diag-session.mjs --cookie-file ./Dola_xxx_Cookies.json'); process.exit(2); }
const OUT = flag('out', '/tmp/dola-sess');
fs.mkdirSync(OUT, { recursive: true });

const pw = await getPlaywright();
const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  viewport: { width: 1560, height: 950 }, locale: 'zh-CN', userAgent: DOLA_HEADERS['user-agent'],
});

const bodies = [];
ctx.on('response', async (r) => {
  const u = r.url();
  if (!/\/alice\/(user\/(launch|config\/pull)|im\/launch|basic\/launch)/.test(u)) return;
  try {
    const ct = r.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    const j = await r.json();
    bodies.push({ url: new URL(u).pathname, status: r.status(), code: j?.code, body: j });
  } catch { /* 忽略 */ }
});

const ck = parseCookies(fs.readFileSync(COOKIE_FILE, 'utf8'));
console.log(`cookie 文件：${path.basename(COOKIE_FILE)}（解析出 ${Object.keys(ck).length} 个字段）`);
console.log('关键字段:', ['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt', 'uid_tt', 'passport_auth_status', 'ttwid', 'odin_tt', 's_v_web_id']
  .map((k) => `${k}=${ck[k] ? '有' : '❌无'}`).join('  '));

const cookieList = Object.entries(ck).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' }));
await ctx.addCookies(cookieList);
await guardLogoutRequests(ctx);

const page = await ctx.newPage();
const consoleMsgs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 200)}`); });
page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message.slice(0, 200)}`));

await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(12000);

// ① 页面看到的 cookie
const pageCookies = await page.evaluate(() => document.cookie);
const hasSession = /(^|;\s*)sessionid=/.test(pageCookies);
console.log('\n── ① 页面 document.cookie ──');
console.log('   sessionid 在页面可见:', hasSession ? '✅ 是' : '❌ 否（HttpOnly 或没写进去）');
console.log('   长度:', pageCookies.length, '| 前 200 字:', pageCookies.slice(0, 200));

// ② localStorage / sessionStorage
const storage = await page.evaluate(() => ({
  ls: Object.keys(localStorage).slice(0, 40),
  ss: Object.keys(sessionStorage).slice(0, 20),
}));
console.log('\n── ② 存储 ──');
console.log('   localStorage:', JSON.stringify(storage.ls));
console.log('   sessionStorage:', JSON.stringify(storage.ss));

// ③ launch 响应（登录与否的权威判据）
console.log('\n── ③ launch / config 响应 ──');
for (const b of bodies) {
  const s = JSON.stringify(b.body);
  console.log(`   ${b.url} → HTTP ${b.status} code=${b.code} len=${s.length}`);
  // 挑出像"用户身份/登录态"的字段
  for (const kw of ['is_login', 'isLogin', 'login_status', 'user_id', 'uid', 'sec_user_id', 'nickname', 'has_login']) {
    const m = s.match(new RegExp(`"${kw}"\\s*:\\s*("[^"]{0,40}"|\\d+|true|false|null)`));
    if (m) console.log(`      ${kw} = ${m[1]}`);
  }
}

// ④ 页面状态
const url = page.url();
const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
const loggedOut = /登录以解锁|使用豆包或飞书账号登录/.test(text);
console.log('\n── ④ 页面状态 ──');
console.log('   url:', url);
console.log('   显示登录框:', loggedOut ? '❌ 是（=浏览器认为未登录）' : '✅ 否');
console.log('   文本片段:', text.slice(0, 260));

console.log('\n── ⑤ console 报错 ──');
for (const m of consoleMsgs.slice(0, 20)) console.log('  ', m);
if (!consoleMsgs.length) console.log('   （无）');

fs.writeFileSync(path.join(OUT, 'session-report.json'), JSON.stringify({
  cookieFile: path.basename(COOKIE_FILE), cookieFields: Object.keys(ck),
  pageCookieLen: pageCookies.length, hasSessionCookieInPage: hasSession,
  storage, launchBodies: bodies, url, loggedOut, pageText: text.slice(0, 2000), consoleMsgs,
}, null, 2));
await page.screenshot({ path: path.join(OUT, 'session.png') });
console.log(`\n报告已存 ${OUT}/session-report.json`);
await browser.close();
