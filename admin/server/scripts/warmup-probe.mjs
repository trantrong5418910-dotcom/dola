/**
 * 只读诊断：验证「缺的 flow_cur_user_sec_id 是**服务端在首次导航时下发**的」这个假设。
 *
 * 背景（2026-09-25）：账号 #408–412（新号001–005）的 cookie 只有 25 个
 * ByteDance passport 字段、没有 flow_cur_user_sec_id，因此被判「未确认已登录的创作页面」；
 * 而 #419 有 51 个字段、含 flow_cur_user_sec_id，能进创作页 —— 但它是免费号、当日额度已用尽。
 *
 * 假设：flow_cur_user_sec_id 不是「导入 cookie 时必须自带」的东西，
 *       而是 Dola 前端在**带有效 passport 会话首次访问时**由服务端 Set-Cookie 下发的。
 *       若成立：#408–412 只要用**自己的代理 + 自己的 cookie**导航一次就能补齐会话，
 *       根本不需要导入别人的 cookie（尤其不能导入 #419 的 —— 那是同一个身份，会撞车）。
 *
 * 判据：导航前 jar 里没有 flow_cur_user_sec_id，导航后出现 ⇒ 假设成立。
 *
 * 严格只读：不填提示词、不点发送、不写数据库、不打印任何 cookie 值/代理凭据。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACCOUNT_ID = Number(process.argv[2] || 411);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DOLA_BASE = process.env.DOLA_BASE || 'https://www.dola.com';

// 必须复用生产同一份实现，否则诊断脚本自己的写法会制造假结论（这一课已经吃过）
const { parseCookies, toPlaywrightCookies } = await import('../dola/provider.js');
const { proxyOf, proxyUrlOf, maskProxy } = await import('../dola/proxy.js');

const db = new DatabaseSync(join(ROOT, 'server', 'data', 'admin.db'));
const acc = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(ACCOUNT_ID);
if (!acc) { console.log(JSON.stringify({ error: 'account not found', id: ACCOUNT_ID })); process.exit(1); }

const cookies = parseCookies(acc.cookie);
const names = Object.keys(cookies);
const proxy = proxyOf(acc);
const proxyUrl = proxyUrlOf(acc);

const pw = await import('playwright');
if (!pw?.chromium) { console.log(JSON.stringify({ error: 'playwright missing' })); process.exit(1); }

const launchOptions = {
  headless: true,
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  executablePath: pw.chromium.executablePath(),
};
if (proxyUrl) {
  if (/^socks5h?:/i.test(proxyUrl)) {
    const { startSocksBridge } = await import('../dola/socks-bridge.js');
    const bridge = await startSocksBridge(proxyUrl);
    launchOptions.proxy = { server: bridge.url };
  } else if (proxy?.server) {
    launchOptions.proxy = proxy;
  }
}

// ⚠️ 独立的 profile 目录：不能和生产的 profile 抢锁
const profileDir = join(ROOT, 'server', 'data', 'browser-profiles', `${ACCOUNT_ID}-warmdiag`);
await mkdir(profileDir, { recursive: true });

const ctx = await pw.chromium.launchPersistentContext(profileDir, {
  ...launchOptions,
  serviceWorkers: 'block',
  viewport: { width: 1280, height: 900 },
  locale: 'zh-CN',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  timeout: 30000,
});

await ctx.addCookies(toPlaywrightCookies(cookies));
const preJar = (await ctx.cookies()).map((c) => c.name);

const page = await ctx.newPage();
// 只读：把会花钱/会改状态的写请求掐掉
await ctx.route('**/chat/completion**', (r) => r.abort());
await ctx.route('**/chat/**', (r) => (r.request().method() === 'POST' ? r.abort() : r.continue()));

let navStatus = null;
let navError = null;
try {
  const resp = await page.goto(`${DOLA_BASE}/chat/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  navStatus = resp?.status?.() ?? null;
} catch (e) { navError = String(e.message).slice(0, 200); }

// 让前端把会话 bootstrap 跑完（这段是服务端下发 cookie 的窗口）
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 25000 }).catch(() => {});
await page.waitForTimeout(3000);

const postJar = (await ctx.cookies()).map((c) => c.name);
const added = postJar.filter((n) => !preJar.includes(n));
const removed = preJar.filter((n) => !postJar.includes(n));

const snapshot = await page.evaluate(() => {
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const has = (kw) => text.includes(kw);
  return {
    url: location.href,
    title: document.title,
    inputs: document.querySelectorAll('textarea, [contenteditable="true"]').length,
    loginMarkers: ['登录', 'Login', '手机号', '验证码', 'Sign in'].filter(has),
    textHead: text.slice(0, 260),
  };
}).catch((e) => ({ error: String(e.message).slice(0, 200) }));

console.log(JSON.stringify({
  stage: 'warmup',
  account: ACCOUNT_ID,
  label: acc.label,
  status: acc.status,
  cookieCountIn: names.length,
  hasProxy: Boolean(proxyUrl),
  proxySafe: maskProxy(proxyUrl),
  exitIpRecorded: acc.exit_ip || null,
  cookiesAdded: names.length,
  navStatus,
  navError,
  preJarCount: preJar.length,
  postJarCount: postJar.length,
  // ★ 本脚本存在的唯一理由：这两个字段
  hasFlowBefore: preJar.includes('flow_cur_user_sec_id'),
  hasFlowAfter: postJar.includes('flow_cur_user_sec_id'),
  issuedByServer: !preJar.includes('flow_cur_user_sec_id') && postJar.includes('flow_cur_user_sec_id'),
  addedNames: added,
  removedNames: removed,
  ...snapshot,
}, null, 2));

await ctx.close().catch(() => {});
process.exit(0);
