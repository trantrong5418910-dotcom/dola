/**
 * 量每个列表页的表格是否超出容器（超了就要横向滚动，操作列会盖住旁边的列）。
 *   node scripts/audit-table-width.mjs
 *
 * 2026-09-27 增强：只报「溢出多少」是不够的 —— 溢出必然导致 fixed/sticky 的操作列
 * **盖住左边一列**，而这一列在截图上看起来只是"空白"，肉眼发现不了。所以补了
 * **命中测试**（elementFromPoint）：对主表体每个单元格取可见区中点，看最上层
 * 元素是否属于它自己；不属于就说明被 fixed-right 层盖住了。
 *
 * 环境变量：BASE / W（视口宽）/ ADMIN_USER / ADMIN_PASSWORD / PAGES（逗号分隔，覆盖默认页）
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const DEFAULT_PAGES = ['/dashboard', '/users', '/roles', '/content', '/tokens', '/cards', '/scripts', '/dola', '/logs', '/settings', '/profile'];
const PAGES = (process.env.PAGES ? process.env.PAGES.split(',') : DEFAULT_PAGES).map((s) => s.trim()).filter(Boolean);
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

/**
 * 探测单个表格：宽度 / 溢出 / 被 fixed-right 层盖住的列。
 * 返回 null 表示该页没有 el-table（例如表单页）。
 */
async function probeTable() {
  return page.evaluate(() => {
    const t = document.querySelector('.el-table');
    if (!t) return null;
    const head = t.querySelector('.el-table__header');
    const wrap = t.querySelector('.el-table__body-wrapper') || t;
    const fixedR = t.querySelector('.el-table__fixed-right');
    const bar = t.querySelector('.el-scrollbar__bar.is-horizontal');
    const barVisible = bar ? getComputedStyle(bar).display !== 'none' : false;
    const wr = wrap.getBoundingClientRect();
    const headers = [...t.querySelectorAll('.el-table__header th')].map((th) => (th.innerText || '').trim());

    // ── 命中测试：主表体里每个单元格的可见区中点，最上层元素是不是它自己 ──
    const covered = [];
    const cells = [...wrap.querySelectorAll('tbody tr:first-child td')];
    cells.forEach((td, idx) => {
      const r = td.getBoundingClientRect();
      if (r.width <= 0) return;
      // 取该单元格与可视区**交集**的中点；完全不可见就跳过（那是滚动出去，不是被盖）
      const left = Math.max(r.left, wr.left);
      const right = Math.min(r.right, wr.right);
      if (right - left < 2) return;
      const el = document.elementFromPoint((left + right) / 2, r.top + Math.min(r.height / 2, 16));
      if (!el) return;
      if (td.contains(el)) return; // 命中自己 → 没被盖
      const byFixed = fixedR ? fixedR.contains(el) : false;
      covered.push({
        col: headers[idx] || `#${idx}`,
        by: byFixed ? 'fixed-right 层' : `${el.tagName}.${String(el.className || '').slice(0, 34)}`,
      });
    });

    return {
      tableW: Math.round(t.getBoundingClientRect().width),
      contentW: head ? head.scrollWidth : null,
      scrollbarVisible: barVisible,
      cols: headers.filter(Boolean).length,
      fixedRight: fixedR ? Math.round(fixedR.getBoundingClientRect().width) : 0,
      covered,
      headers,
    };
  });
}

/**
 * 有些页面的表格藏在「先选中一条记录」之后（如 /scripts 的分镜表在 v-if="current" 里），
 * 不先点一下就永远量到「无表格」。这里按路径给准备动作。
 */
const PREPARE = {
  async '/scripts'(page) {
    const item = page.locator('.script-item').first();
    if (await item.count()) {
      await item.click();
      await page.waitForSelector('.shots-table', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(900);
    }
  },
};

const rows = [];
for (const p of PAGES) {
  await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  if (PREPARE[p]) await PREPARE[p](page);
  // 只看当前可见的那个 tab（Dola 有 3 个 tab，只量账号池）
  const info = await probeTable();
  rows.push({ page: p, ...(info || { tableW: null, contentW: null, note: '无表格' }) });
}
await browser.close();

console.log(`视口宽 ${WIDTH}\n`);
console.log('页面'.padEnd(12), '表格宽'.padEnd(8), '内容宽'.padEnd(8), '列数'.padEnd(6), '需横向滚动');
let bad = 0;
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
  if (over > 4) bad += 1;
}

// ── 遮挡明细 ──
const occluded = rows.filter((r) => (r.covered || []).length);
if (occluded.length) {
  console.log('\n⚠️ 被 fixed-right 操作列盖住的列（截图上看起来只是"空白"，肉眼发现不了）：');
  for (const r of occluded) {
    for (const c of r.covered) console.log(`  ${r.page.padEnd(12)} 「${c.col}」 ← 被 ${c.by} 盖住`);
  }
} else {
  console.log('\n✅ 没有列被操作列盖住');
}
console.log(`\n小结：${bad} 个页面表格需要横向滚动`);
