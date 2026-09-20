import { getPlaywright, checkSession, fetchProfile, missingRequired } from './provider.js';
import { proxyOf } from './proxy.js';
import { requireLoginProxy } from './google-login-proxy.js';
import { isIP } from 'node:net';
import { accountHealth } from './account-observations.js';
import { detectGoogleChallenge } from './google-login-challenge.js';
import { createGoogleLoginCache } from './google-login-cache.js';
import { verifySavedDolaSession } from './google-login-restore.js';
import { dolaCookieMap, matchesGoogleIdentity, isGoogleAuthExchange, authExchangeSucceeded, authSessionMarkers, matchesSessionBinding } from './google-login-core.js';

const DOLA_ORIGIN = 'https://www.dola.com';
const GOOGLE_ORIGIN = 'https://accounts.google.com';
// Official Google OIDC UserInfo endpoint; tokens never appear in URLs or logs.
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const originOf = url => { try { return new URL(url).origin; } catch { return ''; } };
const loginCache = createGoogleLoginCache();

// Deliberate, serial form interaction. No stealth, CAPTCHA bypass or retry loop.
export async function typeGoogleCredentialSlowly(page, input, value) {
  if (originOf(page.url()) !== GOOGLE_ORIGIN) throw new Error('unexpected_origin');
  await input.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(800);
  if (originOf(page.url()) !== GOOGLE_ORIGIN) throw new Error('unexpected_origin');
  await input.click();
  await input.fill('');
  await input.pressSequentially(value, { delay: 140 });
  await page.waitForTimeout(700);
  if (originOf(page.url()) !== GOOGLE_ORIGIN || await input.inputValue() !== value) throw new Error('form_not_ready');
}

export const googleBrowserDriver = {
  async open(input, account, { signal } = {}) {
    const secret = { ...input };
    let browser, context, bridge, closed = false;
    let accessToken = '', identity = null, identityToken = '', booting = true;
    let binding = null, restoredReady = null, restoreBlocked = false;
    let emailEntered = false, passwordEntered = false, rejected = false, manualOnly = false;
    let lastAutomaticAt = 0;
    const proxyUrl = requireLoginProxy(account?.proxy);
    let exitIp = '';
    const close = async () => {
      closed = true; secret.password = ''; accessToken = ''; identity = null; identityToken = ''; binding = null; restoredReady = null;
      await browser?.close().catch(() => {});
      await bridge?.close().catch(() => {});
    };
    signal?.addEventListener('abort', () => { void close(); }, { once: true });
    try {
      if (signal?.aborted) throw new Error('cancelled');
      const pw = await getPlaywright();
      if (!pw?.chromium) throw new Error('browser_missing');
      let proxy = proxyOf(account || {});
      if (!proxy) throw new Error('login_proxy_required');
      if (proxyUrl && /^socks5h?:/i.test(proxyUrl)) {
        const { startSocksBridge } = await import('./socks-bridge.js');
        bridge = await startSocksBridge(proxyUrl);
        proxy = { server: bridge.url };
      }
      if (closed || signal?.aborted) throw new Error('cancelled');
      // Independent context with explicitly authorized cookie-only session storage.
      // No shared user Chrome profile, password manager, stealth or anti-bot bypass.
      const saved = await loginCache.load(secret.email, proxyUrl);
      browser = await pw.chromium.launch({ headless: false, ...(proxy ? { proxy } : {}) });
      if (closed || signal?.aborted) throw new Error('cancelled');
      context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1120, height: 820 },
        ...(saved ? { storageState: { cookies: saved.cookies, origins: [] } } : {}) });
      if (closed || signal?.aborted) throw new Error('cancelled');
      // This request uses the same browser proxy/bridge as Google and Dola.
      // A failed proxy check stops before any account credentials are entered.
      const check = await context.request.get('https://ipinfo.io/json', { timeout: 15000, maxRedirects: 0 });
      const info = check.ok() ? await check.json() : null;
      await check.dispose();
      if (closed || signal?.aborted || !isIP(info?.ip || '')) throw new Error('login_proxy_unavailable');
      exitIp = info.ip;
      browser.on('disconnected', () => { closed = true; secret.password = ''; });
      const watch = page => {
        page.on('framenavigated', frame => {
          if (frame !== page.mainFrame()) return;
          try {
            const url = new URL(frame.url());
            if (url.origin !== DOLA_ORIGIN || url.pathname !== '/auth/callback') return;
            const token = new URLSearchParams(url.hash.slice(1)).get('access_token');
            if (token && token !== accessToken) { accessToken = token; identity = null; binding = null; }
          } catch { /* Never print navigation URLs; OAuth fragments contain credentials. */ }
        });
      };
      context.on('page', watch);
      context.on('response', async response => {
        try {
          const token = accessToken;
          const request = response.request();
          // Bind the returned Dola session to the exact Google token exchange.
          // Unrecognized auth formats fail closed; do not infer from a nickname.
          if (!token || originOf(response.url()) !== DOLA_ORIGIN || request.method() !== 'POST'
              || response.status() !== 200 || !isGoogleAuthExchange(response.url(), request.postData(), token)) return;
          if (!authExchangeSucceeded(await response.json())) return;
          const markers = authSessionMarkers(await response.headersArray());
          if (!closed && token === accessToken && Object.keys(markers).length) binding = { token, markers };
        } catch { /* No raw request/response data is logged. */ }
      });
      const page = await context.newPage();
      // Return the handle immediately; UI can cancel during navigation.
      const boot = async () => {
        try {
          if (saved) {
            // Use what Chromium actually restored (expired cookies are excluded).
            const restoredCookies = await context.cookies();
            const restored = await verifySavedDolaSession({ ...saved, cookies: restoredCookies }, secret.email, account, {
              checkSession, fetchProfile, missingRequired, options: { proxy: proxyUrl, timeout: 15000 },
            });
            if (closed || signal?.aborted) return;
            if (restored.kind === 'reused') {
              secret.password = ''; restoredReady = { ...restored.result, exitIp }; return;
            }
            if (restored.kind === 'blocked') {
              secret.password = ''; restoreBlocked = true; return;
            }
            // Explicitly expired Dola cookies are not login evidence. Retain only
            // the account's authorized Google cookies for the normal OAuth flow.
            await context.clearCookies({ domain: /(^|\.)dola\.com$/ });
          }
          if (closed || signal?.aborted) return;
          await page.goto(`${DOLA_ORIGIN}/chat/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.getByRole('button', { name: /^(登录|Log in|Sign in)$/i }).click({ timeout: 20000 });
          await page.getByRole('button', { name: /Google/i }).click({ timeout: 15000 });
        } catch { /* UI will offer manual control, without exposing URLs or passwords. */ }
        finally { booting = false; }
      };
      void boot();

      return {
        close,
        async preview() {
          const pages = context.pages().filter(p => !p.isClosed());
          const target = pages.find(p => originOf(p.url()) === GOOGLE_ORIGIN) || pages.at(-1);
          if (!target || ![GOOGLE_ORIGIN, DOLA_ORIGIN].includes(originOf(target.url()))) throw new Error('preview_unavailable');
          // Mask form inputs, never capture browser chrome/OAuth address fragments.
          return target.screenshot({ type: 'png', mask: [target.locator('input')], timeout: 5000 });
        },
        async focus() {
          const pages = context.pages().filter(p => !p.isClosed());
          const target = pages.find(p => originOf(p.url()) === GOOGLE_ORIGIN) || pages.at(-1);
          await target?.bringToFront();
        },
        async inspect() {
          if (closed || !browser.isConnected()) return { kind: 'failed' };
          if (booting) return { kind: 'pending' };
          if (restoreBlocked) return { kind: 'waiting_user', reason: 'saved_session' };
          if (restoredReady) return restoredReady;
          if (rejected) return { kind: 'failed' };
          const pages = context.pages().filter(p => !p.isClosed());
          if (!pages.length) return { kind: 'failed' };
          const google = pages.find(p => originOf(p.url()) === GOOGLE_ORIGIN);
          if (google) {
            const body = await google.locator('body').innerText({ timeout: 2000 }).catch(() => '');
            if (/wrong password|couldn.t find your google account|密码错误|找不到您的 Google|密码不正确/i.test(body)) {
              secret.password = ''; rejected = true; return { kind: 'failed' };
            }
            // Latch manual control for this browser once a challenge is observed.
            // Never refill/resubmit credentials when a challenge disappears or is dismissed.
            const challenge = await detectGoogleChallenge(google, body);
            if (challenge) {
              secret.password = ''; manualOnly = true;
              return { kind: 'waiting_user', reason: challenge };
            }
            if (manualOnly) return { kind: 'waiting_user', reason: 'manual_step' };
            const emailInput = google.getByRole('textbox', { name: /^(邮箱或电话号码|Email or phone)$/i });
            if (!emailEntered && await emailInput.isVisible()) {
              if (originOf(google.url()) !== GOOGLE_ORIGIN) return { kind: 'waiting_user' };
              // A submission with an uncertain outcome must never be repeated by polling.
              emailEntered = true;
              await typeGoogleCredentialSlowly(google, emailInput, secret.email);
              // Recheck origin immediately before credential transmission.
              if (originOf(google.url()) !== GOOGLE_ORIGIN) return { kind: 'waiting_user' };
              await google.locator('#identifierNext').click({ timeout: 4000 });
              lastAutomaticAt = Date.now();
              return { kind: 'pending' };
            }
            if (!passwordEntered && secret.password && await google.locator('input[type="password"]').isVisible()) {
              if (originOf(google.url()) !== GOOGLE_ORIGIN) return { kind: 'waiting_user' };
              if (!body.toLowerCase().includes(secret.email.toLowerCase())) {
                secret.password = ''; return { kind: 'waiting_user', reason: 'identity' };
              }
              passwordEntered = true;
              try { await typeGoogleCredentialSlowly(google, google.locator('input[type="password"]'), secret.password); }
              finally { secret.password = ''; }
              if (originOf(google.url()) !== GOOGLE_ORIGIN) return { kind: 'waiting_user' };
              await google.locator('#passwordNext').click({ timeout: 4000 });
              lastAutomaticAt = Date.now();
              return { kind: 'pending' };
            }
            // Never click broad Continue/Accept buttons: they may accept terms or new scopes.
            if (Date.now() - lastAutomaticAt < 10000) return { kind: 'pending' };
            return { kind: 'waiting_user', reason: emailEntered ? 'google_step' : 'email_form' };
          }

          if (!accessToken) return { kind: 'waiting_user', reason: 'callback' };
          const token = accessToken;
          if (!identity || identityToken !== token) {
            const response = await context.request.get(USERINFO, {
              headers: { Authorization: `Bearer ${token}` }, timeout: 15000, maxRedirects: 0,
            });
            const candidate = response.ok() ? await response.json() : null;
            await response.dispose();
            if (closed || token !== accessToken) return { kind: 'pending' };
            if (!matchesGoogleIdentity(candidate, secret.email)) { rejected = true; return { kind: 'failed' }; }
            identity = { sub: candidate.sub, email: candidate.email, email_verified: candidate.email_verified };
            identityToken = token;
          }
          const cookies = dolaCookieMap(await context.cookies(DOLA_ORIGIN));
          if (!binding || binding.token !== token || !matchesSessionBinding(cookies, binding.markers)) return { kind: 'waiting_user', reason: 'binding' };
          if (missingRequired(cookies).length) return { kind: 'pending' };
          const options = { timeout: 15000, proxy: proxyUrl };
          const session = await checkSession(cookies, options);
          const profile = await fetchProfile(cookies, options);
          if (closed || token !== accessToken || binding?.token !== token || !matchesSessionBinding(cookies, binding.markers)) return { kind: 'pending' };
          if (accountHealth(session, profile).kind !== 'valid' || !(profile.entityId || profile.id)) return { kind: 'waiting_user', reason: 'session' };
          let loginStateSaved = false;
          try {
            const savedCookies = await context.cookies();
            if (closed || signal?.aborted || token !== accessToken) return { kind: 'pending' };
            await loginCache.save(secret.email, proxyUrl, { identity, dolaId: String(profile.entityId || profile.id), cookies: savedCookies }, { signal });
            loginStateSaved = true;
          } catch { /* A private-cache failure must not leak credentials or pretend to save state. */ }
          if (closed || signal?.aborted || token !== accessToken) return { kind: 'pending' };
          return { kind: 'ready', identity, cookies, profile, exitIp, loginStateSaved };
        },
      };
    } catch {
      await close();
      throw new Error('google_browser_unavailable');
    }
  },
};
