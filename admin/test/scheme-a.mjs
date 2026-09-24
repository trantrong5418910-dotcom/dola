/**
 * 方案A通道单测：只覆盖纯函数（请求体构造、回执解析、通道名归一化），
 * 不开浏览器、不碰网络，可在 CI / 本机直接跑。
 *
 *   node --test test/scheme-a.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSchemeARequestBody,
  parseSchemeAAck,
  resolveSubmitMode,
  SUBMIT_MODES,
} from '../server/dola/scheme-a.js';

test('通道名集合包含 browser 与 scheme-a', () => {
  assert.ok(SUBMIT_MODES.includes('browser'));
  assert.ok(SUBMIT_MODES.includes('scheme-a'));
});

test('resolveSubmitMode：非法值一律回退 browser', () => {
  assert.equal(resolveSubmitMode('scheme-a'), 'scheme-a');
  assert.equal(resolveSubmitMode('Scheme-A'), 'scheme-a');
  assert.equal(resolveSubmitMode('browser'), 'browser');
  assert.equal(resolveSubmitMode('BROWSER'), 'browser');
  assert.equal(resolveSubmitMode('xxx'), 'browser');
  assert.equal(resolveSubmitMode(''), 'browser');
  assert.equal(resolveSubmitMode(null), 'browser');
  assert.equal(resolveSubmitMode(undefined), 'browser');
});

test('buildSchemeARequestBody：ability 结构与参数', () => {
  const body = buildSchemeARequestBody('一只猫在跑', { ratio: '9:16', model: 'seedance_v2.0', duration: 10 });
  assert.equal(body.chat_ability.ability_type, 17);
  assert.deepEqual(JSON.parse(body.chat_ability.ability_param), {
    ratio: '9:16',
    model: 'seedance_v2.0',
    duration: 10,
  });
  const msg = body.messages[0];
  assert.equal(msg.content_block[0].content.text_block.text, '一只猫在跑');
  assert.equal(msg.content_block[0].block_type, 10000);
  assert.equal(body.client_meta.bot_id, '7339470689562525703');
  assert.ok(body.client_meta.local_conversation_id.startsWith('local_'));
  assert.equal(body.ext.is_finish, '1');
});

test('buildSchemeARequestBody：默认值', () => {
  const body = buildSchemeARequestBody('hi');
  assert.deepEqual(JSON.parse(body.chat_ability.ability_param), {
    ratio: '16:9',
    model: 'seedance_v2.0',
    duration: 10,
  });
});

test('buildSchemeARequestBody：每次 local id 唯一', () => {
  const a = buildSchemeARequestBody('x');
  const b = buildSchemeARequestBody('x');
  assert.notEqual(a.messages[0].local_message_id, b.messages[0].local_message_id);
});

test('parseSchemeAAck：正常 ACK', () => {
  const r = parseSchemeAAck('data: SSE_ACK {"conversation_id":"1234567890123456","question_id":"999"}');
  assert.equal(r.ack, true);
  assert.equal(r.conversationId, '1234567890123456');
  assert.equal(r.questionId, '999');
  assert.deepEqual(r.errorCodes, []);
});

test('parseSchemeAAck：有 SSE_ACK 但无 conversation_id 不算成功', () => {
  const r = parseSchemeAAck('SSE_ACK {}');
  assert.equal(r.ack, false);
  assert.equal(r.conversationId, null);
});

test('parseSchemeAAck：限流错误码', () => {
  const r = parseSchemeAAck('data: {"error_code":710022002,"error_msg":"\u5f53\u524d\u670d\u52a1\u8bbf\u95ee\u9891\u7e41"}');
  assert.equal(r.ack, false);
  assert.deepEqual(r.errorCodes, [710022002]);
});

test('parseSchemeAAck：空回执', () => {
  const r = parseSchemeAAck('');
  assert.equal(r.ack, false);
  assert.equal(r.conversationId, null);
  assert.deepEqual(r.errorCodes, []);
});
