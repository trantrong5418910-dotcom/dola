import { DOLA_ORIGIN, GOOGLE_ORIGIN, originOf } from './google-login-form.js';

export const DOLA_LOGIN_LABEL = /^(登录|登入|Log in|Sign in)$/i;
// Observed on the zh-CN public login dialog on 2026-09-21: “Google 登录”.
export const DOLA_GOOGLE_LOGIN_LABEL = /^(Google|Google\s*登录|Google\s*登入|Continue with Google|Sign in with Google|使用\s*Google\s*登录|通过\s*Google\s*登录)$/i;
const fail = code => { throw Object.assign(new Error('Dola login entry unavailable'), { code }); };

/** Public entry only. Never types credentials, accepts CAPTCHA/consent, reloads
 * a page or retries a click. DOMContentLoaded is not proof of React readiness.
 */
export async function openDolaGoogleLogin(page, {
  context = page.context(), signal, onStage = () => {}, now = Date.now,
  sleep = ms => page.waitForTimeout(ms), timeoutMs = 120_000, hasCallback = () => false,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) fail('ENTRY_OPTIONS');
  const deadline = now() + timeoutMs;
  const check = () => {
    if (signal?.aborted || page.isClosed()) fail('ENTRY_CANCELLED');
    if (now() >= deadline) fail('ENTRY_TIMEOUT');
  };
  const remaining = () => { check(); return Math.max(1, deadline - now()); };
  const assertDola = () => { check(); if (originOf(page.url()) !== DOLA_ORIGIN) fail('ENTRY_ORIGIN'); };
  const unique = async label => {
    assertDola();
    const locator = page.getByRole('button', { name: label }), matches = [];
    for (let i = 0, count = await locator.count(); i < count; i++) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible() && await candidate.isEnabled()) matches.push(candidate);
    }
    assertDola();
    if (matches.length > 1) fail('ENTRY_AMBIGUOUS');
    return matches[0];
  };
  const wait = async label => {
    for (;;) {
      const candidate = await unique(label);
      if (candidate) return candidate;
      await sleep(Math.min(500, remaining()));
    }
  };
  onStage('dola_home'); check();
  try { await page.goto(DOLA_ORIGIN + '/chat/', { waitUntil: 'domcontentloaded', timeout: Math.min(45000, remaining()) }); }
  catch (error) {
    // A slow document may already be at the correct origin; the bounded DOM
    // checks still decide readiness. Do not ignore proxy/TLS/network failures.
    if (error?.name !== 'TimeoutError') fail('ENTRY_NAVIGATION');
  }
  assertDola();
  onStage('dola_login_button');
  if (!await unique(DOLA_GOOGLE_LOGIN_LABEL)) {
    const login = await wait(DOLA_LOGIN_LABEL);
    assertDola(); await login.click({ timeout: Math.min(10000, remaining()) });
  }
  onStage('dola_google_button');
  const google = await wait(DOLA_GOOGLE_LOGIN_LABEL);
  assertDola(); await google.click({ timeout: Math.min(10000, remaining()) });
  onStage('google_redirect');
  for (;;) {
    check();
    if (hasCallback()) return { kind: 'callback' };
    const pages = context.pages().filter(p => !p.isClosed());
    const candidates = pages.filter(p => originOf(p.url()) === GOOGLE_ORIGIN);
    if (candidates.length > 1) fail('ENTRY_AMBIGUOUS');
    if (candidates.length === 1) return { kind: 'google' };
    // A popup may begin at about:blank while the proxy is still loading Google.
    // Keep credentials in memory until a real Google origin is observed, rather
    // than treating a single empty polling tick as a failed OAuth callback.
    if (![DOLA_ORIGIN, GOOGLE_ORIGIN].includes(originOf(page.url()))) fail('ENTRY_ORIGIN');
    await sleep(Math.min(500, remaining()));
  }
}
