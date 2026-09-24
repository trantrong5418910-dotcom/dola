/**
 * Inject with ctx.addInitScript(installVideoRequestAdapter, { seconds: 30 }).
 * Everything needed by the serialized function lives inside it. No I/O at install.
 * targetModel is an optional exact-match filter, NEVER a model replacement.
 * rewrite=false keeps the adapter observation-only; it never changes the body.
 * Only numeric seconds 10/15/20/30 are accepted; repeated installs update the settings.
 * Limits: 1 MiB input, depth 8, 4096 values, 2 MiB cumulative decoded JSON,
 * 100 capture entries. Unsupported/over-limit bodies pass through unchanged.
 */

/**
 * Node-side Fangyue rewrite: set ability_param.duration on chat completion bodies.
 * Mirrors the page adapter's duration rewrite without touching unrelated fields.
 */
export function rewriteVideoDurationBody(body, { seconds, targetModel = 'seedance_v2.5' } = {}) {
  if (![10, 15, 20, 30].includes(Number(seconds))) {
    throw new TypeError('seconds must be 10, 15, 20 or 30');
  }
  if (typeof body !== 'string' || !body || body.length > 1024 * 1024) return { body, changed: false, records: [] };
  const records = [];
  const models = new Set(['seedance_v2.0', 'seedance_v2.5']);
  const envelopes = new Set([
    'chat_ability', 'ability', 'abilities', 'payload', 'data', 'message', 'body', 'params', 'param',
  ]);
  try {
    const root = JSON.parse(body);
    let changed = false;
    const walk = (value, depth, eligible) => {
      if (!value || typeof value !== 'object' || depth > 8) return value;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) value[i] = walk(value[i], depth + 1, eligible);
        return value;
      }
      const ability = Object.prototype.hasOwnProperty.call(value, 'ability_type')
        || Object.prototype.hasOwnProperty.call(value, 'ability_param');
      if (eligible && ability && [17, '17'].includes(value.ability_type)
          && Object.prototype.hasOwnProperty.call(value, 'ability_param')) {
        let param = value.ability_param;
        let asString = false;
        if (typeof param === 'string') {
          try { param = JSON.parse(param); asString = true; } catch { param = null; }
        }
        if (param && typeof param === 'object' && models.has(param.model)
            && (targetModel == null || param.model === targetModel)
            && (Number(seconds) < 20 || param.model === 'seedance_v2.5')
            && Number.isFinite(Number(param.duration))) {
          const before = Number(param.duration);
          if (before !== Number(seconds)) {
            param.duration = Number(seconds);
            value.ability_param = asString ? JSON.stringify(param) : param;
            changed = true;
            records.push({ model: param.model, before, after: Number(seconds), via: 'route-rewrite' });
          } else {
            records.push({ model: param.model, before, after: before, via: 'route-rewrite' });
          }
        }
      }
      for (const key of Object.keys(value)) {
        if (eligible && ability && [17, '17'].includes(value.ability_type) && key === 'ability_param') continue;
        const child = value[key];
        if (typeof child === 'string' && eligible && envelopes.has(key)) {
          try {
            const parsed = JSON.parse(child);
            const next = walk(parsed, depth + 1, true);
            const encoded = JSON.stringify(next);
            if (encoded !== child) { value[key] = encoded; changed = true; }
          } catch { /* plain */ }
        } else if (child && typeof child === 'object') {
          walk(child, depth + 1, eligible && !ability && envelopes.has(key));
        }
      }
      return value;
    };
    walk(root, 0, true);
    return { body: changed ? JSON.stringify(root) : body, changed, records };
  } catch {
    return { body, changed: false, records: [] };
  }
}

export function installVideoRequestAdapter({ seconds, targetModel = null, rewrite = true }) {
  if (![10, 15, 20, 30].includes(seconds)) {
    throw new TypeError('seconds must be 10, 15, 20 or 30');
  }
  if (targetModel !== null && typeof targetModel !== 'string') {
    throw new TypeError('targetModel must be a string or null');
  }
  if (typeof rewrite !== 'boolean') {
    throw new TypeError('rewrite must be a boolean');
  }

  const page = window;
  let origin;
  try {
    const url = new URL(page.location.href);
    if (url.protocol !== 'https:' ||
        !(url.hostname === 'dola.com' || url.hostname.endsWith('.dola.com'))) return;
    origin = url.origin;
  } catch { return; }

  const installKey = Symbol.for('dola.generation-request.adapter.v1');
  const installed = page[installKey];
  if (installed) {
    installed.seconds = seconds;
    installed.targetModel = targetModel;
    installed.rewrite = rewrite;
    return;
  }
  const state = { seconds, targetModel, rewrite };
  const MAX_BODY = 1024 * 1024;
  const MAX_DEPTH = 8;
  const MAX_VALUES = 4096;
  const MAX_CAPTURES = 100;
  const models = new Set(['seedance_v2.0', 'seedance_v2.5']);
  // Only transport envelope fields may contain another encoded payload. Prompt,
  // content, text and arbitrary metadata are never interpreted as requests.
  const envelopes = new Set([
    'chat_ability', 'ability', 'abilities', 'payload', 'data', 'message',
    'messages', 'body', 'request', 'requests', 'list',
  ]);
  const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const safeDuration = value => {
    if (typeof value === 'number') {
      return Number.isFinite(value) && value > 0 && value <= 3600 ? value : null;
    }
    if (typeof value === 'string' && /^\d{1,4}(?:\.\d{1,3})?$/.test(value)) {
      const number = Number(value);
      return number > 0 && number <= 3600 ? value : null;
    }
    return null;
  };

  function matches(url, method) {
    if (typeof method !== 'string' || method.toUpperCase() !== 'POST') return false;
    try {
      const resolved = new URL(url, page.location.href);
      return resolved.protocol === 'https:' && resolved.origin === origin &&
        resolved.pathname === '/chat/completion' && !resolved.username && !resolved.password;
    } catch { return false; }
  }

  function patchBody(body, via, settings) {
    const untouched = { body, records: [] };
    if (typeof body !== 'string' || !body || body.length > MAX_BODY) return untouched;
    try {
      if (new TextEncoder().encode(body).byteLength > MAX_BODY) return untouched;
      let values = 0;
      let decodedSize = 0;
      const records = [];
      function check(value, depth) {
        if (depth > MAX_DEPTH || ++values > MAX_VALUES ||
            (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0) ||
              (Number.isInteger(value) && !Number.isSafeInteger(value))))) {
          // Abort the whole rewrite: never send a partially checked payload.
          throw new RangeError('Unsupported JSON bounds');
        }
      }
      function parse(text) {
        decodedSize += text.length;
        if (decodedSize > MAX_BODY * 2) throw new RangeError('JSON budget exceeded');
        // Invalid nested JSON is an opaque string; no exception text is retained.
        try { return { value: JSON.parse(text) }; } catch { return null; }
      }
      function parameter(value, depth) {
        check(value, depth);
        if (typeof value === 'string') {
          const parsed = parse(value);
          if (!parsed) return { value, changed: false };
          const next = parameter(parsed.value, depth + 1);
          return next.changed ? { value: JSON.stringify(next.value), changed: true } : { value, changed: false };
        }
        if (!isObject(value)) {
          if (Array.isArray(value)) {
            for (const child of value) walk(child, depth + 1, false);
          }
          return { value, changed: false };
        }
        // Validate parameter structure, but never traverse its prompt as an ability.
        for (const child of Object.values(value)) walk(child, depth + 1, false);
        const model = owns(value, 'model') && models.has(value.model) ? value.model : null;
        const before = owns(value, 'duration') ? safeDuration(value.duration) : null;
        const eligible = model !== null && before !== null &&
          (settings.targetModel === null || model === settings.targetModel) &&
          (settings.seconds < 20 || model === 'seedance_v2.5');
        const changed = settings.rewrite && eligible && Number(before) !== settings.seconds;
        if (changed) value.duration = settings.seconds;
        records.push({ model, before, after: changed ? settings.seconds : before, modelAfter: model, via });
        return { value, changed };
      }
      function walk(value, depth, eligible) {
        check(value, depth);
        if (typeof value === 'string' && eligible) {
          const parsed = parse(value);
          if (!parsed) return { value, changed: false };
          const next = walk(parsed.value, depth + 1, true);
          return next.changed ? { value: JSON.stringify(next.value), changed: true } : { value, changed: false };
        }
        if (value === null || typeof value !== 'object') return { value, changed: false };
        let changed = false;
        const ability = !Array.isArray(value) && (owns(value, 'ability_type') || owns(value, 'ability_param'));
        if (eligible && ability && [17, '17'].includes(value.ability_type) && owns(value, 'ability_param')) {
          const next = parameter(value.ability_param, depth + 1);
          if (next.changed) {
            value.ability_param = next.value;
            changed = true;
          }
        }
        for (const key of Object.keys(value)) {
          // Already inspected separately, including any encoded parameter layers.
          if (eligible && ability && [17, '17'].includes(value.ability_type) && key === 'ability_param') continue;
          const next = walk(value[key], depth + 1,
            eligible && !ability && (Array.isArray(value) || envelopes.has(key)));
          if (next.changed) {
            value[key] = next.value;
            changed = true;
          }
        }
        return { value, changed };
      }
      const parsed = parse(body);
      if (!parsed) return untouched;
      const next = walk(parsed.value, 0, true);
      const patched = next.changed ? JSON.stringify(next.value) : body;
      if (patched.length > MAX_BODY || new TextEncoder().encode(patched).byteLength > MAX_BODY) return untouched;
      return { body: patched, records };
    } catch { return untouched; }
  }

  function capture(records) {
    try {
      if (!Array.isArray(page.__CAP)) return;
      for (const record of records) {
        page.__CAP.push(record);
        if (page.__CAP.length > MAX_CAPTURES) page.__CAP.shift();
      }
    } catch { /* Observability must not interfere with a request. */ }
  }

  async function readRequest(input) {
    // Read a clone with a byte/chunk bound. Never consume the caller's Request.
    const copy = input.clone();
    if (!copy.body) return null;
    const reader = copy.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    let text = '';
    let done = false;
    try {
      for (let chunks = 0; chunks < MAX_VALUES; chunks++) {
        const chunk = await reader.read();
        if (chunk.done) {
          done = true;
          return text + decoder.decode();
        }
        size += chunk.value.byteLength;
        if (size > MAX_BODY) return null;
        text += decoder.decode(chunk.value, { stream: true });
      }
      return null;
    } finally {
      // Awaiting cancellation of a teed stream can wait on the original branch.
      if (!done) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  page.__CAP = [];
  const originalFetch = page.fetch;
  if (typeof originalFetch === 'function') {
    page.fetch = async function adaptedFetch(input, init) {
      let forwarded = init;
      let rewritten = false;
      let records = [];
      try {
        const settings = { seconds: state.seconds, targetModel: state.targetModel, rewrite: state.rewrite };
        const isRequest = typeof page.Request === 'function' && input instanceof page.Request;
        const url = isRequest ? input.url : input;
        const method = init?.method !== undefined ? init.method : (isRequest ? input.method : 'GET');
        if (matches(url, method)) {
          const override = init?.body;
          // Fetch treats null/undefined body as absent, inheriting a Request body.
          const fromRequest = isRequest && override == null;
          const body = fromRequest ? await readRequest(input) : override;
          const next = patchBody(body, fromRequest ? 'fetch-request' : 'fetch-init', settings);
          if (next.body !== body) {
            // A RequestInit dictionary may have inherited/non-enumerable fields.
            // Keep all overrides, credentials and headers; replace only its body.
            forwarded = Object.create(init == null ? null : init);
            Object.defineProperty(forwarded, 'body', { value: next.body, enumerable: true });
            rewritten = true;
          }
          records = next.records;
        }
      } catch { /* Unknown inputs pass through; never retain sensitive errors. */ }
      capture(records);
      // Outside the interception catch: a transport failure must NEVER retry.
      return rewritten ? originalFetch.call(this, input, forwarded) : originalFetch.apply(this, arguments);
    };
  }

  const prototype = page.XMLHttpRequest?.prototype;
  if (prototype && typeof prototype.open === 'function' && typeof prototype.send === 'function') {
    const originalOpen = prototype.open;
    const originalSend = prototype.send;
    const requests = new WeakMap();
    prototype.open = function adaptedOpen(method, url) {
      requests.delete(this);
      const result = originalOpen.apply(this, arguments);
      requests.set(this, { method, url });
      return result;
    };
    prototype.send = function adaptedSend(body) {
      let next = { body, records: [] };
      try {
        const request = requests.get(this);
        if (request && matches(request.url, request.method)) {
          next = patchBody(body, 'xhr', state);
        }
      } catch { /* No request, prompt, cookie or exception logging. */ }
      capture(next.records);
      if (next.body === body) return originalSend.apply(this, arguments);
      return originalSend.call(this, next.body);
    };
  }
  Object.defineProperty(page, installKey, { value: state });
}
