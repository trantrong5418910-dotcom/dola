/**
 * 侦察第 2 步：进入 /chat/create-image，切到「视频」tab，找出输入框和生成按钮，
 * 并尝试真正提交一次生成（会消耗账号额度）。
 *
 *   node server/dola/recon-video2.mjs --file ./cookies.json            # 只看不提交
 *   node server/dola/recon-video2.mjs --file ./cookies.json --submit   # 真的提交
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCookies } from './provider.js';

const args = process.argv.slice(2);
const fi = args.indexOf('--file');
const SUBMIT = args.includes('--submit');
const raw = fi >= 0 && args[fi + 1] ? fs.readFileSync(args[fi + 1], 'utf8') : process.env.DOLA_COOKIE;
if (!raw) { console.error('用法：node server/dola/recon-video2.mjs --file ./cookies.json [--submit]'); process.exit(2); }

const { chromium } = await import('playwright');
const ck = parseCookies(raw);
const OUT = process.cwd();

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  viewport: { width: 1560, height: 950 }, locale: 'zh-CN',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});
await ctx.addCookies(Object.entries(ck).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' })));
const page = await ctx.newPage();

const traffic = [];
page.on('request', (r) => {
  const u = r.url();
  if (!u.includes('dola.com')) return;
  if (/\.(js|css|png|jpe?g|svg|woff2?|webp|gif|mp4)(\?|$)/i.test(u)) return;
  traffic.push({ dir: 'req', method: r.method(), url: u, body: (r.postData() || '').slice(0, 1500) });
});
page.on('response', async (r) => {
  const u = r.url();
  if (!u.includes('dola.com')) return;
  try {
    const ct = r.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    traffic.push({ dir: 'res', status: r.status(), url: u, body: (await r.text()).slice(0, 2500) });
  } catch { /* ignore */ }
});

console.log('→ 打开 /chat/create-image');
await page.goto('https://www.dola.com/chat/create-image', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(11000);
await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).catch(() => {});
await page.waitForTimeout(1000);

// 切到「视频」
console.log('→ 切换「视频」tab');
const videoTab = page.getByRole('button', { name: '视频', exact: true });
console.log('   找到「视频」按钮:', await videoTab.count());
await videoTab.first().click({ timeout: 5000 }).catch((e) => console.log('   点击失败:', e.message.slice(0, 60)));
await page.waitForTimeout(6000);
await page.screenshot({ path: path.join(OUT, 'recon2-01-video-tab.png') });

// 列出输入框和按钮
const inputs = await page.evaluate(() => [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].map((el) => {
  const r = el.getBoundingClientRect();
  return { tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', ph: el.getAttribute('placeholder') || '', ce: el.getAttribute('contenteditable') || '', visible: r.width > 0 && r.height > 0 };
}).filter((x) => x.visible));
console.log('\n=== 输入框 ===');
for (const i of inputs) console.log('  ', JSON.stringify(i));

const btns = await page.evaluate(() => [...document.querySelectorAll('button,[role="button"]')].map((el) => {
  const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
  const r = el.getBoundingClientRect();
  return { text: t.slice(0, 30), visible: r.width > 0 && r.height > 0, y: Math.round(r.y) };
}).filter((x) => x.visible && x.text));
console.log('\n=== 按钮 ===');
const seen = new Set();
for (const b of btns) { if (seen.has(b.text)) continue; seen.add(b.text); console.log(`   y=${String(b.y).padStart(4)}  ${b.text}`); }

console.log('\n=== 页面文字 ===');
console.log((await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 1200));

console.log('\n=== 切 tab 期间产生的接口 ===');
const s2 = new Set();
for (const t of traffic) { const p = t.url.split('?')[0]; if (s2.has(p + t.dir)) continue; s2.add(p + t.dir); console.log(`  [${t.dir}] ${t.method || t.status} ${p.replace('https://www.dola.com', '')}`); }
fs.writeFileSync(path.join(OUT, 'recon2-traffic.json'), JSON.stringify(traffic, null, 2));

if (!SUBMIT) {
  console.log('\n（未提交。加 --submit 才真的生成）');
  await browser.close();
  process.exit(0);
}

// ---------- 真正提交 ----------
console.log('\n→ 填入提示词并提交');
const prompt = '海边日落，无人机航拍，海浪拍打礁石，暖橙色光芒';
const editable = page.locator('textarea, [contenteditable="true"]').first();
await editable.click({ timeout: 5000 }).catch(() => {});
await editable.fill(prompt).catch(async () => { await page.keyboard.type(prompt); });
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(OUT, 'recon2-02-filled.png') });

// 找发送按钮：优先 aria-label，其次常见图标按钮
for (const sel of ['[aria-label*="发送"]', '[aria-label*="生成"]', '[class*="send"]']) {
  const el = page.locator(sel).last();
  if (await el.count().catch(() => 0)) {
    console.log('   点发送:', sel);
    await el.click({ timeout: 4000 }).catch(() => {});
    break;
  }
}
await page.keyboard.press('Enter').catch(() => {});
await page.waitForTimeout(12000);
await page.screenshot({ path: path.join(OUT, 'recon2-03-submitted.png') });

console.log('\n=== 提交后产生的接口 ===');
const s3 = new Set();
for (const t of traffic) { const p = t.url.split('?')[0]; if (s3.has(p + t.dir)) continue; s3.add(p + t.dir); console.log(`  [${t.dir}] ${t.method || t.status} ${p.replace('https://www.dola.com', '')}`); }
console.log('\n=== 提交后页面文字 ===');
console.log((await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 1000));
fs.writeFileSync(path.join(OUT, 'recon2-traffic-after-submit.json'), JSON.stringify(traffic, null, 2));
console.log('\n→ 流量已写入 recon2-traffic*.json');
await browser.close();
