/**
 * 追「视频生成入口搬到哪了」（**只读**：不填提示词、不发送、不建任务）。
 *
 * 背景：2026-09-25 15:15 实测 /chat/ 页面健康且已登录，但输入框是纯聊天框，
 * 全站找不到 `data-input-engine-actionbar-control-key`，5 个时长选择器全 0 命中，
 * 也没有任何文案为「视频生成」的可见按钮 —— 说明上游改版，入口搬家了。
 *
 * 本脚本做四件事：
 *   ① 扫描所有含「视频」的元素（标签/文案/是否可见/是否在侧栏/所在链接）；
 *   ② 列出侧栏导航项及其 href；
 *   ③ 点「工作」模式，看是否出现创作条；
 *   ④ 打开「AI 创作」，看是否出现创作条。
 *
 * 用法: node dump-video-entry.mjs <accountId> [outDir]
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

const scan = (tag) => page.evaluate(() => {
  const visible = (el) => el.getClientRects().length > 0;
  const inSidebar = (el) => Boolean(el.closest('aside, nav, [class*="sidebar"], [class*="Sidebar"], #chat-route-aside'));
  const videoish = [...document.querySelectorAll('*')]
    .filter((el) => el.children.length === 0 && (el.textContent || '').includes('视频') && visible(el))
    .map((el) => ({ tag: el.tagName, text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
      sidebar: inSidebar(el),
      role: el.getAttribute('role'), href: el.closest('a')?.getAttribute('href') || null })).slice(0, 20);
  const links = [...document.querySelectorAll('a[href]')]
    .filter(visible).map((a) => ({ text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20),
      href: a.getAttribute('href') })).filter((x) => x.text).slice(0, 25);
  const keys = [...document.querySelectorAll('[data-input-engine-actionbar-control-key]')]
    .map((el) => el.getAttribute('data-input-engine-actionbar-control-key'));
  const dur = ['[data-input-engine-actionbar-control-key="video-duration"]', '[aria-label*="时长"]', '[data-testid*="duration"]']
    .map((s) => ({ sel: s, n: document.querySelectorAll(s).length }));
  const modes = [...document.querySelectorAll('button, [role="button"], [role="tab"]')]
    .filter(visible).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t && t.length <= 8).slice(0, 20);
  return { url: location.href, actionbarControlKeys: keys, durationCounts: dur,
    videoish, links, smallButtons: [...new Set(modes)] };
}).catch((e) => ({ error: String(e?.message || e).slice(0, 160) }));

const shot = (n) => page.screenshot({ path: join(OUT_DIR, `${ACCOUNT_ID}-${n}.png`) }).catch(() => {});

await page.goto(`${BASE}/chat/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForSelector('textarea, [contenteditable="true"], [role="textbox"]', { timeout: 45000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 4000));
log({ stage: 'scan-chat', ...(await scan('chat')) });
await shot('A-chat');

// ③ 试「工作」模式
const workClicked = await page.evaluate(() => {
  const visible = (el) => el.getClientRects().length > 0;
  const el = [...document.querySelectorAll('button, [role="button"], [role="tab"]')]
    .filter(visible).find((e) => (e.textContent || '').trim() === '工作');
  if (!el) return false;
  el.click(); return true;
});
await new Promise((r) => setTimeout(r, 8000));
log({ stage: 'after-work-mode', clicked: workClicked, ...(await scan('work')) });
await shot('B-work-mode');

// ④ 打开「AI 创作」
const href = await page.evaluate(() => {
  const visible = (el) => el.getClientRects().length > 0;
  const el = [...document.querySelectorAll('a[href]')].filter(visible)
    .find((a) => (a.textContent || '').includes('AI 创作'));
  if (el) return el.getAttribute('href');
  const div = [...document.querySelectorAll('*')].filter(visible)
    .find((e) => e.children.length === 0 && (e.textContent || '').trim() === 'AI 创作');
  return div ? `(非链接元素 ${div.tagName})` : null;
});
log({ stage: 'ai-create-href', href });
if (href && href.startsWith('/')) {
  await page.goto(`${BASE}${href}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 9000));
  log({ stage: 'scan-ai-create', ...(await scan('ai')) });
  await shot('C-ai-create');
}

await ctx.close().catch(() => {});
process.exit(0);
