/**
 * 只读诊断：复刻 provider.js 的探测流程，把「探测那一刻」的页面状态抓出来。
 * 不做任何写操作：不填提示词、不点发送、不改库、不重新登录。
 * 不打印 cookie 值、不打印代理凭据。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACCOUNT_ID = Number(process.argv[2] || 419);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DOLA_BASE = process.env.DOLA_BASE || 'https://www.dola.com';

function parseCookies(raw) {
  const out = {};
  for (const part of String(raw || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = part.slice(i + 1).trim();
  }
  return out;
}
function parseJsonCookies(raw) {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object') return v;
  } catch { /* fall through */ }
  return parseCookies(raw);
}

const db = new DatabaseSync(join(ROOT, 'server', 'data', 'admin.db'));
const acc = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(ACCOUNT_ID);
if (!acc) { console.log(JSON.stringify({ error: 'account not found', id: ACCOUNT_ID })); process.exit(1); }

const cookies = parseJsonCookies(acc.cookie);
const cookieNames = Object.keys(cookies);
const reserved = cookieNames.filter(n => n.startsWith('__Host-') || n.startsWith('__Secure-'));

// 必须复用生产同一份解析逻辑，否则诊断脚本自己的写法会制造假结论
const { proxyOf, proxyUrlOf, maskProxy } = await import('../dola/proxy.js');
const { observeVideoComposerBootstrap, waitForVideoComposerBootstrap } = await import('../dola/composer-bootstrap.js');
const proxy = proxyOf(acc);
const proxyUrl = proxyUrlOf(acc);
const proxySafe = maskProxy(proxyUrl);

console.log(JSON.stringify({
  stage: 'input',
  account: ACCOUNT_ID,
  cookieCount: cookieNames.length,
  reserved,
  hasProxy: Boolean(proxyUrl),
  proxySafe,
  exitIp: acc.exit_ip || null,
  native15: { state: acc.native_15s_state, at: acc.native_15s_at, note: acc.native_15s_note },
}, null, 2));

const pw = await import('playwright');
if (!pw?.chromium) { console.log(JSON.stringify({ error: 'playwright missing' })); process.exit(1); }

const DOLA_HEADERS = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' };
const launchOptions = {
  headless: true,
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  executablePath: pw.chromium.executablePath(),
};
if (proxyUrl) {
  if (/^socks5h?:/i.test(proxyUrl)) {
    const { startSocksBridge } = await import('../dola/socks-bridge.js');
    const bridge = await startSocksBridge(proxyUrl);
    launchOptions.proxy = { server: bridge.url };
  } else if (proxy?.server) {
    launchOptions.proxy = proxy;
  }
}

const ctxOptions = {
  serviceWorkers: 'block',
  viewport: { width: 1280, height: 900 },
  locale: 'zh-CN',
  userAgent: DOLA_HEADERS['user-agent'],
};
// 默认用生产已预热的 profile（冷 profile 会慢到误判成"页面没打开"）
const profileDir = join(ROOT, 'server', 'data', 'browser-profiles',
  `${ACCOUNT_ID}${process.env.PROFILE_SUFFIX ?? '-snapdiag'}`);
await mkdir(profileDir, { recursive: true });
const ctx = await pw.chromium.launchPersistentContext(profileDir, { ...launchOptions, ...ctxOptions, timeout: 30000 });

function toPlaywrightCookies(map) {
  return Object.entries(map || {})
    .filter(([name, value]) => typeof name === 'string' && name && typeof value === 'string')
    .map(([name, value]) => {
      if (name.startsWith('__Host-')) return { name, value, url: `${DOLA_BASE}/`, secure: true };
      if (name.startsWith('__Secure-')) return { name, value, domain: '.dola.com', path: '/', secure: true };
      return { name, value, domain: '.dola.com', path: '/' };
    });
}

const cookieList = toPlaywrightCookies(cookies);
await ctx.addCookies(cookieList);
const jarNames = (await ctx.cookies()).map(c => c.name);

const page = await ctx.newPage();
await ctx.route('**/chat/completion**', r => r.abort());
await ctx.route('**/chat/**', r => (r.request().method() === 'POST' ? r.abort() : r.continue()));

// 网络与控制台取证：只读监听，不改请求
const netLog = [];
const consoleLog = [];
const isDola = url => { try { const h = new URL(url).hostname; return h === 'dola.com' || h.endsWith('.dola.com'); } catch { return false; } };
page.on('response', (r) => {
  const u = r.url();
  if (!isDola(u)) return;
  try { netLog.push({ m: 'res', status: r.status(), p: new URL(u).pathname.slice(0, 80) }); } catch { /* ignore */ }
});
page.on('requestfailed', (r) => {
  const u = r.url();
  if (!isDola(u)) return;
  try { netLog.push({ m: 'fail', err: String(r.failure()?.errorText || '').slice(0, 40), p: new URL(u).pathname.slice(0, 80) }); } catch { /* ignore */ }
});
page.on('console', (m) => { if (consoleLog.length < 15) consoleLog.push(`${m.type()}: ${String(m.text()).slice(0, 160)}`); });
page.on('pageerror', (e) => { if (consoleLog.length < 20) consoleLog.push(`pageerror: ${String(e.message).slice(0, 160)}`); });

observeVideoComposerBootstrap(page); // 必须在 goto 之前，否则配置响应不计入就绪
let navStatus = null;
let navError = null;
try {
  const resp = await page.goto(`${DOLA_BASE}/chat/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  navStatus = resp?.status?.() ?? null;
} catch (e) { navError = String(e.message).slice(0, 200); }
await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

// 给页面一点时间渲染输入框（探测里是 30s，这里压缩到 25s 便于观察）
let inputCount = 0;
const t0 = Date.now();
try {
  await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 25000 });
} catch { /* 记录当前值即可 */ }
inputCount = await page.evaluate(() => document.querySelectorAll('textarea, [contenteditable="true"]').length).catch(() => -1);

const snapshot = await page.evaluate(() => {
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const has = kw => text.includes(kw);
  return {
    url: location.href,
    title: document.title,
    hostname: location.hostname,
    inputs: document.querySelectorAll('textarea, [contenteditable="true"]').length,
    buttons: document.querySelectorAll('button').length,
    loginMarkers: ['登录', 'Login', '手机号', '验证码', 'Sign in'].filter(has),
    textHead: text.slice(0, 300),
    lang: document.documentElement.lang || null,
    buttonTexts: [...new Set([...document.querySelectorAll('button,[role="button"]')]
      .filter(el => el.getClientRects().length)
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean))].slice(0, 40),
    videoish: [...new Set([...document.querySelectorAll('*')]
      .filter(el => el.getClientRects().length && el.children.length === 0
        && /video|视频|generat|创作|image|图片/i.test(el.textContent || ''))
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim()))].slice(0, 25),
  };
}).catch(e => ({ error: String(e.message).slice(0, 200) }));

// ---- 第二阶段：复刻生产流程，把「时长这一步」的真实 DOM 抓出来 ----
const { prepareNativeVideoComposer, VIDEO_COMPOSER_INPUT_SELECTOR } = await import('../dola/native-capability.js');
const { NATIVE_DURATION_CONTROL_SELECTOR, DURATION_OPTION_SELECTOR, CONCAT_DURATION_LABEL } = await import('../dola/generation-duration.js');

const SECONDS = Number(process.argv[3] || 15);
let phase2Error = null;
try {
  const cap = await prepareNativeVideoComposer(page, { seconds: SECONDS, timeout: 90000 });
  console.log(JSON.stringify({ stage: 'phase2-ok', cap }, null, 2));
} catch (e) {
  phase2Error = { code: e?.code, reason: e?.reason, message: String(e?.message).slice(0, 300) };
}

const dump = await page.evaluate((args) => {
  const [durSel, optSel, concatSrc] = args;
  const concat = new RegExp(concatSrc, 'i');
  const vis = el => el.getClientRects().length > 0;
  const durNodes = [...document.querySelectorAll(durSel)];
  const optNodes = [...document.querySelectorAll(optSel)];
  const texts = nodes => nodes.filter(vis).map(n => (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60));
  // 页面上所有含「秒 / s」的可见文本，用来看真实档位
  const allSecondTexts = [...document.querySelectorAll('*')]
    .filter(el => vis(el) && el.children.length === 0 && /\d+\s*(?:秒|s)\b/i.test(el.textContent || ''))
    .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
    .slice(0, 40);
  return {
    durationControls: durNodes.length,
    durationVisible: durNodes.filter(vis).length,
    durationTexts: texts(durNodes),
    durationHtml: durNodes.filter(vis).map(n => n.outerHTML.slice(0, 400)),
    optionNodes: optNodes.length,
    optionVisible: optNodes.filter(vis).length,
    optionTexts: texts(optNodes),
    optionConcat: texts(optNodes).filter(t => concat.test(t)),
    allSecondTexts: [...new Set(allSecondTexts)],
    inputStillThere: document.querySelectorAll('textarea, [contenteditable="true"]').length,
    urlNow: location.href,
  };
}, [NATIVE_DURATION_CONTROL_SELECTOR, DURATION_OPTION_SELECTOR, CONCAT_DURATION_LABEL.source]).catch(e => ({ error: String(e.message).slice(0, 200) }));

// ---- 第三阶段：重新点开时长菜单，立刻 dump 菜单内容 ----
let menuDump = null;
try {
  const ctrl = page.locator(NATIVE_DURATION_CONTROL_SELECTOR).filter({ visible: true }).first();
  if (await ctrl.count()) {
    await ctrl.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    menuDump = await page.evaluate(() => {
      const vis = el => el.getClientRects().length > 0;
      const containers = [...document.querySelectorAll('[role="menu"],[role="listbox"],[data-slot*="menu"],[data-slot*="popover"],[data-radix-popper-content-wrapper],div')]
        .filter(el => vis(el) && /\d+\s*(?:秒|s)\b/i.test(el.textContent || '') && (el.textContent || '').length < 400);
      const texts = [...new Set(containers.map(el => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)))].slice(0, 12);
      const leaves = [...new Set([...document.querySelectorAll('*')]
        .filter(el => vis(el) && el.children.length === 0 && /\d+\s*(?:秒|s)\b/i.test(el.textContent || ''))
        .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim()))].slice(0, 30);
      const roles = ['option', 'menuitem', 'menuitemradio', 'radio', 'listitem']
        .map(r => ({ role: r, n: document.querySelectorAll(`[role="${r}"]`).length }));
      return { containerTexts: texts, leafTexts: leaves, roles };
    });
  }
} catch (e) { menuDump = { error: String(e.message).slice(0, 200) }; }

const shotPath = `/tmp/snap-${ACCOUNT_ID}.png`;
await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});
console.log(JSON.stringify({ stage: 'phase3-menu', menuDump }, null, 2));
const actionBar = netLog.filter(n => /action_bar|slot/i.test(n.p));
console.log(JSON.stringify({
  stage: 'phase2',
  seconds: SECONDS,
  phase2Error,
  net: {
    total: netLog.length,
    actionBar,
    nonOk: netLog.filter(n => n.m === 'res' && n.status >= 400).slice(0, 15),
    failed: netLog.filter(n => n.m === 'fail').slice(0, 15),
    tail: netLog.slice(-25),
  },
  consoleLog,
  ...dump,
  screenshot: shotPath,
}, null, 2));

console.log(JSON.stringify({
  stage: 'snapshot',
  navStatus,
  navError,
  cookiesAdded: cookieList.length,
  jarCount: jarNames.length,
  jarHasReserved: reserved.filter(n => jarNames.includes(n)),
  waitedMs: Date.now() - t0,
  inputCount,
  ...snapshot,
  screenshot: shotPath,
}, null, 2));

await ctx.close().catch(() => {});
process.exit(0);
