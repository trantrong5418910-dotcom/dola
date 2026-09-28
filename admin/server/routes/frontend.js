/**
 * 前台入口：在后台一键打开"前台"。
 *
 * 两种打开方式（系统设置里选）：
 *   tab     —— 前端新标签页直接跳转（最简单，不做任何服务端动作）
 *   browser —— **在后台所在机器上开一个真实浏览器窗口**（Playwright，有头模式）
 *
 * ⚠️ 安全设计（重要，别改成接受任意 URL）：
 *   这个接口会在服务器上**启动浏览器进程**。如果允许传任意 URL，就等于开放了
 *   一个 SSRF / 内网探测入口（可访问云元数据、内网管理页等）。
 *   所以：**只允许打开系统设置里登记过的那个地址**，请求体一律不接受 url 参数。
 *   另外额外校验协议必须是 http/https（挡掉 file:// javascript: 之类）。
 */
import express from 'express';
import { getSetting } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { audit } from '../audit.js';

const router = express.Router();
router.use(requireAuth);

// ---------------- 浏览器实例管理（单例） ----------------

let browser = null;      // Playwright Browser
let currentUrl = null;
let launching = null;    // 防并发重复启动

let _pw = null;
async function loadPlaywright() {
  if (_pw !== null) return _pw;
  for (const name of ['playwright', 'playwright-core']) {
    try { _pw = await import(name); return _pw; } catch { /* 试下一个 */ }
  }
  _pw = false;
  return false;
}

async function playwrightAvailable() {
  const pw = await loadPlaywright();
  return Boolean(pw?.chromium);
}

async function isBrowserAlive() {
  if (!browser) return false;
  try {
    // 浏览器被用户手动关掉后 isConnected() 会变 false
    return browser.isConnected();
  } catch {
    return false;
  }
}

async function openInBrowser(url, { visible = true } = {}) {
  // 复用已开的窗口，避免每次点都新起一个进程
  if (await isBrowserAlive()) {
    const pages = browser.contexts().flatMap((c) => c.pages());
    const page = pages[0] ?? await browser.contexts()[0].newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
    currentUrl = url;
    return { reused: true };
  }

  if (launching) return launching;   // 并发点击只启一次
  launching = (async () => {
    const pw = await loadPlaywright();
    if (!pw?.chromium) {
      throw Object.assign(new Error('服务器上没装 playwright：npm i playwright && npx playwright install chromium'), { status: 400 });
    }
    browser = await pw.chromium.launch({
      headless: !visible,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    browser.on('disconnected', () => { browser = null; currentUrl = null; });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    currentUrl = url;
    return { reused: false };
  })();
  try {
    return await launching;
  } finally {
    launching = null;
  }
}

async function closeBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    currentUrl = null;
    return true;
  }
  return false;
}

// ---------------- 工具 ----------------

/** 只允许 http/https，挡掉 file:// javascript: data: 等 */
function assertSafeUrl(u) {
  let parsed;
  try { parsed = new URL(u); } catch { throw Object.assign(new Error('前台地址不是合法 URL'), { status: 400 }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw Object.assign(new Error(`不支持的协议：${parsed.protocol}（只允许 http/https）`), { status: 400 });
  }
  return parsed.toString();
}

function frontendConfig() {
  return {
    name: getSetting('frontend_name', '前台') || '前台',
    url: getSetting('frontend_url', '') || '',
    mode: getSetting('frontend_open_mode', 'tab') || 'tab',
    browserVisible: getSetting('frontend_browser_visible', 'true') === 'true',
  };
}

// ---------------- 接口 ----------------

/** GET /api/frontend/config —— 前端据此决定按钮显不显示、点了怎么开 */
router.get('/config', requireAuth, async (req, res) => {
  const cfg = frontendConfig();
  res.json({
    ok: true,
    ...cfg,
    configured: Boolean(cfg.url),
    playwright: await playwrightAvailable(),
    browserOpen: await isBrowserAlive(),
  });
});

/** GET /api/frontend/status —— 真实浏览器窗口还开着吗 */
router.get('/status', requireAuth, async (req, res) => {
  res.json({ ok: true, browserOpen: await isBrowserAlive(), url: currentUrl });
});

/**
 * POST /api/frontend/open
 * 不接收任何 URL 参数 —— 只打开系统设置里登记的那个地址（防 SSRF）。
 *
 * ⚠️ 整个函数体包在 try/catch 里是**必须的**：
 * Express 4 不会捕获 async handler 抛出的异常，未捕获的 rejection 会直接
 * 终止 Node 进程。之前把 assertSafeUrl() 写在 try 外面，结果在设置里
 * 填个 `file://` 地址就能把整个后台搞崩（真踩过）。
 */
router.post('/open', requirePerm('frontend:open'), async (req, res) => {
  try {
    const cfg = frontendConfig();
    if (!cfg.url) {
      return res.status(400).json({ ok: false, message: '还没配置前台地址，去「系统设置 → 前台入口」填一个' });
    }
    const url = assertSafeUrl(cfg.url);

    if (cfg.mode !== 'browser') {
      // tab 模式：服务端什么都不做，让前端自己 window.open
      audit(req, 'frontend.open', 'frontend', url, 'tab');
      return res.json({ ok: true, mode: 'tab', name: cfg.name, url });
    }

    const r = await openInBrowser(url, { visible: cfg.browserVisible });
    audit(req, 'frontend.open', 'frontend', url, `browser(${r.reused ? '复用窗口' : '新开窗口'}, ${cfg.browserVisible ? '可见' : '静默'})`);
    res.json({
      ok: true,
      mode: 'browser',
      name: cfg.name,
      url,
      reused: r.reused,
      visible: cfg.browserVisible,
      message: cfg.browserVisible
        ? `已在后台所在机器上打开浏览器窗口（${r.reused ? '复用已有窗口' : '新开窗口'}）`
        : '已在后台静默打开（未显示窗口）',
    });
  } catch (e) {
    console.error('[frontend] open 失败:', e.message);
    res.status(e.status || 500).json({ ok: false, message: e.message });
  }
});

/** POST /api/frontend/close —— 关掉服务器上那个浏览器窗口 */
router.post('/close', requirePerm('frontend:open'), async (req, res) => {
  try {
    const closed = await closeBrowser();
    audit(req, 'frontend.close', 'frontend', currentUrl || '', closed ? '' : '本来就没开');
    res.json({ ok: true, closed });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

export default router;
