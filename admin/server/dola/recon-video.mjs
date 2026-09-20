/**
 * dola 视频生成流程侦察：
 *   1. 打开 chat，列出可点元素
 *   2. 点「AI 创作」，看主区域加载出什么、发了哪些接口
 *   3. 把视频生成相关的入口 / 接口全打印出来
 *
 *   node server/dola/recon-video.mjs --file ./cookies.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCookies } from './provider.js';

const args = process.argv.slice(2);
const fi = args.indexOf('--file');
const raw = fi >= 0 && args[fi + 1] ? fs.readFileSync(args[fi + 1], 'utf8') : process.env.DOLA_COOKIE;
if (!raw) { console.error('用法：node server/dola/recon-video.mjs --file ./cookies.json'); process.exit(2); }

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
  traffic.push({ dir: 'req', method: r.method(), url: u, body: (r.postData() || '').slice(0, 800) });
});
page.on('response', async (r) => {
  const u = r.url();
  if (!u.includes('dola.com')) return;
  try {
    const ct = r.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    traffic.push({ dir: 'res', status: r.status(), url: u, body: (await r.text()).slice(0, 1200) });
  } catch { /* ignore */ }
});

console.log('→ 打开 chat');
await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(10000);

async function dumpClickables(tag) {
  const items = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('a,button,[role="button"],[role="tab"],[role="menuitem"]')) {
      const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      if (!t || t.length > 30) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out.push({ tag: el.tagName.toLowerCase(), text: t, href: el.getAttribute('href') || '', y: Math.round(r.y), x: Math.round(r.x) });
    }
    // 去重
    const seen = new Set();
    return out.filter((o) => { const k = o.tag + o.text; if (seen.has(k)) return false; seen.add(k); return true; });
  });
  console.log(`\n=== [${tag}] 可点元素（${items.length}）===`);
  for (const i of items) console.log(`  ${i.tag.padEnd(6)} y=${String(i.y).padStart(4)}  ${i.text}${i.href ? '  → ' + i.href : ''}`);
  return items;
}

await dumpClickables('chat 首屏');
await page.screenshot({ path: path.join(OUT, 'recon-01-chat.png') });

console.log('\n→ 点「AI 创作」');
traffic.length = 0;
await page.getByText('AI 创作', { exact: true }).first().click({ timeout: 5000 }).catch((e) => console.log('  点击失败:', e.message.slice(0, 70)));
await page.waitForTimeout(8000);
console.log('   当前地址:', page.url());
await page.screenshot({ path: path.join(OUT, 'recon-02-aispace.png') });
await dumpClickables('AI 创作页');

console.log('\n=== 点击期间产生的接口 ===');
const seen = new Set();
for (const t of traffic) {
  const p = t.url.split('?')[0];
  if (seen.has(p + t.dir)) continue;
  seen.add(p + t.dir);
  console.log(`  [${t.dir}] ${t.method || t.status} ${p.replace('https://www.dola.com', '')}`);
}

console.log('\n=== 主区域文字 ===');
const mainText = await page.locator('main, [class*="content"], body').last().innerText().catch(() => '');
console.log(mainText.replace(/\s+/g, ' ').slice(0, 900));

await browser.close();
