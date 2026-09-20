/**
 * 量每个列表页的表格是否超出容器（超了就要横向滚动，操作列会盖住旁边的列）。
 *   node scripts/audit-table-width.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const PAGES = ['/dashboard', '/users', '/roles', '/content', '/tokens', '/cards', '/dola', '/logs', '/settings', '/profile'];
const WIDTH = Number(process.env.W || 1440);

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 900 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.getByPlaceholder('用户名').fill(process.env.ADMIN_USER || 'admin');
await page.getByPlaceholder('密码').fill(process.env.ADMIN_PASSWORD || 'admin123');
await page.getByPlaceholder('密码').press('Enter');
await page.waitForTimeout(2500);

const rows = [];
for (const p of PAGES) {
  await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  // 只看当前可见的那个 tab（Dola 有 3 个 tab，只量账号池）
  const info = await page.evaluate(() => {
    const t = document.querySelector('.el-table');
    if (!t) return null;
    const body = t.querySelector('.el-table__body');
    const head = t.querySelector('.el-table__header');
    const bar = t.querySelector('.el-scrollbar__bar.is-horizontal');
    const barVisible = bar ? getComputedStyle(bar).display !== 'none' : false;
    return {
      tableW: Math.round(t.getBoundingClientRect().width),
      contentW: head ? head.scrollWidth : null,
      scrollbarVisible: barVisible,
      cols: [...t.querySelectorAll('.el-table__header th')]
        .map((th) => (th.innerText || '').trim())
        .filter(Boolean).length,
    };
  });
  rows.push({ page: p, ...(info || { tableW: null, contentW: null, note: '无表格' }) });
}
await browser.close();

console.log(`视口宽 ${WIDTH}\n`);
console.log('页面'.padEnd(12), '表格宽'.padEnd(8), '内容宽'.padEnd(8), '列数'.padEnd(6), '需横向滚动');
for (const r of rows) {
  if (r.tableW == null) { console.log(r.page.padEnd(12), '(无表格)'); continue; }
  const over = r.contentW - r.tableW;
  console.log(
    r.page.padEnd(12),
    String(r.tableW).padEnd(8),
    String(r.contentW).padEnd(8),
    String(r.cols).padEnd(6),
    over > 4 ? `❌ 超 ${over}px` : '✅ 不用',
  );
}
