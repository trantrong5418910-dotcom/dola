/**
 * 抓「提交那一刻」的网络包，找出谁触发了登出。
 *
 *   node server/dola/exp-capture-submit.mjs --account-id 82
 *
 * 已知：开浏览器加载页面不会掉登录态，**一提交就变 ?from_logout=1**。
 * 这个脚本把提交前后所有可疑响应（非 200、带 code 的、passport/completion 相关）
 * 原文打出来，看服务端到底回了什么让前端决定登出。
 */
import { initDb, db } from '../db.js';
import { parseCookies, getPlaywright, DOLA_HEADERS, guardLogoutRequests } from './provider.js';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const ACC_ID = Number(flag('account-id'));
if (!ACC_ID) { console.error('用法：node server/dola/exp-capture-submit.mjs --account-id <id>'); process.exit(2); }

await initDb();
const acc = db.prepare('SELECT id,label,cookie FROM dola_accounts WHERE id = ?').get(ACC_ID);
if (!acc) { console.error('账号不存在'); process.exit(1); }
const ck = parseCookies(acc.cookie);

const pw = await getPlaywright();
const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 950 }, locale: 'zh-CN', userAgent: DOLA_HEADERS['user-agent'] });
await ctx.addCookies(Object.entries(ck).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' })));
await guardLogoutRequests(ctx);

const hits = [];
ctx.on('response', async (res) => {
  const u = res.url();
  if (!/dola\.com/.test(u)) return;
  const p = new URL(u).pathname;
  const interesting = res.status() !== 200
    || /passport|logout|login|user\/launch|chat\/completion|chain|session/i.test(p);
  if (!interesting) return;
  let body = '';
  try {
    const ct = res.headers()['content-type'] || '';
    if (ct.includes('json')) body = JSON.stringify(await res.json()).slice(0, 700);
    else body = (await res.text()).slice(0, 300);
  } catch { body = '(读不到)'; }
  hits.push({ t: Date.now(), status: res.status(), path: p, body });
});

const page = await ctx.newPage();
const t0 = Date.now();
console.log(`账号 #${acc.id} ${acc.label} —— 开始提交`);

await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(11000);
await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).catch(() => {});
await page.waitForTimeout(600);
await page.getByRole('button', { name: '视频生成' }).first().click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(5000);
console.log('  已切到视频生成，准备提交');

const markBefore = hits.length;
const box = page.locator('textarea, [contenteditable="true"]').first();
await box.click({ timeout: 5000 }).catch(() => {});
await box.fill('一只橘猫在窗台上晒太阳').catch(async () => page.keyboard.type('一只橘猫在窗台上晒太阳'));
await page.waitForTimeout(1200);
await page.keyboard.press('Enter');
await page.waitForTimeout(16000);

console.log('  提交后 URL:', page.url());
await browser.close();

console.log('\n══════ 提交前后的网络响应 ══════');
for (const [i, h] of hits.entries()) {
  const rel = ((h.t - t0) / 1000).toFixed(1);
  const flag = i < markBefore ? '提交前' : '★提交后';
  if (h.status !== 200 || i >= markBefore) {
    console.log(`\n[${rel}s] ${flag}  HTTP ${h.status}  ${h.path}`);
    console.log('   ', h.body.replace(/\s+/g, ' ').slice(0, 500));
  }
}
console.log(`\n共捕获 ${hits.length} 条可疑响应（提交前 ${markBefore}，提交后 ${hits.length - markBefore}）`);
