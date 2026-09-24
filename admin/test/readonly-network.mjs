import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { READONLY_CONTEXT_OPTIONS, permitsReadonlyRequest, installReadonlyNetwork, preserveDiagnosticUrlParse } from '../server/dola/readonly-network.js';

test('allows observed POST reads, never generation, logout, unknown writes or origin lookalikes', () => {
  assert.equal(READONLY_CONTEXT_OPTIONS.serviceWorkers, 'block');
  for (const path of ['/im/message/send_rate_limit', '/samantha/skill/pack', '/alice/slot/action_bar_v3/get_item_conf']) {
    assert.equal(permitsReadonlyRequest(`https://www.dola.com${path}?fixture=1`, 'POST'), true);
  }
  for (const [url, method] of [
    ['https://www.dola.com/chat/completion?fixture=1', 'POST'],
    ['https://www.dola.com/chat/completion?fixture=1', 'GET'],
    ['https://www.dola.com/chat/', 'POST'], ['https://www.dola.com/im/conversation/create', 'POST'],
    ['https://www.dola.com/passport/web/logout/', 'GET'],
    ['https://www.dola.com.invalid/im/message/send_rate_limit', 'POST'],
    ['https://sub.dola.com/im/message/send_rate_limit', 'POST'],
    ['http://www.dola.com/im/message/send_rate_limit', 'POST'],
    ['https://www.dola.com/im/message/send_rate_limit', 'DELETE'],
    ['https://user:pass@www.dola.com/im/message/send_rate_limit', 'POST'],
  ]) assert.equal(permitsReadonlyRequest(url, method), false, `${method} ${url}`);
  assert.equal(permitsReadonlyRequest('https://cdn.example.invalid/app.js', 'GET'), true);
});

test('blocked callback errors still abort; no WebSocket server connection', async () => {
  let http, websocket, aborted = 0, continued = 0, closed = 0;
  const context = {
    route: async (_p, fn) => { http = fn; }, routeWebSocket: async (_p, fn) => { websocket = fn; },
  };
  await installReadonlyNetwork(context, { onBlocked: () => { throw Error('synthetic diagnostic error'); } });
  websocket({ close: () => closed++ });
  assert.equal(closed, 1);
  const route = method => ({ request: () => ({ url: () => 'https://www.dola.com/chat/', method: () => method }),
    abort: async () => { aborted++; }, continue: async () => { continued++; } });
  await assert.rejects(http(route('POST')), /synthetic/);
  assert.equal(aborted, 1); assert.equal(continued, 0);
  await http(route('GET')); assert.equal(continued, 1);
});

test('old runtime without WebSocket isolation fails before opening a page', async () => {
  await assert.rejects(installReadonlyNetwork({}), /WebSocket isolation/);
});

test('SDK exceptions are exact HTTPS hosts and paths, not wildcards', () => {
  const url = 'https://mssdk.bytedance.com/web/r/token';
  assert.equal(permitsReadonlyRequest(url, 'POST'), true);
  for (const other of [url.replace('https:', 'http:'), url.replace('.com/', '.com.invalid/'),
    url + '/extra', 'https://mssdk.bytedance.com/account/create']) {
    assert.equal(permitsReadonlyRequest(other, 'POST'), false);
  }
});

test('diagnostic-only URL shim preserves parsing after constructor replacement, without faking responses', () => {
  const sandbox = { URL, NativeURL: URL };
  vm.createContext(sandbox);
  vm.runInContext(`(${preserveDiagnosticUrlParse.toString()})();
    globalThis.URL = function SiteURL(...args) { return new NativeURL(...args); };
    globalThis.relative = URL.parse('/path', 'https://example.invalid').href;
    globalThis.invalid = URL.parse('invalid');`, sandbox);
  assert.equal(sandbox.relative, 'https://example.invalid/path');
  assert.equal(sandbox.invalid, null);
  assert.notEqual(sandbox.URL, URL);
});
