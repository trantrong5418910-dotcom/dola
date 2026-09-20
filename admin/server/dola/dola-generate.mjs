/**
 * dola 视频：用账号 cookie 驱动真实页面生成视频，并读回「今日剩余额度」。
 *
 *   node server/dola/dola-generate.mjs --file ./cookies.json                 # 只看额度，不生成
 *   node server/dola/dola-generate.mjs --file ./cookies.json --prompt "..." # 生成一条并等成片
 *   node server/dola/dola-generate.mjs --file ./cookies.json --poll <convId> # 只轮询已有会话
 *
 * 设计说明：
 *   dola 的生成走 `/chat/completion`（流式）+ WebSocket 推消息，纯 HTTP 复刻不现实，
 *   所以用真实浏览器带 cookie 驱动页面 —— 让页面自己算 a_bogus、自己走协议。
 *   我们只做三件事：填提示词、按回车、盯着页面把结果和额度读出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCookies } from './provider.js';

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const raw = flag('file') ? fs.readFileSync(flag('file'), 'utf8') : process.env.DOLA_COOKIE;
if (!raw) { console.error('用法：node server/dola/dola-generate.mjs --file ./cookies.json [--prompt "..."]'); process.exit(2); }

const PROMPT = flag('prompt', '海边日落，无人机航拍，海浪拍打礁石，暖橙色光芒');
const POLL_ID = flag('poll');
const MAX_WAIT_MIN = Number(flag('minutes', '20'));
const OUT = process.cwd();

const { chromium } = await import('playwright');
const ck = parseCookies(raw);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  viewport: { width: 1560, height: 950 }, locale: 'zh-CN',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  acceptDownloads: true,
});
await ctx.addCookies(Object.entries(ck).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' })));

const page = await ctx.newPage();

/** 从页面文字里抽「今日剩余 N 个视频生成额度」和消耗量 */
function parseQuota(text) {
  const t = text.replace(/\s+/g, ' ');
  const remain = t.match(/今日剩余\s*(\d+)\s*个视频生成额度/);
  const cost = t.match(/消耗\s*(\d+)\s*个视频生成额度/);
  const wait = t.match(/预计等待\s*(\d+)\s*分钟/);
  const model = t.match(/使用\s*([A-Za-z0-9.\s]+?)\s*生成/);
  return {
    remaining: remain ? Number(remain[1]) : null,
    cost: cost ? Number(cost[1]) : null,
    etaMinutes: wait ? Number(wait[1]) : null,
    model: model ? model[1].trim() : null,
  };
}

/** 从页面里挖视频直链（<video src> / a[href$=mp4] / img 不算） */
async function findVideoUrl() {
  return page.evaluate(() => {
    const urls = [];
    for (const v of document.querySelectorAll('video')) {
      if (v.src) urls.push(v.src);
      for (const s of v.querySelectorAll('source')) if (s.src) urls.push(s.src);
    }
    for (const a of document.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href') || '';
      if (/\.(mp4|mov|webm)(\?|$)/i.test(h) || /video\/tos|\.mp4/i.test(h)) urls.push(a.href);
    }
    return [...new Set(urls)];
  });
}

const pageText = async () => (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');

if (POLL_ID) {
  console.log(`→ 直接轮询会话 ${POLL_ID}`);
  await page.goto(`https://www.dola.com/chat/${POLL_ID}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
} else if (args.includes('--prompt')) {
  console.log('→ 打开 /chat/ 准备生成');
  await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(11000);
  await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(800);

  console.log('→ 进入「视频生成」');
  await page.getByRole('button', { name: '视频生成' }).first().click({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(6000);

  console.log('→ 填入提示词并提交');
  const box = page.locator('textarea, [contenteditable="true"]').first();
  await box.click({ timeout: 5000 }).catch(() => {});
  await box.fill(PROMPT).catch(async () => page.keyboard.type(PROMPT));
  await page.waitForTimeout(1500);
  await page.keyboard.press('Enter');
} else {
  console.log('→ 只读模式：打开 /chat/ 看额度（不生成）');
  await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
}

await page.waitForTimeout(9000);
await page.getByRole('button', { name: '我知道了' }).click({ timeout: 2500 }).catch(() => {});
await page.waitForTimeout(2000);

console.log('\n=== 首次读取 ===');
{
  const t = await pageText();
  const q = parseQuota(t);
  console.log('   额度解析:', q);
  console.log('   页面片段:', t.slice(0, 500));
  console.log('   视频链接:', await findVideoUrl());
}

// 轮询等成片
const deadline = Date.now() + MAX_WAIT_MIN * 60_000;
let round = 0;
let found = null;
while (Date.now() < deadline) {
  round++;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(7000);
  const t = await pageText();
  const q = parseQuota(t);
  const urls = await findVideoUrl();
  const mm = ((Date.now() - (deadline - MAX_WAIT_MIN * 60_000)) / 60000).toFixed(1);
  console.log(`[${mm}min] #${round} 剩余额度=${q.remaining ?? '-'} 视频链接=${urls.length}`);

  if (urls.length) { found = urls[0]; console.log('   ✅ 拿到视频:', found); break; }
  if (/生成失败|失败|错误/.test(t) && !/我将为您生成/.test(t)) {
    console.log('   ⚠️ 页面出现失败字样:', t.slice(0, 300));
  }
  await page.waitForTimeout(20000);
}

const finalText = await pageText();
const finalQuota = parseQuota(finalText);
console.log('\n=== 结果 ===');
console.log('  今日剩余额度:', finalQuota.remaining ?? '(未读到)');
console.log('  消耗:', finalQuota.cost ?? '-', '预计等待:', finalQuota.etaMinutes ?? '-', '分钟');
console.log('  成片链接:', found || '(尚未出现)');
await page.screenshot({ path: path.join(OUT, 'dola-generate-result.png'), fullPage: true });

fs.writeFileSync(path.join(OUT, 'dola-generate-result.json'), JSON.stringify({
  at: new Date().toISOString(), prompt: PROMPT, quota: finalQuota, videoUrl: found, pageText: finalText.slice(0, 4000),
}, null, 2));
console.log('→ 写入 dola-generate-result.json / dola-generate-result.png');

await browser.close();
