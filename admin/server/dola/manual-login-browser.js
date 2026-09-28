import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const DOLA_HOME = 'https://www.dola.com/chat/';
const DEVTOOLS_TIMEOUT_MS = 15000;
const STDERR_TAIL = 1200;

/**
 * 找一个**真的存在**的 Chrome。
 *
 * 2026-09-29 生产事故：这里原本在 Linux 写死 `/usr/bin/google-chrome`，而服务器上
 * **只装了 Playwright 自带的 chromium**（在 `~/.cache/ms-playwright/chromium-<rev>/chrome-linux64/`），
 * 系统里根本没有 Chrome。于是 `spawn` 直接 ENOENT —— 又因为下面的 stdio 全 `ignore`
 * 加上 `child.once('error', () => {})`，这个错误被完全吞掉，界面只剩一句
 * `manual_browser_unavailable`。运营端看到的「手动登录窗口打不开」，这就是原因之一。
 *
 * `playwright.chromium.executablePath()` 返回的是**已安装的**浏览器路径，
 * 所以它比任何系统路径都可靠，放在候选表的首位。
 */
function chromeExecutable(playwright) {
  const override = typeof process.env.CHROME_PATH === 'string' ? process.env.CHROME_PATH.trim() : '';
  if (override) return override;
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') return process.env.PROGRAMFILES
    ? path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe') : '';
  try {
    const bundled = playwright?.chromium?.executablePath?.();
    if (bundled && existsSync(bundled)) return bundled;
  } catch { /* 探测失败就继续往下退 */ }
  for (const candidate of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(candidate)) return candidate;
  }
  // 全部落空时保留历史默认值：让 spawn 带着这个路径名报 ENOENT，比一个空字符串好诊断。
  return '/usr/bin/google-chrome';
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** 只保留 stderr 的最后一段，并压成一行 —— 错误文案要短，且绝不能带凭据。 */
const stderrDetail = tail => tail.split('\n').map(line => line.trim()).find(Boolean)?.slice(0, 240) || '';

/**
 * 等 DevTools 端口起来。**提前失败优于等到超时**：
 * `diagnose()` 一旦返回非空字符串（子进程已退出 / spawn 已报错）就立刻抛出，
 * 把真正的原因带出去 —— 否则一个「root 下缺 --no-sandbox」也要白等 15 秒。
 */
async function waitForDevTools(port, signal, timeoutMs = DEVTOOLS_TIMEOUT_MS, diagnose = () => '') {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('cancelled');
    const early = diagnose();
    if (early) throw Object.assign(new Error('manual_browser_unavailable'), { detail: early });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const detail = diagnose();
  throw Object.assign(new Error('manual_browser_unavailable'), { cause: lastError, detail: detail || 'DevTools 端口未在超时内就绪' });
}

/**
 * 把出口代理翻译成命令行参数，顺便做 fail-closed 校验。
 *
 * 三种输入，只有第一种是「允许」：
 *   - `undefined` / `null` → **直连**，返回空数组（不加 `--proxy-server=`）。
 *     这是**合法**状态：号池里没有任何可用 IPWeb 模板时，`resolveProxy()` 会显式返回
 *     `DIRECT_LOGIN_PROXY` 哨兵，驱动据此把 proxy 置为 undefined，出口即本机公网 IP。
 *   - 带 `username` / `password` → 拒绝。命令行的 `--proxy-server=` 放不下账号密码
 *     （`user:pass@host` 会被 Chrome **静默忽略**，等于偷偷变成直连）。带凭据的代理
 *     必须先在 `google-login-browser.js` 里过 HTTP 桥，转成 127.0.0.1 无认证地址。
 *   - 形状不对（对象存在但没有 `server`）→ 同样拒绝，绝不静默降级成直连。
 *
 * ⚠️ 2026-09-29 修复：这里原先是 `if (!proxy?.server || proxy.username || proxy.password)`，
 * 第一个条件把「直连」也一起拒了 —— 而直连当天刚被开成**默认兜底**，于是
 * 「直连账号 + 独立窗口手动登录」必定抛 `manual_browser_proxy_unsupported`，窗口永远不出现。
 * 现在与 `cdp-login-browser.js:106` 的守卫保持一致（那边一直是 `if (proxy && ...)`）。
 */
export function proxyArgsFor(proxy) {
  if (proxy === undefined || proxy === null) return [];
  if (proxy.username || proxy.password || !proxy.server) throw new Error('manual_browser_proxy_unsupported');
  return [`--proxy-server=${proxy.server}`];
}

/**
 * Opens a normal, user-visible Chrome process for manual login only.
 *
 * This function deliberately does not use chromium.launch(), Playwright
 * locators, page.fill(), page.click(), stealth flags, or automation markers.
 * Playwright only attaches over CDP so the server can inspect the Dola session
 * after the user finishes the login themselves.
 *
 * 调用方必须先保证 `proxy` **不带凭据**（命令行的 `--proxy-server=` 放不下账号密码，
 * 会被 Chrome 静默忽略）—— 带凭据的代理要在 `google-login-browser.js` 里先过 HTTP 桥。
 */
export async function openManualLoginBrowser({ playwright, proxy, signal, executable = chromeExecutable(playwright), startUrl = DOLA_HOME } = {}) {
  if (!playwright?.chromium?.connectOverCDP || !executable) throw new Error('manual_browser_unavailable');
  // 先校验再建 profile / 占端口：参数不合法时不留任何残留。
  const proxyArgs = proxyArgsFor(proxy);
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dola-manual-login-'));
  await fs.chmod(profileDir, 0o700);
  const port = await freePort();
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    // 以 root 跑 Chrome 必须显式关沙箱，否则 zygote 直接拒绝启动：
    // `Running as root without --no-sandbox is not supported.`（2026-09-29 实测）
    '--no-sandbox',
    // 小内存 / 容器里 /dev/shm 太小会让渲染进程崩掉。
    '--disable-dev-shm-usage',
    // 固定缩放，让「后台页面上的点击坐标」与「页面 viewport 坐标」严格 1:1。
    '--force-device-scale-factor=1',
    '--window-size=1120,860',
    '--lang=zh-CN',
    '--new-window',
    ...proxyArgs,
    startUrl,
  ];
  let child;
  let browser;
  let closing = false;
  let stderrTail = '';
  let exited = '';
  let spawnFailure = '';
  const diagnose = () => spawnFailure || exited;
  // detached: true 让 Chrome 自成**进程组**，收尾时才能用 kill(-pid) 把渲染/GPU
  // 子进程一起带走。只杀主进程是「测试跑完了但 CPU 一直 100%」的经典成因。
  const cleanup = async () => {
    if (closing) return;
    closing = true;
    try { await browser?.close(); } catch { /* disconnecting is already enough */ }
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 整组可能已退出 */ }
      await new Promise(resolve => setTimeout(resolve, 200));
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 同上 */ }
    }
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    // stderr 必须收下来：spawn 的 ENOENT 和 Chrome 自己的启动失败都只在这里说话。
    child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL); });
    child.once('exit', code => { exited = `浏览器进程已退出（code=${code}）：${stderrDetail(stderrTail)}`; });
    const spawned = new Promise(resolve => {
      child.once('spawn', () => resolve(true));
      child.once('error', error => { spawnFailure = `无法启动浏览器（${error?.code || 'spawn failed'}）：${executable}`; resolve(false); });
    });
    child.unref?.();
    if (!await spawned) throw Object.assign(new Error('manual_browser_unavailable'), { detail: diagnose() });
    await waitForDevTools(port, signal, DEVTOOLS_TIMEOUT_MS, diagnose);
    browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error('manual_browser_context_missing');
    return { browser, context, close: cleanup, profileDir };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export { chromeExecutable };
