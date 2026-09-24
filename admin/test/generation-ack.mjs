import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGenerationAckObserver, identifyGenerationRequest } from '../server/dola/generation-ack.js';

// Synthetic identifiers only; no app imports, DB, browser, credentials or I/O.
const ID = '12345678901234567890';
const OTHER_ID = '98765432109876543210';
const identity = () => ({ localConversationId: 'local-c', localMessageIds: ['local-m1', 'local-m2'] });
const ack = (meta = {}, ids = identity().localMessageIds) => ({
  ack_client_meta: { local_conversation_id: 'local-c', conversation_id: ID, ...meta },
  query_list: ids.map(local_message_id => ({ local_message_id, question_id: 'synthetic-question' })),
});
const frame = (type, value, eol = '\n') => `event: ${type}${eol}data: ${JSON.stringify(value)}${eol}${eol}`;
const good = () => frame('SSE_ACK', ack());
const empty = () => ({ conversationId: null, ackMatched: false, errorCodes: [], events: 0, truncated: false });
const identify = value => identifyGenerationRequest(JSON.stringify(value));
const expectMatch = observer => {
  assert.equal(observer.snapshot().conversationId, ID);
  assert.equal(observer.snapshot().ackMatched, true);
  assert.equal(observer.snapshot().truncated, false);
};
const expectTerminal = (observer, truncated) => {
  assert.equal(observer.snapshot().ackMatched, false);
  assert.equal(observer.snapshot().conversationId, null);
  assert.equal(observer.snapshot().truncated, truncated);
  const before = observer.snapshot();
  observer.push(good());
  assert.deepEqual(observer.finish(), before);
};

test('extracts root and messages identities exactly, with stable deduplication', () => {
  assert.deepEqual(identify({ local_conversation_id: 'local-c', local_message_id: 'local-m1', messages: [
    { local_message_id: 'local-m2' }, { local_message_id: 'local-m1', local_conversation_id: 'local-c' },
  ] }), identity());
  assert.deepEqual(identify({ messages: [{ local_message_id: '00123456789012345678901234567890' }] }), {
    localConversationId: null, localMessageIds: ['00123456789012345678901234567890'],
  });
  assert.deepEqual(identify({ local_conversation_id: 'local-c' }), { localConversationId: 'local-c', localMessageIds: [] });
  assert.deepEqual(identify({ local_message_id: 'x'.repeat(128) }), { localConversationId: null, localMessageIds: ['x'.repeat(128)] });
});

test('decodes only transport containers, never identifier string values', () => {
  const value = { local_conversation_id: 'local-c', messages: JSON.stringify([
    JSON.stringify({ local_message_id: 'local-m1' }), { local_message_id: 'local-m2' },
  ]) };
  assert.deepEqual(identify(value), identity());
  assert.deepEqual(identify(JSON.stringify(value)), identity());
  assert.deepEqual(identify({ local_message_id: '"12345"' }), { localConversationId: null, localMessageIds: ['"12345"'] });
});

test('does not search prompts, content, URLs, arbitrary metadata or other envelopes', () => {
  const decoy = { local_conversation_id: 'local-c', local_message_id: 'local-m1' };
  for (const key of ['prompt', 'content', 'text', 'metadata', 'extra', 'data', 'payload', 'client_meta', 'request']) {
    for (const value of [decoy, JSON.stringify(decoy), [decoy]]) {
      assert.equal(identify({ [key]: value }), null, key);
      assert.equal(identify({ messages: [{ [key]: value }] }), null, `messages.${key}`);
    }
  }
  assert.equal(identify({ messages: [{ messages: [decoy] }], url: `https://example.invalid/chat/${ID}` }), null);
  assert.deepEqual(identify({ local_message_id: 'real', prompt: JSON.stringify(decoy), content: decoy }), {
    localConversationId: null, localMessageIds: ['real'],
  });
});

test('rejects malformed, non-object, invalid or conflicting request identities', () => {
  for (const body of [null, undefined, 3, '', '{', 'null', '[]', '42', '{}']) assert.equal(identifyGenerationRequest(body), null);
  for (const bad of ['', ' ', 'x'.repeat(129), 123, 12345678901234567890, null, false, [], {}]) {
    assert.equal(identify({ local_conversation_id: bad, local_message_id: 'otherwise-valid' }), null);
    assert.equal(identify({ local_conversation_id: 'otherwise-valid', messages: [{ local_message_id: bad }] }), null);
  }
  assert.equal(identify({ local_conversation_id: 'one', messages: [{ local_conversation_id: 'two' }] }), null);
  for (const messages of [null, {}, 'bad JSON', [null], [42], ['bad JSON']]) {
    assert.equal(identify({ local_conversation_id: 'valid', messages }), null);
  }
});

test('request body, message count and JSON decoding are bounded', () => {
  assert.equal(identifyGenerationRequest(' '.repeat(1024 * 1024 + 1)), null);
  const messages = Array.from({ length: 128 }, (_, i) => ({ local_message_id: `m${i}` }));
  assert.equal(identify({ messages }).localMessageIds.length, 128);
  assert.equal(identify({ messages: [...messages, {}] }), null);
  assert.equal(identify({ local_message_id: 'additional', messages }), null);
  let encoded = { local_message_id: 'm' };
  for (let i = 0; i < 5; i++) encoded = JSON.stringify(encoded);
  assert.equal(identifyGenerationRequest(encoded), null);
  const nested = JSON.stringify({ local_message_id: 'm', content: 'x'.repeat(530000) });
  assert.equal(identify(JSON.stringify({ messages: JSON.stringify([nested]) })), null);
});

test('empty observer exposes only sanitized fields; finish is idempotent', () => {
  const observer = createGenerationAckObserver(identity());
  assert.deepEqual(observer.snapshot(), empty());
  assert.deepEqual(observer.finish(), empty());
  assert.deepEqual(observer.finish(), empty());
  assert.deepEqual(observer.push(good()), empty());
});

test('a correlation conflict remains distinguishable from absent or truncated evidence', () => {
  const observer = createGenerationAckObserver(identity());
  assert.equal(observer.hasConflict(), false);
  observer.push(good());
  observer.push(frame('SSE_ACK', ack({ conversation_id: OTHER_ID })));
  assert.equal(observer.hasConflict(), true);
  assert.equal(observer.snapshot().ackMatched, false);
  const partial = createGenerationAckObserver(identity());
  partial.push('event: SSE_ACK\ndata: partial'); partial.finish();
  assert.equal(partial.hasConflict(), false);
  assert.equal(partial.snapshot().truncated, true);
});

test('matches across every two-chunk split, including CRLF splits', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const text = frame('SSE_ACK', ack(), eol);
    for (let split = 0; split <= text.length; split++) {
      const observer = createGenerationAckObserver(identity());
      observer.push(text.slice(0, split));
      observer.push(text.slice(split));
      expectMatch(observer);
      assert.equal(observer.finish().events, 1);
    }
  }
});

test('supports one-character chunks, initial BOM, multiline data and SSE field semantics', () => {
  const text = '\uFEFF: comment\r\nevent: discarded\r\nevent:SSE_ACK\r\nid: ignored\r\n'
    + JSON.stringify(ack(), null, 2).split('\n').map(line => `data: ${line}\r\n`).join('') + '\r\n';
  const observer = createGenerationAckObserver(identity());
  for (const char of text) observer.push(char);
  expectMatch(observer);
  assert.equal(observer.finish().events, 1);
  const reversed = createGenerationAckObserver(identity());
  reversed.push(`data:${JSON.stringify(ack())}\nevent:SSE_ACK\n\n`);
  expectMatch(reversed);
});

test('accepts direct or nested bounded conversation strings without numeric conversion', () => {
  for (const id of ['0123456789', ID, '9'.repeat(30)]) {
    for (const meta of [{ conversation_id: id }, { conversation_info: { conversation_id: id } },
      { conversation_id: id, conversation_info: { conversation_id: id } }]) {
      const value = ack();
      value.ack_client_meta = { local_conversation_id: 'local-c', ...meta };
      const observer = createGenerationAckObserver(identity());
      observer.push(frame('SSE_ACK', value));
      assert.equal(observer.finish().conversationId, id);
    }
  }
});

test('all expected messages must occur in a single ACK, never accumulated across ACKs', () => {
  const observer = createGenerationAckObserver(identity());
  for (const ids of [[], ['other'], ['local-m1'], ['local-m2'], ['local-m1', 'local-m1']]) {
    observer.push(frame('SSE_ACK', ack({}, ids)));
    assert.equal(observer.snapshot().ackMatched, false);
  }
  observer.push(frame('SSE_ACK', ack({}, ['extra', 'local-m2', 'local-m1'])));
  expectMatch(observer);
});

test('uncorrelated ACKs cannot set or replace a match', () => {
  const observer = createGenerationAckObserver(identity());
  const unrelated = frame('SSE_ACK', ack({ local_conversation_id: 'other-c', conversation_id: OTHER_ID }, ['other-m']));
  observer.push(unrelated);
  assert.equal(observer.snapshot().ackMatched, false);
  observer.push(good());
  observer.push(unrelated);
  observer.push(good());
  expectMatch(observer);
  assert.equal(observer.finish().events, 4);
});

test('conversation-only identity requires exact ACK local conversation', () => {
  const observer = createGenerationAckObserver({ localConversationId: 'local-c', localMessageIds: [] });
  for (const meta of [{ conversation_id: ID }, { local_conversation_id: 'other', conversation_id: ID },
    { local_conversation_id: 123, conversation_id: ID }]) {
    observer.push(frame('SSE_ACK', { ack_client_meta: meta }));
    assert.equal(observer.snapshot().ackMatched, false);
  }
  observer.push(frame('SSE_ACK', { ack_client_meta: { local_conversation_id: 'local-c', conversation_id: ID } }));
  expectMatch(observer);
});

test('message identity can correlate without an ACK local conversation', () => {
  for (const localConversationId of [null, 'local-c']) {
    const observer = createGenerationAckObserver({ ...identity(), localConversationId });
    const value = ack();
    delete value.ack_client_meta.local_conversation_id;
    observer.push(frame('SSE_ACK', value));
    expectMatch(observer);
  }
});

test('correlated conflicting local conversations are terminal, including partial matches', () => {
  for (const ids of [['local-m1'], identity().localMessageIds]) {
    for (const bad of ['other-c', '', null, 123]) {
      const observer = createGenerationAckObserver(identity());
      observer.push(frame('SSE_ACK', ack({ local_conversation_id: bad }, ids)));
      expectTerminal(observer, false);
    }
  }
});

test('conflicting direct/nested or successive correlated server IDs clear any match permanently', () => {
  for (const conflicting of [ack({ conversation_info: { conversation_id: OTHER_ID } }), ack({ conversation_id: OTHER_ID })]) {
    const observer = createGenerationAckObserver(identity());
    observer.push(good());
    observer.push(frame('SSE_ACK', conflicting));
    expectTerminal(observer, false);
  }
  const observer = createGenerationAckObserver(identity());
  observer.push(frame('SSE_ACK', ack({ conversation_info: { conversation_id: OTHER_ID } })));
  expectTerminal(observer, false);
});

test('rejects unsafe, malformed and incorrectly located server IDs without fallback', () => {
  for (const bad of [12345678901234567890, '', '1'.repeat(9), '1'.repeat(31), `${ID}\n`, ` ${ID}`,
    `${ID} `, '+1234567890', '1e123456789', '１２３４５６７８９０', null, {}, [ID]]) {
    for (const meta of [{ conversation_id: bad }, { conversation_id: bad, conversation_info: { conversation_id: ID } },
      { conversation_id: ID, conversation_info: { conversation_id: bad } }]) {
      const observer = createGenerationAckObserver(identity());
      observer.push(frame('SSE_ACK', ack(meta)));
      assert.equal(observer.finish().ackMatched, false);
    }
  }
  const observer = createGenerationAckObserver(identity());
  observer.push(frame('SSE_ACK', { ack_client_meta: { local_conversation_id: 'local-c' },
    query_list: ack().query_list, conversation_id: ID, conversation_info: { conversation_id: ID } }));
  assert.equal(observer.finish().ackMatched, false);
});

test('never uses FULL_MSG_NOTIFY, URL, question_id, prompt or content as ACK evidence', () => {
  const observer = createGenerationAckObserver(identity());
  for (const type of ['FULL_MSG_NOTIFY', 'message', 'sse_ack', 'SSE_ACK ', 'STREAM_ERROR']) {
    observer.push(frame(type, ack()));
  }
  for (const key of ['prompt', 'content', 'metadata', 'data']) observer.push(frame('SSE_ACK', { [key]: ack() }));
  observer.push(frame('SSE_ACK', { ack_client_meta: { conversation_id: ID },
    query_list: [{ local_message_id: 'other', question_id: 'local-m1' }, { local_message_id: 'other2', question_id: 'local-m2' }],
    prompt: ack(), content: JSON.stringify(ack()), url: `https://example.invalid/chat/${ID}` }));
  observer.push(`data: ${JSON.stringify(ack())}\n\n`);
  assert.equal(observer.finish().ackMatched, false);
});

test('ignores malformed JSON and malformed ACK structures without leaking data', () => {
  const observer = createGenerationAckObserver(identity());
  for (const value of ['{', 'null', '[]', '42', '"secret prompt"', '{}']) {
    observer.push(`event: SSE_ACK\ndata: ${value}\n\n`);
  }
  for (const value of [{ ack_client_meta: null }, { ack_client_meta: [] },
    { ...ack(), query_list: [null, 2, {}, { local_message_id: 123 }] }, { ...ack(), query_list: 'local-m1' }]) {
    observer.push(frame('SSE_ACK', value));
  }
  assert.equal(observer.snapshot().ackMatched, false);
  observer.push(good());
  expectMatch(observer);
  assert.equal(JSON.stringify(observer.finish()).includes('secret'), false);
});

test('only numeric safe integer STREAM_ERROR codes are retained, deduplicated in order', () => {
  const observer = createGenerationAckObserver(identity());
  for (const error_code of [710022002, 42, 710022002, -1, 0, Number.MAX_SAFE_INTEGER,
    '710022002', 1.5, Number.MAX_SAFE_INTEGER + 1, null, true, {}, []]) {
    observer.push(frame('STREAM_ERROR', { error_code, error_msg: 'secret prompt token', content: ack() }));
  }
  observer.push(frame('FULL_MSG_NOTIFY', { error_code: 99 }));
  observer.push(frame('STREAM_ERROR', { metadata: { error_code: 99 }, error_msg: 'error_code: 99' }));
  observer.push('event: STREAM_ERROR\ndata: {"error_code":1e999}\n\n');
  observer.push('event: STREAM_ERROR\ndata: malformed secret\n\n');
  assert.deepEqual(observer.finish().errorCodes, [710022002, 42, -1, 0, Number.MAX_SAFE_INTEGER]);
  assert.equal(JSON.stringify(observer.snapshot()).includes('secret'), false);
});

test('ACK receipt and stream errors remain separate diagnostics, never a final video result', () => {
  const observer = createGenerationAckObserver(identity());
  observer.push(good() + frame('STREAM_ERROR', { error_code: 710022002, error_msg: 'private' }));
  assert.deepEqual(observer.finish(), { conversationId: ID, ackMatched: true,
    errorCodes: [710022002], events: 2, truncated: false });
});

test('defensively copies identity and snapshots; invalid identities cannot correlate', () => {
  const source = identity();
  const observer = createGenerationAckObserver(source);
  source.localConversationId = 'changed';
  source.localMessageIds.splice(0);
  observer.push(frame('STREAM_ERROR', { error_code: 1 }));
  const result = observer.snapshot();
  result.conversationId = OTHER_ID;
  result.ackMatched = true;
  result.errorCodes.push(999);
  observer.push(good());
  expectMatch(observer);
  assert.deepEqual(observer.finish().errorCodes, [1]);
  for (const value of [null, undefined, {}, { localConversationId: null, localMessageIds: [] },
    { ...identity(), localConversationId: 123 }, { ...identity(), localMessageIds: [123] },
    { ...identity(), localMessageIds: Array(129).fill('m') }, Object.create(identity())]) {
    const invalid = createGenerationAckObserver(value);
    invalid.push(good());
    assert.equal(invalid.finish().ackMatched, false);
  }
});

test('requires terminating blank line; finish discards incomplete frames permanently', () => {
  for (const ending of ['', '\n', '\r\n']) {
    const observer = createGenerationAckObserver(identity());
    observer.push(`event: SSE_ACK\ndata: ${JSON.stringify(ack())}${ending}`);
    assert.equal(observer.snapshot().ackMatched, false);
    observer.finish();
    expectTerminal(observer, true);
  }
  const observer = createGenerationAckObserver(identity());
  observer.push(good() + 'event: STREAM_ERROR\ndata: {');
  observer.finish();
  expectTerminal(observer, true);
});

test('event types and data never carry across frames; comments do not dispatch data', () => {
  const observer = createGenerationAckObserver(identity());
  observer.push('event: SSE_ACK\n\n');
  observer.push(`data: ${JSON.stringify(ack())}\n\n`);
  observer.push(': event: SSE_ACK\n: data: ignored\n\n');
  observer.push(`event: SSE_ACK\nevent\ndata: ${JSON.stringify(ack())}\n\n`);
  assert.deepEqual(observer.finish(), { ...empty(), events: 4 });
});

test('oversized chunks reject the whole chunk, even a leading valid ACK', () => {
  const observer = createGenerationAckObserver(identity());
  observer.push(good() + 'x'.repeat(64 * 1024));
  assert.equal(observer.snapshot().events, 0);
  expectTerminal(observer, true);
});

test('event size is bounded across chunks, for data, comments and unknown fields', () => {
  for (const prefix of ['event: SSE_ACK\ndata: ', ':', 'unknown: ']) {
    const observer = createGenerationAckObserver(identity());
    observer.push(good());
    observer.push(prefix);
    observer.push('x'.repeat(32768));
    observer.push('x'.repeat(32768));
    expectTerminal(observer, true);
  }
  const observer = createGenerationAckObserver(identity());
  for (let i = 0; i < 33; i++) observer.push(`: ${'x'.repeat(2048)}\n`);
  expectTerminal(observer, true);
});

test('total stream size is bounded even when all frames fit', () => {
  const observer = createGenerationAckObserver(identity());
  observer.push(good());
  const comment = `:${'x'.repeat(32765)}\n\n`;
  for (let i = 0; i < 64; i++) observer.push(comment);
  assert.ok(observer.snapshot().events < 1024);
  expectTerminal(observer, true);
});

test('event count is bounded including malformed or unrelated frames', () => {
  const observer = createGenerationAckObserver(identity());
  observer.push(': keepalive\n\n'.repeat(1023));
  observer.push(good());
  expectMatch(observer);
  assert.equal(observer.snapshot().events, 1024);
  observer.push('event: unknown\n\n');
  assert.equal(observer.snapshot().events, 1024);
  expectTerminal(observer, true);
});

test('push count, invalid chunk types, query count and error count fail closed', () => {
  const manyPushes = createGenerationAckObserver(identity());
  for (let i = 0; i < 32768; i++) manyPushes.push('');
  manyPushes.push(good());
  expectTerminal(manyPushes, true);
  for (const invalid of [null, undefined, 123, {}, ['event: SSE_ACK']]) {
    const observer = createGenerationAckObserver(identity());
    observer.push(good());
    observer.push(invalid);
    expectTerminal(observer, true);
  }
  const manyQueries = createGenerationAckObserver(identity());
  manyQueries.push(frame('SSE_ACK', ack({}, Array(129).fill('local-m1'))));
  expectTerminal(manyQueries, true);
  const manyErrors = createGenerationAckObserver(identity());
  manyErrors.push(good());
  for (let code = 0; code < 32; code++) manyErrors.push(frame('STREAM_ERROR', { error_code: code }));
  manyErrors.push(frame('STREAM_ERROR', { error_code: 0 }));
  expectMatch(manyErrors);
  manyErrors.push(frame('STREAM_ERROR', { error_code: 32 }));
  assert.equal(manyErrors.snapshot().errorCodes.length, 32);
  expectTerminal(manyErrors, true);
});
