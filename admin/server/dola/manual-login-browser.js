import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const DOLA_HOME = 'https://www.dola.com/chat/';

function chromeExecutable() {
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') return process.env.PROGRAMFILES
    ? path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe') : '';
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

async function waitForDevTools(port, signal, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('cancelled');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Object.assign(new Error('manual_browser_unavailable'), { cause: lastError });
}

/**
 * Opens a normal, user-visible Chrome process for manual login only.
 *
 * This function deliberately does not use chromium.launch(), Playwright
 * locators, page.fill(), page.click(), stealth flags, or automation markers.
 * Playwright only attaches over CDP so the server can inspect the Dola session
 * after the user finishes the login themselves.
 */
export async function openManualLoginBrowser({ playwright, proxy, signal, executable = chromeExecutable(), startUrl = DOLA_HOME } = {}) {
  if (!playwright?.chromium?.connectOverCDP || !executable) throw new Error('manual_browser_unavailable');
  if (!proxy?.server || proxy.username || proxy.password) {
    // Chrome's command line has no safe place for proxy credentials. SOCKS
    // IPWeb accounts are converted to a local unauthenticated bridge before
    // this helper is called; reject other credentialed proxies fail-closed.
    throw new Error('manual_browser_proxy_unsupported');
  }
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dola-manual-login-'));
  await fs.chmod(profileDir, 0o700);
  const port = await freePort();
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--lang=zh-CN',
    '--new-window',
    `--proxy-server=${proxy.server}`,
    startUrl,
  ];
  let child;
  let browser;
  let closing = false;
  const cleanup = async () => {
    if (closing) return;
    closing = true;
    try { await browser?.close(); } catch { /* disconnecting is already enough */ }
    if (child && !child.killed) child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 100));
    if (child && !child.killed) child.kill('SIGKILL');
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'ignore'], detached: false });
    child.once('error', () => {});
    await waitForDevTools(port, signal);
    browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error('manual_browser_context_missing');
    return { browser, context, close: cleanup, profileDir };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

