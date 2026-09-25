/**
 * 判别：新版「AI 创作」页（/chat/create-image）切到「视频」tab 后，
 * 时长控件到底出不出来（**只读**：不填提示词、不发送、不建任务）。
 *
 * 为什么这一步是决定性的：
 *   /chat/ 上点「视频生成」快速入口之后，页面很可能切到 /chat/create-image 的「视频」tab。
 *   旧代码只在 /chat/ 原地等 `[data-input-engine-actionbar-control-key="video-duration"]`，
 *   若入口已经改成"先跳页、再切 tab"，旧代码就会一直等到超时 ——
 *   这正好解释了 100 秒烧穿预算、phase 停在 entry。
 *
 * 用法: node dump-video-tab.mjs <accountId> [outDir]
 */
const ACCOUNT_ID = Number(process.argv[2]) || 408;
const OUT_DIR = process.argv[3] || '/tmp/composer-dump';
const BASE = 'https://www.dola.com';

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

const pw = await getPlaywright();
const profileDir = join(ROOT, 'data', 'browser-profiles', String(ACCOUNT_ID));
await fs.mkdir(profileDir, { recursive: true });

const ctx = await pw.chromium.launchPersistentContext(profileDir, {
  headless: true,
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  serviceWorkers: 'block',
  viewport: { width: 1280, height: 900 },
  locale: 'zh-CN',
  userAgent: DOLA_HEADERS['user-agent'],
  proxy: proxyOf(acc),
});
await ctx.route('**/passport/**/logout**', (r) => r.abort());
await ctx.route('**/chat/completion**', (r) => r.abort());
await ctx.route('**/chat/**', (r) => (r.request().method() === 'POST' ? r.abort() : r.continue()));
await ctx.addCookies(toPlaywrightCookies(parseCookies(acc.cookie)));
const page = await ctx.newPage();

const inspect = (tag) => page.evaluate(() => {
  const visible = (el) => el.getClientRects().length > 0;
  const ctrl = [...document.querySelectorAll('[data-input-engine-actionbar-control-key]')];
  const durationEls = [...document.querySelectorAll(
    '[data-input-engine-actionbar-control-key="video-duration"], [data-input-engine-actionbar-control-key="duration"], [data-testid*="duration"], [aria-label*="时长"]')];
  return {
    url: location.href,
    actionbarControls: ctrl.map((el) => ({
      key: el.getAttribute('data-input-engine-actionbar-control-key'),
      visible: visible(el),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    })),
    durationMatches: durationEls.length,
    durationVisible: durationEls.filter(visible).length,
    durationSample: durationEls.slice(0, 3).map((el) => ({
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      aria: el.getAttribute('aria-label'), testid: el.getAttribute('data-testid'),
    })),
    tabs: [...document.querySelectorAll('[role="tab"], button')].filter(visible)
      .map((el) => ({ t: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 12),
        role: el.getAttribute('role'), sel: el.getAttribute('aria-selected') }))
      .filter((x) => x.t && x.t.length <= 6).slice(0, 24),
    bodySample: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
  };
}).catch((e) => ({ error: String(e?.message || e).slice(0, 180) }));

const shot = (n) => page.screenshot({ path: join(OUT_DIR, `${ACCOUNT_ID}-${n}.png`), fullPage: false }).catch(() => {});

// ① 从 /chat/ 点「视频生成」快速入口，看它跳到哪
// CSS 属性选择器对简单标识符不需要引号；把选择器抽成常量，顺带躲开引号嵌套
const INPUT_SELECTOR = 'textarea, [contenteditable], [role=textbox]';

await page.goto(`${BASE}/chat/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForSelector(INPUT_SELECTOR, { timeout: 45000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 6000)); // 关键：快速入口行渲染得比输入框晚

const clickedChip = await page.evaluate(() => {
  const visible = (el) => el.getClientRects().length > 0;
  const inSidebar = (el) => Boolean(el.closest('aside, nav, [class*="sidebar"], [class*="Sidebar"], #chat-route-aside'));
  const cand = [...document.querySelectorAll('button, [role="button"], div, span')]
    .filter((el) => visible(el) && !inSidebar(el) && (el.textContent || '').trim() === '视频生成');
  if (!cand.length) return { found: 0 };
  // 取最内层（叶子）那个，避免点到外层容器
  const leaf = cand[cand.length - 1];
  leaf.click();
  return { found: cand.length, tag: leaf.tagName };
});
log({ stage: 'clicked-video-chip', ...clickedChip });
await new Promise((r) => setTimeout(r, 9000));
log({ stage: 'after-video-chip', ...(await inspect('after-chip')) });
await shot('D-after-video-chip');

// ② 直接打开「AI 创作」页并切到「视频」tab
await page.goto(`${BASE}/chat/create-image`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 7000));
log({ stage: 'create-image-default', ...(await inspect('default')) });

const tabClicked = await page.evaluate(() => {
  const visible = (el) => el.getClientRects().length > 0;
  const el = [...document.querySelectorAll('[role="tab"], button, div, span')]
    .filter((el) => visible(el) && (el.textContent || '').trim() === '视频')[0];
  if (!el) return false;
  el.click(); return true;
});
log({ stage: 'clicked-video-tab', clicked: tabClicked });
await new Promise((r) => setTimeout(r, 12000));
log({ stage: 'create-image-video-tab', ...(await inspect('video-tab')) });
await shot('E-create-image-video-tab');

await ctx.close().catch(() => {});
process.exit(0);
