/**
 * 决定性复现：**直接调用生产的 `prepareNativeVideoComposer`**（不重写逻辑），
 * 用 onPhase 拿到各阶段真实耗时，并在失败瞬间抓 DOM + 截图。
 *
 * 为什么要这样：
 *   前面的取证已经证明——手动点「视频生成」9 秒就能开出 `video-duration: 10s`。
 *   但生产链路要等到预算烧穿。两者差别只可能在"怎么点"和"点的时候页面什么状态"。
 *   所以必须跑生产原函数，并在它抛错的**那一刻**看页面。
 *
 * **只读**：prepareNativeVideoComposer 从不填提示词、不按发送、不建任务。
 *
 * 用法: node repro-preflight.mjs <accountId> [seconds]
 */
const ACCOUNT_ID = Number(process.argv[2]) || 408;
const SECONDS = Number(process.argv[3]) || 10;
const OUT_DIR = '/tmp/composer-dump';
const BASE = 'https://www.dola.com';

const fs = await import('node:fs/promises');
const { parseCookies, DOLA_HEADERS, getPlaywright, toPlaywrightCookies } = await import('../dola/provider.js');
const { proxyOf } = await import('../dola/proxy.js');
const { prepareNativeVideoComposer } = await import('../dola/native-capability.js');
const { observeVideoComposerBootstrap, waitForVideoComposerBootstrap } = await import('../dola/composer-bootstrap.js');
const { DatabaseSync } = await import('node:sqlite');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const db = new DatabaseSync(join(ROOT, 'data', 'admin.db'));
const log = (o) => console.log(JSON.stringify(o));
const t0 = Date.now();
const since = () => Math.round((Date.now() - t0) / 1000);

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
// 与生产 probe 同构
await ctx.route('**/passport/**/logout**', (r) => r.abort());
await ctx.route('**/chat/completion**', (r) => r.abort());
await ctx.route('**/chat/**', (r) => (r.request().method() === 'POST' ? r.abort() : r.continue()));
await ctx.addCookies(toPlaywrightCookies(parseCookies(acc.cookie)));

const page = await ctx.newPage();
observeVideoComposerBootstrap(page);   // ★ 必须在导航前挂载，否则 bootstrap 永远为 false
await page.goto(`${BASE}/chat/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForSelector('textarea, [contenteditable], [role=textbox]', { timeout: 45000 }).catch(() => {});
log({ stage: 'page-ready', sinceSec: since() });

const phases = [];
const onPhase = (p) => phases.push({ phase: p, sinceSec: since() });

// ── 失败瞬间的现场取证
const autopsy = async (label) => {
  const info = await page.evaluate(() => {
    const visible = (el) => el.getClientRects().length > 0;
    const inSidebar = (el) => Boolean(el.closest('aside, nav, [class*="sidebar"], [class*="Sidebar"], #chat-route-aside'));
    const videoEls = [...document.querySelectorAll('button, [role="button"], div, span')]
      .filter((el) => (el.textContent || '').trim() === '视频生成')
      .map((el) => ({ tag: el.tagName, role: el.getAttribute('role'), sidebar: inSidebar(el),
        inGuidance: Boolean(el.closest('#flow-chat-guidance-page')),
        inInputEngine: Boolean(el.closest('#input-engine-container')),
        parentChain: (() => { const c = []; let p = el.parentElement, i = 0;
          while (p && i < 4) { c.push(`${p.tagName}${p.id ? '#' + p.id : ''}${p.getAttribute('data-input-engine-action-source') ? '[' + p.getAttribute('data-input-engine-action-source') + ']' : ''}`); p = p.parentElement; i++; }
          return c; })(),
        rect: el.getBoundingClientRect().toJSON(),
        textLen: (el.textContent || '').trim().length }));
    return {
      url: location.href,
      consentVisible: [...document.querySelectorAll('button, [role="button"], div')]
        .some((el) => visible(el) && (el.textContent || '').trim() === '我知道了'),
      guidancePageExists: Boolean(document.querySelector('#flow-chat-guidance-page')),
      inputEngineExists: Boolean(document.querySelector('#input-engine-container')),
      videoGenMatches: videoEls,
      durationSelectorCount: document.querySelectorAll(
        '[data-input-engine-actionbar-control-key="video-duration"]').length,
      actionbarKeys: [...document.querySelectorAll('[data-input-engine-actionbar-control-key]')]
        .map((el) => el.getAttribute('data-input-engine-actionbar-control-key')),
    };
  }).catch((e) => ({ error: String(e?.message || e).slice(0, 200) }));
  await page.screenshot({ path: join(OUT_DIR, `${ACCOUNT_ID}-F-${label}.png`) }).catch(() => {});
  log({ stage: 'autopsy', label, sinceSec: since(), ...info });
};

await autopsy('before-composer');

// ── 生产原函数
let result = null, error = null;
try {
  result = await prepareNativeVideoComposer(page, {
    seconds: SECONDS, timeout: 120000, log: (m) => log({ stage: 'probe-log', sinceSec: since(), message: m }),
    onPhase,
  });
} catch (e) {
  error = { message: String(e?.message || e).slice(0, 300), code: e?.code ?? null, reason: e?.reason ?? null };
}

log({ stage: 'phases', phases });
log({ stage: 'outcome', ok: Boolean(result), result, error, totalSec: since() });
if (error) await autopsy('after-composer-failure');
else await autopsy('after-composer-success');

await ctx.close().catch(() => {});
process.exit(0);
