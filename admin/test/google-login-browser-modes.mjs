/**
 * Actual driver source evaluated in a VM with an explicit import whitelist.
 * No provider/DB/browser/cache implementation is imported; all I/O is in-memory.
 * Run: node --test test/google-login-form.mjs test/google-login-browser-modes.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import vm from 'node:vm';
import { setImmediate as flush } from 'node:timers/promises';
import * as form from '../server/dola/google-login-form.js';
import * as core from '../server/dola/google-login-core.js';
import { verifySavedDolaSession } from '../server/dola/google-login-restore.js';
import { openDolaGoogleLogin } from '../server/dola/dola-login-entry.js';

const EMAIL = 'synthetic@example.test', PASSWORD = 'synthetic-password';
const PROXY = 'http://proxy.example.invalid:8080';
const G = 'https://accounts.google.com', D = 'https://www.dola.com';
const LINK = 'https://gapi.mailsapi.com/google/login?uid=synthetic-only';
const MAIL = 'https://mail.example.test/read?token=synthetic-only';
const TOKEN = 'synthetic-google-access-token';
const plain = value => JSON.parse(JSON.stringify(value));
const deny = () => { throw new Error('Unexpected real dependency'); };
const source = readFileSync(new URL('../server/dola/google-login-browser.js', import.meta.url), 'utf8');
const allowedImports = new Set(['./provider.js', './proxy.js', './google-login-proxy.js', 'node:net', './google-login-cache.js',
  './login-session-vault.js', './google-login-restore.js', './google-login-core.js', './google-login-form.js', './dola-login-entry.js', './manual-login-browser.js']);
const code = source.replace(/^import\s+[\s\S]*?from\s+['"]([^'"]+)['"];\n/gm, (_, name) => {
  assert.ok(allowedImports.delete(name), 'unexpected or duplicate driver import: ' + name); return '';
}).replace(/\bexport (async function|function|const) /g, '$1 ');
assert.equal(allowedImports.size, 0);
const box = { ...form, ...core, verifySavedDolaSession, openDolaGoogleLogin, isIP, URL, URLSearchParams, AbortController,
  getPlaywright: deny, checkSession: deny, fetchProfile: deny, missingRequired: deny, proxyOf: deny, requireLoginProxy: deny,
  createGoogleLoginCache: () => ({ load: deny, save: deny, clear: deny }),
  createLoginSessionVault: () => ({ hasRecord: deny, load: deny, save: deny, clear: deny }),
  openManualLoginBrowser: deny,
};
vm.runInNewContext(code + '\nthis.factory = createGoogleBrowserDriver; this.typeSlowly = typeGoogleCredentialSlowly;', box);

function deferred() {
  let resolve;
  return { promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value) };
}
function cookie(domain, name, value = 'synthetic-' + name) { return { domain, name, value, path: '/', secure: true }; }
function dolaCookies() { return [cookie('.dola.com', 'ttwid'), cookie('www.dola.com', 'odin_tt'), cookie('.dola.com', 'sessionid')]; }
function identity() { return { sub: 'synthetic-sub', email: EMAIL, email_verified: true }; }
function record(manual = false) { return { cookies: dolaCookies(), origins: [{ origin: D, localStorage: [{ name: 'state', value: 'synthetic' }] }],
  dolaId: 'synthetic-dola-id', identity: manual ? null : identity(), ...(manual ? { manual: true } : {}) }; }

class Locator {
  constructor(page, nodes) { this.page = page; this.nodes = nodes; }
  async count() { return this.nodes.length; }
  nth(i) { return new Locator(this.page, [this.nodes[i]]); }
  or(other) { return new Locator(this.page, [...new Set([...this.nodes, ...other.nodes])]); }
  async isVisible() { return Boolean(this.nodes[0]?.visible !== false && this.nodes[0]); }
  async isEnabled() { return !this.nodes[0]?.disabled; }
  async waitFor() { if (!await this.isVisible()) throw new Error('hidden synthetic element'); }
  async click() {
    if (this.nodes.length !== 1) throw new Error('ambiguous synthetic locator');
    const node = this.nodes[0];
    this.page.h.clicks.push({ origin: form.originOf(this.page.url()), kind: node.kind, name: node.name, id: node.id });
    await node.action?.();
  }
  async fill(value) { this.nodes[0].value = value; await this.page.h.afterFill?.(this.page, this.nodes[0]); }
  async pressSequentially(value) {
    const node = this.nodes[0]; node.value = value;
    this.page.h.typed.push({ origin: form.originOf(this.page.url()), kind: node.kind, value });
    await this.page.h.afterType?.(this.page, node);
  }
  async inputValue() { return this.nodes[0].value || ''; }
  async innerText() { if (this.page.h.bodyError) throw this.page.h.bodyError; return this.page.text; }
}

class Page {
  constructor(h) { this.h = h; this.currentUrl = 'about:blank'; this.nodes = []; this.text = ''; this.handlers = {}; this.closed = false; this.frame = { url: () => this.url() }; }
  url() { return this.currentUrl; }
  on(event, fn) { this.handlers[event] = fn; }
  mainFrame() { return this.frame; }
  isClosed() { return this.closed; }
  navigate(url) { this.currentUrl = url; this.handlers.framenavigated?.(this.frame); }
  async goto(url, options) {
    this.h.navigations.push({ url, options });
    if (/gapi\.mailsapi\.com/i.test(url)) {
      this.navigate(this.h.linkLanding || G + '/signin');
      if (this.h.linkCookie) this.h.cookies.push(cookie('.google.com', 'SID'));
      if (this.h.linkError) throw new Error('synthetic-private-url-error ' + url);
    } else {
      this.navigate(url);
      this.nodes = [{ role: 'button', name: 'Log in', kind: 'login' }, { role: 'button', name: 'Continue with Google', kind: 'oauth', action: () => {
        const popup = this.h.newPage(); popup.step(this.h.firstStep || 'email'); this.h.google = popup;
      } }];
    }
  }
  step(kind, extra = {}) {
    const paths = { email: '/v3/signin/identifier', loading: '/v3/signin/identifier', password: '/v3/signin/challenge/pwd', recovery: '/v3/signin/challenge/kpe',
      email_otp: '/v3/signin/challenge/ipe', authenticator_otp: '/v3/signin/challenge/totp', sms: '/v3/signin/challenge/ipp', captcha: '/v3/signin/identifier', unknown: '/v3/signin/challenge/unknown' };
    this.navigate(extra.url || G + paths[kind]);
    this.text = extra.text ?? (kind === 'password' ? EMAIL : kind === 'email_otp' ? 'Enter the code sent to your recovery email'
      : kind === 'authenticator_otp' ? `Google Authenticator. Enter the code. ${EMAIL}` : kind === 'sms' ? 'SMS code on your phone' : '');
    const fields = {
      email: { id: extra.arabic ? '' : 'identifierId', name: extra.arabic ? 'البريد الإلكتروني أو الهاتف' : 'Email or phone', role: 'textbox', kind: 'email' },
      password: { type: 'password', kind: 'password' },
      recovery: { attrName: 'knowledgePreregisteredEmailResponse', kind: 'recovery' },
      email_otp: { id: 'idvPin', attrName: 'Pin', kind: 'email_otp' },
      authenticator_otp: { id: 'totpPin', attrName: 'totpPin', autocomplete: 'one-time-code', kind: 'authenticator_otp' },
      sms: { id: 'idvPin', attrName: 'Pin', kind: 'sms' },
      captcha: { attrName: 'captcha', kind: 'captcha' },
    };
    this.nodes = fields[kind] ? [{ tag: 'input', ...fields[kind] }] : [];
    this.nodes.push({ role: 'button', name: extra.unknownButton ? 'مجهول' : 'التالي', kind: 'next',
      id: extra.noId ? '' : kind === 'email' ? 'identifierNext' : kind === 'password' ? 'passwordNext' : kind === 'authenticator_otp' ? 'totpNext' : '' });
    if (extra.captcha) this.nodes.push({ tag: 'input', attrName: 'captcha', kind: 'captcha' });
    return this;
  }
  locator(selector) {
    if (selector === 'body') return new Locator(this, [{ tag: 'body' }]);
    const selected = this.nodes.filter(n => {
      if (selector.startsWith('[data-identifier=')) return Boolean(n.identifier) && n.identifier.toLowerCase() === /="([^"]+)"/.exec(selector)[1].toLowerCase();
      if (selector === 'input') return n.tag === 'input';
      if (selector.includes(':not(')) return n.autocomplete === 'one-time-code' && n.id !== 'idvPin' && n.attrName !== 'Pin'
        && (!selector.includes('totpPin') || (n.id !== 'totpPin' && n.attrName !== 'totpPin'));
      return selector.split(',').some(raw => {
        const s = raw.trim(), id = /#([\w-]+)/.exec(s)?.[1], name = /\[name="([^"]+)"\]/.exec(s)?.[1];
        if (id) return n.id === id;
        if (name) return n.attrName === name;
        if (s === 'input[type="password"]') return n.type === 'password';
        return false;
      });
    });
    return new Locator(this, selected);
  }
  getByRole(role, { name }) { return new Locator(this, this.nodes.filter(n => n.role === role && name.test(n.name))); }
  async waitForTimeout() { await this.h.afterWait?.(this); }
  async screenshot(options) { this.h.screenshots.push(options); return Buffer.from('synthetic-image'); }
  async bringToFront() {}
}

function harness(t, config = {}) {
  const h = { navigations: [], clicks: [], typed: [], requests: [], saves: [], cacheCalls: [], checks: [], screenshots: [], pages: [],
    cookies: [], origins: [], connected: true, session: { valid: true, pullStatus: 200, launchStatus: 200, pullCode: 0, launchCode: 0 },
    profile: { ok: true, status: 200, code: 0, entityId: 'synthetic-dola-id' }, userinfo: identity(), codeCalls: [], now: 100000, ...config };
  const events = {};
  h.newPage = () => { const p = new Page(h); h.pages.push(p); events.page?.(p); return p; };
  const response = data => ({ ok: () => true, json: async () => data, dispose: async () => {} });
  h.context = {
    on: (event, fn) => { events[event] = fn; }, newPage: async () => h.newPage(), pages: () => h.pages,
    cookies: async origin => origin ? h.cookies.filter(c => new URL(origin).hostname === c.domain.replace(/^\./, '')
      || new URL(origin).hostname.endsWith('.' + c.domain.replace(/^\./, ''))) : h.cookies,
    clearCookies: async () => { h.cookies = h.cookies.filter(c => !/dola\.com$/.test(c.domain)); },
    storageState: async () => h.storageOverride ? h.storageOverride() : ({ cookies: h.cookies, origins: h.origins }),
    request: { get: async (url, options) => {
      h.requests.push({ url, options });
      if (url === 'https://ipinfo.io/json') return response({ ip: h.badIp ? '' : '198.51.100.5' });
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return response(h.userinfo);
      throw new Error('Unexpected synthetic request');
    } },
  };
  let disconnected;
  h.browser = { on: (event, fn) => { assert.equal(event, 'disconnected'); disconnected = fn; },
    newContext: async options => { h.contextOptions = options; if (options.storageState) { h.cookies = options.storageState.cookies; h.origins = options.storageState.origins; } return h.context; },
    isConnected: () => h.connected,
    close: async () => { h.connected = false; disconnected?.(); },
  };
  h.vault = { hasRecord: async email => { h.cacheCalls.push(['has', email]); if (h.hasError) throw new Error('synthetic secret'); return Boolean(h.saved || h.hasRecord); },
    load: async (email, proxy) => { h.cacheCalls.push(['vaultLoad', email, proxy]); return h.saved || null; },
    save: async (email, proxy, data, options) => { if (h.saveOverride) return h.saveOverride(email, proxy, data, options); h.saves.push({ email, proxy, data, options }); }, clear: deny };
  h.driver = box.factory({
    getPlaywright: async () => ({ chromium: { launch: async options => { h.launchOptions = options; return h.launchOverride ? h.launchOverride() : h.browser; }, connectOverCDP: deny } }),
    openManualLoginBrowser: async options => { h.manualOptions = options; return { browser: h.browser, context: h.context, close: async () => { h.manualClosed = true; h.connected = false; } }; },
    requireLoginProxy: raw => { if (typeof raw !== 'string' || !/^(?:https?|socks5h?):\/\//.test(raw)) throw new Error('login_proxy_required'); return raw; },
    proxyOf: () => h.noProxy ? undefined : ({ server: PROXY }),
    startSocksBridge: async url => { h.bridgeInput = url; return h.bridgeOverride ? h.bridgeOverride() : { url: 'http://127.0.0.1:12345', close: async () => { h.bridgeClosed = true; } }; },
    vault: h.vault,
    legacy: { load: async (email, proxy) => { h.cacheCalls.push(['legacyLoad', email, proxy]); return h.legacy || null; }, save: deny, clear: deny },
    checkSession: async (cookies, options) => { h.checks.push({ kind: 'session', cookies, options }); return h.checkOverride ? h.checkOverride() : h.session; },
    fetchProfile: async (cookies, options) => { h.checks.push({ kind: 'profile', cookies, options }); return h.profile; },
    missingRequired: cookies => ['ttwid', 'odin_tt'].filter(key => !cookies[key]),
    fetchLoginVerificationCode: async (url, options) => { h.codeCalls.push({ url, options }); return h.codeOverride ? h.codeOverride() : '123456'; },
    now: () => h.now,
  });
  h.open = async (mode = 'password', account = { proxy: PROXY }) => {
    h.input = { email: EMAIL, password: PASSWORD, loginMethod: mode, recoveryEmail: 'recovery@example.test',
      googleSessionUrl: mode === 'google_link' ? LINK : '', verificationUrl: h.verificationUrl || MAIL, profileId: 'synthetic-profile', accountCode: 'synthetic-code' };
    h.handle = await h.driver.open(h.input, account, { signal: h.abort?.signal, onStage: phase => (h.stages ||= []).push(phase) });
    t.after(() => h.handle.close()); await flush(); return h.handle;
  };
  h.oauth = async ({ bind = true, boundValue = 'synthetic-sessionid' } = {}) => {
    h.cookies = dolaCookies();
    h.pages[0].navigate(D + '/auth/callback#access_token=' + TOKEN);
    if (bind) await events.response?.({ url: () => D + '/passport/web/auth/login/', status: () => 200,
      request: () => ({ method: () => 'POST', postData: () => JSON.stringify({ access_token: TOKEN, platform_app_id: '2085' }) }),
      json: async () => ({ message: 'success', data: { synthetic: true } }),
      headersArray: async () => [{ name: 'set-cookie', value: 'sessionid=' + boundValue + '; Secure' }] });
  };
  return h;
}

test('manual opens an empty isolated Dola context, never clicks or fills, then saves live-bound manual schema', async t => {
  const h = harness(t); await h.open('manual', { proxy: PROXY, sec_user_id: 'synthetic-dola-id' });
  assert.ok(h.manualOptions);
  assert.equal(h.manualOptions.playwright?.chromium?.connectOverCDP, deny);
  assert.deepEqual(h.cacheCalls, []);
  assert.equal((await h.handle.inspect()).reason, 'manual_login');
  assert.equal(h.navigations[0].url, D + '/chat/'); assert.equal(h.clicks.length, 0); assert.equal(h.typed.length, 0);
  h.cookies = [...dolaCookies(), cookie('.google.com', 'SID'), cookie('evil.test', 'private')];
  h.origins = [D, G, 'https://evil.test'].map(origin => ({ origin, localStorage: [{ name: 'synthetic', value: 'state' }] }));
  const result = await h.handle.inspect();
  assert.equal(result.kind, 'ready'); assert.equal(result.manual, true); assert.equal(result.identity, null); assert.equal(result.sessionVerified, true);
  assert.equal(result.loginStateSaved, true); assert.equal(result.profile.entityId, 'synthetic-dola-id');
  assert.equal(h.connected, true, 'core owns window finish');
  assert.equal(h.requests.length, 1, 'manual never queries Google UserInfo');
  assert.ok(h.checks.every(c => c.options.proxy === PROXY && !c.cookies.SID));
  assert.equal(h.saves.length, 1); assert.deepEqual(plain(h.saves[0].data), { ...record(true), origins: [{ origin: D, localStorage: [{ name: 'synthetic', value: 'state' }] }] });
  await h.handle.inspect(); assert.equal(h.saves.length, 1);
  await h.handle.close(); assert.ok(Object.entries(h.input).filter(([key]) => key !== 'loginMethod').every(([, value]) => value === ''));
});

for (const condition of ['wrong-account', 'no-entity', 'unknown', 'conflict', 'profile-http']) test('manual rejects ' + condition, async t => {
  const h = harness(t); await h.open('manual', { proxy: PROXY, sec_user_id: condition === 'wrong-account' ? 'other' : '' }); h.cookies = dolaCookies();
  if (condition === 'no-entity') h.profile = { ...h.profile, entityId: '', id: 'synthetic-dola-id' };
  if (condition === 'unknown') h.session.pullStatus = 503;
  if (condition === 'conflict') h.session.pullCode = 710012001;
  if (condition === 'profile-http') h.profile.status = 429;
  assert.equal((await h.handle.inspect()).kind, 'waiting_user'); assert.equal(h.saves.length, 0); assert.equal(h.typed.length, 0);
});

for (const mode of ['password', 'google_link']) test(mode + ' blocks corrupt vault without plaintext fallback or credentials', async t => {
  const h = harness(t, { hasRecord: true, legacy: record() }); await h.open(mode);
  assert.deepEqual(plain(await h.handle.inspect()), { kind: 'waiting_user', reason: 'saved_session', stage: 'dola_home' });
  assert.deepEqual(h.cacheCalls.map(c => c[0]), ['has', 'vaultLoad']);
  assert.equal(h.clicks.length, 0); assert.equal(h.typed.length, 0); assert.equal(h.navigations.some(n => n.url === LINK), false);
  assert.equal(h.input.password, ''); assert.equal(h.input.verificationUrl, '');
});

test('hasRecord failure is conservative and never opens legacy cache', async t => {
  const h = harness(t, { hasError: true }); await h.open();
  assert.equal((await h.handle.inspect()).reason, 'saved_session'); assert.deepEqual(h.cacheCalls.map(c => c[0]), ['has']);
});

for (const cache of ['google', 'manual', 'corrupt']) test('manual reauth ignores all stored data: ' + cache, async t => {
  const h = harness(t, { saved: cache === 'corrupt' ? null : record(cache === 'manual'), hasRecord: true });
  await h.open('manual', { proxy: PROXY, sec_user_id: 'synthetic-dola-id' });
  assert.ok(h.manualOptions); assert.equal(h.cookies.length, 0); assert.equal(h.cacheCalls.length, 0);
  assert.equal((await h.handle.inspect()).reason, 'manual_login'); assert.equal(h.saves.length, 0);
  h.cookies = dolaCookies(); const result = await h.handle.inspect();
  assert.equal(result.kind, 'ready'); assert.equal(result.manual, true); assert.equal(result.identity, null); assert.equal(result.sessionVerified, true);
  assert.equal(result.sessionReused, undefined); assert.equal(h.checks.length, 2); assert.equal(h.saves.length, 1); assert.equal(h.cacheCalls.length, 0);
});

test('manual vault identity cannot bypass ordinary Google verification', async t => {
  const h = harness(t, { saved: record(true) }); await h.open('password');
  assert.equal((await h.handle.inspect()).reason, 'saved_session'); assert.equal(h.checks.length, 0); assert.equal(h.clicks.length, 0);
});

test('legacy fallback is read-only and never migrated on successful live reuse', async t => {
  const h = harness(t, { legacy: record() }); await h.open();
  const result = await h.handle.inspect(); assert.equal(result.kind, 'ready'); assert.equal(result.sessionReused, true);
  assert.deepEqual(h.cacheCalls.map(c => c[0]), ['has', 'legacyLoad']); assert.equal(h.saves.length, 0);
});

for (const landing of ['unknown', 'timeout', 'link-empty', 'foreign-with-cookies']) test('Google link ' + landing + ' hands off without replay or account data', async t => {
  const h = harness(t, { linkLanding: landing === 'link-empty' ? LINK : 'https://unknown.example.test/result',
    linkError: landing === 'timeout', linkCookie: landing === 'foreign-with-cookies' });
  await h.open('google_link');
  assert.equal((await h.handle.inspect()).kind, 'waiting_user'); await h.handle.inspect();
  assert.equal(h.navigations.length, 1); assert.equal(h.navigations[0].url, LINK);
  assert.deepEqual(Object.keys(h.navigations[0].options).sort(), ['timeout', 'waitUntil']);
  assert.equal(h.clicks.length, 0); assert.equal(h.typed.length, 0); assert.equal(h.saves.length, 0);
  assert.equal(h.input.password, ''); assert.equal(h.input.googleSessionUrl, '');
  await assert.rejects(h.handle.preview(), { message: 'preview_unavailable' });
});

for (const cookiesOnly of [false, true]) test('Google page/cookies allow Dola OAuth but never establish identity; cookies=' + cookiesOnly, async t => {
  const h = harness(t, { linkLanding: cookiesOnly ? LINK : G + '/signin', linkCookie: cookiesOnly }); await h.open('google_link');
  assert.deepEqual(h.navigations.map(n => n.url), [LINK, D + '/chat/']);
  assert.equal(h.clicks.filter(c => c.kind === 'oauth').length, 1); assert.equal(h.saves.length, 0);
  h.google.step('unknown'); assert.equal((await h.handle.inspect()).kind, 'waiting_user');
  assert.equal(h.requests.length, 1); assert.equal(h.saves.length, 0);
});

for (const semantic of ['data', 'button', 'option', 'overlap']) test('Google link chooser selects one exact mailbox once via ' + semantic, async t => {
  const h = harness(t); await h.open('google_link');
  h.google.step('unknown', { url: G + '/v3/signin/accountchooser', text: 'Choose an account' });
  h.google.nodes = [{ kind: 'account-choice', ...(semantic === 'data' ? { identifier: EMAIL.toUpperCase() }
    : semantic === 'overlap' ? { identifier: EMAIL, role: 'button', name: EMAIL }
      : { role: semantic, name: EMAIL }) }, { kind: 'other', role: 'option', name: 'other@example.test' }];
  assert.equal((await h.handle.inspect()).kind, 'pending');
  await h.handle.inspect(); h.now += 10001; assert.equal((await h.handle.inspect()).reason, 'google_step');
  assert.equal(h.clicks.filter(c => c.kind === 'account-choice').length, 1);
  assert.equal(h.clicks.filter(c => c.kind === 'other').length, 0); assert.equal(h.saves.length, 0);
  assert.equal(h.codeCalls.length, 0); assert.equal(h.typed.length, 0);
});

for (const unsafe of ['duplicate', 'different', 'substring', 'nickname', 'consent', 'foreign', 'password-mode']) test('chooser refuses ' + unsafe, async t => {
  const h = harness(t); await h.open(unsafe === 'password-mode' ? 'password' : 'google_link');
  const url = unsafe === 'consent' ? G + '/o/oauth2/consent' : unsafe === 'foreign' ? 'https://evil.example.test/accountchooser' : G + '/v3/signin/accountchooser';
  h.google.step('unknown', { url, text: unsafe === 'consent' ? 'Allow access to your account' : 'Choose an account' });
  const label = unsafe === 'different' ? 'other@example.test' : unsafe === 'substring' ? EMAIL + '.evil' : unsafe === 'nickname' ? 'Synthetic Person' : EMAIL;
  h.google.nodes = [{ kind: 'account-choice', role: 'button', name: label, identifier: label }];
  if (unsafe === 'duplicate') h.google.nodes.push({ kind: 'duplicate-choice', role: 'option', name: EMAIL });
  const result = await h.handle.inspect();
  assert.notEqual(result.kind, 'ready'); assert.equal(h.clicks.some(c => c.kind.includes('choice')), false); assert.equal(h.saves.length, 0);
});

test('chooser selection alone never authorizes an email OTP fetch', async t => {
  const h = harness(t); await h.open('google_link');
  h.google.step('unknown', { url: G + '/v3/signin/accountchooser', text: 'Choose an account' });
  h.google.nodes = [{ kind: 'account-choice', identifier: EMAIL }]; await h.handle.inspect();
  h.google.step('email_otp'); assert.equal((await h.handle.inspect()).reason, 'security'); assert.equal(h.codeCalls.length, 0);
});

test('Arabic email, password, recovery and email OTP are typed once on Google; repeated challenge latches manual', async t => {
  const h = harness(t); await h.open(); h.google.step('email', { arabic: true, noId: true });
  assert.equal((await h.handle.inspect()).kind, 'pending');
  h.google.step('password'); assert.equal((await h.handle.inspect()).kind, 'pending'); assert.equal(h.input.password, '');
  h.google.step('recovery'); assert.equal((await h.handle.inspect()).kind, 'pending'); assert.equal(h.input.recoveryEmail, '');
  h.google.step('email_otp'); assert.equal((await h.handle.inspect()).kind, 'pending');
  assert.equal(h.codeCalls.length, 1); assert.equal(h.codeCalls[0].url, MAIL); assert.ok(h.codeCalls[0].options.signal);
  assert.deepEqual(h.typed.map(v => v.kind), ['email', 'password', 'recovery', 'email_otp']);
  assert.ok(h.typed.every(v => v.origin === G)); assert.equal(h.input.verificationUrl, '');
  assert.equal((await h.handle.inspect()).reason, 'security'); h.google.step('password'); await h.handle.inspect();
  assert.equal(h.typed.length, 4); assert.equal(h.codeCalls.length, 1);
});

for (const kind of ['sms', 'captcha', 'unknown', 'email_otp']) test('challenge without verified email submission: ' + kind, async t => {
  const h = harness(t, { firstStep: kind }); await h.open();
  assert.equal((await h.handle.inspect()).kind, 'waiting_user'); h.google.step('email'); await h.handle.inspect();
  assert.equal(h.typed.length, 0); assert.equal(h.codeCalls.length, 0); assert.equal(h.input.password, ''); assert.equal(h.input.verificationUrl, '');
});

test('recovery cannot repeat; unknown RTL confirmation never receives a click', async t => {
  const h = harness(t); await h.open(); await h.handle.inspect();
  h.google.step('recovery', { unknownButton: true }); assert.equal((await h.handle.inspect()).reason, 'security');
  h.google.step('recovery'); await h.handle.inspect();
  assert.equal(h.typed.filter(v => v.kind === 'recovery').length, 1); assert.equal(h.clicks.filter(c => c.name === 'مجهول').length, 0);
});

for (const change of ['origin', 'captcha', 'abort', 'uncertain']) test('OTP fetch rechecks challenge and cancellation: ' + change, async t => {
  const gate = deferred(), abort = new AbortController();
  const h = harness(t, { abort, codeOverride: () => gate.promise }); await h.open(); await h.handle.inspect(); h.google.step('email_otp');
  const work = h.handle.inspect(); await flush();
  assert.equal(h.codeCalls.length, 1); assert.equal((await h.handle.inspect()).kind, 'pending');
  if (change === 'origin') h.google.navigate('https://evil.example.test/');
  if (change === 'captcha') h.google.step('email_otp', { captcha: true });
  if (change === 'abort') abort.abort();
  gate.resolve(change === 'uncertain' ? '' : '123456');
  const result = await work; assert.notEqual(result.kind, 'ready');
  assert.equal(h.typed.filter(v => v.kind === 'email_otp').length, 0);
  await h.handle.inspect(); assert.equal(h.codeCalls.length, 1); assert.equal(h.input.password, ''); assert.equal(h.input.verificationUrl, '');
});

for (const digits of ['1234', '12345', '1234567', '12345678', '123456789']) test('OTP injected result must have exactly 6 or 8 digits: length=' + digits.length, async t => {
  const h = harness(t, { codeOverride: async () => digits }); await h.open(); await h.handle.inspect(); h.google.step('email_otp');
  const result = await h.handle.inspect();
  assert.equal(result.kind, digits.length === 8 ? 'pending' : 'waiting_user');
  assert.equal(h.typed.filter(v => v.kind === 'email_otp').length, digits.length === 8 ? 1 : 0);
});

test('a Google page that leaves and returns loses its verified-email OTP flow', async t => {
  const h = harness(t); await h.open(); await h.handle.inspect();
  h.google.navigate('https://evil.example.test/'); h.google.step('email_otp');
  assert.equal((await h.handle.inspect()).reason, 'security'); assert.equal(h.codeCalls.length, 0);
});

test('origin change during password preparation never transmits a password', async t => {
  const h = harness(t); await h.open(); h.google.step('password');
  h.afterFill = async page => page.navigate('https://evil.example.test/');
  assert.equal((await h.handle.inspect()).kind, 'waiting_user'); assert.equal(h.typed.length, 0); assert.equal(h.input.password, '');
});

for (const bad of ['identity', 'binding', 'account']) test('Google completion rejects ' + bad + ' mismatch', async t => {
  const h = harness(t); await h.open('password', { proxy: PROXY, sec_user_id: bad === 'account' ? 'other' : '' });
  if (bad === 'identity') h.userinfo.email = 'other@example.test';
  await h.oauth({ boundValue: bad === 'binding' ? 'wrong' : 'synthetic-sessionid' });
  assert.notEqual((await h.handle.inspect()).kind, 'ready'); assert.equal(h.saves.length, 0);
});

test('Google ready requires OIDC plus token exchange/session binding and saves scoped cookies+origins', async t => {
  const h = harness(t); await h.open('google_link'); await h.oauth({ bind: false });
  assert.equal((await h.handle.inspect()).reason, 'binding'); assert.equal(h.saves.length, 0);
  await h.oauth(); h.origins = [{ origin: G, localStorage: [{ name: 'synthetic', value: 'google' }] }, { origin: 'https://gapi.mailsapi.com', localStorage: [] }];
  const result = await h.handle.inspect(); assert.equal(result.kind, 'ready'); assert.deepEqual(plain(result.identity), identity());
  assert.equal(result.manual, undefined); assert.equal(h.saves.length, 1); assert.equal(h.saves[0].data.manual, undefined);
  assert.deepEqual(plain(h.saves[0].data.origins), [{ origin: G, localStorage: [{ name: 'synthetic', value: 'google' }] }]);
  assert.equal(h.saves[0].proxy, PROXY); assert.equal(h.saves[0].data.dolaId, 'synthetic-dola-id');
  assert.ok(h.requests.find(r => /userinfo$/.test(r.url)).options.headers.Authorization.endsWith(TOKEN));
});

test('manual save failure reports unsaved; cancellation aborts save and cannot return ready', async t => {
  const h = harness(t, { saveOverride: async () => { throw new Error('synthetic private failure'); } });
  await h.open('manual'); h.cookies = dolaCookies(); const result = await h.handle.inspect();
  assert.equal(result.kind, 'ready'); assert.equal(result.loginStateSaved, false);
  const gate = deferred(), abort = new AbortController(); let receivedSignal;
  const k = harness(t, { abort, saveOverride: async (_email, _proxy, _data, { signal }) => { receivedSignal = signal; await gate.promise; } });
  await k.open('manual'); k.cookies = dolaCookies(); const work = k.handle.inspect(); await flush();
  abort.abort(); assert.equal(receivedSignal.aborted, true); gate.resolve();
  assert.equal((await work).kind, 'failed'); assert.equal(k.connected, false);
});

test('changed cookies during storage capture cannot be saved as the verified session', async t => {
  const h = harness(t); await h.open('manual'); h.cookies = dolaCookies();
  h.storageOverride = async () => ({ cookies: dolaCookies().map(c => ({ ...c, value: 'switched' })), origins: [] });
  assert.equal((await h.handle.inspect()).reason, 'session'); assert.equal(h.saves.length, 0);
});

test('preview masks input controls and does not close a verified window', async t => {
  const h = harness(t); await h.open(); await h.handle.preview();
  assert.equal(h.screenshots.length, 1); assert.equal(h.screenshots[0].mask.length, 1);
  assert.equal(h.screenshots[0].mask[0].nodes[0].tag, 'input'); assert.equal(h.connected, true);
});

test('driver entry rejects sensitive URL before cache/browser work with secret-safe errors', async t => {
  const h = harness(t); const input = { email: EMAIL, password: PASSWORD, loginMethod: 'google_link', googleSessionUrl: LINK + '&extra=bad', verificationUrl: MAIL };
  await assert.rejects(h.driver.open(input, { proxy: PROXY }), { message: 'google_browser_unavailable' });
  assert.equal(h.cacheCalls.length, 0); assert.equal(h.launchOptions, undefined); assert.equal(input.password, ''); assert.equal(input.googleSessionUrl, '');
});

for (const bad of ['missing', 'parse', 'exit-ip']) test('mandatory proxy fails closed: ' + bad, async t => {
  const h = harness(t, { noProxy: bad === 'parse', badIp: bad === 'exit-ip' });
  await assert.rejects(h.open('password', { proxy: bad === 'missing' ? '' : PROXY }), { message: 'google_browser_unavailable' });
  assert.equal(h.typed.length, 0); assert.equal(h.navigations.length, 0);
  if (bad === 'exit-ip') assert.equal(h.connected, false); else assert.equal(h.launchOptions, undefined);
});

test('cancellation while browser launch is pending closes the late browser and erases all secrets', async t => {
  const gate = deferred(), abort = new AbortController(), h = harness(t, { abort, launchOverride: () => gate.promise });
  const opening = h.open(); await flush(); abort.abort(); gate.resolve(h.browser);
  await assert.rejects(opening, { message: 'google_browser_unavailable' }); assert.equal(h.connected, false); assert.equal(h.contextOptions, undefined);
  assert.ok(Object.entries(h.input).filter(([key]) => key !== 'loginMethod').every(([, value]) => value === ''));
});

test('SOCKS authentication stays on the bridge and bridge closes with the browser', async t => {
  const h = harness(t), proxy = 'socks5://synthetic:synthetic@proxy.example.invalid:1080';
  await h.open('manual', { proxy });
  assert.equal(h.bridgeInput, proxy); assert.equal(h.manualOptions.proxy.server, 'http://127.0.0.1:12345');
  h.cookies = dolaCookies(); assert.equal((await h.handle.inspect()).kind, 'ready');
  assert.ok(h.checks.every(c => c.options.proxy === proxy));
  await h.handle.close(); assert.equal(h.bridgeClosed, true);
});

test('a late SOCKS bridge is closed after cancellation before browser launch', async t => {
  const gate = deferred(), abort = new AbortController(), h = harness(t, { abort, bridgeOverride: () => gate.promise });
  const opening = h.open('manual', { proxy: 'socks5://proxy.example.invalid:1080' }); await flush(); abort.abort();
  gate.resolve({ url: 'http://127.0.0.1:12345', close: async () => { h.bridgeClosed = true; } });
  await assert.rejects(opening, { message: 'google_browser_unavailable' }); assert.equal(h.bridgeClosed, true); assert.equal(h.launchOptions, undefined);
});

async function startTotp(t, config = {}) {
  const h = harness(t, config); await h.open(); await h.handle.inspect();
  h.google.step('password'); await h.handle.inspect();
  h.google.step('authenticator_otp');
  return h;
}
const rejectedTotp = h => h.google.step('authenticator_otp', { text: `Google Authenticator. Wrong code. ${EMAIL}` });
const totpTypes = h => h.typed.filter(v => v.kind === 'authenticator_otp');

test('TOTP has its own parser profile, one submission and Google/Dola identity is still required', async t => {
  const h = await startTotp(t);
  assert.equal((await h.handle.inspect()).stage, 'otp_submitted');
  assert.equal(h.codeCalls.length, 1); assert.equal(h.codeCalls[0].options.profile, 'authenticator');
  assert.equal(totpTypes(h).length, 1); assert.equal(totpTypes(h)[0].value, '123456');
  assert.equal(h.clicks.filter(v => v.id === 'totpNext').length, 1);
  assert.equal(h.input.verificationUrl, ''); assert.equal(h.saves.length, 0);
  for (let n = 0; n < 4; n++) assert.equal((await h.handle.inspect()).stage, 'otp_submitted');
  assert.equal(h.codeCalls.length, 1); assert.equal(totpTypes(h).length, 1);
  await h.oauth(); const result = await h.handle.inspect();
  assert.equal(result.kind, 'ready'); assert.equal(h.saves.length, 1);
  assert.ok(h.requests.some(r => r.url.endsWith('/userinfo')));
});

test('TOTP rejection waits, suppresses an unchanged code, then submits only a new code', async t => {
  let calls = 0;
  const h = await startTotp(t, { codeOverride: async () => ++calls < 3 ? '123456' : '654321' });
  await h.handle.inspect(); rejectedTotp(h);
  assert.equal((await h.handle.inspect()).stage, 'otp_waiting_refresh');
  assert.equal(h.codeCalls.length, 1);
  h.now += 15000;
  assert.equal((await h.handle.inspect()).stage, 'otp_same_code'); assert.equal(totpTypes(h).length, 1);
  assert.equal((await h.handle.inspect()).stage, 'otp_waiting_refresh'); assert.equal(h.codeCalls.length, 2);
  h.now += 15000;
  assert.equal((await h.handle.inspect()).stage, 'otp_submitted');
  assert.deepEqual(totpTypes(h).map(v => v.value), ['123456', '654321']);
  rejectedTotp(h);
  assert.equal((await h.handle.inspect()).reason, 'otp_refresh_exhausted');
  h.now += 90000; await h.handle.inspect();
  assert.equal(h.codeCalls.length, 3); assert.equal(h.saves.length, 0);
});

test('unchanged TOTP exhausts three reads without repeating a submission', async t => {
  const h = await startTotp(t); await h.handle.inspect(); rejectedTotp(h);
  h.now += 15000; assert.equal((await h.handle.inspect()).stage, 'otp_same_code');
  h.now += 15000; assert.equal((await h.handle.inspect()).reason, 'otp_refresh_exhausted');
  assert.equal(totpTypes(h).length, 1); assert.equal(h.codeCalls.length, 3);
  await h.handle.inspect(); assert.equal(h.codeCalls.length, 3);
});

test('TOTP does not silently retry while Google has not acknowledged submission', async t => {
  const h = await startTotp(t); await h.handle.inspect(); h.now += 15000;
  assert.equal((await h.handle.inspect()).reason, 'otp_not_accepted');
  assert.equal(h.codeCalls.length, 1); assert.equal(totpTypes(h).length, 1);
});

test('TOTP deadline never resets on polling or refresh', async t => {
  const h = await startTotp(t); await h.handle.inspect(); rejectedTotp(h); h.now += 90000;
  assert.equal((await h.handle.inspect()).reason, 'otp_refresh_exhausted');
  assert.equal(h.codeCalls.length, 1);
});

for (const condition of ['no-email-flow', 'other-email', 'missing-email', 'initial-rejection', 'captcha', 'duplicate-input']) {
  test('TOTP refuses an unverified or ambiguous context: ' + condition, async t => {
    const h = condition === 'no-email-flow' ? harness(t, { firstStep: 'authenticator_otp' }) : await startTotp(t);
    if (condition === 'no-email-flow') await h.open();
    if (condition === 'other-email') h.google.text = 'Google Authenticator code other@example.test';
    if (condition === 'missing-email') h.google.text = 'Google Authenticator code';
    if (condition === 'initial-rejection') rejectedTotp(h);
    if (condition === 'captcha') h.google.step('authenticator_otp', { captcha: true });
    if (condition === 'duplicate-input') h.google.nodes.push({ ...h.google.nodes[0] });
    assert.equal((await h.handle.inspect()).kind, 'waiting_user');
    assert.equal(h.codeCalls.length, 0); assert.equal(totpTypes(h).length, 0); assert.equal(h.saves.length, 0);
  });
}

for (const change of ['origin', 'captcha', 'email', 'kind', 'second-google-page', 'abort', 'deadline']) {
  test('TOTP rechecks account/page after asynchronous fetch: ' + change, async t => {
    const gate = deferred(), abort = new AbortController();
    const h = await startTotp(t, { abort, codeOverride: () => gate.promise });
    const pending = h.handle.inspect(); await flush(); assert.equal(h.codeCalls.length, 1);
    if (change === 'origin') h.google.navigate('https://evil.example.test/');
    if (change === 'captcha') h.google.step('authenticator_otp', { captcha: true });
    if (change === 'email') h.google.text = 'Google Authenticator other@example.test';
    if (change === 'kind') h.google.step('email_otp');
    if (change === 'second-google-page') h.newPage().step('authenticator_otp');
    if (change === 'abort') abort.abort();
    if (change === 'deadline') h.now += 90000;
    gate.resolve('123456');
    assert.notEqual((await pending).kind, 'ready'); assert.equal(totpTypes(h).length, 0);
    assert.equal(h.input.verificationUrl, ''); assert.equal(h.saves.length, 0);
  });
}

test('TOTP checks identity again during slow input preparation', async t => {
  const h = await startTotp(t);
  h.afterFill = async page => { page.text = 'Google Authenticator other@example.test'; };
  assert.equal((await h.handle.inspect()).reason, 'otp_step_changed');
  assert.equal(totpTypes(h).length, 0); assert.equal(h.clicks.filter(v => v.id === 'totpNext').length, 0);
});

for (const value of ['', '1234567', '12345678', 'code:123456', 123456, null]) {
  test('TOTP rejects malformed injected code: ' + String(value), async t => {
    const h = await startTotp(t, { codeOverride: async () => value });
    assert.equal((await h.handle.inspect()).reason, 'otp_fetch_failed'); assert.equal(totpTypes(h).length, 0);
  });
}

test('TOTP fetch errors are safe and latch manual without further requests', async t => {
  const h = await startTotp(t, { codeOverride: async () => { throw new Error('synthetic-secret-url'); } });
  const result = await h.handle.inspect(); assert.equal(result.reason, 'otp_fetch_failed');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
  h.now += 60000; await h.handle.inspect(); assert.equal(h.codeCalls.length, 1);
});

test('email OTP cannot implicitly reuse its endpoint for a subsequent TOTP', async t => {
  const h = harness(t); await h.open(); await h.handle.inspect(); h.google.step('email_otp'); await h.handle.inspect();
  h.google.step('authenticator_otp'); assert.equal((await h.handle.inspect()).reason, 'otp_identity');
  assert.equal(h.codeCalls.length, 1); assert.equal(totpTypes(h).length, 0);
});

test('allowlisted HTTP/public-IP endpoint reaches only the injected TOTP fetcher', async t => {
  const previous = process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST;
  process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST = 'http://93.184.216.34:8000/2fa/';
  t.after(() => { if (previous === undefined) delete process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST;
    else process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST = previous; });
  const verificationUrl = 'http://93.184.216.34:8000/2fa/synthetic-only';
  const h = await startTotp(t, { verificationUrl });
  assert.equal((await h.handle.inspect()).stage, 'otp_submitted');
  assert.equal(h.codeCalls[0].url, verificationUrl);
  assert.equal(h.codeCalls[0].options.profile, 'authenticator');
  assert.equal(h.launchOptions.proxy.server, PROXY); assert.equal(h.input.verificationUrl, '');
});

for (const change of ['unknown-google-step', 'foreign-origin', 'duplicate-google-window']) {
  test('a TOTP page change between polls requests a security pause: ' + change, async t => {
    const h = await startTotp(t); await h.handle.inspect();
    if (change === 'unknown-google-step') h.google.step('unknown');
    if (change === 'foreign-origin') h.google.navigate('https://evil.example.test/');
    if (change === 'duplicate-google-window') h.newPage().step('email');
    assert.equal((await h.handle.inspect()).reason, 'otp_step_changed');
    assert.equal(h.codeCalls.length, 1); assert.equal(totpTypes(h).length, 1);
  });
}

test('a Google page still mounting its email form does not erase the pending credentials', async t => {
  const h = harness(t, { firstStep: 'loading' }); await h.open();
  const result = await h.handle.inspect();
  assert.equal(result.kind, 'pending'); assert.equal(result.stage, 'google_redirect');
  assert.equal(h.input.password, PASSWORD); assert.equal(h.typed.length, 0);
  h.now += 10000; h.google.step('email');
  assert.equal((await h.handle.inspect()).stage, 'google_email');
  assert.equal(h.typed[0].value, EMAIL);
  h.google.step('password'); assert.equal((await h.handle.inspect()).stage, 'google_password');
  assert.equal(h.typed[1].value, PASSWORD);
});

test('Google form grace is bounded and does not postpone CAPTCHA handling', async t => {
  const h = harness(t, { firstStep: 'loading' }); await h.open(); h.now += 15000;
  assert.equal((await h.handle.inspect()).kind, 'waiting_user'); assert.equal(h.input.password, '');
  const k = harness(t, { firstStep: 'captcha' }); await k.open();
  assert.equal((await k.handle.inspect()).reason, 'captcha'); assert.equal(k.input.password, '');
});

test('a Google body readiness timeout retains credentials only within the loading grace', async t => {
  const h = harness(t); await h.open();
  h.bodyError = Object.assign(new Error('synthetic DOM not ready'), { name: 'TimeoutError' });
  assert.equal((await h.handle.inspect()).kind, 'pending');
  assert.equal(h.input.password, PASSWORD); assert.equal(h.typed.length, 0);
  h.now += 5000; h.bodyError = null;
  assert.equal((await h.handle.inspect()).stage, 'google_email');
  assert.equal(h.typed[0].value, EMAIL);
  const k = harness(t); await k.open();
  k.bodyError = Object.assign(new Error('synthetic DOM not ready'), { name: 'TimeoutError' });
  k.now += 15000;
  assert.equal((await k.handle.inspect()).kind, 'waiting_user');
  assert.equal(k.input.password, ''); assert.equal(k.typed.length, 0);
});

test('non-readiness DOM errors do not retain credentials or get automatic retries', async t => {
  const h = harness(t); await h.open(); h.bodyError = new Error('synthetic failure');
  assert.equal((await h.handle.inspect()).kind, 'waiting_user');
  assert.equal(h.input.password, '');
  h.bodyError = null; await h.handle.inspect(); assert.equal(h.typed.length, 0);
});

test('driver phases come from fixed keys and browser closure is not a bad-password verdict', async t => {
  const h = harness(t); await h.open();
  for (const key of ['session_restore', 'browser_launch', 'proxy_check', 'dola_home', 'dola_google_button', 'google_redirect']) assert.ok(h.stages.includes(key));
  await h.browser.close();
  assert.equal((await h.handle.inspect()).reason, 'browser_closed');
  assert.doesNotMatch(JSON.stringify(h.stages), /synthetic|https|@/);
});
