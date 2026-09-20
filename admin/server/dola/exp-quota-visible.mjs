/**
 * 关键判定：视频面板在**生成之前**会不会显示剩余额度？
 *
 *   node server/dola/exp-quota-visible.mjs --account-id 111
 *
 * 为什么这个判定重要：
 *   如果生成前就能看到「今日剩余 N 次」→ 存在只读的额度查询路径，可以低成本巡池。
 *   如果只有生成之后才出现      → 那个商业面板的额度列只能是**跟踪推算**出来的，
 *                                 我们也照做即可，不用去猜什么接口。
 *
 * 只加载 + 点面板，**不提交**（提交会触发限流）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { initDb, db } from '../db.js';
import { parseCookies, getPlaywright, DOLA_HEADERS } from './provider.js';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const ACC_ID = Number(flag('account-id', 111));
const OUT = flag('out', '/tmp/dola-quota-visible');
fs.mkdirSync(OUT, { recursive: true });

await initDb();
const acc = db.prepare('SELECT id,label,cookie FROM dola_accounts WHERE id = ?').get(ACC_ID);
if (!acc) { console.error('账号不存在'); process.exit(1); }

const pw = await getPlaywright();
const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 950 }, locale: 'zh-CN', userAgent: DOLA_HEADERS['user-agent'] });
await ctx.addCookies(Object.entries(parseCookies(acc.cookie)).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' })));

const json = [];
ctx.on('response', async (res) => {
  const u = res.url();
  if (!/dola\.com/.test(u)) return;
  const p = new URL(u).pathname;
  // 只留"可能承载额度"的几类接口
  if (!/action_bar|skill\/pack|skill\/recommend|commerce|subscription|slot/i.test(p)) return;
  try {
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    json.push({ path: p, body: JSON.stringify(await res.json()) });
  } catch { /* 忽略 */ }
});

const page = await ctx.newPage();
await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(11000);
await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).catch(() => {});
await page.waitForTimeout(800);

// 关键：确认「视频生成」按钮真的点到了
const btn = page.getByRole('button', { name: '视频生成' }).first();
const clicked = await btn.click({ timeout: 6000 }).then(() => true).catch(() => false);
await page.waitForTimeout(8000);

const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
await page.screenshot({ path: path.join(OUT, 'panel.png') });
await browser.close();

console.log(`账号 #${acc.id} ${acc.label}`);
console.log('「视频生成」按钮点击:', clicked ? '✅ 成功' : '❌ 没点到');
console.log('\n── 面板文字里跟额度/次数相关的片段 ──');
const hits = [...text.matchAll(/.{0,26}(额度|剩余|次数|今日|免费|升级|订阅).{0,44}/g)].map((m) => m[0].trim());
if (hits.length) for (const h of [...new Set(hits)].slice(0, 30)) console.log('  ', h);
else console.log('   （一个都没有 → 生成前查不到额度）');

console.log('\n── 疑似额度接口响应里的数字字段 ──');
let any = false;
for (const r of json) {
  const nums = [...r.body.matchAll(/"([a-z_]*(?:quota|credit|remain|count|limit|times|free)[a-z_]*)"\s*:\s*(\d+)/gi)];
  if (!nums.length) continue;
  any = true;
  console.log(`\n  ${r.path}`);
  for (const n of nums.slice(0, 12)) console.log(`     ${n[1]} = ${n[2]}`);
}
if (!any) console.log('   （没有）');
console.log(`\n截图：${OUT}/panel.png`);
console.log('捕获的候选接口：', [...new Set(json.map((j) => j.path))].join(', ') || '(无)');
