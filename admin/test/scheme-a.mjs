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

test('buildSchemeARequestBody：ability 结构与参数（按页面真实抓包）', () => {
  const body = buildSchemeARequestBody('一只猫在跑', { ratio: '9:16', model: 'seedance_v2.0', duration: 10 });
  assert.equal(body.chat_ability.ability_type, 17);
  // ★ 真实抓包里 ability_param 只有 model/duration/input_box_content，没有 ratio。
  assert.deepEqual(JSON.parse(body.chat_ability.ability_param), {
    model: 'seedance_v2.0',
    duration: 10,
    input_box_content: { user_input_content: '一只猫在跑', reply_message_format: '生成视频：%s' },
  });
  const msg = body.messages[0];
  // ★ 页面真实体里输入框内容是「生成视频：<提示词>」，不是裸提示词。
  assert.equal(msg.content_block[0].content.text_block.text, '生成视频：一只猫在跑');
  assert.equal(msg.content_block[0].block_type, 10000);
  assert.equal(body.client_meta.bot_id, '7339470689562525703');
  assert.ok(body.client_meta.local_conversation_id.startsWith('local_'));
  assert.equal(body.ext.is_finish, '1');
});

test('buildSchemeARequestBody：★ text_block 必须带「生成视频：」前缀', () => {
  // 2026-09-26 实测：发了两轮都是裸提示词，服务端都当成**图片生成**（会话回「已生成 4 张」）。
  // 页面真实抓包里 text_block.text 是 `生成视频：<提示词>`，而 input_box_content 里存裸提示词。
  const b = buildSchemeARequestBody('橘猫晒太阳');
  assert.equal(b.messages[0].content_block[0].content.text_block.text, '生成视频：橘猫晒太阳');
  const p = JSON.parse(b.chat_ability.ability_param);
  assert.equal(p.input_box_content.user_input_content, '橘猫晒太阳');
  assert.equal(p.input_box_content.reply_message_format, '生成视频：%s');
  assert.equal('ratio' in p, false, '真实抓包的 ability_param 里没有 ratio');
});

test('buildSchemeARequestBody：local_permissions 必须是 3 条', () => {
  const lp = buildSchemeARequestBody('x').client_meta.local_permissions;
  assert.deepEqual(lp.map((x) => x.permission_name), [
    'ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'ACCESS_BACKGROUND_LOCATION',
  ]);
});

test('buildSchemeARequestBody：option / ext 按真实抓包补齐', () => {
  const b = buildSchemeARequestBody('x');
  const o = b.option;
  assert.equal(o.need_create_conversation, true);
  assert.deepEqual(o.conversation_init_option, { need_ack_conversation: true });
  assert.ok(Number.isInteger(o.create_time_ms));
  assert.ok(typeof o.unique_key === 'string' && o.unique_key.length > 8);
  assert.deepEqual(o.related_deleted_message_ids, {});
  assert.ok(o.aggregate_params && 'mention_skill_list' in o.aggregate_params);
  assert.ok(o.model_config && 'model_item_key' in o.model_config);
  // ext 真实抓包有 6 个字段，旧版只有 is_finish 一个
  assert.deepEqual(Object.keys(b.ext).sort(), [
    'answer_with_suggest', 'collection_id', 'commerce_credit_config_enable',
    'conversation_init_option', 'is_finish', 'sub_conv_firstmet_type',
  ]);
});

test('buildSchemeARequestBody：默认值', () => {
  const body = buildSchemeARequestBody('hi');
  assert.deepEqual(JSON.parse(body.chat_ability.ability_param), {
    model: 'seedance_v2.5',
    duration: 30,
    input_box_content: { user_input_content: 'hi', reply_message_format: '生成视频：%s' },
  });
});

test('buildSchemeARequestBody：每次 local id 唯一', () => {
  const a = buildSchemeARequestBody('x');
  const b = buildSchemeARequestBody('x');
  assert.notEqual(a.messages[0].local_message_id, b.messages[0].local_message_id);
});

test('parseSchemeAAck：正常 ACK', () => {
  const body = buildSchemeARequestBody('hello');
  const receipt = 'event: SSE_ACK\ndata: ' + JSON.stringify({
    ack_client_meta: { conversation_id: '1234567890123456', local_conversation_id: body.client_meta.local_conversation_id },
    query_list: [{ local_message_id: body.messages[0].local_message_id, question_id: '999' }],
  }) + '\n\n';
  const r = parseSchemeAAck(receipt, JSON.stringify(body));
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

test('parseSchemeAAck：保留上游拒绝错误码', () => {
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

// ───────────────────────── 参考图（2026-09-27 新增） ─────────────────────────
//
// 判据全部来自真实抓包样本：admin/server/scripts/fixtures/real-ref-image-body.json
// 与 RECON-2026-09-27-纯协议参考图上传-契约.md §4.1 的逐字段差异表。

const REF = { uri: 'tos-mya-i-uo7y4d541q/abc.png', width: 512, height: 512, name: 'ref.png', format: 'png' };

test('参考图：不带图时输出必须与历史完全一致（回归护栏）', () => {
  const b = buildSchemeARequestBody('hello', { model: 'seedance_v2.5', duration: 10 });
  assert.equal(b.messages.length, 1);
  assert.equal(b.messages[0].content_block[0].block_type, 10000);
  assert.equal(b.option.collect_id, '');
  assert.equal(b.ext.collection_id, '');
  assert.equal(b.messages[0].content_block[0].content.text_block.text, '生成视频：hello');
  // 不带图**不能**有 ratio —— 带图样本里才有，视频-only 抓包样本里没有。
  assert.deepEqual(Object.keys(JSON.parse(b.chat_ability.ability_param)),
    ['model', 'duration', 'input_box_content']);
});

test('参考图：独立一条 message 且排在文本前面，block_type=10052 / type=1', () => {
  const b = buildSchemeARequestBody('hello', { duration: 30, referenceImages: [REF] });
  assert.equal(b.messages.length, 2, '带图时是两条 message');
  assert.equal(b.messages[0].content_block[0].block_type, 10052);
  assert.equal(b.messages[1].content_block[0].block_type, 10000);
  const att = b.messages[0].content_block[0].content.attachment_block.attachments[0];
  assert.equal(att.type, 1);            // AttachmentTypeImage
  assert.equal(att.parse_state, 0);     // 实测抓到的是 0（不是 Success=1）
  assert.equal(att.review_state, 1);    // ReviewStateAccess
  assert.equal(att.upload_status, 1);   // UploadStatusSuccess
  assert.equal(att.progress, 100);
  assert.equal(att.image.uri, REF.uri);
  assert.equal(att.image.name, REF.name);
  assert.deepEqual(att.image.image_ori,
    { url: '', width: 512, height: 512, format: 'png', url_formats: {} });
});

test('参考图：collect_id / collection_id 同值且非空', () => {
  const b = buildSchemeARequestBody('hello', { duration: 30, referenceImages: [REF] });
  assert.ok(b.option.collect_id);
  assert.equal(b.option.collect_id, b.ext.collection_id);
  // 两条 message 的 id 必须各自唯一，不能复用
  assert.notEqual(b.messages[0].local_message_id, b.messages[1].local_message_id);
});

test('参考图：ability_param 含 ratio=auto，且 text 带「，<秒数>s」后缀', () => {
  const b = buildSchemeARequestBody('hello', { duration: 30, referenceImages: [REF] });
  const ap = JSON.parse(b.chat_ability.ability_param);
  assert.deepEqual(Object.keys(ap), ['ratio', 'model', 'duration', 'input_box_content']);
  assert.equal(ap.ratio, 'auto');
  assert.equal(ap.duration, 30);
  assert.equal(ap.input_box_content.user_input_content, 'hello');
  assert.equal(b.messages[1].content_block[0].content.text_block.text, '生成视频：hello，30s');
});

test('参考图：abilityRatio / uiSeconds 可覆盖默认值', () => {
  const b = buildSchemeARequestBody('hi', {
    duration: 30, referenceImages: [REF], abilityRatio: '9:16', uiSeconds: 10,
  });
  assert.equal(JSON.parse(b.chat_ability.ability_param).ratio, '9:16');
  assert.equal(b.messages[1].content_block[0].content.text_block.text, '生成视频：hi，10s');
});

test('参考图：多张时每张一条 attachment，仍只有一条文本 message', () => {
  const b = buildSchemeARequestBody('hi', {
    duration: 30, referenceImages: [REF, { ...REF, uri: 'tos-mya-i-uo7y4d541q/b.png', name: 'b.png' }],
  });
  assert.equal(b.messages.length, 3);
  assert.equal(b.messages[2].content_block[0].block_type, 10000);
  assert.equal(b.messages[0].content_block[0].content.attachment_block.attachments[0].image.uri, REF.uri);
  assert.equal(b.messages[1].content_block[0].content.attachment_block.attachments[0].image.uri,
    'tos-mya-i-uo7y4d541q/b.png');
});

test('参考图：没有 uri 的条目被忽略（不会造出半个 attachment）', () => {
  const b = buildSchemeARequestBody('hi', { duration: 10, referenceImages: [{ name: 'x.png' }] });
  assert.equal(b.messages.length, 1);
  assert.equal(b.option.collect_id, '');
});
