/**
 * 实测「一次生成」会消耗多少代理流量。
 *
 *   node server/dola/exp-measure-traffic.mjs --account-id 110
 *
 * 为什么要量：IPWeb 按 GB 计费，得先知道一条生成大概多少 MB，
 * 才能算出"充多少 / 能跑多少条"。
 *
 * 统计口径（用 CDP 的 Network.loadingFinished.encodedDataLength，是**压缩后真实字节数**）：
 *   ✔ 计入：打开 dola 页面、切视频生成面板、轮询 /im/chain/single
 *   ✘ 不计入：成片下载（我们**故意不走代理** —— TOS 直链带签名与账号 IP 无关，
 *             视频几十 MB，走住宅代理纯烧钱）
 *
 * 默认**不提交生成**（提交会撞限流），只量"打开页面 + 进面板"这段固定开销；
 * 加 --submit 才会量完整一轮（含提交与轮询）。
 */
import { initDb, db } from '../db.js';
import { parseCookies, getPlaywright, DOLA_HEADERS } from './provider.js';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const ACC_ID = Number(flag('account-id', 110));
const SUBMIT = argv.includes('--submit');

await initDb();
const acc = db.prepare('SELECT id,label,cookie FROM dola_accounts WHERE id = ?').get(ACC_ID);
if (!acc) { console.error('账号不存在'); process.exit(1); }

const pw = await getPlaywright();
const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });

// --profile <dir>：用持久化 context（和 generator 一样），第二次跑就能验证缓存效果
const PROFILE_DIR = flag('profile');
const ctx = PROFILE_DIR
  ? await pw.chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1560, height: 950 }, locale: 'zh-CN', userAgent: DOLA_HEADERS['user-agent'],
  })
  : await browser.newContext({ viewport: { width: 1560, height: 950 }, locale: 'zh-CN', userAgent: DOLA_HEADERS['user-agent'] });
const persistent = Boolean(PROFILE_DIR);
if (persistent) console.log(`（持久化 profile：${PROFILE_DIR}）`);

await ctx.addCookies(Object.entries(parseCookies(acc.cookie)).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' })));

const page = await ctx.newPage();

// --block：和 generator 一样掐掉 image/font/media，用来对比省了多少
if (argv.includes('--block')) {
  const BLOCK = new Set(['image', 'font', 'media']);
  await ctx.route('**/*', (route) => {
    try { if (BLOCK.has(route.request().resourceType())) return route.abort(); } catch { /* 忽略 */ }
    return route.continue();
  });
  console.log('（已开启资源拦截：image / font / media）\n');
}

const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');

/** 持久化模式下 ctx.close() 就等于关浏览器 */
async function closeAll() {
  await ctx?.close().catch(() => {});
  if (!persistent) await browser.close().catch(() => {});
}

const perHost = new Map();
const perType = new Map();
const perUrl = new Map();
const idUrl = new Map();      // requestId → URL
const idType = new Map();
let total = 0;
let reqs = 0;
let blocked = 0;

// ⚠️ 字节数必须在 `loadingFinished` 里取 —— `responseReceived` 那一刻
// `encodedDataLength` 往往还是 -1（响应头刚到、body 没传完），
// 之前按 responseReceived 累加域名流量，结果只统计到 0.4 MB（真实是 12 MB）。
cdp.on('Network.responseReceived', ({ requestId, response, type }) => {
  idUrl.set(requestId, response.url);
  idType.set(requestId, type);
});
cdp.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
  const n = encodedDataLength || 0;
  total += n;
  reqs++;
  const url = idUrl.get(requestId) || '';
  const type = idType.get(requestId) || '?';
  try { const h = new URL(url).hostname; perHost.set(h, (perHost.get(h) || 0) + n); } catch { /* 忽略 */ }
  perType.set(type, (perType.get(type) || 0) + n);
  if (url) perUrl.set(url.split('?')[0], (perUrl.get(url.split('?')[0]) || 0) + n);
  idUrl.delete(requestId);
  idType.delete(requestId);
});
cdp.on('Network.loadingFailed', ({ requestId }) => {
  if (idUrl.has(requestId)) blocked++;
  idUrl.delete(requestId);
});

const MB = (b) => (b / 1048576).toFixed(2);
const mark = (label) => {
  console.log(`  ${label.padEnd(28)} 累计 ${MB(total)} MB（${reqs} 个请求）`);
  return { total, reqs };
};

console.log(`账号 #${acc.id} ${acc.label}　提交=${SUBMIT ? '是' : '否'}\n`);
console.log('—— 分阶段流量 ——');

await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(11000);
const a = mark('① 打开页面');

await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).catch(() => {});
await page.waitForTimeout(600);
await page.getByRole('button', { name: '视频生成' }).first().click({ timeout: 6000 }).catch(() => {});
await page.waitForTimeout(6000);
const b = mark('② 进视频生成面板');

if (SUBMIT) {
  const box = page.locator('textarea, [contenteditable="true"]').first();
  await box.click({ timeout: 5000 }).catch(() => {});
  await box.fill('一只橘猫在窗台上晒太阳').catch(async () => page.keyboard.type('一只橘猫在窗台上晒太阳'));
  await page.waitForTimeout(1200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(16000);
  const c = mark('③ 提交 + 首次响应');
  await closeAll();

  console.log('\n—— 按阶段增量 ——');
  console.log(`  打开页面         ${MB(a.total)} MB`);
  console.log(`  进面板           ${MB(b.total - a.total)} MB`);
  console.log(`  提交+首响应      ${MB(c.total - b.total)} MB`);
  console.log(`  ── 小计         ${MB(c.total)} MB（不含后续轮询）`);
  console.log(`\n  后续轮询按每 30s 一次、约 4 分钟估 ≈ 8 次；`);
  console.log(`  每次 /im/chain/single 的响应通常几十 KB，合计约 0.3~1 MB。`);
  console.log(`  → **一次生成约 ${MB(c.total)} ~ ${MB(c.total + 1048576)} MB 代理流量**`);
} else {
  await closeAll();
  console.log('\n—— 合计 ——');
  console.log(`  打开页面 + 进面板 = ${MB(b.total)} MB（${b.reqs} 个请求）`);
  console.log(`  提交后再加约 1~3 MB（/chat/completion 是流式，会持续吐数据）`);
  console.log(`\n  → 一次生成大致 **${MB(b.total)} ~ ${MB(b.total + 3 * 1048576)} MB 代理流量**`);
  console.log('  （加 --submit 可以量到含提交的准确值；不加是因为提交会撞限流、且要消耗额度）');
}

console.log('\n—— 按资源类型 ——');
for (const [t, bytes] of [...perType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${t.padEnd(16)} ${MB(bytes).padStart(7)} MB   ${((bytes / (total || 1)) * 100).toFixed(0)}%`);
}

console.log('\n—— 单个体积最大的 10 个文件 ——');
for (const [url, bytes] of [...perUrl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${MB(bytes).padStart(7)} MB  ${url.slice(0, 96)}`);
}

console.log('\n—— 流量最大的几个域 ——');
const top = [...perHost.entries()].sort((x, y) => x[1] - y[1] ? y[1] - x[1] : 0).slice(0, 8);
for (const [host, bytes] of top) console.log(`  ${host.padEnd(34)} ${MB(bytes).padStart(7)} MB`);
if (blocked) console.log(`\n（被拦下的请求数：${blocked}）`);
console.log('\n结论：如果大头是 script，那是应用的 JS 包 —— **拦不得**（拦了页面跑不起来）。');
console.log('      省这块只能靠**浏览器 HTTP 缓存**：用持久化 profile，第二次起就不再重下。');
