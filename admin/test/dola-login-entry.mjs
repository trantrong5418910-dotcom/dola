import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDolaGoogleLogin, DOLA_GOOGLE_LOGIN_LABEL } from '../server/dola/dola-login-entry.js';

const D = 'https://www.dola.com', G = 'https://accounts.google.com';
function fixture(options = {}) {
  const state = { now: 0, clicks: [], stages: [], dialog: false, url: 'about:blank', pages: [], ...options };
  const abort = new AbortController();
  const button = kind => ({
    isVisible: async () => true,
    isEnabled: async () => state.now >= (state.enabledAt || 0),
    click: async () => {
      state.clicks.push(kind);
      if (kind === 'login') { state.dialog = true; return; }
      if (state.sameTab) state.url = G + '/v3/signin/identifier';
      else {
        state.googleAt = state.now + (state.redirectDelay || 0);
        const popup = { isClosed: () => false, url: () => state.now >= state.googleAt ? G + '/v3/signin/identifier' : 'about:blank' };
        state.pages.push(popup);
        if (state.duplicateGoogle) state.pages.push(popup);
      }
    },
  });
  const page = {
    isClosed: () => Boolean(state.closed), url: () => state.url,
    goto: async () => {
      state.url = state.landing || D + '/chat/'; state.now += state.navigationMs || 0;
      if (state.navError) throw Object.assign(new Error('synthetic-private-network-error'), { name: state.navError });
    },
    getByRole: (role, { name }) => {
      assert.equal(role, 'button');
      const nodes = [];
      if (!state.dialog && !state.neverLogin && state.now >= (state.loginAt || 0) && name.test('登录')) {
        nodes.push(button('login')); if (state.duplicateLogin) nodes.push(button('login'));
      }
      if (state.dialog && name.test(state.providerName || 'Google 登录')) {
        nodes.push(button('google')); if (state.duplicateProvider) nodes.push(button('google'));
      }
      return { count: async () => nodes.length, nth: i => nodes[i] };
    },
  };
  state.pages.push(page);
  const run = extra => openDolaGoogleLogin(page, {
    context: { pages: () => state.pages }, signal: abort.signal,
    now: () => state.now, sleep: async ms => { state.now += ms; if (state.abortAt && state.now >= state.abortAt) abort.abort(); },
    onStage: stage => state.stages.push(stage), ...extra,
  });
  return { state, run, abort };
}

test('observed zh-CN Google 登录 name is recognized, not a broad Google substring', async () => {
  assert.ok(DOLA_GOOGLE_LOGIN_LABEL.test('Google 登录'));
  for (const label of ['Google 登录教程', '取消 Google 登录', 'Not Google', '登录']) assert.equal(DOLA_GOOGLE_LOGIN_LABEL.test(label), false);
  const f = fixture(); assert.equal((await f.run()).kind, 'google');
  assert.deepEqual(f.state.clicks, ['login', 'google']);
  assert.deepEqual(f.state.stages, ['dola_home', 'dola_login_button', 'dola_google_button', 'google_redirect']);
});

test('a 65-second skeleton is not mistaken for absent login; controls are clicked once', async () => {
  const f = fixture({ navigationMs: 15000, loginAt: 65000 });
  assert.equal((await f.run()).kind, 'google');
  assert.equal(f.state.now, 65000); assert.deepEqual(f.state.clicks, ['login', 'google']);
});

test('disabled login is not clicked until enabled', async () => {
  const f = fixture({ enabledAt: 35000 }); await f.run();
  assert.equal(f.state.now, 35000); assert.deepEqual(f.state.clicks, ['login', 'google']);
});

test('about:blank popup gets bounded time to become Google without another click', async () => {
  const f = fixture({ redirectDelay: 15000 }); await f.run();
  assert.equal(f.state.now, 15000); assert.deepEqual(f.state.clicks, ['login', 'google']);
});

test('same-tab Google OAuth navigation is supported', async () => {
  const f = fixture({ sameTab: true }); assert.equal((await f.run()).kind, 'google');
});

test('an already open Dola login dialog does not get a second login click', async () => {
  const f = fixture({ dialog: true }); await f.run(); assert.deepEqual(f.state.clicks, ['google']);
});

for (const option of ['duplicateLogin', 'duplicateProvider', 'duplicateGoogle']) {
  test('ambiguous entry is stopped: ' + option, async () => {
    const f = fixture({ [option]: true });
    await assert.rejects(f.run(), { code: 'ENTRY_AMBIGUOUS' });
    assert.equal(f.state.clicks.filter(x => x === 'google').length, option === 'duplicateGoogle' ? 1 : 0);
  });
}

test('one 120-second budget includes document and delayed redirect', async () => {
  const f = fixture({ navigationMs: 45000, loginAt: 80000, redirectDelay: 80000 });
  await assert.rejects(f.run(), { code: 'ENTRY_TIMEOUT' });
  assert.equal(f.state.now, 120000); assert.deepEqual(f.state.clicks, ['login', 'google']);
});

test('missing login ends within the shared budget, without repeated navigation', async () => {
  const f = fixture({ neverLogin: true }); await assert.rejects(f.run(), { code: 'ENTRY_TIMEOUT' });
  assert.equal(f.state.now, 120000); assert.deepEqual(f.state.clicks, []);
});

test('cancellation stops a slow skeleton before any clicks', async () => {
  const f = fixture({ loginAt: 60000, abortAt: 1000 });
  await assert.rejects(f.run(), { code: 'ENTRY_CANCELLED' }); assert.deepEqual(f.state.clicks, []);
});

test('foreign navigation cannot receive credentials or login clicks', async () => {
  const f = fixture({ landing: 'https://evil.example.test/chat/' });
  await assert.rejects(f.run(), { code: 'ENTRY_ORIGIN' }); assert.deepEqual(f.state.clicks, []);
});

test('document timeout at the verified Dola origin still checks actual DOM readiness', async () => {
  const f = fixture({ navError: 'TimeoutError', navigationMs: 45000, loginAt: 60000 });
  assert.equal((await f.run()).kind, 'google'); assert.equal(f.state.now, 60000);
});

test('network errors do not become blind retry or leak transport errors', async () => {
  const f = fixture({ navError: 'Error' });
  await assert.rejects(f.run(), e => e.code === 'ENTRY_NAVIGATION' && !e.message.includes('private'));
  assert.deepEqual(f.state.clicks, []);
});

test('already observed callback only returns callback, never an authenticated-ready result', async () => {
  const f = fixture({ redirectDelay: 10000 }); assert.deepEqual(await f.run({ hasCallback: () => true }), { kind: 'callback' });
});

test('invalid entry timeouts cannot extend the bound', async () => {
  for (const timeoutMs of [0, -1, 120001, Infinity, '120000']) {
    const f = fixture(); await assert.rejects(f.run({ timeoutMs }), { code: 'ENTRY_OPTIONS' });
    assert.deepEqual(f.state.clicks, []);
  }
});
