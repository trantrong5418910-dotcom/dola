/**
 * dola 视频生成：走真实 UI 提交，同时抓 HTTP + WebSocket 帧。
 *
 *   node server/dola/dola-video.mjs --file ./cookies.json          # 只进界面看结构
 *   node server/dola/dola-video.mjs --file ./cookies.json --submit # 真的提交生成
 *
 * 产出 dola-video-run.json（含全部 HTTP 与 WS 帧），用来定位生成接口/协议。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCookies } from './provider.js';

const args = process.argv.slice(2);
const fi = args.indexOf('--file');
const SUBMIT = args.includes('--submit');
const raw = fi >= 0 && args[fi + 1] ? fs.readFileSync(args[fi + 1], 'utf8') : process.env.DOLA_COOKIE;
if (!raw) { console.error('用法：node server/dola/dola-video.mjs --file ./cookies.json [--submit]'); process.exit(2); }

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

const http = [];
const ws = [];

page.on('request', (r) => {
  const u = r.url();
  if (!u.includes('dola.com')) return;
  if (/\.(js|css|png|jpe?g|svg|woff2?|webp|gif|mp4)(\?|$)/i.test(u)) return;
  http.push({ dir: 'req', method: r.method(), path: u.split('?')[0].replace('https://www.dola.com', ''), url: u, body: (r.postData() || '').slice(0, 3000) });
});
page.on('response', async (r) => {
  const u = r.url();
  if (!u.includes('dola.com')) return;
  try {
    const ct = r.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    http.push({ dir: 'res', status: r.status(), path: u.split('?')[0].replace('https://www.dola.com', ''), body: (await r.text()).slice(0, 3000) });
  } catch { /* ignore */ }
});
page.on('websocket', (sock) => {
  ws.push({ ev: 'open', url: sock.url() });
  sock.on('framesent', (f) => ws.push({ ev: 'send', len: String(f).length, data: String(f).slice(0, 2500) }));
  sock.on('framereceived', (f) => ws.push({ ev: 'recv', len: String(f).length, data: String(f).slice(0, 2500) }));
});

console.log('→ 打开 /chat/');
await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(11000);
await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).catch(() => {});
await page.waitForTimeout(800);

console.log('→ 点「视频生成」快捷入口');
http.length = 0;
const entry = page.getByRole('button', { name: '视频生成' }).first();
console.log('   找到入口按钮:', await entry.count());
await entry.click({ timeout: 5000 }).catch((e) => console.log('   点击失败:', e.message.slice(0, 60)));
await page.waitForTimeout(7000);
console.log('   当前地址:', page.url());
await page.screenshot({ path: path.join(OUT, 'dola-video-01-entry.png') });

const inputs = await page.evaluate(() => [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].map((el) => {
  const r = el.getBoundingClientRect();
  return { tag: el.tagName.toLowerCase(), ph: el.getAttribute('placeholder') || '', ce: el.getAttribute('contenteditable') || '', vis: r.width > 0 && r.height > 0, y: Math.round(r.y) };
}).filter((x) => x.vis));
console.log('\n=== 输入框 ===');
for (const i of inputs) console.log('  ', JSON.stringify(i));

console.log('\n=== 页面文字 ===');
console.log((await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 800));

if (!SUBMIT) {
  console.log('\n（未提交。加 --submit 才真的生成）');
  await browser.close();
  process.exit(0);
}

// ---------------- 提交 ----------------
const PROMPT = '海边日落，无人机航拍，海浪拍打礁石，暖橙色光芒';
console.log('\n→ 输入提示词:', PROMPT);
const box = page.locator('textarea, [contenteditable="true"]').first();
await box.click({ timeout: 5000 }).catch(() => {});
await box.fill(PROMPT).catch(async () => page.keyboard.type(PROMPT));
await page.waitForTimeout(2000);
await page.screenshot({ path: path.join(OUT, 'dola-video-02-filled.png') });

console.log('→ 提交');
http.length = 0;
const before = ws.length;
await page.keyboard.press('Enter');
await page.waitForTimeout(20000);
await page.screenshot({ path: path.join(OUT, 'dola-video-03-submitted.png'), fullPage: false });

console.log('\n=== 提交后 · HTTP ===');
const s = new Set();
for (const t of http) { const k = t.dir + t.path; if (s.has(k)) continue; s.add(k); console.log(`  [${t.dir}] ${t.method || t.status} ${t.path}`); }
console.log('\n=== 提交后 · WebSocket 帧 ===');
for (const f of ws.slice(before).slice(0, 30)) console.log(`  [${f.ev}] ${f.len}B ${String(f.data).slice(0, 400)}`);

console.log('\n=== 提交后页面文字 ===');
console.log((await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 1200));

fs.writeFileSync(path.join(OUT, 'dola-video-run.json'), JSON.stringify({ at: new Date().toISOString(), http, ws, finalUrl: page.url() }, null, 2));
console.log('\n→ 已写入 dola-video-run.json');
await browser.close();
