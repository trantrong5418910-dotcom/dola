/**
 * 前台（用户端工作台）端到端走查。
 *
 *   node scripts/e2e-workbench.mjs --token dv_xxx [--submit]
 *
 * 走一遍真实用户的路径：打开 → 登录 → 看余额 → 提交生成 → 轮询 → 看结果。
 * 每步截图，并收集浏览器 console 报错（前端有问题时这是最快的线索）。
 *
 * 不带 --submit 就只走到"填好表单"为止，不会真的消耗生成额度。
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const BASE = flag('url', process.env.WB_URL || 'http://127.0.0.1:8787');
const TOKEN = flag('token') || process.env.WB_TOKEN;
const OUT = path.resolve(flag('out', './capture/wb'));
const SUBMIT = has('submit');
const PROMPT = flag('prompt', '一只橘猫趴在洒满阳光的木窗台上打盹，窗外樱花缓缓飘落，镜头缓慢推进');
const WAIT_MIN = Number(flag('minutes', 12));

if (!TOKEN) { console.error('需要 --token <用户访问令牌>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

const consoleMsgs = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 200)}`); });
page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message.slice(0, 200)}`));

let step = 0;
async function shot(label) {
  step++;
  const f = path.join(OUT, `${String(step).padStart(2, '0')}-${label}.png`);
  await page.screenshot({ path: f, fullPage: false }).catch(() => {});
  const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  console.log(`\n── ${step}. ${label} ──`);
  console.log(`   url: ${page.url()}`);
  console.log(`   文本: ${text.slice(0, 320)}`);
  console.log(`   截图: ${f}`);
  return text;
}

// ---------------- ① 打开 ----------------
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(1500);
await shot('打开首页');

// ---------------- ② 登录 ----------------
// 前端可能因为服务端有默认令牌而直接进主界面；没有就填令牌
const needLogin = await page.locator('input[type="password"], #credential, input[placeholder*="令牌"]').first().isVisible().catch(() => false);
if (needLogin) {
  const input = page.locator('input[type="password"], #credential, input[placeholder*="令牌"]').first();
  await input.fill(TOKEN);
  await page.getByRole('button').filter({ hasText: /登录|进入/ }).first().click().catch(() => page.keyboard.press('Enter'));
  await page.waitForTimeout(2000);
  await shot('登录后');
} else {
  console.log('\n（页面没有要求登录 —— 服务端可能配了默认令牌，直接进主界面）');
}

// ---------------- ③ 主界面：余额 + 任务列表 ----------------
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
// 点一次刷新，确保拿到最新列表
await page.getByRole('button', { name: '刷新' }).first().click({ timeout: 4000 }).catch(() => {});
await page.waitForTimeout(1500);
const mainText = await shot('主界面');

const balMatch = mainText.match(/积分\s*(\d+)/);
console.log(`   解析到的余额: ${balMatch ? balMatch[1] : '(没显示)'}`);

// ---------------- ④ 填表单 ----------------
const promptBox = page.locator('#prompt, textarea').first();
await promptBox.fill(PROMPT).catch(() => {});
// 选一个时长（如果有下拉）
const secSel = page.locator('#seconds');
if (await secSel.count()) await secSel.selectOption('10').catch(() => {});
await page.waitForTimeout(500);
await shot('已填表单');

if (!SUBMIT) {
  console.log('\n（未加 --submit，到此为止，没有消耗额度）');
  await browser.close();
  process.exit(0);
}

// ---------------- ⑤ 提交 ----------------
console.log('\n提交生成 …');
await page.getByRole('button', { name: /创建视频任务/ }).first().click();
await page.waitForTimeout(3000);
const afterSubmit = await shot('提交后');

// ---------------- ⑥ 轮询（用页面的「查询」按钮，模拟真实用户操作） ----------------
//
// ⚠️ 判定只看**第一行**（列表是按 id 倒序，第一行就是刚提交的那条）。
// 早期版本直接对整页文字做 /已成功|已失败/ 匹配 —— 结果把列表里**别的历史任务**
// 的角标也算进去了，循环第一次就误判为"已完成"退出，完全没等到真正的结果。
const deadline = Date.now() + WAIT_MIN * 60_000;
let last = afterSubmit;
let round = 0;
while (Date.now() < deadline) {
  round++;
  await page.waitForTimeout(25_000);
  await page.getByRole('button', { name: '查询', exact: true }).first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '刷新' }).first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const row = (await page.locator('#rows tr').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  last = row;
  const elapsed = ((Date.now() - (deadline - WAIT_MIN * 60_000)) / 60000).toFixed(1);
  const done = /已成功/.test(row);
  const failed = /已失败/.test(row);
  console.log(`   [${elapsed}min] #${round} 首行: ${row.slice(0, 110)}`);
  if (done || failed) break;
}

await shot('最终状态');

console.log('\n══════ 走查结论 ══════');
console.log('页面能正常渲染:', mainText.includes('视频任务工作台') ? '✅' : '❌');
console.log('显示了令牌身份:', /dv_/.test(mainText) ? '✅' : '❌');
console.log('显示了余额:', balMatch ? `✅ ${balMatch[1]}` : '❌');
console.log('提交后首行进入处理中/成功/失败:', /处理中|已成功|已失败/.test(last) ? '✅' : '❌');
console.log('最终首行:', last.slice(0, 160));

console.log('\n浏览器 console 报错：');
if (!consoleMsgs.length) console.log('   （无）');
for (const m of [...new Set(consoleMsgs)].slice(0, 15)) console.log('  ', m);

console.log(`\n截图目录：${OUT}`);
await browser.close();
