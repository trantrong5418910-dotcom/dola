/**
 * 带真实 cookie 起浏览器，把 dola 加载时的所有接口响应全抓下来，用来定位「额度」字段。
 *
 *   node server/dola/browser-capture.mjs --file "/path/to/cookies.json"
 *
 * 产出：
 *   dola-browser-capture.json   所有响应体（截断 40KB/条）+ 全部数值型叶子字段
 *   dola-browser-01.png / 02.png  页面截图
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCookies, playwrightAvailable, guardLogoutRequests } from './provider.js';

const args = process.argv.slice(2);
const fi = args.indexOf('--file');
const raw = fi >= 0 && args[fi + 1]
  ? fs.readFileSync(args[fi + 1], 'utf8')
  : (process.env.DOLA_COOKIE || args.filter((a) => !a.startsWith('--'))[0]);
if (!raw) { console.error('用法：node server/dola/browser-capture.mjs --file ./cookies.json'); process.exit(2); }

if (!(await playwrightAvailable())) {
  console.error('需要 playwright：npm i playwright && npx playwright install chromium');
  process.exit(2);
}
const { chromium } = await import('playwright');

const cookies = parseCookies(raw);
console.log(`解析出 ${Object.keys(cookies).length} 个 cookie：${Object.keys(cookies).slice(0, 10).join(', ')}…`);

const OUT = process.cwd();
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
});
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 950 },
  locale: 'en-US',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});
await ctx.addCookies(Object.entries(cookies).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' })));
await guardLogoutRequests(ctx);

const captured = [];
const page = await ctx.newPage();

page.on('response', async (res) => {
  const u = res.url();
  if (!/\/alice\/|\/samantha\/|\/im\/|\/biz\/|\/passport\//.test(u)) return;
  try {
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    captured.push({ path: new URL(u).pathname, status: res.status(), body: text.slice(0, 40000), json });
  } catch { /* ignore */ }
});

console.log('→ 打开 https://www.dola.com/chat/');
await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('  goto:', e.message));
await page.waitForTimeout(14000);
await page.screenshot({ path: path.join(OUT, 'dola-browser-01.png') });

// 页面上能看到的文字（额度一般显示在顶栏）
const bodyText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
console.log('\n=== 页面可见文字（前 700 字）===');
console.log(bodyText.slice(0, 700));

// 尽量点开可能显示额度的入口
for (const label of [/credit/i, /balance/i, /upgrade/i, /plan/i, /额度/i, /积分/i, /订阅/i, /Profile/i, /Account/i]) {
  const el = page.getByText(label).first();
  if (await el.count().catch(() => 0)) {
    await el.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
}
await page.screenshot({ path: path.join(OUT, 'dola-browser-02.png') });
const bodyText2 = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
if (bodyText2 !== bodyText) {
  console.log('\n=== 点击后页面文字（前 700 字）===');
  console.log(bodyText2.slice(0, 700));
}

// 收集所有数值型叶子字段
const numerics = [];
(function walk(o, prefix = '', depth = 0) {
  if (depth > 8 || o == null) return;
  if (Array.isArray(o)) { o.slice(0, 5).forEach((v, i) => walk(v, `${prefix}[${i}]`, depth + 1)); return; }
  if (typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'number') numerics.push({ field: p, value: v });
    else if (v && typeof v === 'object') walk(v, p, depth + 1);
  }
})(captured.map((c) => c.json));

fs.writeFileSync(path.join(OUT, 'dola-browser-capture.json'), JSON.stringify({
  capturedAt: new Date().toISOString(),
  finalUrl: page.url(),
  bodyText: bodyText2,
  numerics,
  responses: captured,
}, null, 2));
console.log(`\n→ 写入 dola-browser-capture.json（${captured.length} 个接口响应，${numerics.length} 个数值字段）`);

console.log('\n=== 响应清单 ===');
for (const c of captured) console.log(`  ${c.status}  ${c.path}  (${c.body.length}B)`);

const KW = /credit|quota|balance|remain|coin|diamond|energy|available|left|point|vip|plan|subscription|package|benefit|free|pro|limit|usage|total|used/i;
console.log('\n=== 命中关键词的数值字段 ===');
const hits = numerics.filter((n) => KW.test(n.field));
if (!hits.length) console.log('  （没有）');
for (const h of hits) console.log(`  ${h.field} = ${h.value}`);

await browser.close();
