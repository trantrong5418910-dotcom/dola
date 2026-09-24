import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const MAX_BYTES = 32 * 1024;
const MAX_TIMEOUT_MS = 10_000;
const OTP_KEYS = new Set(['otp', 'verification_code', 'code']);
const AUTHENTICATOR_KEYS = new Set([...OTP_KEYS, 'totp', 'pin', 'token']);
export const LOGIN_VERIFICATION_CODE_ERROR = 'LOGIN_VERIFICATION_CODE_UNAVAILABLE';

function safeError() {
  return Object.assign(new Error('Unable to read login verification code.'), {
    code: LOGIN_VERIFICATION_CODE_ERROR,
  });
}

function ipv4Number(address) {
  return address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
}

// Conservatively exclude special-purpose ranges, including their public exceptions.
const IPV4_DENY = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  // Azure's platform virtual IP must not be treated as an ordinary public host.
  ['168.63.129.16', 32],
].map(([address, bits]) => [ipv4Number(address), 2 ** (32 - bits)]);

function ipv6Number(address) {
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const parts = halves.length === 1 ? left
    : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

const IPV6_DENY = [
  ['2001::', 23], // IETF special assignments, including Teredo and ORCHID.
  ['2001:db8::', 32], ['2002::', 16], // Documentation and IPv4 tunnelling.
  ['2620:4f:8000::', 48], // Special-purpose AS112 service.
  ['3ffe::', 16], ['3fff::', 20], // Retired 6bone and documentation.
].map(([address, bits]) => [ipv6Number(address), BigInt(128 - bits)]);

export function isPublicIP(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return !IPV4_DENY.some(([base, size]) => Math.floor(value / size) === Math.floor(base / size));
  }
  // Only ordinary global unicast IPv6; no mapped/compatible IPv4, NAT64, ULA,
  // link-local, multicast, scoped addresses, or unallocated address space.
  if (family !== 6 || address.includes('.')) return false;
  const value = ipv6Number(address);
  return value >> 125n === 1n
    && !IPV6_DENY.some(([base, shift]) => value >> shift === base >> shift);
}

function readEndpointUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 8192
      || /[\s\u0000-\u001f\u007f-\u009f\\#]/u.test(rawUrl)
      || /%(?![a-f0-9]{2})/i.test(rawUrl)) throw safeError();
  const parts = /^https?:\/\/([^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?$/i.exec(rawUrl);
  const authority = parts?.[1];
  // Check the raw authority before URL normalizes IP spellings, escapes and
  // default ports. Only canonical dotted IPv4 and ASCII domain names qualify.
  if (!authority || !/^[a-z0-9.-]+(?::[1-9][0-9]{0,4})?$/i.test(authority)) throw safeError();
  const url = new URL(rawUrl);
  const host = url.hostname;
  const rawHost = authority.split(':')[0].toLowerCase();
  if (rawHost !== host || host.length > 253 || !host.includes('.')
      || /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|intranet|corp|onion|arpa)$/.test(host)
      || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
      || (isIP(host) && (isIP(rawHost) !== 4 || !isPublicIP(host)))) {
    throw safeError();
  }
  // Examine the ORIGINAL path: URL has already erased dot segments. Also
  // reject layered encodings before any proxy/server could decode a prefix
  // into a different route. Queries remain opaque and are never sent as headers.
  let path = parts[2] || '/';
  for (let i = 0; ; i++) {
    if (/[\s\\?#\u0000-\u001f\u007f-\u009f]/u.test(path)
        || /(?:^|\/)\.{1,2}(?:\/|;|$)/.test(path)
        || /%(?:2f|5c)/i.test(path)) throw safeError();
    if (!/%[a-f0-9]{2}/i.test(path)) break;
    if (i === 8) throw safeError();
    path = path.replace(/%([a-f0-9]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  // Refuse recognizable image/challenge resources before DNS or GET. MIME
  // validation below also rejects an unexpected image at an opaque endpoint.
  let resource = `${host}${url.pathname}${url.search}`;
  for (let i = 0; i < 8 && /%[a-f0-9]{2}/i.test(resource); i++) {
    resource = resource.replace(/%([a-f0-9]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  if (/%[a-f0-9]{2}/i.test(resource) || /captcha/i.test(resource)
      || /gapi\.mailsapi\.com/i.test(resource) || /(?:^|\.)gapi(?:\.|$)/i.test(host)
      || /(?:^|\.)accounts\.google\.com$/i.test(host)
      || /\/(?:login|signin|oauth)(?:[/?#;]|$)/i.test(resource)
      || /(?:^|[\/?&=_.-])images?(?:$|[\/?&=_.-])/i.test(resource)
      || /(?:\.|[?&](?:format|type|ext)=)(?:png|jpe?g|gif|webp|svg|bmp|ico|avif|apng|tiff?|heic)(?:$|[/?&#;])/i.test(resource)) {
    throw safeError();
  }
  return url;
}

/** Syntax-only shared policy; fetching must still validate and pin DNS answers.
 * Ordinary public-domain HTTPS:443 needs no configuration. Other public HTTP(S)
 * endpoints require an explicit origin + directory prefix (including its '/').
 * The comma/newline-separated allowlist cannot override any safety rejection.
 */
export function validateLoginVerificationCodeUrl(rawUrl, options = {}) {
  try {
    const { endpointAllowlist = process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST || '' } = options;
    if (typeof endpointAllowlist !== 'string') throw safeError();
    const url = readEndpointUrl(rawUrl);
    if (url.protocol === 'https:' && !url.port && !isIP(url.hostname)) return url;
    if (Buffer.byteLength(endpointAllowlist, 'utf8') > MAX_BYTES) throw safeError();
    const prefixes = endpointAllowlist.split(/[,\r\n]/).map(value => value.trim()).filter(Boolean).map(value => {
      const prefix = readEndpointUrl(value);
      if (!value.endsWith('/') || value.includes('?')) throw safeError();
      return prefix;
    });
    if (!prefixes.some(prefix => prefix.origin === url.origin && url.pathname.startsWith(prefix.pathname))) {
      throw safeError();
    }
    return url;
  } catch {
    throw safeError();
  }
}

function rejectDuplicateKeys(json, foldCase = false) {
  // JSON.parse would silently retain the last duplicate OTP. Scan JSON tokens
  // after syntax validation, decoding escaped keys before comparing them.
  const objects = [];
  const tokens = /"(?:\\.|[^"\\])*"|[{}]/g;
  let match;
  while ((match = tokens.exec(json))) {
    const token = match[0];
    if (token === '{') objects.push(new Set());
    else if (token === '}') objects.pop();
    else if (/^\s*:/.test(json.slice(tokens.lastIndex))) {
      const decodedKey = JSON.parse(token);
      const key = foldCase ? decodedKey.toLowerCase() : decodedKey;
      const keys = objects[objects.length - 1];
      if (!keys || keys.has(key)) throw safeError();
      keys.add(key);
    }
  }
}

function parseAuthenticatorObject(root) {
  const candidates = [];
  // Generic conservative adapter, NOT a promise about an unverified vendor.
  // Only data/result may nest (root depth 0, at most six wrapper levels).
  // Status values are deliberately finite; msg/message may only acknowledge
  // success and require an explicit success/status/business-code marker locally.
  const successValue = value => value === 0 || value === 200
    || (typeof value === 'string' && /^(?:0|200|ok|success)$/i.test(value.trim()));
  const collect = (object, depth) => {
    if (depth > 6 || !object || typeof object !== 'object' || Array.isArray(object)
        || Object.keys(object).length === 0) throw safeError();
    let successful = false, hasMetadata = false;
    for (const [rawKey, value] of Object.entries(object)) {
      const key = rawKey.toLowerCase();
      if (key === 'data' || key === 'result') { collect(value, depth + 1); continue; }
      if (key === 'success' || key === 'status' || (key === 'code' && successValue(value))) {
        if (key === 'success' ? value !== true : !successValue(value)) throw safeError();
        successful = true;
        continue;
      }
      if (key === 'message' || key === 'msg') {
        if (typeof value !== 'string' || !/^(?:ok|success)?$/i.test(value.trim())) throw safeError();
        hasMetadata = true;
        continue;
      }
      if (!AUTHENTICATOR_KEYS.has(key) || !['string', 'number'].includes(typeof value)) throw safeError();
      const code = typeof value === 'string' ? value.trim() : String(value);
      if (!/^[0-9]{6}$/.test(code)) throw safeError();
      candidates.push(code);
      // Unlike the legacy email profile, even repeated equal candidates are
      // ambiguous: the authenticator adapter requires exactly one code field.
      if (candidates.length > 1) throw safeError();
    }
    if (hasMetadata && !successful) throw safeError();
  };
  collect(root, 0);
  if (candidates.length !== 1) throw safeError();
  return candidates[0];
}

/** Pure parser. Only a bare OTP or the documented shallow JSON objects qualify.
 * JSON OTP values may be strings or integers; strings retain leading zeroes.
 * Unknown keys, duplicate keys, arrays, malformed fields and ambiguity fail closed.
 * profile='email' preserves the original contract; 'authenticator' accepts six
 * digits and the explicitly bounded object adapter above, never text extraction.
 */
export function parseLoginVerificationCode(body, options = {}) {
  try {
    const { profile = 'email' } = options;
    if (profile !== 'email' && profile !== 'authenticator') throw safeError();
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_BYTES) throw safeError();
    const trimmed = body.trim();
    if ((profile === 'email' ? /^(?:[0-9]{6}|[0-9]{8})$/ : /^[0-9]{6}$/).test(trimmed)) return trimmed;
    const root = JSON.parse(trimmed);
    rejectDuplicateKeys(trimmed, profile === 'authenticator');
    if (profile === 'authenticator') return parseAuthenticatorObject(root);
    const candidates = new Set();
    const collect = (object, allowData) => {
      if (!object || typeof object !== 'object' || Array.isArray(object)
          || Object.keys(object).length === 0) throw safeError();
      for (const [key, value] of Object.entries(object)) {
        if (allowData && key === 'data') { collect(value, false); continue; }
        if (!OTP_KEYS.has(key) || !['string', 'number'].includes(typeof value)) throw safeError();
        const code = typeof value === 'string' ? value.trim() : String(value);
        if (!/^(?:[0-9]{6}|[0-9]{8})$/.test(code)) throw safeError();
        candidates.add(code);
      }
    };
    collect(root, true);
    if (candidates.size !== 1) throw safeError();
    return [...candidates][0];
  } catch {
    throw safeError();
  }
}

function destroyQuietly(stream) {
  try { stream?.destroy(); } catch { /* Never expose transport errors. */ }
}

/** One policy-approved HTTP(S) GET; no account state, cookies, redirects, retries or logging.
 * lookup: node:dns.lookup callback signature (Promise-returning mocks also work).
 * request: node:http(s).request(options, onResponse) signature, followed by end().
 * One injected request works for either transport; production selects by URL.
 * timeoutMs may shorten the total DNS + TLS + response deadline, never extend it.
 */
export function fetchLoginVerificationCode(rawUrl, options = {}) {
  return new Promise((resolve, reject) => {
    let done = false, timer, signal, requestStream, responseStream;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { signal?.removeEventListener('abort', abort); } catch { /* No raw errors. */ }
      destroyQuietly(responseStream);
      destroyQuietly(requestStream);
      if (code === undefined) reject(safeError());
      else resolve(code);
    };
    const abort = () => finish();
    try {
      const url = validateLoginVerificationCodeUrl(rawUrl, options);
      const { lookup = dnsLookup, request = url.protocol === 'http:' ? httpRequest : httpsRequest,
        timeoutMs = MAX_TIMEOUT_MS, profile = 'email' } = options;
      signal = options.signal;
      if (typeof lookup !== 'function' || typeof request !== 'function'
          || (profile !== 'email' && profile !== 'authenticator')
          || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS
          || (signal !== undefined && (typeof signal?.addEventListener !== 'function'
            || typeof signal?.removeEventListener !== 'function' || typeof signal?.aborted !== 'boolean'))) {
        throw safeError();
      }
      if (signal?.aborted) { finish(); return; }
      timer = setTimeout(abort, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      let dnsSettled = false;
      const onLookup = (error, records) => {
        if (done || dnsSettled) return;
        dnsSettled = true;
        try {
          if (error || !Array.isArray(records) || records.length === 0) throw safeError();
          // Copy before pinning: mutable resolver records must never change the
          // validated destination. Every answer must pass, even unused answers.
          const addresses = records.map(record => ({ address: record.address, family: record.family }));
          if (!addresses.every(({ address, family }) => isPublicIP(address) && isIP(address) === family)) {
            throw safeError();
          }
          const pinned = addresses[0];
          const pinnedLookup = (hostname, lookupOptions, callback) => {
            if (typeof lookupOptions === 'function') { callback = lookupOptions; lookupOptions = {}; }
            if (hostname !== url.hostname || done) { callback(safeError()); return; }
            if (lookupOptions?.all) callback(null, [{ ...pinned }]);
            else callback(null, pinned.address, pinned.family);
          };
          const onResponse = (response) => {
            // Install error handling even on a response arriving after timeout.
            response.on('error', abort);
            if (done) { destroyQuietly(response); return; }
            if (responseStream) { destroyQuietly(response); finish(); return; }
            responseStream = response;
            try {
              const headers = response.headers;
              const type = headers['content-type'];
              if (response.statusCode !== 200 || typeof type !== 'string'
                  || !/^(?:application\/json|text\/plain)(?:\s*;[^\r\n]*)?$/i.test(type)
                  || (headers['content-encoding'] !== undefined && headers['content-encoding'] !== 'identity')) {
                throw safeError();
              }
              const seenHeaders = new Set();
              for (let i = 0; i < (response.rawHeaders?.length ?? 0); i += 2) {
                const name = response.rawHeaders[i].toLowerCase();
                if (!['content-type', 'content-length', 'content-encoding'].includes(name)) continue;
                if (seenHeaders.has(name)) throw safeError();
                seenHeaders.add(name);
              }
              const length = headers['content-length'];
              if (length !== undefined && (typeof length !== 'string' || !/^[0-9]+$/.test(length)
                  || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_BYTES)) throw safeError();
              const chunks = [];
              let bytes = 0, ended = false;
              response.on('aborted', abort);
              response.on('close', () => { if (!ended) finish(); });
              response.on('data', chunk => {
                if (done) return;
                if (!Buffer.isBuffer(chunk) || (bytes += chunk.length) > MAX_BYTES) { finish(); return; }
                chunks.push(chunk);
              });
              response.on('end', () => {
                if (done) return;
                ended = true;
                try {
                  if (response.complete === false || (length !== undefined && bytes !== Number(length))) throw safeError();
                  const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
                  finish(parseLoginVerificationCode(body, { profile }));
                } catch { finish(); }
              });
            } catch { finish(); }
          };
          requestStream = request({
            protocol: url.protocol, method: 'GET', hostname: url.hostname,
            port: Number(url.port || (url.protocol === 'http:' ? 80 : 443)),
            ...(url.protocol === 'https:' && !isIP(url.hostname) ? { servername: url.hostname } : {}),
            path: url.pathname + url.search,
            lookup: pinnedLookup, family: pinned.family, autoSelectFamily: false,
            agent: false, rejectUnauthorized: true, maxHeaderSize: 8192, timeout: timeoutMs,
            headers: { accept: 'application/json, text/plain', 'accept-encoding': 'identity' },
          }, onResponse);
          requestStream.on('error', abort);
          requestStream.on('timeout', abort);
          requestStream.on('close', () => { if (!responseStream) finish(); });
          requestStream.on('upgrade', (response, socket) => {
            destroyQuietly(socket); destroyQuietly(response); finish();
          });
          if (done) destroyQuietly(requestStream);
          else requestStream.end();
        } catch { finish(); }
      };
      if (isIP(url.hostname) === 4) {
        onLookup(null, [{ address: url.hostname, family: 4 }]);
      } else {
        const pending = lookup(url.hostname, { all: true, verbatim: true }, onLookup);
        if (pending && typeof pending.then === 'function') pending.then(records => onLookup(null, records), abort);
      }
    } catch { finish(); }
  });
}
