/**
 * 只用「加载页面」的方式复现前端的全部请求，把带数字的额度字段挖出来。
 *
 *   node server/dola/exp-find-quota.mjs --account-id 110
 *
 * 背景：某商业面板能显示「剩 2/4 额度」，说明**存在可查询的额度数值来源**。
 * 我们自己早先的结论是"免费号查不到额度" —— 可能是没找对地方。
 * 这个脚本不提交、不生成（避免触发限流），只做一次页面加载 + 响应全量落盘，
 * 然后按关键词筛出候选字段。
 */
import fs from 'node:fs';
import path from 'node:path';
import { initDb, db } from '../db.js';
import { parseCookies, getPlaywright, DOLA_HEADERS, guardLogoutRequests } from './provider.js';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const ACC_ID = Number(flag('account-id', 110));
const OUT = flag('out', '/tmp/dola-quota');
fs.mkdirSync(OUT, { recursive: true });

await initDb();
const acc = db.prepare('SELECT id,label,cookie FROM dola_accounts WHERE id = ?').get(ACC_ID);
if (!acc) { console.error('账号不存在'); process.exit(1); }
const ck = parseCookies(acc.cookie);

const pw = await getPlaywright();
const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 950 }, locale: 'zh-CN', userAgent: DOLA_HEADERS['user-agent'] });
await ctx.addCookies(Object.entries(ck).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' })));
await guardLogoutRequests(ctx);

const store = [];
ctx.on('response', async (res) => {
  const u = res.url();
  if (!/dola\.com/.test(u)) return;
  const ct = res.headers()['content-type'] || '';
  if (!ct.includes('json')) return;
  try {
    const json = await res.json();
    store.push({ path: new URL(u).pathname, query: new URL(u).search.slice(0, 200), status: res.status(), json });
  } catch { /* 忽略 */ }
});

const page = await ctx.newPage();
await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(9000);
// 进「视频生成」面板 —— 额度信息通常在这个 skill 的配置里
await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).catch(() => {});
await page.waitForTimeout(600);
await page.getByRole('button', { name: '视频生成' }).first().click({ timeout: 6000 }).catch(() => {});
await page.waitForTimeout(8000);

// 顺便把渲染出来的文字抓一份 —— 前端显示的额度文案是最直接的线索
const pageText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
await browser.close();

fs.writeFileSync(path.join(OUT, 'responses.json'), JSON.stringify(store, null, 2));
console.log(`账号 #${acc.id} ${acc.label}：捕获 ${store.length} 个 JSON 响应 → ${OUT}/responses.json`);

console.log('\n── 页面文字里跟额度相关的片段 ──');
const texts = [...pageText.matchAll(/.{0,30}(额度|生成次数|剩余|quota|credit|次数).{0,40}/gi)].map((m) => m[0].trim());
for (const t of [...new Set(texts)].slice(0, 25)) console.log('  ', t);

console.log('\n── 响应 JSON 里的候选额度字段（值是小整数的数字字段）──');
const KW = /credit|quota|remain|balance|limit|count|left|times|amount|num/i;
const seen = new Set();
function walk(node, p, hits) {
  if (node == null) return;
  if (typeof node === 'string') { try { const j = JSON.parse(node); walk(j, p, hits); } catch { /* 非 JSON 字符串 */ } return; }
  if (typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    const np = p ? `${p}.${k}` : k;
    if (typeof v === 'number' && Number.isInteger(v) && KW.test(k)) hits.push({ field: np, value: v });
    else walk(v, np, hits);
  }
}
for (const r of store) {
  const hits = [];
  walk(r.json, '', hits);
  const uniq = hits.filter((h) => { const key = `${r.path}|${h.field}`; if (seen.has(key)) return false; seen.add(key); return true; });
  if (!uniq.length) continue;
  console.log(`\n  ${r.path}`);
  for (const h of uniq.slice(0, 14)) console.log(`     ${h.field} = ${h.value}`);
}
console.log(`\n完整响应已存 ${OUT}/responses.json（可以自己翻）`);
