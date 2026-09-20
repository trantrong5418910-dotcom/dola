/**
 * 给用户端工作台自动登录并截图（验收用）。
 *   node scripts/shot-workbench.mjs --token dv_xxx --out ./capture/workbench.png
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const TOKEN = flag('token') || process.env.WB_TOKEN;
const URLBASE = flag('url', 'http://127.0.0.1:8787');
const OUT = path.resolve(flag('out', './capture/workbench.png'));
if (!TOKEN) { console.error('需要 --token'); process.exit(2); }
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

// 先进页面写入令牌，再刷新，让前端走"已登录"分支
await page.goto(URLBASE, { waitUntil: 'domcontentloaded' });
await page.evaluate((t) => {
  // 前端的令牌键名，见 web/index.html 的 TOKEN_KEY
  localStorage.setItem('video_workbench_token', t);
  localStorage.removeItem('video_workbench_force_login');
}, TOKEN);

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

// 如果还停在登录页，就手工填一次
const loginVisible = await page.locator('#credential, input[type="password"]').first().isVisible().catch(() => false);
if (loginVisible) {
  await page.locator('#credential, input[type="password"]').first().fill(TOKEN).catch(() => {});
  const btn = page.getByRole('button', { name: /登录|进入/ }).first();
  await btn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

// 点一次刷新，确保列表最新
await page.getByRole('button', { name: '刷新' }).first().click({ timeout: 4000 }).catch(() => {});
await page.waitForTimeout(1500);

const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
console.log('页面文本:', text.slice(0, 400));
await page.screenshot({ path: OUT, fullPage: true });
console.log('截图:', OUT);
await browser.close();
