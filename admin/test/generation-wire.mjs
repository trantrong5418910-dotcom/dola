import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGenerationWireGate } from '../server/dola/generation-wire.js';

const request = (duration = 30, model = 'seedance_v2.5', extra = {}) => ({
  url: () => 'https://www.dola.com/chat/completion', method: () => 'POST',
  postData: () => JSON.stringify({ chat_ability: { ability_type: 17, ability_param: { model, duration } } }), ...extra,
});
const gate = (seconds = 30, extra = {}) => createGenerationWireGate({ seconds,
  isActive: () => true, sessionVerified: () => true, ...extra });

test('exactly one valid completion is reserved before any asynchronous forwarding', () => {
  const g = gate();
  assert.equal(g.inspect(request()).action, 'forward');
  assert.equal(g.inspect(request()).reason, 'duplicate_submission');
  assert.equal(g.snapshot().forwarded, 1);
  // Failed network forwarding cannot reset the reservation; no reset API exists.
  assert.equal(g.inspect(request()).action, 'abort');
});

test('15s checks actual model, duration and video ability, not just the UI', () => {
  // 15 秒是原生档、不走改写，所以它最能体现"核对的是请求体本身"。
  // （30 秒会先把 duration 改写成 30，mismatch 用例会被改写抹平，用在这里没意义。）
  for (const r of [request(30, 'seedance_v2.0'), request(15, 'other-model'), request(15, 'seedance_v2.5'),
    request(15, '', { postData: () => '{"prompt":"plain chat"}' })]) {
    const g = gate(15);
    assert.equal(g.inspect(r).reason, 'request_mismatch');
    assert.equal(g.snapshot().forwarded, 0);
  }
});

test('preserves the 30s carrier adaptation and native 15s model contract', () => {
  for (const seconds of [30]) {
    const g = gate(seconds), result = g.inspect(request());
    assert.equal(result.action, 'forward');
    assert.equal(JSON.parse(result.body).chat_ability.ability_param.duration, seconds);
  }
  assert.equal(gate(15).inspect(request(15, 'seedance_v2.0')).action, 'forward');
  assert.equal(gate(15).inspect(request(30, 'seedance_v2.0')).action, 'abort');
});

test('unknown origins/methods, logout-shaped paths and inactive sessions never use the allowance', () => {
  for (const url of ['http://www.dola.com/chat/completion', 'https://www.dola.com.invalid/chat/completion',
    'https://user:pass@www.dola.com/chat/completion', 'https://www.dola.com/chat/completion/extra']) {
    assert.equal(gate().inspect(request(30, 'seedance_v2.5', { url: () => url })).reason, 'invalid_endpoint');
  }
  assert.equal(gate().inspect(request(30, '', { method: () => 'GET' })).action, 'abort');
  assert.equal(gate(30, { isActive: () => false }).inspect(request()).reason, 'inactive_session');
  assert.equal(gate(30, { sessionVerified: () => false }).inspect(request()).reason, 'inactive_session');
  const g = gate();
  assert.equal(g.inspect(request(30, '', { url: () => 'https://www.dola.com/chat/' })).action, 'unrelated');
  assert.equal(g.inspect(request()).action, 'forward');
});
