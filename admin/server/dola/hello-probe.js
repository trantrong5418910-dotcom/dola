import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOLA_BASE, DOLA_HEADERS, getPlaywright, toPlaywrightCookies } from './provider.js';
import { startSocksBridge } from './socks-bridge.js';
import { tryAcquireAccountBrowserLock } from './account-browser-lock.js';

const INPUT_SELECTOR = 'textarea, [contenteditable="true"]';
const SEND_SELECTOR = '#flow-end-msg-send';
const PROFILE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'browser-profiles');
const DOLA_ORIGIN = new URL(DOLA_BASE).origin;

function bodyHasModePayload(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024 * 1024) return true;
  let value;
  try { value = JSON.parse(raw); } catch { return true; }
  let visited = 0;
  const visit = (item, depth = 0) => {
    if (++visited > 4096 || depth > 10) return true;
    if (typeof item === 'string') {
      const text = item.trim();
      if (text.startsWith('{') || text.startsWith('[')) {
        try { return visit(JSON.parse(text), depth + 1); } catch { return false; }
      }
      return false;
    }
    if (!item || typeof item !== 'object') return false;
    for (const [key, child] of Object.entries(item)) {
      if (/ability|video|image.?mode|generation.?mode/i.test(key)) return true;
      if (visit(child, depth + 1)) return true;
    }
    return false;
  };
  return visit(value);
}

function chatPath(url) {
  if (url.pathname === '/chat/completion') return true;
  return /^\/chat\/local_[A-Za-z0-9_-]+$/.test(url.pathname);
}

function isKnownChatTelemetry(raw) {
  try {
    const body = JSON.parse(raw);
    return body?.ev_type === 'batch' && Array.isArray(body.list);
  } catch { return false; }
}

function bodyHasHelloText(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024 * 1024) return false;
  let root;
  try { root = JSON.parse(raw); } catch { return false; }
  let visited = 0;
  const visit = (item, depth = 0) => {
    if (++visited > 4096 || depth > 10 || item == null) return false;
    if (typeof item === 'string') {
      if (item.trim() === '你好') return true;
      if (item.startsWith('{') || item.startsWith('[')) {
        try { return visit(JSON.parse(item), depth + 1); } catch { return false; }
      }
      return false;
    }
    if (typeof item !== 'object') return false;
    return Object.values(item).some(child => visit(child, depth + 1));
  };
  return visit(root);
}

/**
 * Explicit, one-shot text-chat probe. It uses the normal Dola chat page and
 * sends exactly “你好”. Video/image-mode requests and repeated sends are
 * blocked before they leave the account browser.
 */
export async function sendHelloProbeViaBrowser(cookies, {
  accountId,
  proxy = null,
  proxyUrl = null,
  timeout = 75_000,
} = {}) {
  const pw = await getPlaywright();
  if (!pw?.chromium) return { state: 'unknown', message: 'Playwright 不可用，未发送' };
  if (!proxyUrl) return { state: 'unknown', message: '账号没有已配置的代理，未发送' };
  const cookieList = toPlaywrightCookies(cookies);
  if (!cookieList.length) return { state: 'unavailable', message: '账号没有可用 Cookie，未发送' };

  const launchOptions = {
    executablePath: pw.chromium.executablePath(),
    headless: true,
    timeout: Math.min(timeout, 30_000),
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  };
  let bridge = null;
  let context = null;
  let browser = null;
  const releaseAccountBrowserLock = tryAcquireAccountBrowserLock(accountId);
  if (!releaseAccountBrowserLock) return { state: 'unknown', message: '该账号浏览器正忙，未发送' };
  let armed = false;
  let blockedReason = '';
  let localMessageRequests = 0;
  let completionRequests = 0;
  let page = null;
  const responses = [];
  const failedRequests = [];

  try {
    if (/^socks5h?:/i.test(proxyUrl)) {
      bridge = await startSocksBridge(proxyUrl);
      launchOptions.proxy = { server: bridge.url };
    } else if (proxy?.server) {
      launchOptions.proxy = proxy;
    } else {
      return { state: 'unknown', message: '账号代理无法用于浏览器，未发送' };
    }

    const contextOptions = {
      serviceWorkers: 'block',
      viewport: { width: 1280, height: 900 },
      locale: 'zh-CN',
      userAgent: DOLA_HEADERS['user-agent'],
    };
    if (accountId) {
      const profileDir = join(PROFILE_ROOT, String(accountId));
      const { mkdir } = await import('node:fs/promises');
      await mkdir(profileDir, { recursive: true });
      const launchPersistent = () => pw.chromium.launchPersistentContext(profileDir, {
        ...launchOptions, ...contextOptions,
      });
      context = await launchPersistent();
    } else {
      browser = await pw.chromium.launch(launchOptions);
      context = await browser.newContext(contextOptions);
    }

    await context.route('**/passport/**/logout**', route => route.abort());
    await context.route('**/chat/**', async route => {
      const request = route.request();
      if (request.method() !== 'POST') return route.continue();
      let url;
      try { url = new URL(request.url()); } catch {
        blockedReason = '聊天请求地址异常，已拦截';
        return route.abort();
      }
      if (url.origin !== DOLA_ORIGIN) {
        blockedReason = '检测到跨站聊天写请求，已拦截';
        return route.abort();
      }
      if (url.pathname === '/chat/') {
        if (isKnownChatTelemetry(request.postData() || '')) return route.continue();
        blockedReason = '检测到非预期的 /chat/ 写请求，已拦截';
        return route.abort();
      }
      if (url.pathname === '/chat/create-image') {
        blockedReason = '检测到图片生成请求，已拦截';
        return route.abort();
      }
      if (!armed) {
        if (url.pathname === '/chat/completion' || /^\/chat\/local_/.test(url.pathname)) {
          blockedReason = '发送前出现聊天提交请求，已拦截';
          return route.abort();
        }
        blockedReason = '发送前出现非预期聊天写请求，已拦截';
        return route.abort();
      }
      if (!chatPath(url)) {
        blockedReason = '请求路径不属于普通文本聊天，已拦截';
        return route.abort();
      }
      if (bodyHasModePayload(request.postData() || '')) {
        blockedReason = '请求包含模式/生成参数，已拦截以避免提交生成任务';
        return route.abort();
      }
      if (url.pathname === '/chat/completion' && !bodyHasHelloText(request.postData() || '')) {
        blockedReason = '普通聊天请求中未确认探测文本为“你好”，已拦截';
        return route.abort();
      }
      if (url.pathname.startsWith('/chat/local_')) {
        if (++localMessageRequests > 1) {
          blockedReason = '检测到重复发送，已拦截后续请求';
          return route.abort();
        }
      } else if (++completionRequests > 1) {
        blockedReason = '检测到重复聊天提交，已拦截后续请求';
        return route.abort();
      }
      return route.continue();
    });

    if (cookieList.length) await context.addCookies(cookieList);
    page = await context.newPage();
    page.on('response', async response => {
      if (response.request().method() !== 'POST') return;
      let url;
      try { url = new URL(response.url()); } catch { return; }
      if (url.origin !== DOLA_ORIGIN || !chatPath(url)) return;
      const body = await response.text().catch(() => '');
      responses.push({
        path: url.pathname,
        status: response.status(),
        expired: /710012001|710012014/.test(body),
        upstreamError: /STREAM_ERROR|"error_code"\s*:\s*[1-9]\d*/i.test(body),
        rateLimited: /710022002/.test(body),
      });
    });
    page.on('requestfailed', request => {
      if (request.method() !== 'POST') return;
      let url;
      try { url = new URL(request.url()); } catch { return; }
      if (url.origin === DOLA_ORIGIN && chatPath(url)) failedRequests.push(request.failure()?.errorText || '聊天请求失败');
    });

    await page.goto(`${DOLA_BASE.replace(/\/$/, '')}/chat/`, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 45_000) });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    if (blockedReason) return { state: 'unknown', message: `${blockedReason}，未发送探测消息` };
    const input = page.locator(INPUT_SELECTOR).filter({ visible: true });
    const inputCount = await input.count();
    if (inputCount !== 1) {
      const pathname = new URL(page.url()).pathname;
      return {
        state: /^\/(?:login|passport)(?:\/|$)/.test(pathname) ? 'unavailable' : 'unknown',
        message: /^\/(?:login|passport)(?:\/|$)/.test(pathname)
          ? '跳转到登录页，账号登录态不可用'
          : '未找到唯一普通聊天输入框，未发送',
      };
    }
    const placeholder = await input.first().getAttribute('placeholder').catch(() => '') || '';
    if (/视频|图像|图片生成|生成视频/i.test(placeholder)) {
      return { state: 'unknown', message: '页面当前不是普通聊天输入框，未发送' };
    }
    const videoModeSelected = await page.evaluate(() => [...document.querySelectorAll('button,[role="button"]')]
      .filter(el => /视频生成/.test(el.innerText || ''))
      .some(el => el.getAttribute('aria-pressed') === 'true'
        || el.getAttribute('aria-selected') === 'true'
        || el.getAttribute('data-state') === 'active'
        || /(?:^|\s)(?:active|selected|is-active)(?:\s|$)/i.test(String(el.className || ''))));
    if (videoModeSelected) return { state: 'unknown', message: '页面处于视频生成模式，未发送' };

    await input.first().fill('你好', { timeout: 10_000 });
    const typed = await input.first().inputValue().catch(() => input.first().innerText());
    if (String(typed).trim() !== '你好') return { state: 'unknown', message: '未能确认探测文本已完整填写，未发送' };
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const send = page.locator(SEND_SELECTOR).filter({ visible: true });
    if (await send.count() !== 1 || !await send.isEnabled()) {
      return { state: 'unknown', message: '普通聊天发送按钮未就绪，未发送' };
    }

    armed = true;
    await send.click({ timeout: 10_000 }).catch(() => {
      throw new Error('发送结果不确定；为避免重复消息，不会自动重试');
    });
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (blockedReason) return { state: 'unknown', message: blockedReason };
      if (responses.some(item => item.expired)) return { state: 'unavailable', message: '上游明确返回登录会话失效' };
      if (responses.some(item => item.status === 401 || item.status === 403)) {
        return { state: 'unavailable', message: '上游拒绝账号会话（HTTP 401/403）' };
      }
      if (responses.some(item => item.rateLimited)) return { state: 'unknown', message: '上游聊天限流（710022002），不判定账号失效' };
      const completionResponse = responses.find(item => item.path === '/chat/completion');
      if (completionResponse?.upstreamError) return { state: 'unknown', message: '上游未确认普通聊天回复，不判定账号失效' };
      if (completionResponse && completionResponse.status >= 200 && completionResponse.status < 300) {
        return { state: 'available', message: '已发送“你好”，普通聊天接口已接受请求' };
      }
      if (failedRequests.length) break;
      await page.waitForTimeout(200);
    }
    return {
      state: 'unknown',
      message: blockedReason || (failedRequests[0]
        ? `聊天请求未完成：${failedRequests[0]}`
        : (responses.some(item => item.path.startsWith('/chat/local_') && item.status >= 200 && item.status < 300)
          ? '“你好”已写入会话，但未确认普通聊天回复；不自动重试'
          : '发送后没有收到确定回执；不自动重试')),
    };
  } catch (error) {
    return { state: 'unknown', message: String(error?.message || error).replace(/\s+/g, ' ').slice(0, 240) };
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await bridge?.close().catch(() => {});
    releaseAccountBrowserLock();
  }
}
