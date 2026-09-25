/**
 * 验证 Bug 2（令牌下拉框）是否真的有数据 —— **零消耗**。
 *
 * 只做：登录后台 → 进账号页 → 打开「测试生成」弹窗 → 数下拉选项 + 截图。
 * 绝不点确定、绝不提交任务（提交才会扣额度和令牌积分）。
 */
const BASE = process.env.ADMIN_BASE || 'https://admin.fei85.cn';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || '';

const pw = await import('playwright');
const browser = await pw.chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  executablePath: pw.chromium.executablePath(),
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const steps = [];
const note = (s) => { steps.push(s); console.error(`[verify] ${s}`); };

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);
note(`landing url=${page.url()}`);

const inputs = page.locator('input');
const inputCount = await inputs.count();
if (inputCount >= 2) {
  await inputs.nth(0).fill(USER).catch(() => {});
  await inputs.nth(1).fill(PASS).catch(() => {});
  note('filled credentials');
  const btn = page.locator('button').filter({ hasText: /登录|登 录|Sign in|Login/ }).first();
  await btn.click({ timeout: 8000 }).catch(async () => {
    await page.keyboard.press('Enter');
  });
  await page.waitForTimeout(3000);
}
note(`after login url=${page.url()}`);

await page.goto(`${BASE}/dola`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(4000);
// 表格是异步拉的，必须等行真的出来，否则找不到「更多」
await page.waitForSelector('.el-table__row', { timeout: 25000 }).catch(() => {});
note(`dola page url=${page.url()}`);

// 找第一行的「更多」按钮 → 下拉里点「测试生成」
const opened = await (async () => {
  const moreBtns = page.getByText(/更多/);
  const n = await moreBtns.count();
  note(`more buttons=${n}`);
  for (let i = 0; i < Math.min(n, 8); i++) {
    await moreBtns.nth(i).click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(800);
    const item = page.locator('.el-dropdown-menu__item', { hasText: /测试生成/ }).first();
    if (await item.count()) {
      await item.click({ timeout: 3000 }).catch(() => {});
      note(`clicked 更多 #${i} -> 测试生成`);
      return true;
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
  return false;
})();
note(`dialog opened=${opened}`);

await page.waitForTimeout(3000);
const dialog = page.locator('.el-dialog:visible').first();
const visible = await dialog.count();
note(`visible dialog count=${visible}`);

// 只在弹窗范围内找下拉，避免把页面上的筛选器当成选项
const select = dialog.locator('.el-select:visible').first();
await select.click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1500);
// el-select 的下拉面板挂在 body 上，取**当前展开**的那个
const options = await page.locator('.el-select-dropdown:visible .el-select-dropdown__item')
  .allInnerTexts().catch(() => []);
note(`option count=${options.length}`);

await page.screenshot({ path: '/tmp/bug2-dropdown.png', fullPage: false }).catch(() => {});

console.log(JSON.stringify({
  url: page.url(),
  dialogFound: Boolean(visible),
  // 关键判据：下拉里有没有真令牌
  optionCount: options.length,
  options: options.map(t => t.replace(/\s+/g, ' ').trim()).slice(0, 10),
  screenshot: '/tmp/bug2-dropdown.png',
  steps,
}, null, 2));

await browser.close().catch(() => {});
process.exit(0);
