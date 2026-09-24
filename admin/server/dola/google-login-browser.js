import { getPlaywright, checkSession, fetchProfile, missingRequired } from './provider.js';
import { proxyOf } from './proxy.js';
import { requireLoginProxy } from './google-login-proxy.js';
import { isIP } from 'node:net';
import { createGoogleLoginCache } from './google-login-cache.js';
import { createLoginSessionVault } from './login-session-vault.js';
import { verifySavedDolaSession } from './google-login-restore.js';
import { openDolaGoogleLogin } from './dola-login-entry.js';
import { openManualLoginBrowser } from './manual-login-browser.js';
import { dolaCookieMap, matchesGoogleIdentity, isGoogleAuthExchange, authExchangeSucceeded, authSessionMarkers, matchesSessionBinding } from './google-login-core.js';
import { DOLA_ORIGIN, GOOGLE_ORIGIN, originOf, validateGoogleSessionUrl, validateVerificationUrl, eraseLoginSecrets,
  displaysEmail, readGoogleLoginStep, assertGoogleOrigin, clickGoogleStepNext, filterLoginStorageState, reliableDolaIdentity } from './google-login-form.js';

const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const TOTP_REFRESH_MS = 15_000;
const TOTP_DEADLINE_MS = 90_000;
const TOTP_MAX_FETCHES = 3;
const TOTP_MAX_SUBMISSIONS = 2;

// Serial, single-attempt interaction. Recheck origin/cancellation at every
// boundary; no positional clicks, CAPTCHA bypass, password retry or raw errors.
export async function typeGoogleCredentialSlowly(page, input, value, { signal, verify } = {}) {
  const check = async () => { assertGoogleOrigin(page, signal); await verify?.(); assertGoogleOrigin(page, signal); };
  await check();
  await input.waitFor({ state: 'visible', timeout: 15000 }); await check();
  await page.waitForTimeout(800); await check();
  await input.click(); await check();
  await input.fill(''); await check();
  await input.pressSequentially(value, { delay: 140 }); await check();
  await page.waitForTimeout(700); await check();
  const entered = await input.inputValue(); await check();
  if (entered !== value) throw new Error('form_not_ready');
}

// Dependencies allow in-memory browser/vault tests; constructors do no I/O.
export function createGoogleBrowserDriver(dependencies = {}) {
  const deps = {
    getPlaywright, checkSession, fetchProfile, missingRequired, proxyOf, requireLoginProxy, verifySavedDolaSession,
    openManualLoginBrowser,
    vault: createLoginSessionVault(), legacy: createGoogleLoginCache(),
    startSocksBridge: async url => (await import('./socks-bridge.js')).startSocksBridge(url),
    fetchLoginVerificationCode: async (url, options) => (await import('./login-verification-code.js')).fetchLoginVerificationCode(url, options),
    now: Date.now, ...dependencies,
  };
  return {
    async open(input, account, { signal, onStage } = {}) {
      const secret = { ...input };
      const mode = secret.loginMethod || 'password';
      const manual = mode === 'manual';
      const controller = new AbortController();
      const activeSignal = controller.signal;
      let browser, context, bridge, manualRuntime, closed = false, booting = true, busy = false;
      let accessToken = '', identity = null, identityToken = '', binding = null;
      let restoredReady = null, readyResult = null, restoreBlocked = false, saved = null;
      let emailAttempted = false, emailSubmitted = false, emailPage = null, passwordAttempted = false;
      let recoveryAttempted = false, otpAttempted = false, chooserAttempted = false, rejected = false, manualOnly = manual;
      let totp = null;
      let phase = 'session_restore', failureReason = '';
      const stage = value => { phase = value; try { onStage?.(value); } catch { /* Diagnostic callbacks cannot affect login. */ } };
      let manualReason = 'manual_step', lastAutomaticAt = 0, proxyUrl = '', exitIp = '';
      const alive = () => !closed && !activeSignal.aborted;
      const ensureAlive = () => { if (!alive()) throw new Error('cancelled'); };
      const erase = all => {
        if (totp) { totp.lastCode = ''; totp.page = null; totp = null; }
        eraseLoginSecrets(secret, { all }); eraseLoginSecrets(input, { all });
      };
      const handoff = (reason = 'manual_step') => {
        manualOnly = true; manualReason = reason; erase(false);
        return { kind: 'waiting_user', reason, stage: phase };
      };
      const stop = () => {
        closed = true; controller.abort(); erase(true);
        accessToken = ''; identity = null; identityToken = ''; binding = null;
        restoredReady = null; readyResult = null; saved = null;
        signal?.removeEventListener('abort', onAbort);
      };
      const close = async () => {
        stop();
        if (manualRuntime) await manualRuntime.close().catch(() => {});
        else await browser?.close().catch(() => {});
        await bridge?.close().catch(() => {});
      };
      const onAbort = () => { void close(); };
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        if (signal?.aborted) throw new Error('cancelled');
        if (!['password', 'google_link', 'manual'].includes(mode)) throw new Error('invalid_login_method');
        // Validate even unused URLs before any browser, cache or network work.
        if (secret.googleSessionUrl) validateGoogleSessionUrl(secret.googleSessionUrl);
        if (secret.verificationUrl) validateVerificationUrl(secret.verificationUrl);
        if (mode === 'google_link') validateGoogleSessionUrl(secret.googleSessionUrl);
        if (manual) erase(false);
        proxyUrl = deps.requireLoginProxy(account?.proxy);
        let proxy = deps.proxyOf(account || {});
        if (!proxy) throw new Error('login_proxy_required');

        // An absent hasRecord method also fails closed, never into plaintext.
        // Manual is explicit reauthentication: always empty, even when an old
        // encrypted record is corrupt/expired or contains a Google identity.
        stage('session_restore');
        if (!manual) {
          try {
            const exists = await deps.vault.hasRecord(secret.email); ensureAlive();
            if (exists) {
              saved = await deps.vault.load(secret.email, proxyUrl); ensureAlive();
              if (!saved || saved.manual === true) restoreBlocked = true;
            } else { saved = await deps.legacy.load(secret.email, proxyUrl); ensureAlive(); }
          } catch { restoreBlocked = true; }
        }
        if (restoreBlocked) { saved = null; handoff('saved_session'); }
        ensureAlive();
        const pw = await deps.getPlaywright(); ensureAlive();
        if (!pw?.chromium) throw new Error('browser_missing');
        if (/^socks5h?:/i.test(proxyUrl)) {
          bridge = await deps.startSocksBridge(proxyUrl); ensureAlive();
          if (!bridge?.url) throw new Error('login_proxy_required');
          proxy = { server: bridge.url };
        }
        stage('browser_launch');
        if (manual) {
          manualRuntime = await deps.openManualLoginBrowser({ playwright: pw, proxy, signal: activeSignal });
          browser = manualRuntime.browser; context = manualRuntime.context;
        } else {
          browser = await pw.chromium.launch({ headless: false, proxy });
          ensureAlive();
          context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1120, height: 820 },
            ...(saved ? { storageState: filterLoginStorageState(saved, { manual }) } : {}) });
        }
        ensureAlive();
        browser.on('disconnected', () => { stop(); void bridge?.close().catch(() => {}); });
        ensureAlive();
        stage('proxy_check');
        const check = await context.request.get('https://ipinfo.io/json', { timeout: 15000, maxRedirects: 0 });
        let info;
        try { info = check.ok() ? await check.json() : null; }
        finally { await check.dispose(); }
        ensureAlive();
        if (!isIP(info?.ip || '')) throw new Error('login_proxy_unavailable');
        exitIp = info.ip;

        // Manual sessions cannot acquire Google identity or exchange evidence.
        if (!manual) {
          context.on('page', page => {
            page.on('framenavigated', frame => {
              if (!alive() || frame !== page.mainFrame()) return;
              if (page === emailPage && originOf(frame.url()) !== GOOGLE_ORIGIN) emailSubmitted = false;
              try {
                const url = new URL(frame.url());
                if (url.origin !== DOLA_ORIGIN || url.pathname !== '/auth/callback') return;
                const token = new URLSearchParams(url.hash.slice(1)).get('access_token');
                if (token && token !== accessToken) { accessToken = token; identity = null; binding = null; }
              } catch { /* OAuth URLs contain secrets. */ }
            });
          });
          context.on('response', async response => {
            try {
              const token = accessToken, request = response.request();
              if (!alive() || !token || originOf(response.url()) !== DOLA_ORIGIN || request.method() !== 'POST'
                  || response.status() !== 200 || !isGoogleAuthExchange(response.url(), request.postData(), token)) return;
              if (!authExchangeSucceeded(await response.json())) return;
              const markers = authSessionMarkers(await response.headersArray());
              if (alive() && token === accessToken && Object.keys(markers).length) binding = { token, markers };
            } catch { /* Never report response/URL/token contents. */ }
          });
        }
        const page = await context.newPage(); ensureAlive();
        const options = { proxy: proxyUrl, timeout: 15000 };

        const manualSession = async (expectedId = account?.sec_user_id || '') => {
          stage('dola_session');
          const cookies = dolaCookieMap(await context.cookies(DOLA_ORIGIN)); ensureAlive();
          if (deps.missingRequired(cookies).length) return null;
          const session = await deps.checkSession(cookies, options); ensureAlive();
          const profile = await deps.fetchProfile(cookies, options); ensureAlive();
          if (!reliableDolaIdentity(session, profile, expectedId)
              || (account?.sec_user_id && String(profile.entityId) !== String(account.sec_user_id))) return null;
          return { kind: 'ready', manual: true, identity: null, sessionVerified: true, cookies, profile, exitIp };
        };

        const startDolaOAuth = async () => {
          ensureAlive();
          await openDolaGoogleLogin(page, { context, signal: activeSignal, onStage: stage,
            now: deps.now, hasCallback: () => Boolean(accessToken) });
          ensureAlive(); lastAutomaticAt = deps.now();
        };
        const boot = async () => {
          try {
            if (restoreBlocked) {
              stage('dola_home');
              await page.goto(DOLA_ORIGIN + '/chat/', { waitUntil: 'domcontentloaded', timeout: 45000 });
              return;
            }
            if (saved) {
              stage('session_restore');
              const restoredCookies = await context.cookies(); ensureAlive();
              const restored = await deps.verifySavedDolaSession({ ...saved, cookies: restoredCookies }, secret.email, account, {
                checkSession: deps.checkSession, fetchProfile: deps.fetchProfile, missingRequired: deps.missingRequired, options,
              });
              ensureAlive();
              if (restored.kind === 'reused') { erase(false); restoredReady = { ...restored.result, exitIp }; return; }
              if (restored.kind === 'blocked') { restoreBlocked = true; handoff('saved_session'); return; }
              await context.clearCookies({ domain: /(^|\.)dola\.com$/ }); ensureAlive();
              // Old cookie-only records can safely continue normal OAuth. With
              // saved Dola localStorage, expiry needs manual handling to avoid
              // resurrecting a session from stale origin data.
              if (saved.origins?.some(o => [DOLA_ORIGIN, 'https://dola.com'].includes(o.origin) && o.localStorage?.length)) {
                restoreBlocked = true; handoff('saved_session'); return;
              }
            }
            if (manual) {
              stage('dola_home');
              await page.goto(DOLA_ORIGIN + '/chat/', { waitUntil: 'domcontentloaded', timeout: 45000 }); ensureAlive();
              return;
            }
            if (mode === 'google_link') {
              stage('session_restore');
              const link = secret.googleSessionUrl;
              secret.googleSessionUrl = ''; input.googleSessionUrl = '';
              // Exactly one navigation, no headers, account fields or form data.
              await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 }); ensureAlive();
              const googleCookies = (await context.cookies(GOOGLE_ORIGIN)).some(c => ['google.com', 'accounts.google.com'].includes(c.domain.replace(/^\./, '')));
              ensureAlive();
              const landing = page.url();
              let atLink = false;
              try { validateGoogleSessionUrl(landing); atLink = true; } catch { /* Unknown landing: manual only. */ }
              if (originOf(landing) !== GOOGLE_ORIGIN && !(atLink && googleCookies)) { handoff('google_step'); return; }
              // Page/cookies only permit starting Dola OAuth, never proving identity.
            }
            await startDolaOAuth();
          } catch {
            if (alive()) {
              if (saved) restoreBlocked = true;
              handoff(saved ? 'saved_session' : manual ? 'manual_login'
                : ['dola_home', 'dola_login_button', 'dola_google_button', 'google_redirect'].includes(phase) ? 'dola_entry' : 'manual_step');
            }
          } finally { booting = false; }
        };
        void boot();

        const saveVerified = async (result, token = '') => {
          stage('session_save');
          let loginStateSaved = false;
          try {
            const storage = filterLoginStorageState(await context.storageState(), { manual }); ensureAlive();
            if (!manual && token !== accessToken) return { kind: 'pending' };
            // Never save a cookie switch that happened after live verification.
            const fresh = dolaCookieMap(storage.cookies);
            if (JSON.stringify(Object.entries(fresh).sort()) !== JSON.stringify(Object.entries(result.cookies).sort())) return handoff('session');
            await deps.vault.save(secret.email, proxyUrl, {
              identity: result.identity, dolaId: String(result.profile.entityId), cookies: storage.cookies, origins: storage.origins,
              ...(manual ? { manual: true } : {}),
            }, { signal: activeSignal });
            loginStateSaved = true;
          } catch { /* A vault failure must not expose credentials or claim a save. */ }
          ensureAlive();
          if (!manual && token !== accessToken) return { kind: 'pending' };
          erase(false);
          readyResult = { ...result, loginStateSaved };
          return readyResult;
        };

        // Independent of email OTP: one account/page, at most 3 fetches and 2
        // distinct submissions. Clock-based waits keep polling/cancellation live.
        const authenticatorStep = async (google, step) => {
          stage('authenticator_otp');
          const matches = current => current.kind === 'authenticator_otp'
            && emailSubmitted && emailPage === google && !google.isClosed()
            && displaysEmail(current.text, secret.email);
          if (!matches(step) || otpAttempted || !secret.verificationUrl) return handoff('otp_identity');
          if (!totp) {
            // Do not retry a code typed by a human/another flow.
            if (step.otpRejected) return handoff('otp_not_accepted');
            totp = { page: google, startedAt: deps.now(), nextAt: 0, fetches: 0,
              submissions: 0, submittedAt: 0, lastCode: '', waitingRefresh: false };
          }
          const state = totp;
          if (state.page !== google || deps.now() - state.startedAt >= TOTP_DEADLINE_MS) return handoff('otp_refresh_exhausted');
          if (state.submissions && !state.waitingRefresh) {
            if (!step.otpRejected) {
              if (deps.now() - state.submittedAt < TOTP_REFRESH_MS) return { kind: 'pending', stage: 'otp_submitted' };
              return handoff('otp_not_accepted');
            }
            if (state.submissions >= TOTP_MAX_SUBMISSIONS) return handoff('otp_refresh_exhausted');
            state.waitingRefresh = true;
          }
          if (deps.now() < state.nextAt) return { kind: 'pending', stage: 'otp_waiting_refresh' };
          if (state.fetches >= TOTP_MAX_FETCHES) return handoff('otp_refresh_exhausted');
          state.fetches++;
          state.nextAt = deps.now() + TOTP_REFRESH_MS;
          let code = '';
          const verify = async () => {
            assertGoogleOrigin(google, activeSignal);
            const current = await readGoogleLoginStep(google); ensureAlive();
            if (totp !== state || !matches(current) || deps.now() - state.startedAt >= TOTP_DEADLINE_MS
                || context.pages().filter(p => !p.isClosed() && originOf(p.url()) === GOOGLE_ORIGIN).length !== 1) {
              throw new Error('otp_step_changed');
            }
            return current;
          };
          try {
            await verify();
            const url = validateVerificationUrl(secret.verificationUrl);
            // Only the driver's bounded in-memory copy survives for refresh.
            input.verificationUrl = '';
            try { code = await deps.fetchLoginVerificationCode(url, { signal: activeSignal, profile: 'authenticator' }); }
            catch { ensureAlive(); return handoff('otp_fetch_failed'); }
            const current = await verify();
            if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return handoff('otp_fetch_failed');
            if (code === state.lastCode) {
              if (state.fetches >= TOTP_MAX_FETCHES) return handoff('otp_refresh_exhausted');
              return { kind: 'pending', stage: 'otp_same_code' };
            }
            await typeGoogleCredentialSlowly(google, current.input, code, { signal: activeSignal, verify });
            await verify();
            // Count before the click: a lost click response never authorizes a
            // second send. Clear raw codes on every terminal/handoff boundary.
            state.lastCode = code; state.submissions++; state.waitingRefresh = false;
            state.submittedAt = deps.now(); state.nextAt = state.submittedAt + TOTP_REFRESH_MS;
            if (!await clickGoogleStepNext(google, 'authenticator_otp', { signal: activeSignal })) return handoff('otp_not_accepted');
            lastAutomaticAt = deps.now();
            return { kind: 'pending', stage: 'otp_submitted' };
          } catch {
            ensureAlive(); return handoff('otp_step_changed');
          } finally { code = ''; }
        };

        const inspect = async () => {
          if (!alive() || !browser.isConnected()) return { kind: 'failed', reason: 'browser_closed' };
          if (booting) return { kind: 'pending' };
          if (restoreBlocked) return { kind: 'waiting_user', reason: 'saved_session' };
          if (restoredReady) return restoredReady;
          if (readyResult) return readyResult;
          if (rejected) return { kind: 'failed', reason: failureReason };
          const pages = context.pages().filter(p => !p.isClosed());
          if (!pages.length) return { kind: 'failed', reason: 'browser_closed' };
          if (manual) {
            const result = await manualSession();
            return result ? saveVerified(result) : { kind: 'waiting_user', reason: 'manual_login' };
          }
          const googlePages = pages.filter(p => originOf(p.url()) === GOOGLE_ORIGIN);
          const google = googlePages[0];
          if (google && !accessToken) {
            if (manualOnly) return { kind: 'waiting_user', reason: manualReason };
            if (googlePages.length !== 1) return handoff(totp ? 'otp_step_changed' : 'google_step');
            let step;
            try { step = await readGoogleLoginStep(google, secret.email); }
            catch (error) {
              // Google may have committed its URL before the body exists. Only
              // a DOM readiness timeout gets the same bounded loading grace;
              // closed/foreign pages and other errors still stop automation.
              ensureAlive(); assertGoogleOrigin(google, activeSignal);
              if (!totp && error?.name === 'TimeoutError' && deps.now() - lastAutomaticAt < 15000) {
                return { kind: 'pending', stage: 'google_redirect' };
              }
              throw error;
            }
            ensureAlive();
            assertGoogleOrigin(google, activeSignal);
            if (/wrong password|couldn.t find your google account|密码错误|找不到您的 Google|密码不正确/i.test(step.text)) {
              erase(false); rejected = true; failureReason = 'credentials_rejected';
              return { kind: 'failed', reason: failureReason };
            }
            if (step.kind === 'manual') {
              if (!totp && step.reason === 'google_step' && deps.now() - lastAutomaticAt < 15000) {
                return { kind: 'pending', stage: 'google_redirect' };
              }
              return handoff(totp && !['captcha', 'browser_blocked'].includes(step.reason) ? 'otp_step_changed' : step.reason);
            }
            if (step.kind === 'authenticator_otp') return authenticatorStep(google, step);
            if (totp) return handoff('otp_step_changed');
            if (step.kind === 'chooser' && !chooserAttempted && mode === 'google_link') {
              chooserAttempted = true;
              assertGoogleOrigin(google, activeSignal);
              await step.input.click({ timeout: 4000 });
              ensureAlive(); lastAutomaticAt = deps.now();
              // Selection is not an entered-email OTP flow or identity proof.
              return { kind: 'pending' };
            }
            if (step.kind === 'email' && !emailAttempted) {
              stage('google_email');
              emailAttempted = true;
              await typeGoogleCredentialSlowly(google, step.input, secret.email, { signal: activeSignal });
              if (!await clickGoogleStepNext(google, 'email', { signal: activeSignal })) return handoff('email_form');
              assertGoogleOrigin(google, activeSignal);
              emailSubmitted = true; emailPage = google; lastAutomaticAt = deps.now();
              return { kind: 'pending' };
            }
            if (step.kind === 'password' && !passwordAttempted && secret.password) {
              stage('google_password');
              if (!displaysEmail(step.text, secret.email)) return handoff('identity');
              passwordAttempted = true;
              try { await typeGoogleCredentialSlowly(google, step.input, secret.password, { signal: activeSignal }); }
              finally { secret.password = ''; input.password = ''; }
              if (!await clickGoogleStepNext(google, 'password', { signal: activeSignal })) return handoff();
              lastAutomaticAt = deps.now(); return { kind: 'pending' };
            }
            if (step.kind === 'recovery' && !recoveryAttempted && secret.recoveryEmail && emailSubmitted && emailPage === google) {
              stage('google_recovery');
              recoveryAttempted = true;
              try { await typeGoogleCredentialSlowly(google, step.input, secret.recoveryEmail, { signal: activeSignal }); }
              finally { secret.recoveryEmail = ''; input.recoveryEmail = ''; }
              if (!await clickGoogleStepNext(google, 'recovery', { signal: activeSignal })) return handoff('security');
              lastAutomaticAt = deps.now(); return { kind: 'pending' };
            }
            if (step.kind === 'email_otp' && !otpAttempted && secret.verificationUrl && emailSubmitted && emailPage === google) {
              stage('email_otp');
              otpAttempted = true;
              let code = '';
              try {
                assertGoogleOrigin(google, activeSignal);
                const url = validateVerificationUrl(secret.verificationUrl);
                secret.verificationUrl = ''; input.verificationUrl = '';
                code = await deps.fetchLoginVerificationCode(url, { signal: activeSignal });
                assertGoogleOrigin(google, activeSignal);
                // Re-read after mail loading; a new challenge needs a new decision.
                const current = await readGoogleLoginStep(google); ensureAlive();
                if (current.kind !== 'email_otp' || !emailSubmitted || emailPage !== google
                    || typeof code !== 'string' || !/^(?:\d{6}|\d{8})$/.test(code)) return handoff('security');
                await typeGoogleCredentialSlowly(google, current.input, code, { signal: activeSignal });
                if (!await clickGoogleStepNext(google, 'email_otp', { signal: activeSignal })) return handoff('security');
                lastAutomaticAt = deps.now(); return { kind: 'pending' };
              } finally { code = ''; }
            }
            if (['recovery', 'email_otp'].includes(step.kind)) return handoff('security');
            if (deps.now() - lastAutomaticAt < 10000) return { kind: 'pending' };
            return handoff('google_step');
          }

          if (!accessToken) return handoff(totp ? 'otp_step_changed' : manualOnly ? manualReason : 'callback');
          const token = accessToken;
          if (!identity || identityToken !== token) {
            stage('google_identity');
            const response = await context.request.get(USERINFO, {
              headers: { Authorization: 'Bearer ' + token }, timeout: 15000, maxRedirects: 0,
            });
            let candidate;
            try { candidate = response.ok() ? await response.json() : null; }
            finally { await response.dispose(); }
            ensureAlive();
            if (token !== accessToken) return { kind: 'pending' };
            if (!matchesGoogleIdentity(candidate, secret.email)) {
              erase(false); rejected = true; failureReason = 'identity_mismatch'; return { kind: 'failed', reason: failureReason };
            }
            identity = { sub: candidate.sub, email: candidate.email, email_verified: candidate.email_verified };
            identityToken = token;
          }
          const cookies = dolaCookieMap(await context.cookies(DOLA_ORIGIN)); ensureAlive();
          stage('dola_binding');
          if (!binding || binding.token !== token || !matchesSessionBinding(cookies, binding.markers)) return handoff('binding');
          if (deps.missingRequired(cookies).length) return { kind: 'pending' };
          stage('dola_session');
          const session = await deps.checkSession(cookies, options); ensureAlive();
          const profile = await deps.fetchProfile(cookies, options); ensureAlive();
          if (token !== accessToken || binding?.token !== token || !matchesSessionBinding(cookies, binding.markers)) return { kind: 'pending' };
          if (!reliableDolaIdentity(session, profile, account?.sec_user_id)) return handoff('session');
          return saveVerified({ kind: 'ready', identity, cookies, profile, exitIp }, token);
        };
        return {
          close,
          async inspect() {
            if (busy) return { kind: 'pending', stage: phase };
            busy = true;
            try { const result = await inspect(); return { ...result, stage: result.stage || phase }; }
            catch { return alive() ? handoff(totp ? 'otp_step_changed' : manual ? 'manual_login' : 'manual_step')
              : { kind: 'failed', reason: 'browser_closed', stage: phase }; }
            finally { busy = false; }
          },
          async preview() {
            try {
              ensureAlive();
              const pages = context.pages().filter(p => !p.isClosed());
              const target = pages.find(p => originOf(p.url()) === GOOGLE_ORIGIN) || pages.at(-1);
              if (!target || ![GOOGLE_ORIGIN, DOLA_ORIGIN].includes(originOf(target.url()))) throw new Error();
              return await target.screenshot({ type: 'png', mask: [target.locator('input')], timeout: 5000 });
            } catch { throw new Error('preview_unavailable'); }
          },
          async focus() {
            try {
              ensureAlive();
              const pages = context.pages().filter(p => !p.isClosed());
              const target = pages.find(p => originOf(p.url()) === GOOGLE_ORIGIN) || pages.at(-1);
              await target?.bringToFront();
            } catch { /* Browser errors can contain navigation URLs. */ }
          },
        };
      } catch {
        await close();
        throw new Error('google_browser_unavailable');
      }
    },
  };
}

export const googleBrowserDriver = createGoogleBrowserDriver();
