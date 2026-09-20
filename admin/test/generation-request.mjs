import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { installVideoRequestAdapter } from '../server/dola/generation-request.js';

// Deliberately no browser, fetch implementation, account, DB or network imports.
// Node's Request/streams encode and decode only memory owned by these fixtures.
const endpoint = 'https://www.dola.com/chat/completion';
const source = `(${installVideoRequestAdapter.toString()})(configuration)`;
const bodyLimit = 1024 * 1024;
const fixturePrompt = 'synthetic prompt; cookie=fixture-cookie; token=fixture-token';
const makeParam = (extra = {}) => ({ model: 'seedance_v2.5', duration: 10, prompt: fixturePrompt, ...extra });
function payload({ param = makeParam(), stringParam = true, type = 17 } = {}) {
  return { conversation_id: 'synthetic-id', chat_ability: {
    ability_type: type, ability_param: stringParam ? JSON.stringify(param) : param,
  }, prompt: fixturePrompt, untouched: { membership: 'free', enabled: false } };
}
const encode = options => JSON.stringify(payload(options));
function getParam(body) {
  const param = JSON.parse(body).chat_ability.ability_param;
  return typeof param === 'string' ? JSON.parse(param) : param;
}
function harness({ seconds = 30, targetModel = null, href = 'https://www.dola.com/chat/',
  fetchError = null, xhrError = null } = {}) {
  const fetchCalls = [];
  const xhrCalls = [];
  const logs = [];
  class MemoryXHR {
    open(method, url, ...rest) {
      if (url === 'invalid-fixture-url') throw new Error(fixturePrompt);
      this.opened = { method, url, rest };
      return 'opened';
    }
    send(body) {
      xhrCalls.push({ ...this.opened, body, receiver: this, argumentCount: arguments.length });
      if (xhrError) throw xhrError;
      return 'sent';
    }
  }
  const originalFetch = async function (input, init) {
    const call = { input, init, receiver: this, argumentCount: arguments.length };
    fetchCalls.push(call);
    if (fetchError) throw fetchError;
    const request = new Request(input instanceof Request ? input : new URL(input, href), init);
    Object.assign(call, { method: request.method, url: request.url, credentials: request.credentials,
      headers: [...request.headers], body: await request.text() });
    return { ok: true, fixture: 'memory-only' };
  };
  const originalOpen = MemoryXHR.prototype.open;
  const originalSend = MemoryXHR.prototype.send;
  const context = vm.createContext({
    URL, Request, TextEncoder, TextDecoder, XMLHttpRequest: MemoryXHR,
    location: { href }, fetch: originalFetch,
    console: Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map(key => [key, (...args) => logs.push(args)])),
  });
  vm.runInContext('window = globalThis', context);
  function install(options = { seconds, targetModel }) {
    context.configuration = options;
    // Serialization into a fresh VM proves there are no module-scope dependencies.
    vm.runInContext(source, context, { timeout: 1000 });
    delete context.configuration;
  }
  install();
  const caps = () => JSON.parse(JSON.stringify(context.__CAP ?? []));
  const send = body => context.fetch(endpoint, { method: 'POST', body });
  return { context, fetchCalls, xhrCalls, logs, install, caps, send,
    originalFetch, originalOpen, originalSend };
}

for (const stringParam of [true, false]) {
  test(`serialized installer patches ${stringParam ? 'string' : 'object'} ability_param and preserves all other values`, async () => {
    const h = harness();
    const original = payload({ stringParam });
    const expected = payload({ stringParam, param: makeParam({ duration: 30 }) });
    const init = Object.freeze({ method: 'POST', body: JSON.stringify(original),
      headers: { 'x-fixture': 'kept' }, credentials: 'omit' });
    assert.deepEqual(await h.context.fetch(endpoint, init), { ok: true, fixture: 'memory-only' });
    assert.deepEqual(JSON.parse(h.fetchCalls[0].body), expected);
    assert.equal(init.body, JSON.stringify(original));
    assert.equal(h.fetchCalls[0].credentials, 'omit');
    assert.deepEqual(h.caps(), [{ model: 'seedance_v2.5', before: 10, after: 30,
      modelAfter: 'seedance_v2.5', via: 'fetch-init' }]);
  });
}

test('already 30s numeric/string bodies remain byte-for-byte unchanged and are observed', async () => {
  const h = harness();
  for (const duration of [30, '30']) {
    const body = JSON.stringify(payload({ param: makeParam({ duration }) }), null, 2);
    const init = { method: 'POST', body };
    await h.context.fetch(endpoint, init);
    assert.equal(h.fetchCalls.at(-1).body, body);
    assert.equal(h.fetchCalls.at(-1).init, init);
    assert.equal(h.caps().at(-1).after, duration);
  }
});

test('30s observer mode records the request without rewriting its duration', async () => {
  const h = harness();
  h.install({ seconds: 30, targetModel: 'seedance_v2.5', rewrite: false });
  const body = encode({ param: makeParam({ duration: 10 }) });
  await h.send(body);
  assert.equal(h.fetchCalls.at(-1).body, body);
  assert.deepEqual(h.caps().at(-1), { model: 'seedance_v2.5', before: 10, after: 10,
    modelAfter: 'seedance_v2.5', via: 'fetch-init' });
});

test('bounded nested object/array and multiply encoded envelope JSON is supported', async () => {
  const h = harness();
  const original = { data: JSON.stringify({ messages: [payload({ stringParam: false })] }) };
  await h.send(JSON.stringify(original));
  const inner = JSON.parse(JSON.parse(h.fetchCalls[0].body).data);
  assert.equal(inner.messages[0].chat_ability.ability_param.duration, 30);
  assert.equal(inner.messages[0].prompt, fixturePrompt);
  const double = payload();
  double.chat_ability.ability_param = JSON.stringify(double.chat_ability.ability_param);
  await h.send(JSON.stringify({ payload: JSON.stringify(JSON.stringify(double)) }));
  const unpacked = JSON.parse(JSON.parse(JSON.parse(h.fetchCalls[1].body).payload));
  assert.equal(JSON.parse(JSON.parse(unpacked.chat_ability.ability_param)).duration, 30);
});

test('prompt/text/content and unknown metadata are opaque even when they resemble video requests', async () => {
  const h = harness();
  const original = payload({ stringParam: false });
  const fake = payload({ stringParam: false });
  original.prompt = fake;
  original.content = [fake];
  original.text = JSON.stringify(fake);
  original.metadata = fake;
  original.chat_ability.ability_param.prompt = { payload: fake };
  await h.send(JSON.stringify(original));
  const expected = structuredClone(original);
  expected.chat_ability.ability_param.duration = 30;
  assert.deepEqual(JSON.parse(h.fetchCalls[0].body), expected);
  assert.equal(h.caps().length, 1);
});

test('30s never promotes 2.0/unknown/missing models, even with targetModel 2.5', async () => {
  const h = harness({ targetModel: 'seedance_v2.5' });
  for (const model of ['seedance_v2.0', 'seedance_v2', 'unknown', fixturePrompt, null, {}, undefined]) {
    const body = encode({ param: makeParam({ model }) });
    await h.send(body);
    assert.equal(h.fetchCalls.at(-1).body, body);
  }
  assert.equal(h.caps()[0].model, 'seedance_v2.0');
  assert.ok(h.caps().slice(1).every(cap => cap.model === null && cap.modelAfter === null));
  assert.equal(JSON.stringify(h.caps()).includes(fixturePrompt), false);
});

test('15s expert observer never rewrites Seedance 2.0 payloads', async () => {
  const h = harness({ seconds: 15, targetModel: 'seedance_v2.0' });
  h.install({ seconds: 15, targetModel: 'seedance_v2.0', rewrite: false });
  const body = encode({ param: makeParam({ model: 'seedance_v2.0', duration: 10 }) });
  await h.send(body);
  assert.equal(h.fetchCalls[0].body, body);
  assert.deepEqual(h.caps()[0], { model: 'seedance_v2.0', before: 10, after: 10, modelAfter: 'seedance_v2.0', via: 'fetch-init' });
});

test('targetModel filters but never replaces the native model', async () => {
  for (const targetModel of ['seedance_v2.0', 'unknown', fixturePrompt]) {
    const h = harness({ targetModel });
    const body = encode();
    await h.send(body);
    assert.equal(h.fetchCalls[0].body, body);
  }
});

test('10s compatibility preserves native models, prompts and all unrelated fields', async () => {
  const h = harness({ seconds: 10 });
  for (const model of ['seedance_v2.0', 'seedance_v2.5']) {
    await h.send(encode({ param: makeParam({ model, duration: 15 }) }));
    assert.deepEqual(getParam(h.fetchCalls.at(-1).body), makeParam({ model, duration: 10 }));
  }
  const body = encode({ param: makeParam({ model: 'unknown', duration: 15 }) });
  await h.send(body);
  assert.equal(h.fetchCalls.at(-1).body, body);
});

test('non-video and unknown ability/parameter/duration types pass through', async () => {
  const h = harness();
  const bodies = [null, [], {}, { payload: null }, { chat_ability: [] },
    ...[1, 16, 18, null, {}, [17], '017'].map(type => payload({ type })),
    ...[null, false, 17, [], 'invalid-json'].map(param => payload({ param, stringParam: false })),
    ...[null, false, {}, [], fixturePrompt, undefined].map(duration => payload({ param: makeParam({ duration }) }))];
  for (const value of bodies) {
    const body = JSON.stringify(value);
    await h.send(body);
    assert.equal(h.fetchCalls.at(-1).body, body);
  }
  await h.send(encode({ type: '17', param: makeParam({ duration: '10' }) }));
  assert.equal(getParam(h.fetchCalls.at(-1).body).duration, 30);
});

test('only exact same-origin HTTPS /chat/completion POST is eligible', async () => {
  const h = harness();
  for (const url of ['https://example.invalid/chat/completion', 'https://dola.com/chat/completion',
    'https://api.dola.com/chat/completion', 'https://www.dola.com:444/chat/completion',
    'http://www.dola.com/chat/completion', 'https://www.dola.com.evil.invalid/chat/completion',
    '/chat/completion/', '/chat/completion-extra', '/prefix/chat/completion', '/chat/completion%2f',
    '/other?next=/chat/completion']) {
    const body = encode();
    await h.context.fetch(url, { method: 'POST', body });
    assert.equal(h.fetchCalls.at(-1).body, body);
  }
  assert.deepEqual(h.caps(), []);
  for (const url of ['/chat/completion', new URL(`${endpoint}?fixture=1`)]) {
    await h.context.fetch(url, { method: 'post', body: encode() });
    assert.equal(getParam(h.fetchCalls.at(-1).body).duration, 30);
  }
});

test('adapter does not install on HTTP, non-Dola or lookalike pages', () => {
  for (const href of ['http://www.dola.com/', 'https://doubao.com/', 'https://notdola.com/',
    'https://www.dola.com.evil.invalid/', 'about:blank']) {
    const h = harness({ href });
    assert.equal(h.context.fetch, h.originalFetch);
    assert.equal(h.context.XMLHttpRequest.prototype.open, h.originalOpen);
    assert.equal(h.context.XMLHttpRequest.prototype.send, h.originalSend);
    assert.equal(h.context.__CAP, undefined);
  }
});

test('fetch(Request) patches a clone, preserving URL, headers, credentials and caller body', async () => {
  const h = harness();
  const body = encode();
  const request = new Request(endpoint, { method: 'POST', body, credentials: 'same-origin',
    headers: { 'x-fixture': 'preserved' } });
  await h.context.fetch(request);
  const call = h.fetchCalls[0];
  assert.equal(call.input, request);
  assert.equal(getParam(call.body).duration, 30);
  assert.equal(call.url, endpoint);
  assert.equal(call.credentials, 'same-origin');
  assert.equal(new Map(call.headers).get('x-fixture'), 'preserved');
  assert.equal(await request.text(), body);
  assert.equal(h.caps()[0].via, 'fetch-request');
});

test('Request init method overrides win: PATCH/GET never become POST', async () => {
  const h = harness();
  const body = encode();
  await h.context.fetch(new Request(endpoint, { method: 'POST', body }), { method: 'PATCH' });
  assert.equal(h.fetchCalls[0].method, 'PATCH');
  assert.equal(h.fetchCalls[0].body, body);
  await h.context.fetch(new Request(endpoint, { method: 'POST', body }), { method: 'PATCH', body });
  assert.equal(h.fetchCalls[1].body, body);
  await assert.rejects(h.context.fetch(new Request(endpoint, { method: 'POST', body }), { method: 'GET' }), TypeError);
  await assert.rejects(h.context.fetch(endpoint, { method: 'GET', body }), TypeError);
  await assert.rejects(h.context.fetch(endpoint, { body }), TypeError);
  assert.deepEqual(h.caps(), []);
  await h.context.fetch(new Request(endpoint, { method: 'PATCH', body }), { method: 'POST' });
  assert.equal(h.fetchCalls.at(-1).method, 'POST');
  assert.equal(getParam(h.fetchCalls.at(-1).body).duration, 30);
});

test('Request init body overrides win, including empty/unknown bodies and null inheritance', async () => {
  const h = harness();
  const native20 = encode({ param: makeParam({ model: 'seedance_v2.0' }) });
  const native25 = encode();
  await h.context.fetch(new Request(endpoint, { method: 'POST', body: native25 }), { body: native20 });
  assert.equal(h.fetchCalls.at(-1).body, native20);
  await h.context.fetch(new Request(endpoint, { method: 'POST', body: native20 }), { body: native25 });
  assert.equal(getParam(h.fetchCalls.at(-1).body).duration, 30);
  assert.equal(h.caps().at(-1).via, 'fetch-init');
  for (const body of ['', new URLSearchParams({ payload: native25 }), new Uint8Array([123, 125]), {}]) {
    const init = { body };
    const request = new Request(endpoint, { method: 'POST', body: native25 });
    await h.context.fetch(request, init);
    assert.equal(h.fetchCalls.at(-1).init, init);
    assert.equal(h.fetchCalls.at(-1).init.body, body);
  }
  for (const body of [null, undefined]) {
    await h.context.fetch(new Request(endpoint, { method: 'POST', body: native25 }), { body });
    assert.equal(getParam(h.fetchCalls.at(-1).body).duration, 30);
    assert.equal(h.caps().at(-1).via, 'fetch-request');
  }
  await h.context.fetch(new Request(endpoint), { method: 'POST', body: native25 });
  assert.equal(getParam(h.fetchCalls.at(-1).body).duration, 30);
});

test('inherited and non-enumerable RequestInit overrides and fetch receiver survive', async () => {
  const h = harness();
  const init = Object.create({ method: 'POST', credentials: 'omit', headers: { 'x-fixture': 'inherited' } });
  Object.defineProperty(init, 'body', { value: encode() });
  Object.freeze(init);
  const receiver = { fixture: true };
  await h.context.fetch.call(receiver, endpoint, init);
  const call = h.fetchCalls[0];
  assert.equal(call.receiver, receiver);
  assert.equal(call.credentials, 'omit');
  assert.equal(new Map(call.headers).get('x-fixture'), 'inherited');
  assert.equal(getParam(call.body).duration, 30);
});

test('XHR handles POST, reopen, original arguments, receiver and return values', () => {
  const h = harness();
  const xhr = new h.context.XMLHttpRequest();
  const body = encode();
  assert.equal(xhr.open('post', '/chat/completion', false, 'fixture-user', 'fixture-password'), 'opened');
  assert.equal(xhr.send(body), 'sent');
  assert.equal(getParam(h.xhrCalls[0].body).duration, 30);
  assert.equal(h.xhrCalls[0].receiver, xhr);
  assert.deepEqual(h.xhrCalls[0].rest, [false, 'fixture-user', 'fixture-password']);
  assert.equal(h.caps()[0].via, 'xhr');
  for (const [method, url] of [['GET', endpoint], ['PATCH', endpoint], ['POST', `${endpoint}/extra`],
    ['POST', 'https://api.dola.com/chat/completion']]) {
    xhr.open(method, url);
    xhr.send(body);
    assert.equal(h.xhrCalls.at(-1).body, body);
  }
  xhr.open('POST', endpoint);
  assert.throws(() => xhr.open('POST', 'invalid-fixture-url'));
  xhr.send(body);
  assert.equal(h.xhrCalls.at(-1).body, body, 'failed reopen clears stale match');
  const unopened = new h.context.XMLHttpRequest();
  unopened.send();
  assert.equal(h.xhrCalls.at(-1).argumentCount, 0);
});

test('idempotent installs retain hooks/captures and use the latest valid settings once', async () => {
  const h = harness();
  const hooks = [h.context.fetch, h.context.XMLHttpRequest.prototype.open, h.context.XMLHttpRequest.prototype.send];
  await h.send(encode());
  const cap = h.context.__CAP;
  h.install({ seconds: 30 });
  h.install({ seconds: 10, targetModel: 'seedance_v2.5' });
  assert.equal(h.context.fetch, hooks[0]);
  assert.equal(h.context.XMLHttpRequest.prototype.open, hooks[1]);
  assert.equal(h.context.XMLHttpRequest.prototype.send, hooks[2]);
  assert.equal(h.context.__CAP, cap);
  await h.send(encode({ param: makeParam({ duration: 15 }) }));
  assert.equal(getParam(h.fetchCalls[1].body).duration, 10);
  assert.equal(h.caps().length, 2);
  assert.equal(h.fetchCalls.length, 2);
});

test('invalid settings reject with fixed text and do not replace existing settings/hooks', async () => {
  const h = harness();
  const hook = h.context.fetch;
  for (const seconds of [undefined, null, false, true, '10', '15', '20', '30', 0, 31, NaN, Infinity, {}, []]) {
    assert.throws(() => h.install({ seconds }), /seconds must be 10, 15, 20 or 30/);
  }
  for (const targetModel of [false, 25, {}, []]) {
    assert.throws(() => h.install({ seconds: 30, targetModel }), /targetModel must be a string or null/);
  }
  for (const rewrite of [null, 0, 1, 'false', {}, []]) {
    assert.throws(() => h.install({ seconds: 30, rewrite }), /rewrite must be a boolean/);
  }
  assert.equal(h.context.fetch, hook);
  await h.send(encode());
  assert.equal(getParam(h.fetchCalls[0].body).duration, 30);
});

test('invalid JSON, large bodies and unsafe numeric IDs are unchanged across all transports', async () => {
  const h = harness();
  for (const body of ['', '{invalid:' + fixturePrompt, encode().slice(0, -1),
    encode({ param: '{bad', stringParam: false }),
    encode({ param: makeParam({ prompt: 'x'.repeat(bodyLimit) }) }),
    encode({ param: makeParam({ prompt: '中'.repeat(bodyLimit / 2) }) }),
    ...['9007199254740993', '-0', '1e400'].map(number => encode().replace('"synthetic-id"', number))]) {
    await h.send(body);
    assert.equal(h.fetchCalls.at(-1).body, body);
    await h.context.fetch(new Request(endpoint, { method: 'POST', body }));
    assert.equal(h.fetchCalls.at(-1).body, body);
    const xhr = new h.context.XMLHttpRequest();
    xhr.open('POST', endpoint);
    xhr.send(body);
    assert.equal(h.xhrCalls.at(-1).body, body);
  }
  assert.deepEqual(h.caps(), []);
  assert.deepEqual(h.logs, []);
  assert.equal(h.context.__CAPERR, undefined);
});

test('depth/value limits roll back the entire rewrite and all captures', async () => {
  const h = harness();
  for (const encoded of [false, true]) {
    let deep = payload();
    for (let i = 0; i < 12; i++) deep = { payload: encoded ? JSON.stringify(deep) : deep };
    const body = JSON.stringify({ messages: [payload(), deep] });
    await h.send(body);
    assert.equal(h.fetchCalls.at(-1).body, body);
  }
  const wide = JSON.stringify({ messages: [payload()], data: Array(5000).fill(0) });
  await h.send(wide);
  assert.equal(h.fetchCalls.at(-1).body, wide);
  assert.deepEqual(h.caps(), []);
});

test('unknown parameter arrays still count toward depth limits', async () => {
  const h = harness();
  let deep = [];
  for (let i = 0; i < 12; i++) deep = [deep];
  const body = JSON.stringify({ messages: [payload(), payload({ param: deep, stringParam: false })] });
  await h.send(body);
  assert.equal(h.fetchCalls[0].body, body);
  assert.deepEqual(h.caps(), []);
});

test('cumulative decoded JSON budget prevents rewriting repeatedly encoded large envelopes', async () => {
  const h = harness();
  let body = encode({ param: makeParam({ prompt: 'x'.repeat(720000) }) });
  body = JSON.stringify({ payload: JSON.stringify({ payload: body }) });
  assert.ok(body.length < bodyLimit, 'input itself fits the body limit');
  await h.send(body);
  assert.equal(h.fetchCalls[0].body, body);
  assert.deepEqual(h.caps(), []);
});

test('Request byte streams with invalid UTF-8 remain untouched', async () => {
  const h = harness();
  const prefix = new TextEncoder().encode(encode().slice(0, -1));
  const bytes = new Uint8Array(prefix.length + 1);
  bytes.set(prefix);
  bytes[prefix.length] = 0xff;
  const request = new Request(endpoint, { method: 'POST', body: bytes });
  await h.context.fetch(request);
  assert.equal(h.fetchCalls[0].input, request);
  assert.equal(h.fetchCalls[0].argumentCount, 1);
  assert.equal(h.fetchCalls[0].body, new TextDecoder().decode(bytes));
  assert.deepEqual(h.caps(), []);
});

test('a mixed-model batch changes only native 2.5 video duration', async () => {
  const h = harness();
  const values = [payload(), payload({ param: makeParam({ model: 'seedance_v2.0' }) }),
    payload({ type: 16 }), payload({ param: makeParam({ model: 'unknown' }) })];
  await h.send(JSON.stringify({ messages: values }));
  const expected = structuredClone(values);
  expected[0] = payload({ param: makeParam({ duration: 30 }) });
  assert.deepEqual(JSON.parse(h.fetchCalls[0].body).messages, expected);
});

test('Request clone failures fall through once without capturing sensitive exception strings', async () => {
  const h = harness();
  const body = encode();
  const request = new Request(endpoint, { method: 'POST', body });
  request.clone = () => { throw new Error(fixturePrompt); };
  await h.context.fetch(request);
  assert.equal(h.fetchCalls[0].body, body);
  assert.equal(h.fetchCalls[0].argumentCount, 1);
  assert.deepEqual(h.caps(), []);
  assert.deepEqual(h.logs, []);
  assert.equal(h.context.__CAPERR, undefined);
});

test('fetch and XHR failures propagate exactly once, with no retry or error logging', async () => {
  const failure = new Error(fixturePrompt);
  const h = harness({ fetchError: failure, xhrError: failure });
  await assert.rejects(h.send(encode()), error => error === failure);
  const xhr = new h.context.XMLHttpRequest();
  xhr.open('POST', endpoint);
  assert.throws(() => xhr.send(encode()), error => error === failure);
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.xhrCalls.length, 1);
  assert.deepEqual(h.logs, []);
  assert.equal(h.context.__CAPERR, undefined);
});

test('capture ring is bounded and contains only sanitized model/duration/pathway fields', async () => {
  const h = harness();
  for (let i = 0; i < 105; i++) await h.send(encode());
  await h.send(encode({ param: makeParam({ model: fixturePrompt, duration: fixturePrompt }) }));
  const caps = h.caps();
  assert.equal(caps.length, 100);
  assert.ok(caps.every(cap => Object.keys(cap).sort().join(',') === 'after,before,model,modelAfter,via'));
  assert.deepEqual(caps.at(-1), { model: null, before: null, after: null, modelAfter: null, via: 'fetch-init' });
  assert.equal(JSON.stringify(caps).includes('fixture'), false);
  assert.deepEqual(h.logs, []);
});
