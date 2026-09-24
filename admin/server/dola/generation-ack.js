/**
 * Pure, bounded request/SSE correlation. An ACK confirms receipt only; it says
 * nothing about generation success or a final video. No URLs or message content
 * are used as evidence, and no completed event or raw transcript is retained.
 *
 * String budgets are UTF-16 code units: request 1 Mi, decoded request 2 Mi,
 * chunk/event 64 Ki, stream 2 Mi. Other limits: 4 JSON container layers,
 * 128 messages, 1,024 nonempty frames, 32,768 pushes, 32 unique error codes.
 */
const MAX_BODY = 1024 * 1024;
const MAX_CHUNK = 64 * 1024;
const MAX_EVENT = 64 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024;
const MAX_MESSAGES = 128;
const MAX_EVENTS = 1024;
const MAX_PUSHES = 32768;
const MAX_ERRORS = 32;
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const localId = value => typeof value === 'string' && value.length > 0
  && value.length <= 128 && value.trim().length > 0;
const conversationId = value => typeof value === 'string' && value.length >= 10
  && value.length <= 30 && !/[^0-9]/.test(value);

/**
 * Only root.{local_conversation_id,local_message_id} and the same fields on
 * root.messages[] are inspected. Root, messages, and message containers may
 * be JSON encoded; identifier strings themselves are never decoded/coerced.
 * Invalid known fields or conflicting conversation IDs reject the whole body.
 */
export function identifyGenerationRequest(bodyString) {
  if (typeof bodyString !== 'string' || !bodyString.length || bodyString.length > MAX_BODY) return null;
  let decoded = 0;
  const container = input => {
    let value = input;
    for (let layer = 0; typeof value === 'string'; layer++) {
      decoded += value.length;
      if (layer >= 4 || decoded > MAX_TOTAL) throw new RangeError('Transport bounds');
      value = JSON.parse(value);
    }
    return value;
  };
  try {
    const root = container(bodyString);
    if (!object(root)) return null;
    let localConversationId = null;
    const messages = new Set();
    const inspect = value => {
      if (!object(value)) throw new TypeError('Transport shape');
      if (owns(value, 'local_conversation_id')) {
        const id = value.local_conversation_id;
        if (!localId(id) || (localConversationId !== null && localConversationId !== id)) {
          throw new TypeError('Conversation identity');
        }
        localConversationId = id;
      }
      if (owns(value, 'local_message_id')) {
        const id = value.local_message_id;
        if (!localId(id)) throw new TypeError('Message identity');
        messages.add(id);
        if (messages.size > MAX_MESSAGES) throw new RangeError('Message bounds');
      }
    };
    inspect(root);
    if (owns(root, 'messages')) {
      const values = container(root.messages);
      if (!Array.isArray(values) || values.length > MAX_MESSAGES) return null;
      for (const value of values) inspect(container(value));
    }
    return localConversationId !== null || messages.size
      ? { localConversationId, localMessageIds: [...messages] } : null;
  } catch {
    return null;
  }
}

function normalizeIdentity(identity) {
  if (!object(identity) || !owns(identity, 'localConversationId') || !owns(identity, 'localMessageIds')) return null;
  const { localConversationId, localMessageIds } = identity;
  if (localConversationId !== null && !localId(localConversationId)) return null;
  if (!Array.isArray(localMessageIds) || localMessageIds.length > MAX_MESSAGES) return null;
  const ids = new Set();
  for (const id of localMessageIds) {
    if (!localId(id)) return null;
    ids.add(id);
  }
  return localConversationId !== null || ids.size ? { localConversationId, ids } : null;
}

/**
 * push/finish return fresh sanitized snapshots. finish is idempotent; further
 * pushes are ignored. EOF does not dispatch an unterminated SSE frame: partial
 * input marks truncation and clears any match. Limits and correlated conflicts
 * permanently clear the match and stop processing (conflict is not truncation).
 *
 * With message IDs, every expected ID must occur in ONE ACK. Unrelated/partial
 * ACKs are never combined. A supplied ACK local conversation must not conflict;
 * it may be absent when all message IDs match. With only a local conversation,
 * its exact ACK match is mandatory. question_id is not correlation evidence.
 */
export function createGenerationAckObserver(identity) {
  const expected = normalizeIdentity(identity);
  let matchedConversation = null;
  let truncated = false;
  let conflicted = false;
  let stopped = false;
  let finished = false;
  let total = 0;
  let pushes = 0;
  let events = 0;
  const errorCodes = new Set();
  let line = '';
  let data = [];
  let eventType = null;
  let frameSize = 0;
  let hasLine = false;
  let skipLF = false;
  let atStart = true;

  const snapshot = () => ({
    conversationId: matchedConversation,
    ackMatched: matchedConversation !== null,
    errorCodes: [...errorCodes],
    events,
    truncated,
  });
  const clearFrame = () => {
    line = '';
    data = [];
    eventType = null;
    frameSize = 0;
    hasLine = false;
  };
  const stop = isTruncated => {
    conflicted ||= !isTruncated;
    truncated ||= isTruncated;
    matchedConversation = null;
    stopped = true;
    skipLF = false;
    clearFrame();
  };

  function inspectAck(ack) {
    if (!object(ack)) return;
    const queries = owns(ack, 'query_list') ? ack.query_list : undefined;
    if (Array.isArray(queries) && queries.length > MAX_MESSAGES) {
      stop(true);
      return;
    }
    if (!expected || !owns(ack, 'ack_client_meta') || !object(ack.ack_client_meta)) return;
    const meta = ack.ack_client_meta;
    const hasLocalConversation = owns(meta, 'local_conversation_id');
    if (expected.ids.size) {
      if (!Array.isArray(queries)) return;
      const matched = new Set();
      for (const query of queries) {
        if (object(query) && owns(query, 'local_message_id') && expected.ids.has(query.local_message_id)) {
          matched.add(query.local_message_id);
        }
      }
      // Another request in the same conversation is still unrelated.
      if (!matched.size) return;
      if (hasLocalConversation && (!localId(meta.local_conversation_id)
          || (expected.localConversationId !== null && meta.local_conversation_id !== expected.localConversationId))) {
        stop(false);
        return;
      }
      if (matched.size !== expected.ids.size) return;
    } else if (!hasLocalConversation || meta.local_conversation_id !== expected.localConversationId) {
      return;
    }

    const hasDirect = owns(meta, 'conversation_id');
    const info = owns(meta, 'conversation_info') ? meta.conversation_info : null;
    const hasNested = object(info) && owns(info, 'conversation_id');
    if (!hasDirect && !hasNested) return;
    // A malformed direct ID never falls back to a nested ID (or vice versa).
    if ((hasDirect && !conversationId(meta.conversation_id))
        || (hasNested && !conversationId(info.conversation_id))) return;
    if (hasDirect && hasNested && meta.conversation_id !== info.conversation_id) {
      stop(false);
      return;
    }
    const id = hasDirect ? meta.conversation_id : info.conversation_id;
    if (matchedConversation !== null && matchedConversation !== id) {
      stop(false);
      return;
    }
    matchedConversation = id;
  }

  function dispatch() {
    if (!hasLine) return;
    if (events >= MAX_EVENTS) {
      stop(true);
      return;
    }
    events++;
    if (!data.length || eventType === null) return;
    let value;
    try { value = JSON.parse(data.join('\n')); } catch { return; }
    if (eventType === 'SSE_ACK') {
      inspectAck(value);
    } else if (object(value) && owns(value, 'error_code') && Number.isSafeInteger(value.error_code)) {
      if (!errorCodes.has(value.error_code) && errorCodes.size >= MAX_ERRORS) {
        stop(true);
        return;
      }
      errorCodes.add(value.error_code);
    }
  }

  function acceptLine(value) {
    if (value === '') {
      dispatch();
      clearFrame();
      return;
    }
    hasLine = true;
    if (value[0] === ':') return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content[0] === ' ') content = content.slice(1);
    if (field === 'event') {
      eventType = content === 'SSE_ACK' || content === 'STREAM_ERROR' ? content : null;
    } else if (field === 'data') {
      data.push(content);
    }
  }

  function push(textChunk) {
    if (finished || stopped) return snapshot();
    if (typeof textChunk !== 'string' || textChunk.length > MAX_CHUNK
        || pushes >= MAX_PUSHES || total + textChunk.length > MAX_TOTAL) {
      stop(true);
      return snapshot();
    }
    pushes++;
    total += textChunk.length;
    let start = 0;
    for (let i = 0; i < textChunk.length; i++) {
      const char = textChunk[i];
      if (atStart) {
        atStart = false;
        if (char === '\uFEFF') {
          start = i + 1;
          continue;
        }
      }
      if (skipLF) {
        skipLF = false;
        if (char === '\n') {
          start = i + 1;
          continue;
        }
      }
      if (++frameSize > MAX_EVENT) {
        stop(true);
        return snapshot();
      }
      if (char === '\n' || char === '\r') {
        const completed = line + textChunk.slice(start, i);
        line = '';
        acceptLine(completed);
        if (stopped) return snapshot();
        skipLF = char === '\r';
        start = i + 1;
      }
    }
    line += textChunk.slice(start);
    return snapshot();
  }

  function finish() {
    if (!finished && !stopped && (hasLine || line.length)) stop(true);
    finished = true;
    clearFrame();
    return snapshot();
  }

  return { push, finish, snapshot, hasConflict: () => conflicted };
}
