/**
 * 打开 dola 的「AI 创作 / 视频」面板，看额度/剩余次数是不是在这里才暴露。
 *
 *   node server/dola/video-panel.mjs --file ./cookies.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCookies, playwrightAvailable, guardLogoutRequests } from './provider.js';

const args = process.argv.slice(2);
const fi = args.indexOf('--file');
const raw = fi >= 0 && args[fi + 1] ? fs.readFileSync(args[fi + 1], 'utf8') : process.env.DOLA_COOKIE;
if (!raw) { console.error('用法：node server/dola/video-panel.mjs --file ./cookies.json'); process.exit(2); }
if (!(await playwrightAvailable())) { console.error('需要 playwright'); process.exit(2); }
const { chromium } = await import('playwright');

const cookies = parseCookies(raw);
const OUT = process.cwd();
const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1500, height: 950 }, locale: 'en-US',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});
await ctx.addCookies(Object.entries(cookies).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' })));
await guardLogoutRequests(ctx);
const page = await ctx.newPage();

const hits = [];
page.on('response', async (res) => {
  const u = res.url();
  if (!/dola\.com\/(alice|samantha|biz)\//.test(u)) return;
  try {
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    const text = await res.text();
    hits.push({ path: new URL(u).pathname, body: text });
  } catch { /* ignore */ }
});

console.log('→ 打开 chat');
await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(9000);
hits.length = 0; // 只看后面点击产生的

for (const label of [/Create Videos/i, /AI 创作/, /Create Images/i, /Video/i]) {
  const el = page.getByText(label).first();
  if (await el.count().catch(() => 0)) {
    console.log('→ 点击:', String(label));
    await el.click({ timeout: 4000 }).catch((e) => console.log('   点击失败:', e.message.slice(0, 60)));
    await page.waitForTimeout(4000);
  }
}
await page.screenshot({ path: path.join(OUT, 'dola-video-panel.png') });

// 侧边栏「AI 创作」
for (const label of [/AI 创作/, /AI Creation/i, /云盘/]) {
  const el = page.getByText(label).first();
  if (await el.count().catch(() => 0)) {
    console.log('→ 点击侧栏:', String(label));
    await el.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }
}
await page.screenshot({ path: path.join(OUT, 'dola-video-panel-2.png') });

console.log('\n=== 点击期间产生的接口 ===');
for (const h of hits) console.log(`  ${h.path}  (${h.body.length}B)`);

console.log('\n=== 全部响应里含额度/次数关键词的片段 ===');
const KW = /(quota|remain|left|credit|limit|usage|次数|额度|remaining|available|balance)/i;
let n = 0;
for (const h of hits) {
  for (const m of h.body.matchAll(new RegExp(`.{0,90}${KW.source}.{0,110}`, 'gi'))) {
    console.log(`  [${h.path.slice(0, 36)}] …${m[0].replace(/\n/g, ' ').slice(0, 190)}`);
    if (++n > 25) break;
  }
  if (n > 25) break;
}
if (!n) console.log('  （无）');

console.log('\n=== 页面文字 ===');
console.log((await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 700));

fs.writeFileSync(path.join(OUT, 'dola-video-panel.json'), JSON.stringify({ hits, at: new Date().toISOString() }, null, 2));
console.log('\n→ 写入 dola-video-panel.json');
await browser.close();
