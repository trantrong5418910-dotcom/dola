import { getPlaywright, checkSession, fetchProfile, missingRequired } from './provider.js';
import { proxyOf } from './proxy.js';
import { DIRECT_LOGIN_PROXY, requireLoginProxy } from './google-login-proxy.js';
import { isIP } from 'node:net';
import { createGoogleLoginCache } from './google-login-cache.js';
import { createLoginSessionVault } from './login-session-vault.js';
import { verifySavedDolaSession } from './google-login-restore.js';
import { openDolaGoogleLogin } from './dola-login-entry.js';
import { openManualLoginBrowser } from './manual-login-browser.js';
import { openCdpLoginBrowser } from './cdp-login-browser.js';
import { dolaCookieMap, matchesGoogleIdentity, isGoogleAuthExchange, authExchangeSucceeded, authSessionMarkers, matchesSessionBinding } from './google-login-core.js';
import { DOLA_ORIGIN, GOOGLE_ORIGIN, originOf, isGoogleWebOrigin, validateGoogleSessionUrl, validateVerificationUrl, eraseLoginSecrets,
  displaysEmail, readGoogleLoginStep, readDolaAgeConfirm, assertGoogleOrigin, clickGoogleStepNext, filterLoginStorageState, reliableDolaIdentity } from './google-login-form.js';

const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const TOTP_REFRESH_MS = 15_000;
const TOTP_DEADLINE_MS = 90_000;
const TOTP_MAX_FETCHES = 3;
const TOTP_MAX_SUBMISSIONS = 2;

// 「谷歌已登录链接」的落地是**有延迟**的（2026-09-29 生产实测）：
// domcontentloaded 那一刻页面仍停在 gapi.mailsapi.com 且一个 Google cookie 都没有；
// 约 4 秒后才种下 cookie、约 7 秒后才跳转到 myaccount.google.com。
// 只判定一次必然误判成「需要人工」，所以这里做**有界**轮询（不发任何数据、不重放导航）。
const LINK_SETTLE_ATTEMPTS = 20;
const LINK_SETTLE_POLL_MS = 1000;

// 会话绑定的**有界宽限**（2026-09-29 生产实测）：OAuth 回调导航与 Dola 自己的弹窗
// （「确认你的年龄」）渲染之间差 1~3 秒。若在弹窗出现前就判 binding 失败，
// handoff 会把 manualOnly 置位，后面的自动处理分支**再也不会被执行** —— 整批就此卡死。
// 所以拿到 access_token 之后先等 BEYOND 这段时间再交人工；宽限用完仍失败才 handoff，
// 绝不无限等待。
const BINDING_GRACE_MS = 20000;

// 交互窗口允许转发的按键白名单：只放「导航/编辑」类按键，
// 普通字符一律走 `insertText`（text 事件），避免逐键转发碰上输入法组合态。
const INTERACTIVE_KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ' '];

// 浏览器**启动阶段**允许向上传递的原因码白名单（2026-09-29 加）。
// 背景：这个文件末尾的 catch 会把 `open()` 体内的一切异常压成
// `google_browser_unavailable`，而 core 又用一个裸 `catch` 把它丢掉，
// 于是运营端只剩一句「登录窗口启动失败」——「手动窗口打不开」时什么线索都没有。
// 这里只放行**不带任何上游文本/URL 的固定原因码**，与「绝不上报 response/URL/token」
// 的既有约定一致；白名单之外的异常仍然压成 `google_browser_unavailable`。
const SAFE_LAUNCH_FAILURES = new Set([
  'browser_missing',
  'manual_browser_unavailable',
  'manual_browser_proxy_unsupported',
  'manual_browser_context_missing',
  'cdp_browser_unavailable',
  'cdp_browser_proxy_unsupported',
  'cdp_context_missing',
]);
const launchFailure = error => {
  const reason = typeof error?.message === 'string' ? error.message : '';
  return SAFE_LAUNCH_FAILURES.has(reason) ? reason : 'google_browser_unavailable';
};

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
    getPlaywright, checkSession, fetchProfile, missingRequired, proxyOf, requireLoginProxy, DIRECT_LOGIN_PROXY, verifySavedDolaSession,
    openManualLoginBrowser, openCdpLoginBrowser,
    vault: createLoginSessionVault(), legacy: createGoogleLoginCache(),
    startSocksBridge: async url => (await import('./socks-bridge.js')).startSocksBridge(url),
    startHttpBridge: async url => (await import('./http-bridge.js')).startHttpBridge(url),
    fetchLoginVerificationCode: async (url, options) => (await import('./login-verification-code.js')).fetchLoginVerificationCode(url, options),
    // 浏览器启动方式。**默认保持 'launch'**（旧的 chromium.launch()），由装配点
    // （routes/dola-google-login.js）在生产显式传 'cdp' —— 这样既不改动既有夹具
    // 与用例的语义，又让生产走「无自动化标记」的 CDP 路径。
    //   'cdp'    = spawn + connectOverCDP（navigator.webdriver === false）
    //   其它值   = pw.chromium.launch()（navigator.webdriver === true，会被 Google 拒）
    launchMode: 'launch',
    now: Date.now, ...dependencies,
  };
  return {
    async open(input, account, { signal, onStage } = {}) {
      const secret = { ...input };
      const mode = secret.loginMethod || 'password';
      const manual = mode === 'manual';
      const controller = new AbortController();
      const activeSignal = controller.signal;
      let browser, context, bridge, manualRuntime, cdpRuntime, closed = false, booting = true, busy = false;
      let accessToken = '', identity = null, identityToken = '', binding = null, tokenAt = 0;
      let restoredReady = null, readyResult = null, restoreBlocked = false, saved = null;
      let emailAttempted = false, emailSubmitted = false, emailPage = null, passwordAttempted = false;
      let recoveryAttempted = false, otpAttempted = false, chooserAttempted = false, consentAttempted = false, ageConfirmAttempted = false, rejected = false, manualOnly = manual;
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
        // CDP 模式的浏览器是**独立进程**：必须走 cdpRuntime.close() 杀整个进程组，
        // 只调 browser.close() 会留下渲染/GPU 子进程继续空转（CPU 100% 的坑）。
        else if (cdpRuntime) await cdpRuntime.close().catch(() => {});
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
        // 出口策略（2026-09-29 飞哥确认）：账号自带代理 → 号池 IPWeb 模板 → **直连兜底**（腾讯出口 IP）。
        // 直连**只能**由 resolveProxy 显式返回 DIRECT_LOGIN_PROXY 哨兵触发；
        // 空串 / 缺失一律照旧 fail-closed（见 mandatory proxy fails closed 用例）——
        // 「忘了配代理」绝不允许被静默降级成直连。
        // 走 deps 取哨兵：VM 夹具会剥掉 import 行，任何裸标识符都会直接 ReferenceError。
        // 缺省（未注入）时视为「没有直连能力」，保持 fail-closed。
        const directProxy = Boolean(deps.DIRECT_LOGIN_PROXY) && account?.proxy === deps.DIRECT_LOGIN_PROXY;
        proxyUrl = directProxy ? '' : deps.requireLoginProxy(account?.proxy);
        let proxy = directProxy ? undefined : deps.proxyOf({ proxy: proxyUrl });
        if (!directProxy && !proxy) throw new Error('login_proxy_required');

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
        // CDP 模式的浏览器是 spawn 出来的**命令行进程**，而命令行的 `--proxy-server=`
        // **不支持内联凭据**（`user:pass@` 会被静默忽略）。所以带用户名密码的 HTTP 代理
        // 在 CDP 模式下也要先转成本地无认证地址（http-bridge）。
        // **手动窗口同理**：它也是命令行启动，所以 manual 也要过桥（2026-09-29 修复 ——
        // 之前只有 CDP 分支过桥，带凭据代理直接透传给 manual，必中 proxy_unsupported）。
        // 旧的 chromium.launch() 路径不需要桥：凭据是当**参数**传给 Playwright 的。
        const useCdpLaunch = !manual && deps.launchMode === 'cdp';
        const socksUpstream = /^socks5h?:/i.test(proxyUrl);
        const needsBridge = socksUpstream
          || (Boolean(proxy?.username || proxy?.password) && (useCdpLaunch || manual));
        if (needsBridge) {
          bridge = socksUpstream
            ? await deps.startSocksBridge(proxyUrl)
            : await deps.startHttpBridge(proxyUrl);
          ensureAlive();
          if (!bridge?.url) throw new Error('login_proxy_required');
          proxy = { server: bridge.url };
        }
        stage('browser_launch');
        if (manual) {
          manualRuntime = await deps.openManualLoginBrowser({ playwright: pw, proxy, signal: activeSignal });
          browser = manualRuntime.browser; context = manualRuntime.context;
        } else if (useCdpLaunch) {
          // spawn + connectOverCDP：不注入 --enable-automation，navigator.webdriver === false，
          // 从而避免 Google 在「输入账号密码」这一步判「此浏览器或应用可能不安全」。
          // CDP 不能 newContext()，locale/viewport/storageState 都在模块内部换路子还原。
          cdpRuntime = await deps.openCdpLoginBrowser({
            playwright: pw, proxy,
            storageState: saved ? filterLoginStorageState(saved, { manual }) : null,
            signal: activeSignal,
          });
          ensureAlive();
          browser = cdpRuntime.browser; context = cdpRuntime.context;
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
                if (token && token !== accessToken) { accessToken = token; identity = null; binding = null; tokenAt = deps.now(); }
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
              // 落地判定：落在任意 google.com 子域都算登录已建立（实测是 myaccount.google.com，
              // 不只是 accounts.google.com）；或仍停在链接页但已拿到 Google cookie。
              // 身份仍由后面的 OAuth + 邮箱精确比对证明，这里只决定「能不能往下走」。
              const landed = async () => {
                const url = page.url();
                if (isGoogleWebOrigin(url)) return true;
                let atLink = false;
                try { validateGoogleSessionUrl(url); atLink = true; } catch { /* 未知落地页 → 交给人工。 */ }
                if (!atLink) return false;
                const cookies = await context.cookies(GOOGLE_ORIGIN);
                return cookies.some(c => ['google.com', 'accounts.google.com'].includes(String(c.domain).replace(/^\./, '')));
              };
              let settled = await landed(); ensureAlive();
              for (let attempt = 0; !settled && attempt < LINK_SETTLE_ATTEMPTS && !activeSignal.aborted; attempt++) {
                await page.waitForTimeout(LINK_SETTLE_POLL_MS);
                ensureAlive();
                settled = await landed();
              }
              if (!settled) { handoff('google_step'); return; }
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
          // Dola 自己的「确认你的年龄」弹窗：不点掉它，OAuth 回调后的登录交换就不会发生，
          // 绑定标记永远采不到 → handoff('binding')。放在 Google 分支之前，因为这一步
          // 与「Google 页面上该填什么」无关，只看 Dola 页面自己弹了什么。
          if (!ageConfirmAttempted) {
            const dola = pages.find(p => originOf(p.url()) === DOLA_ORIGIN && !p.isClosed());
            if (dola) {
              let modal = null;
              try { modal = await readDolaAgeConfirm(dola); } catch { modal = null; }
              ensureAlive();
              if (modal) {
                ageConfirmAttempted = true;
                stage('dola_age_confirm');
                await modal.click({ timeout: 4000 });
                ensureAlive(); lastAutomaticAt = deps.now();
                return { kind: 'pending' };
              }
            }
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
            // 授权同意页（Sign in to dola.com）：一次「继续」就能走完 OAuth。
            // 这既不是安全验证，也不构成身份证明 —— 身份由 readGoogleLoginStep 的
            // 「正文必须出现期望邮箱」保证，这里只是把缺的那一次点击补上。
            // 与 chooser 同样**最多点一次**；点完不推进就交回人工，绝不反复点。
            // 只限 google_link 通道（该通道的链接天然带一次性额度，也没有人工可介入）。
            if (step.kind === 'consent' && !consentAttempted && mode === 'google_link') {
              consentAttempted = true;
              assertGoogleOrigin(google, activeSignal);
              await step.input.click({ timeout: 4000 });
              ensureAlive(); lastAutomaticAt = deps.now();
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
          if (!binding || binding.token !== token || !matchesSessionBinding(cookies, binding.markers)) {
            // 回调刚落地的几秒内 Dola 可能还在渲染自己的弹窗（年龄确认等），
            // 上面的自动处理分支需要这段窗口才能出手；用完仍失败才交人工。
            if (deps.now() - tokenAt < BINDING_GRACE_MS) return { kind: 'pending' };
            return handoff('binding');
          }
          if (deps.missingRequired(cookies).length) return { kind: 'pending' };
          stage('dola_session');
          const session = await deps.checkSession(cookies, options); ensureAlive();
          const profile = await deps.fetchProfile(cookies, options); ensureAlive();
          if (token !== accessToken || binding?.token !== token || !matchesSessionBinding(cookies, binding.markers)) return { kind: 'pending' };
          if (!reliableDolaIdentity(session, profile, account?.sec_user_id)) return handoff('session');
          return saveVerified({ kind: 'ready', identity, cookies, profile, exitIp }, token);
        };
        // 当前可被运营看到 / 操作的那一页。快照与交互共用这一套白名单 ——
        // 只允许 Google（任意子域）与 Dola，避免这条通道变成一台通用远程浏览器。
        const interactiveTarget = () => {
          ensureAlive();
          const pages = context.pages().filter(candidate => !candidate.isClosed());
          const target = pages.find(candidate => isGoogleWebOrigin(candidate.url())) || pages.at(-1);
          return target && (isGoogleWebOrigin(target.url()) || originOf(target.url()) === DOLA_ORIGIN) ? target : null;
        };
        const coord = value => {
          const number = Number(value);
          if (!Number.isFinite(number) || Math.abs(number) > 20000) throw new Error('interactive_event_invalid');
          return Math.round(number);
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
              const target = interactiveTarget();
              // 快照仅对 Google（任意子域）与 Dola 的页面开放；输入框一律遮挡。
              if (!target) throw new Error();
              return await target.screenshot({ type: 'png', mask: [target.locator('input')], timeout: 5000 });
            } catch { throw new Error('preview_unavailable'); }
          },
          // 交互画面：与 preview 同一张截图，但**只遮挡密码框** ——
          // 运营要看得见邮箱框才点得进去；密码则永远不会被渲染成图片。
          // 同时回传 viewport 尺寸，让前端的点击坐标能与页面坐标严格对齐。
          async surface() {
            try {
              const target = interactiveTarget();
              if (!target) throw new Error();
              const viewport = target.viewportSize?.()
                || await target.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
              if (!viewport?.width || !viewport?.height) throw new Error();
              const image = await target.screenshot({ type: 'png', mask: [target.locator('input[type="password"]')], timeout: 5000 });
              return { image, viewport: { width: viewport.width, height: viewport.height } };
            } catch { throw new Error('preview_unavailable'); }
          },
          // 把运营在后台页面上的点击 / 滚动 / 按键 / 文本转进真实窗口。
          // 绝不记录、绝不回传任何事件内容：`text` 里可能就有账号密码。
          async interact(event) {
            ensureAlive();
            const target = interactiveTarget();
            if (!target) throw new Error('interactive_page_unavailable');
            const type = typeof event?.type === 'string' ? event.type : '';
            if (type === 'click' || type === 'scroll') {
              await target.mouse.move(coord(event.x), coord(event.y));
              if (type === 'click') {
                const button = ['left', 'right', 'middle'].includes(event.button) ? event.button : 'left';
                await target.mouse.down({ button });
                await target.mouse.up({ button });
              } else {
                await target.mouse.wheel(0, coord(event.deltaY));
              }
              return { ok: true };
            }
            if (type === 'key') {
              if (!INTERACTIVE_KEYS.includes(event.key)) throw new Error('interactive_event_invalid');
              await target.keyboard.press(event.key);
              return { ok: true };
            }
            if (type === 'text') {
              const text = typeof event.text === 'string' ? event.text : '';
              if (!text || text.length > 512) throw new Error('interactive_event_invalid');
              await target.keyboard.insertText(text);
              return { ok: true };
            }
            throw new Error('interactive_event_invalid');
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
      } catch (error) {
        await close();
        // 只放行白名单内的原因码（不含任何上游文本 / URL / 凭据）；
        // 其余一律压成 `google_browser_unavailable`，保持既有语义不变。
        throw new Error(launchFailure(error));
      }
    },
  };
}

export const googleBrowserDriver = createGoogleBrowserDriver();
