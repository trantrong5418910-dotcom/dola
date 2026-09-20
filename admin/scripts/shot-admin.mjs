/**
 * 后台页面截图（验收 UI 改动）。
 *   node scripts/shot-admin.mjs --path /dola --out ../capture/admin-dola.png [--width 1600]
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const BASE = flag('base', 'http://127.0.0.1:8788');
const PAGE = flag('path', '/dola');
const OUT = path.resolve(flag('out', '../capture/admin.png'));
const WIDTH = Number(flag('width', 1600));
const HEIGHT = Number(flag('height', 1000));
const USER = flag('user', process.env.ADMIN_USER || 'admin');
const PASS = flag('pass', process.env.ADMIN_PASSWORD || 'admin123');
const FULL = !argv.includes('--viewport-only');
const THEME = flag('theme', '');   // dark / light，空=用默认（深色）

fs.mkdirSync(path.dirname(OUT), { recursive: true });

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });

// 主题是存在 localStorage 的 admin_theme（见 store.js：只有 'light' 才是浅色）
if (THEME) {
  await ctx.addInitScript((t) => localStorage.setItem('admin_theme', t), THEME);
}
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);

// 登录：用 placeholder 定位（el-input 的内层 input），再按 Enter 提交
await page.getByPlaceholder('用户名').fill(USER).catch(() => {});
await page.getByPlaceholder('密码').fill(PASS).catch(() => {});
await page.getByPlaceholder('密码').press('Enter').catch(() => {});
await page.waitForTimeout(2500);

if (/\/login/.test(page.url())) {
  // Enter 没生效就点按钮（文案是「登 录」，带空格，所以按 type=primary 找）
  await page.locator('button.el-button--primary').first().click().catch(() => {});
  await page.waitForTimeout(2500);
}
if (/\/login/.test(page.url())) {
  throw new Error('登录失败，仍停在 /login —— 检查账号密码');
}

await page.goto(`${BASE}${PAGE}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// 打开可能的弹窗？
const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
console.log('URL:', page.url());
console.log('页面片段:', text.slice(0, 300));

// 顺便量一下表格列宽，用来诊断"列被压扁"
const cols = await page.evaluate(() => {
  const ths = [...document.querySelectorAll('.el-table__header th')];
  const tbl = document.querySelector('.el-table');
  const body = document.querySelector('.el-table__body');
  return {
    tableWidth: tbl ? Math.round(tbl.getBoundingClientRect().width) : null,
    bodyScrollWidth: body ? body.scrollWidth : null,
    cols: ths.map((t) => ({ label: (t.innerText || '').trim().slice(0, 12), w: Math.round(t.getBoundingClientRect().width) })),
  };
});
console.log('表格宽:', cols.tableWidth, '| 内容宽:', cols.bodyScrollWidth);
console.log('列宽:', JSON.stringify(cols.cols));

await page.screenshot({ path: OUT, fullPage: FULL });
console.log('截图:', OUT);
await browser.close();
