/**
 * 分步实验：到底哪一步会把 dola 会话搞死？
 *
 *   node server/dola/exp-kill-step.mjs --account-id 113
 *
 * 背景：观测到账号在「校验说活」到「生成提交失败」之间只隔 15 秒。
 * 已排除：cookie 落库往返（29/29 键值一致）、探测接口判错（HTTP 与浏览器同秒一致）。
 * 剩下要区分的是这三个动作里哪一个触发了注销：
 *   ① 单次 HTTP 探测本身
 *   ② 开浏览器加载页面
 *   ③ 在页面里填提示词 + 回车（真实提交）
 *
 * 每步之间**只查一次** self_brief，不重复打接口（否则样本被自己的探测污染）。
 */
import { initDb, db } from '../db.js';
import { parseCookies, fetchProfile, dolaFetch, getPlaywright, DOLA_HEADERS } from './provider.js';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const ACC_ID = Number(flag('account-id'));
const FULL_SUBMIT = !argv.includes('--no-submit');
if (!ACC_ID) { console.error('用法：node server/dola/exp-kill-step.mjs --account-id <id>'); process.exit(2); }

await initDb();
const acc = db.prepare('SELECT id,label,cookie FROM dola_accounts WHERE id = ?').get(ACC_ID);
if (!acc) { console.error('账号不存在'); process.exit(1); }
const ck = parseCookies(acc.cookie);

/** 只查一次，返回可读结论 */
async function probe(tag) {
  const p = await fetchProfile(ck, { timeout: 15000 });
  const l = await dolaFetch('/alice/user/launch', { cookies: ck, body: { select: { user_info: true } } });
  const il = (JSON.stringify(l.json || {}).match(/"is_login"\s*:\s*"?(\d)/) || [])[1];
  const ok = p.ok;
  console.log(`  ${ok ? '✅' : '❌'} ${tag.padEnd(34)} self_brief ${ok ? 'ok' : 'code=' + p.code}  is_login=${il}`);
  return ok;
}

async function withBrowser(fn) {
  const pw = await getPlaywright();
  const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1560, height: 950 }, locale: 'zh-CN', userAgent: DOLA_HEADERS['user-agent'] });
    await ctx.addCookies(Object.entries(ck).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' })));
    return await fn(ctx);
  } finally {
    await browser.close().catch(() => {});
  }
}

console.log(`实验对象：#${acc.id} ${acc.label}\n`);

console.log('阶段 0 — 基线');
const alive0 = await probe('实验开始时');
if (!alive0) { console.log('\n起点就是死的，换一个号再跑。'); process.exit(1); }

console.log('\n阶段 1 — 只开浏览器加载 /chat/（不提交）');
await withBrowser(async (ctx) => {
  const page = await ctx.newPage();
  await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(12000);
  const t = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  console.log('  页面显示登录框:', /登录以解锁|使用豆包或飞书账号登录/.test(t) ? '❌ 是' : '✅ 否');
});
const alive1 = await probe('加载页面之后');

console.log('\n阶段 2 — 在页面里填提示词 + 回车（真实提交）');
await withBrowser(async (ctx) => {
  const page = await ctx.newPage();
  await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(11000);
  await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '视频生成' }).first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const box = page.locator('textarea, [contenteditable="true"]').first();
  await box.click({ timeout: 5000 }).catch(() => {});
  await box.fill('一只橘猫在窗台上晒太阳').catch(async () => page.keyboard.type('一只橘猫在窗台上晒太阳'));
  await page.waitForTimeout(1200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(15000);
  console.log('  提交后 URL:', page.url());
  const m = page.url().match(/\/chat\/(\d{10,})/);
  console.log('  conversationId:', m ? m[1] : '❌ 没拿到');
});
const alive2 = await probe('提交之后');

console.log('\n══════ 结论 ══════');
console.log(`  基线           ${alive0 ? '活' : '死'}`);
console.log(`  开浏览器之后   ${alive1 ? '活' : '死'}   ${!alive1 ? '← 这一步把它搞死了' : ''}`);
console.log(`  提交之后       ${alive2 ? '活' : '死'}   ${alive1 && !alive2 ? '← 这一步把它搞死了' : ''}`);
if (alive0 && alive1 && alive2) console.log('  三步都没搞死它 —— 说明失效来自外部（别处登录 / 风控周期），不是我们的动作。');
