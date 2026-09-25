/**
 * 页面取证（**只读**：不填提示词、不按发送、不建任务、不扣积分）。
 *
 * 目的：当"创作条时长控件出不来"时，别再猜是 UI 改了、代理慢、还是预算不够 ——
 * 直接把真实页面和网络回执抓下来看。
 *
 * 与生产 probe 刻意保持同构的部分（否则结论不可比）：
 *   - 同一个持久化 profile 目录 data/browser-profiles/<id>（热缓存）
 *   - 同样的 UA / locale / viewport
 *   - 同样拦住 passport logout 与 chat 提交（避免任何写操作）
 *
 * 抓四件事：
 *   ① 输入框出现耗时（判断冷/热启动）；
 *   ② `get_item_conf`（创作条启动配置）到底有没有回来、回了几条；
 *   ③ 非侧边栏的可见按钮文案，以及每个时长选择器各命中几个；
 *   ④ 点「视频生成」前后各一张截图。
 *
 * 用法: node dump-composer.mjs <accountId> [outDir]
 */
const ACCOUNT_ID = Number(process.argv[2]) || 408;
const OUT_DIR = process.argv[3] || '/tmp/composer-dump';
const TARGET = 'https://www.dola.com/chat/';
const CONFIG_PATH = '/alice/slot/action_bar_v3/get_item_conf';
const DURATION_SELECTORS = [
  '[data-input-engine-actionbar-control-key="video-duration"]',
  '[data-input-engine-actionbar-control-key="duration"]',
  '[data-testid*="duration"]',
  '[aria-label*="时长"]',
  '[aria-label*="Duration"]',
];
const INPUT_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';

const fs = await import('node:fs/promises');
const { parseCookies, DOLA_HEADERS, getPlaywright, toPlaywrightCookies } = await import('../dola/provider.js');
const { proxyOf } = await import('../dola/proxy.js');
const { DatabaseSync } = await import('node:sqlite');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const db = new DatabaseSync(join(ROOT, 'data', 'admin.db'));
const log = (o) => console.log(JSON.stringify(o));

const acc = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(ACCOUNT_ID);
if (!acc) { log({ error: '账号不存在' }); process.exit(1); }
await fs.mkdir(OUT_DIR, { recursive: true });

const pwMod = await getPlaywright();
if (!pwMod?.chromium) { log({ error: 'playwright 不可用' }); process.exit(1); }

const profileDir = join(ROOT, 'data', 'browser-profiles', String(ACCOUNT_ID));
await fs.mkdir(profileDir, { recursive: true });
log({ stage: 'setup', account: ACCOUNT_ID, label: acc.label, profileDir,
  proxy: proxyOf(acc)?.server ? '已配置' : '无' });

const t0 = Date.now();
const ctx = await pwMod.chromium.launchPersistentContext(profileDir, {
  headless: true,
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  serviceWorkers: 'block',
  viewport: { width: 1280, height: 900 },
  locale: 'zh-CN',
  ...(DOLA_HEADERS ? { userAgent: DOLA_HEADERS['user-agent'] } : {}),
  proxy: proxyOf(acc),
});
log({ stage: 'context-launched', elapsedSec: Math.round((Date.now() - t0) / 1000) });

// 与生产同构：拦住会登出/提交的请求
await ctx.route('**/passport/**/logout**', (r) => r.abort());
await ctx.route('**/chat/completion**', (r) => r.abort());
await ctx.route('**/chat/**', (r) => (r.request().method() === 'POST' ? r.abort() : r.continue()));
const cookieList = toPlaywrightCookies(parseCookies(acc.cookie));
if (!cookieList.length) { log({ error: '账号没有可用 cookie' }); await ctx.close().catch(() => {}); process.exit(1); }
await ctx.addCookies(cookieList);

const page = await ctx.newPage();

// 网络回执取证
const configs = [];
const failed = [];
const transfers = [];
page.on('response', async (res) => {
  try {
    const u = new URL(res.url());
    if (res.request().resourceType() === 'document' || res.request().resourceType() === 'script') {
      transfers.push({ type: res.request().resourceType(), len: Number(res.headers()['content-length'] || 0) });
    }
    if (u.pathname === CONFIG_PATH) {
      let items = null, code = null;
      try { const b = await res.json(); code = b?.code ?? null; items = Object.keys(b?.data?.item_list || {}).length; } catch { /* 非 JSON 不算就绪 */ }
      configs.push({ status: res.status(), code, itemCount: items });
    }
  } catch { /* 取证失败不影响流程 */ }
});
page.on('requestfailed', (req) => failed.push({ url: req.url().slice(0, 120), err: req.failure()?.errorText }));

const tNav = Date.now();
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
  log({ stage: 'nav-failed', message: String(e?.message || e).slice(0, 200) });
});
log({ stage: 'navigated', elapsedSec: Math.round((Date.now() - tNav) / 1000) });

let inputAppeared = false;
try {
  await page.waitForSelector(INPUT_SELECTOR, { timeout: 45000 });
  inputAppeared = true;
} catch { inputAppeared = false; }
log({ stage: 'input', appeared: inputAppeared, elapsedSec: Math.round((Date.now() - tNav) / 1000),
  totalElapsedSec: Math.round((Date.now() - t0) / 1000) });

const dumpDom = async (tag) => {
  const info = await page.evaluate(({ sels, inputSel }) => {
    const visible = (el) => el.getClientRects().length > 0;
    const inSidebar = (el) => Boolean(el.closest('aside, nav, [class*="sidebar"], [class*="Sidebar"], #chat-route-aside'));
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter((el) => visible(el) && !inSidebar(el))
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const selCounts = {};
    for (const s of sels) selCounts[s] = { all: document.querySelectorAll(s).length,
      visible: [...document.querySelectorAll(s)].filter(visible).length };
    return {
      title: document.title,
      inputCount: document.querySelectorAll(inputSel).length,
      inputVisible: [...document.querySelectorAll(inputSel)].some(visible),
      actionbarControlKeys: [...document.querySelectorAll('[data-input-engine-actionbar-control-key]')]
        .map((el) => el.getAttribute('data-input-engine-actionbar-control-key')),
      selCounts,
      buttons: [...new Set(buttons)].slice(0, 25),
      bodyTextSample: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
    };
  }, { sels: DURATION_SELECTORS, inputSel: INPUT_SELECTOR }).catch((e) => ({ error: String(e?.message || e).slice(0, 160) }));
  await page.screenshot({ path: join(OUT_DIR, `${ACCOUNT_ID}-${tag}.png`), fullPage: false }).catch(() => {});
  log({ stage: 'dom', tag, ...info });
};

await dumpDom('1-before-click');

// 找一个非侧边栏、可见、文案恰好是「视频生成」的元素并点击
const clicked = await page.evaluate(() => {
  const visible = (el) => el.getClientRects().length > 0;
  const inSidebar = (el) => Boolean(el.closest('aside, nav, [class*="sidebar"], [class*="Sidebar"], #chat-route-aside'));
  const cand = [...document.querySelectorAll('button, [role="button"], [data-guidance-input-sug-anchor] *')]
    .filter((el) => visible(el) && !inSidebar(el) && (el.textContent || '').trim() === '视频生成');
  if (!cand.length) return { found: 0 };
  cand[0].click();
  return { found: cand.length, tag: cand[0].tagName };
});
log({ stage: 'click-video-entry', ...clicked });

await new Promise((r) => setTimeout(r, 20000));
await dumpDom('2-after-click');

log({ stage: 'network', configsSeen: configs.length, configs,
  failedCount: failed.length, failedSample: failed.slice(0, 8),
  docAndScriptCount: transfers.length,
  docAndScriptBytes: transfers.reduce((s, t) => s + t.len, 0) });

await ctx.close().catch(() => {});
process.exit(0);
