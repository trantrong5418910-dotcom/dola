/**
 * 提交步骤的分步诊断：每走一步就截一张图，把"卡在哪一步"钉死。
 *
 *   node server/dola/diag-submit.mjs --cookie-file ./Dola_xxx_Cookies.json
 *
 * 为什么需要它：generator.js 失败时只回一句"没拿到 conversationId"，
 * 但那一句对应好几种完全不同的原因（页面没加载完 / 按钮选择器变了 /
 * 号被风控 / 提示词没填进去 / 回车没生效）。不截图就只能靠猜。
 * 这个脚本把每一步的截图 + 可点元素清单都落盘，一眼看出卡点。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCookies, getPlaywright, DOLA_HEADERS, guardLogoutRequests } from './provider.js';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const COOKIE_FILE = flag('cookie-file') || process.env.DOLA_COOKIE_FILE;
const ACCOUNT_ID = Number(flag('account-id')) || null;
const PROMPT = flag('prompt', '一只橘猫在窗台上晒太阳');
const FORCE = flag('force') ? Number(flag('force')) : null;
const OUT = flag('out', '/tmp/dola-diag');
if (!COOKIE_FILE && !ACCOUNT_ID) { console.error('用法：node server/dola/diag-submit.mjs --account-id <id>  或  --cookie-file ./Dola_xxx_Cookies.json'); process.exit(2); }

let ck;
let proxyUrl = null;
if (ACCOUNT_ID) {
  // ⚠️ 必须用命名空间访问 m.db —— `const { db } = await import(...)` 会**丢掉 live binding**，
  //    解构拿到的是导入那一刻的值（null），initDb() 之后也不会更新。这个坑记过一次了。
  const m = await import('../db.js');
  const { proxyUrlOf } = await import('./proxy.js');
  await m.initDb();
  const acc = m.db.prepare('SELECT id,label,cookie,proxy FROM dola_accounts WHERE id=?').get(ACCOUNT_ID);
  if (!acc) { console.error('账号不存在'); process.exit(1); }
  ck = parseCookies(acc.cookie);
  proxyUrl = proxyUrlOf(acc);
  console.log(`账号 #${acc.id} ${acc.label} | 代理：${proxyUrl ? proxyUrl.replace(/\/\/[^@]+@/, '//***@') : '(无，走本机)'}`);
} else {
  ck = parseCookies(fs.readFileSync(COOKIE_FILE, 'utf8'));
}

fs.mkdirSync(OUT, { recursive: true });
const pw = await getPlaywright();
if (!pw?.chromium) { console.error('playwright 未安装'); process.exit(2); }

const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });

// socks5 需要本地桥（Chromium 不支持带认证的 SOCKS5）
let bridge = null;
if (proxyUrl && /^socks5?h?:/i.test(proxyUrl)) {
  const { startSocksBridge } = await import('./socks-bridge.js');
  bridge = await startSocksBridge(proxyUrl);
  console.log(`本地 SOCKS5 桥：${bridge.url}`);
}
const ctx = await browser.newContext({
  viewport: { width: 1560, height: 950 },
  locale: 'zh-CN',
  userAgent: DOLA_HEADERS['user-agent'],
  // 有代理就用（socks5 走本地桥，见上）
  ...(bridge ? { proxy: { server: bridge.url } } : {}),
});

const netLog = [];
ctx.on('response', (r) => {
  const u = r.url();
  if (/\/(chat\/completion|im\/chain|samantha|alice)/.test(u)) {
    netLog.push(`${r.status()} ${u.slice(0, 150)}`);
  }
});

if (FORCE) {
  await ctx.addInitScript((force) => {
    const orig = window.fetch;
    window.fetch = function (input, init = {}) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (String(url).includes('/chat/completion') && init && typeof init.body === 'string') {
          const p = JSON.parse(init.body);
          const ab = p && p.chat_ability;
          if (ab && Number(ab.ability_type) === 17 && typeof ab.ability_param === 'string') {
            const ap = JSON.parse(ab.ability_param);
            window.__CAP = window.__CAP || [];
            window.__CAP.push({ model: ap.model, before: ap.duration, after: force });
            ap.duration = force;
            ab.ability_param = JSON.stringify(ap);
            init = { ...init, body: JSON.stringify(p) };
          }
        }
      } catch { /* 非目标请求 */ }
      return orig.call(this, input, init);
    };
  }, FORCE);
}


await ctx.addCookies(Object.entries(ck).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' })));

// ★ 拦住 dola 前端在限流时「自己登出自己」的请求。
// 实测：提交撞上限流后前端会调 /passport/web/logout/，把会话销毁 ——
// 每失败一次就烧掉一个账号。这里 abort 掉，限流就只是"这次没成功"。
await guardLogoutRequests(ctx);


const page = await ctx.newPage();
let step = 0;
async function shot(label) {
  step++;
  const f = path.join(OUT, `${String(step).padStart(2, '0')}-${label}.png`);
  await page.screenshot({ path: f, fullPage: false }).catch(() => {});
  const url = page.url();
  const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  console.log(`\n── ${step}. ${label} ──`);
  console.log(`   url: ${url}`);
  console.log(`   文本(${text.length}字): ${text.slice(0, 300)}`);
  console.log(`   截图: ${f}`);
  return { url, text };
}

/** 页面里当前可点的按钮 / 可输入的框，用来判断选择器有没有失效 */
async function inventory() {
  const inv = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button,[role="button"],a')]
      .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim())
      .filter((s) => s && s.length < 20);
    const inputs = [...document.querySelectorAll('textarea,input,[contenteditable="true"]')]
      .map((e) => ({ tag: e.tagName, ph: e.getAttribute('placeholder') || '', ce: e.getAttribute('contenteditable') || '' }));
    return { buttons: [...new Set(btns)].slice(0, 60), inputs: inputs.slice(0, 12) };
  });
  console.log('   可点元素:', JSON.stringify(inv.buttons));
  console.log('   输入框:', JSON.stringify(inv.inputs));
  return inv;
}

console.log(`诊断对象：${ACCOUNT_ID ? `账号 #${ACCOUNT_ID}` : path.basename(String(COOKIE_FILE))}，force=${FORCE ?? '否'}`);

await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('  goto 异常:', e.message));
await page.waitForTimeout(11000);
await shot('进入chat');
await inventory();

// 关弹窗（可能不存在）
const dlgOk = await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).then(() => true).catch(() => false);
console.log(`   点「我知道了」: ${dlgOk ? '成功' : '没有这个按钮'}`);
await page.waitForTimeout(800);

// 切视频生成
const vidOk = await page.getByRole('button', { name: '视频生成' }).first().click({ timeout: 6000 }).then(() => true).catch(() => false);
console.log(`   点「视频生成」: ${vidOk ? '成功' : '❌ 没找到'}`);
await page.waitForTimeout(6000);
await shot('切换视频生成后');
await inventory();

// 填提示词
const box = page.locator('textarea, [contenteditable="true"]').first();
const boxCount = await page.locator('textarea, [contenteditable="true"]').count();
console.log(`   输入框数量: ${boxCount}`);
let filled = false;
try {
  await box.click({ timeout: 5000 });
  await box.fill(PROMPT);
  filled = true;
} catch (e) {
  console.log('   fill 失败:', e.message, '→ 退回 keyboard.type');
  try { await page.keyboard.type(PROMPT); filled = true; } catch (e2) { console.log('   type 也失败:', e2.message); }
}
await page.waitForTimeout(1500);
await shot(filled ? '已填提示词' : '填提示词失败');
let boxVal = '(读不到)';
try { boxVal = await box.inputValue(); } catch {
  try { boxVal = await box.innerText(); } catch { /* 都不行 */ }
}
console.log('   输入框实际内容:', JSON.stringify(String(boxVal).slice(0, 120)));

// 回车提交
await page.keyboard.press('Enter');
await page.waitForTimeout(15000);
const after = await shot('回车后15秒');

const convMatch = page.url().match(/\/chat\/(\d{10,})/);
const cap = await page.evaluate(() => window.__CAP || null).catch(() => null);

console.log('\n══════ 结论 ══════');
console.log('conversationId:', convMatch ? convMatch[1] : '❌ 没拿到（页面没跳到会话页）');
console.log('时长 patch 捕获:', JSON.stringify(cap));
console.log('页面里有没有"生成中/排队/额度"字样:', /生成中|排队|额度|消耗|失败/.test(after.text));
console.log('\n网络日志（最近 25 条）:');
for (const l of netLog.slice(-25)) console.log('  ', l);

fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({
  cookieFile: COOKIE_FILE ? path.basename(String(COOKIE_FILE)) : `account:${ACCOUNT_ID}`, force: FORCE, prompt: PROMPT,
  conversationId: convMatch ? convMatch[1] : null, cap, pageText: after.text.slice(0, 3000), netLog,
}, null, 2));
console.log(`\n结果已存 ${OUT}/result.json`);

await browser.close();
await bridge?.close().catch(() => {});
