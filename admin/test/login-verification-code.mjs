import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import {
  fetchLoginVerificationCode, parseLoginVerificationCode, isPublicIP,
  validateLoginVerificationCodeUrl, LOGIN_VERIFICATION_CODE_ERROR,
} from '../server/dola/login-verification-code.js';

// Every fetch supplies BOTH dependencies. Public IPs below are classification
// fixtures only; these tests never open a socket or invoke the system resolver.
const URL_FIXTURE = 'https://otp.example.invalid/mail?token=fixture-secret&mail=authorized%40example.invalid';
const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:4700:4700::1111';
const SECRET = 'fixture-private-url-body-error';
function safeFailure(error) {
  assert.equal(error.constructor, Error);
  assert.equal(error.code, LOGIN_VERIFICATION_CODE_ERROR);
  assert.equal(error.message, 'Unable to read login verification code.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.deepEqual(Object.keys(error), ['code']);
  assert.doesNotMatch(error.stack, /fixture-secret|fixture-private-url-body-error|otp\.example/);
  return true;
}

function fixture({ records = [{ address: PUBLIC_V4, family: 4 }], body = '123456',
  headers = { 'content-type': 'text/plain' }, status = 200, chunks, rawHeaders,
  complete = true, deliver, onRequest } = {}) {
  const state = { dnsCalls: 0, requests: [], ends: 0, request: null, response: null };
  const lookup = (host, options, callback) => {
    state.dnsCalls++;
    assert.equal(host, 'otp.example.invalid');
    assert.deepEqual(options, { all: true, verbatim: true });
    queueMicrotask(() => callback(null, records));
  };
  const request = (options, callback) => {
    state.requests.push(options);
    onRequest?.(options);
    const req = new EventEmitter();
    req.destroy = () => { req.destroyed = true; };
    req.end = () => {
      state.ends++;
      queueMicrotask(() => {
        if (req.destroyed) return;
        const res = new EventEmitter();
        Object.assign(res, { headers, rawHeaders, statusCode: status, complete });
        res.destroy = () => { res.destroyed = true; res.emit('close'); };
        state.response = res;
        callback(res);
        if (deliver) { deliver(res, req); return; }
        for (const chunk of chunks ?? [Buffer.from(body)]) {
          if (res.destroyed) return;
          res.emit('data', chunk);
        }
        if (!res.destroyed) res.emit('end');
      });
    };
    state.request = req;
    return req;
  };
  return { state, lookup, request, endpointAllowlist: '' };
}

test('pure parser accepts only one six/eight digit value, preserving leading zeroes', () => {
  for (const [body, expected] of [
    [' \n001234\t', '001234'], ['00123456', '00123456'],
    ['{"otp":"012345"}', '012345'], ['{"verification_code":123456}', '123456'],
    ['{"code":" 12345678 "}', '12345678'], ['{"data":{"otp":"123456"}}', '123456'],
    ['{"data":{"verification_code":12345678}}', '12345678'],
    ['{"otp":"123456","code":123456,"data":{"code":"123456"}}', '123456'],
  ]) assert.equal(parseLoginVerificationCode(body), expected);
});

test('parser fails closed on ambiguity, unsupported structures, duplicates and text extraction', () => {
  for (const body of [
    '', '12345', '1234567', '123456789', '１２３４５６', 'Your OTP is 123456',
    '123456 123456', '<html>123456</html>', '"123456"', '["123456"]', 'null', '{}',
    '{"data":[]}', '{"data":"123456"}', '{"result":{"code":"123456"}}',
    '{"data":{"data":{"code":"123456"}}}', '{"message":"123456"}',
    '{"otp":"123456","unknown":"123456"}', '{"otp":"123456","data":{}}',
    '{"otp":"123456","code":"654321"}', '{"otp":"123456","data":{"code":"12345678"}}',
    '{"otp":"123456","code":null}', '{"otp":true}', '{"otp":-123456}',
    '{"otp":12345.6}', '{"otp":{"code":"123456"}}', '{"code":"123456","code":"654321"}',
    '{"code":"123456","c\\u006fde":"654321"}', '{"code":"123456","code":"123456"}',
    '{"data":{"otp":"123456","otp":"654321"}}', '{"code":"123456"} trailing',
    ' '.repeat(32763) + '123456', null, 123456, Buffer.from('123456'),
  ]) assert.throws(() => parseLoginVerificationCode(body), safeFailure);
});

test('public IP classification rejects special-purpose, metadata and tunnel ranges', () => {
  for (const ip of [PUBLIC_V4, PUBLIC_V6, '8.8.8.8', '1.1.1.1', '2001:4860:4860::8888',
    '2001:4860:4860:0:0:0:0:8888', '2606:4700::ABCD']) assert.equal(isPublicIP(ip), true, ip);
  for (const ip of [
    '0.0.0.0', '0.255.255.255', '10.0.0.1', '100.64.0.0', '100.127.255.255',
    '100.100.100.200', '127.0.0.1', '127.255.255.255', '169.254.169.254', '169.254.0.1',
    '172.16.0.0', '172.31.255.255', '192.0.0.9', '192.0.2.1', '192.31.196.1',
    '192.52.193.1', '192.88.99.1', '192.168.1.1', '192.175.48.1', '198.18.0.1',
    '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.0', '239.255.255.255',
    '240.0.0.0', '255.255.255.255', '168.63.129.16', '::', '::1', '::8.8.8.8',
    '::ffff:127.0.0.1', '::ffff:8.8.8.8', '::ffff:0808:0808', '::ffff:0:808:808',
    '64:ff9b::808:808', '64:ff9b:1::1', '100::1', '2001::1', '2001:2::1',
    '2001:10::1', '2001:20::1', '2001:db8::1', '2002:0808:0808::1',
    '2620:4f:8000::1', '3ffe::1', '3fff::1',
    '3fff:fff:ffff::1', '4000::1', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'fe80::1%en0',
    'fec0::1', 'ff02::1', '2606:4700::1%en0', '01.1.1.1', '2130706433', '0x7f000001',
    '[2606:4700::1]', '93.184.216.34\n', 'not-an-ip', '', null,
  ]) assert.equal(isPublicIP(ip), false, String(ip));
});

test('unsafe URLs and recognizable image/captcha URLs fail before any DNS or request', async () => {
  const rejected = [
    'http://otp.example.invalid/mail', 'ftp://otp.example.invalid/mail', '/mail',
    'https://u:p@otp.example.invalid/mail', 'https://@otp.example.invalid/mail',
    'https://otp.example.invalid:444/mail', 'https://otp.example.invalid:/mail',
    'https://otp.example.invalid/mail#', 'https://otp.example.invalid/mail#secret',
    'https://localhost/mail', 'https://sub.localhost/mail', 'https://router.local/mail',
    'https://router/mail', 'https://otp.example.invalid./mail', 'https://bad_name.example/mail',
    'https://127.0.0.1/mail', 'https://8.8.8.8/mail', 'https://2130706433/mail',
    'https://0x7f000001/mail', 'https://0177.0.0.1/mail', 'https://127.1/mail',
    'https://[::1]/mail', 'https://[::ffff:8.8.8.8]/mail', 'https://[2606:4700::1111]/mail',
    ' https://otp.example.invalid/mail', 'https://otp.example.invalid/\r\nCookie:secret',
    'https://otp.example.invalid/\tmail', 'https://otp.example.invalid\\@localhost/mail',
    'https://otp.example.invalid/captcha', 'https://otp.example.invalid/%63aptcha',
    'https://otp.example.invalid/%2563aptcha', 'https://otp.example.invalid/image',
    'https://otp.example.invalid/image.png', 'https://otp.example.invalid/render?type=image',
    'https://otp.example.invalid/code?format=png', 'https://otp.example.invalid/code?kind=captcha',
    'https://captcha.example.invalid/code', 'https://otp.example.invalid/code.svg?token=1',
    '', null, new URL(URL_FIXTURE), `https://otp.example.invalid/${'a'.repeat(8192)}`,
  ];
  for (const url of rejected) {
    const mock = fixture();
    await assert.rejects(fetchLoginVerificationCode(url, mock), safeFailure);
    assert.equal(mock.state.dnsCalls, 0);
    assert.equal(mock.state.requests.length, 0);
  }
  assert.equal(validateLoginVerificationCodeUrl('https://otp.example.invalid:443/mail').port, '');
});

test('DNS validates all IPv4/IPv6 answers before connecting; empty and malformed answers fail', async () => {
  for (const records of [
    [], null, [{ address: PUBLIC_V4, family: 6 }], [{ address: PUBLIC_V6, family: 4 }],
    [{ address: PUBLIC_V4, family: '4' }], [{}], [null],
    ...['127.0.0.1', '10.0.0.1', '169.254.169.254', '168.63.129.16', '198.51.100.1',
      '::ffff:8.8.8.8', '::1', '2001:db8::1', 'fc00::1'].map(address => [
      { address: PUBLIC_V4, family: 4 }, { address, family: address.includes(':') ? 6 : 4 },
    ]),
  ]) {
    const mock = fixture({ records });
    await assert.rejects(fetchLoginVerificationCode(URL_FIXTURE, mock), safeFailure);
    assert.equal(mock.state.dnsCalls, 1);
    assert.equal(mock.state.requests.length, 0);
  }
});

test('one GET preserves query and original TLS host, with only safe headers and pinned DNS', async () => {
  const mock = fixture();
  const url = URL_FIXTURE + '&opaque=%0D%0ACookie%3Ainjected&x=one+two&x=%2F';
  assert.equal(await fetchLoginVerificationCode(url, mock), '123456');
  assert.equal(mock.state.ends, 1);
  assert.equal(mock.state.requests.length, 1);
  const options = mock.state.requests[0];
  assert.equal(options.hostname, 'otp.example.invalid');
  assert.equal(options.servername, options.hostname);
  assert.equal(options.path, new URL(url).pathname + new URL(url).search);
  assert.equal(options.protocol, 'https:'); assert.equal(options.port, 443);
  assert.equal(options.method, 'GET'); assert.equal(options.agent, false);
  assert.equal(options.rejectUnauthorized, true); assert.equal(options.autoSelectFamily, false);
  assert.equal(options.timeout, 10000); assert.equal(options.maxHeaderSize, 8192);
  assert.deepEqual(options.headers, { accept: 'application/json, text/plain', 'accept-encoding': 'identity' });
  for (const key of ['auth', 'cookie', 'referer', 'origin', 'authorization']) assert.equal(options[key], undefined);
  assert.equal(mock.state.request.destroyed, true);
});

test('DNS rebinding: repeated connection lookups stay pinned; no second resolver lookup or retry', async () => {
  for (const [address, family] of [[PUBLIC_V4, 4], [PUBLIC_V6, 6]]) {
    let resolverCalls = 0;
    const records = [{ address, family }, { address: PUBLIC_V4, family: 4 }];
    const mock = fixture({ onRequest: options => {
      records[0].address = '127.0.0.1'; // Cannot mutate the copied pin.
      const observed = [];
      options.lookup(options.hostname, {}, (err, ip, version) => {
        assert.equal(err, null); observed.push([ip, version]);
      });
      options.lookup(options.hostname, { all: true }, (err, addresses) => {
        assert.equal(err, null); observed.push([addresses[0].address, addresses[0].family]);
        addresses[0].address = '127.0.0.1';
      });
      options.lookup(options.hostname, (err, ip, version) => {
        assert.equal(err, null); observed.push([ip, version]);
      });
      options.lookup('different.example.invalid', {}, error => assert.ok(safeFailure(error)));
      assert.deepEqual(observed, [[address, family], [address, family], [address, family]]);
    } });
    mock.lookup = (_host, _options, callback) => {
      resolverCalls++;
      callback(null, resolverCalls === 1 ? records : [{ address: '127.0.0.1', family: 4 }]);
    };
    assert.equal(await fetchLoginVerificationCode(URL_FIXTURE, mock), '123456');
    assert.equal(resolverCalls, 1); assert.equal(mock.state.requests.length, 1);
  }
});

test('Promise-based offline resolver is supported', async () => {
  const mock = fixture({ body: '{"data":{"code":"00123456"}}', headers: { 'content-type': 'application/json; charset=utf-8' } });
  mock.lookup = async () => [{ address: PUBLIC_V6, family: 6 }];
  assert.equal(await fetchLoginVerificationCode(URL_FIXTURE, mock), '00123456');
});

test('redirects and all non-200 responses are rejected without following Location', async () => {
  for (const status of [201, 204, 301, 302, 303, 307, 308, 400, 401, 429, 500]) {
    const mock = fixture({ status, headers: { 'content-type': 'text/plain', location: 'https://127.0.0.1/captcha' } });
    await assert.rejects(fetchLoginVerificationCode(URL_FIXTURE, mock), safeFailure);
    assert.equal(mock.state.requests.length, 1); assert.equal(mock.state.response.destroyed, true);
  }
});

test('MIME allowlist rejects images, HTML, compression and duplicate/invalid response headers', async () => {
  for (const headers of [
    {}, { 'content-type': 'image/png' }, { 'content-type': 'text/html' },
    { 'content-type': 'application/octet-stream' }, { 'content-type': 'application/problem+json' },
    { 'content-type': ['text/plain', 'application/json'] }, { 'content-type': 'text/plain, text/html' },
    { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
    { 'content-type': 'text/plain', 'content-length': '32769' },
    { 'content-type': 'text/plain', 'content-length': '-1' },
    { 'content-type': 'text/plain', 'content-length': '6junk' },
    { 'content-type': 'text/plain', 'content-length': '9007199254740992' },
    { 'content-type': 'text/plain', 'content-length': ['6'] },
  ]) {
    const mock = fixture({ headers });
    await assert.rejects(fetchLoginVerificationCode(URL_FIXTURE, mock), safeFailure);
    assert.equal(mock.state.response.destroyed, true);
  }
  for (const rawHeaders of [
    ['Content-Type', 'text/plain', 'content-type', 'image/png'],
    ['Content-Length', '6', 'content-length', '6'],
    ['Content-Encoding', 'identity', 'content-encoding', 'gzip'],
  ]) await assert.rejects(fetchLoginVerificationCode(URL_FIXTURE, fixture({ rawHeaders })), safeFailure);
});

test('stream limit uses bytes, accepts exactly 32KiB and rejects oversized/chunked/truncated/invalid UTF-8', async () => {
  const body = ' '.repeat(32762) + '123456';
  assert.equal(await fetchLoginVerificationCode(URL_FIXTURE, fixture({ body,
    headers: { 'content-type': 'text/plain', 'content-length': '32768' } })), '123456');
  for (const config of [
    { body: body + ' ' }, { chunks: [Buffer.alloc(32768, 32), Buffer.from('123456')] },
    { body: '\u3000'.repeat(10923) + '123456' },
    { headers: { 'content-type': 'text/plain', 'content-length': '7' } },
    { complete: false }, { chunks: [Buffer.from([0xff]), Buffer.from('123456')] },
    { chunks: ['123456'] },
  ]) await assert.rejects(fetchLoginVerificationCode(URL_FIXTURE, fixture(config)), safeFailure);
  assert.equal(await fetchLoginVerificationCode(URL_FIXTURE, fixture({
    chunks: [Buffer.from('001'), Buffer.from('23456')],
  })), '00123456');
});

test('total deadline includes DNS, waiting for headers and a slow body, then ignores late DNS', async () => {
  let lateLookup;
  const dns = fixture();
  dns.lookup = (_host, _options, callback) => { lateLookup = callback; };
  await assert.rejects(fetchLoginVerificationCode(URL_FIXTURE, { ...dns, timeoutMs: 15 }), safeFailure);
  lateLookup(null, [{ address: PUBLIC_V4, family: 4 }]);
  assert.equal(dns.state.requests.length, 0);
  const headers = fixture();
  headers.request = () => {
    const req = new EventEmitter(); req.end = () => {}; req.destroy = () => { req.destroyed = true; };
    headers.state.request = req; return req;
  };
  await assert.rejects(fetchLoginVerificationCode(URL_FIXTURE, { ...headers, timeoutMs: 15 }), safeFailure);
  assert.equal(headers.state.request.destroyed, true);
  const slow = fixture({ deliver: response => response.emit('data', Buffer.from('123')) });
  await assert.rejects(fetchLoginVerificationCode(URL_FIXTURE, { ...slow, timeoutMs: 15 }), safeFailure);
  assert.equal(slow.state.request.destroyed, true); assert.equal(slow.state.response.destroyed, true);
});

test('abort before DNS, during DNS and during body never leaks abort reason or starts a late GET', async () => {
  const pre = new AbortController(); pre.abort(new Error(SECRET));
  const first = fixture();
  await assert.rejects(fetchLoginVerificationCode(URL_FIXTURE, { ...first, signal: pre.signal }), safeFailure);
  assert.equal(first.state.dnsCalls, 0); assert.equal(first.state.requests.length, 0);
  const during = new AbortController(); let lateLookup;
  const second = fixture(); second.lookup = (_h, _o, callback) => { lateLookup = callback; };
  const pending = fetchLoginVerificationCode(URL_FIXTURE, { ...second, signal: during.signal });
  during.abort(new Error(SECRET)); await assert.rejects(pending, safeFailure);
  lateLookup(null, [{ address: PUBLIC_V4, family: 4 }]);
  assert.equal(second.state.requests.length, 0);
  const bodyAbort = new AbortController();
  const third = fixture({ deliver: () => bodyAbort.abort(new Error(SECRET)) });
  await assert.rejects(fetchLoginVerificationCode(URL_FIXTURE, { ...third, signal: bodyAbort.signal }), safeFailure);
  assert.equal(third.state.request.destroyed, true); assert.equal(third.state.response.destroyed, true);
});

test('DNS, request, body and upgrade errors are sanitized and never retried', async () => {
  const failure = () => { throw new Error(SECRET); };
  const callbackError = fixture(); callbackError.lookup = (_h, _o, cb) => cb(new Error(SECRET));
  const promiseError = fixture(); promiseError.lookup = async () => { throw new Error(SECRET); };
  for (const mock of [callbackError, promiseError, { ...fixture(), lookup: failure },
    { ...fixture(), request: failure }, fixture({ body: SECRET }),
    fixture({ deliver: response => response.emit('error', new Error(SECRET)) }),
    fixture({ deliver: response => response.emit('aborted') }),
    fixture({ deliver: response => response.emit('close') }),
    fixture({ deliver: (_res, req) => req.emit('error', new Error(SECRET)) }),
    fixture({ deliver: (_res, req) => req.emit('timeout') }),
  ]) {
    await assert.rejects(fetchLoginVerificationCode(URL_FIXTURE, mock), safeFailure);
    assert.ok(mock.state.requests.length <= 1);
  }
  let socketDestroyed = false;
  const upgrade = fixture({ deliver: (res, req) => req.emit('upgrade', res, { destroy: () => { socketDestroyed = true; } }) });
  await assert.rejects(fetchLoginVerificationCode(URL_FIXTURE, upgrade), safeFailure);
  assert.equal(socketDestroyed, true);
});

test('invalid options fail safely; deadlines cannot exceed ten seconds', async () => {
  for (const options of [null, { timeoutMs: 10001 }, { timeoutMs: Infinity }, { timeoutMs: NaN },
    { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: '10' }, { signal: {} },
    { lookup: null }, { request: null }]) {
    const mock = fixture();
    await assert.rejects(fetchLoginVerificationCode(URL_FIXTURE, options === null ? null : { ...mock, ...options }), safeFailure);
    assert.equal(mock.state.requests.length, 0);
  }
});

test('abort listeners are removed on success, failure and deadline; late events cannot revive a read', async () => {
  for (const config of [{}, { body: SECRET }, { deliver: () => {} }]) {
    const controller = new AbortController();
    const mock = fixture(config);
    const result = fetchLoginVerificationCode(URL_FIXTURE, { ...mock, signal: controller.signal, timeoutMs: 15 });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    if (config.body || config.deliver) await assert.rejects(result, safeFailure);
    else assert.equal(await result, '123456');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    controller.abort(new Error(SECRET));
    mock.state.response.emit('error', new Error(SECRET));
    mock.state.request.emit('error', new Error(SECRET));
    mock.state.response.emit('data', Buffer.from('654321'));
    mock.state.response.emit('end');
    assert.equal(mock.state.requests.length, 1);
  }
});

test('premature request close and a response arriving after timeout close all transport objects', async () => {
  for (const prematurelyClose of [false, true]) {
    let receive, req;
    const mock = fixture();
    mock.request = (_options, callback) => {
      receive = callback;
      req = new EventEmitter();
      req.destroy = () => { req.destroyed = true; };
      req.end = () => { if (prematurelyClose) queueMicrotask(() => req.emit('close')); };
      return req;
    };
    await assert.rejects(fetchLoginVerificationCode(URL_FIXTURE, { ...mock, timeoutMs: 15 }), safeFailure);
    const lateResponse = new EventEmitter();
    lateResponse.destroy = () => { lateResponse.destroyed = true; };
    receive(lateResponse);
    lateResponse.emit('error', new Error(SECRET));
    assert.equal(req.destroyed, true);
    assert.equal(lateResponse.destroyed, true);
  }
});

test('resolver callback duplication cannot initiate another request', async () => {
  const mock = fixture();
  mock.lookup = (_host, _options, callback) => {
    callback(null, [{ address: PUBLIC_V4, family: 4 }]);
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
  };
  assert.equal(await fetchLoginVerificationCode(URL_FIXTURE, mock), '123456');
  assert.equal(mock.state.requests.length, 1);
});

test('authenticator accepts exactly six digits and each explicit code key, preserving leading zeroes', () => {
  const parse = body => parseLoginVerificationCode(body, { profile: 'authenticator' });
  assert.equal(parse(' \n001234\t'), '001234');
  for (const key of ['otp', 'totp', 'pin', 'verification_code', 'token', 'code']) {
    for (const value of ['001234', ' 001234 ', 123456]) {
      const expected = String(value).trim();
      for (const object of [{ [key]: value }, { data: { [key]: value } },
        { result: { data: { [key.toUpperCase()]: value } } }]) {
        assert.equal(parse(JSON.stringify(object)), expected);
      }
    }
  }
});

test('authenticator success envelopes have finite statuses and acknowledged metadata; code 200 is never an OTP', () => {
  for (const marker of [{ success: true }, ...[0, 200, '0', '200', 'OK', 'success'].flatMap(value => [
    { status: value }, { code: value },
  ])]) {
    for (const message of [{}, { msg: 'ok' }, { message: ' Success ' }, { message: '' }]) {
      const body = JSON.stringify({ ...marker, ...message, data: { result: { totp: '001234' } } });
      assert.equal(parseLoginVerificationCode(body, { profile: 'authenticator' }), '001234');
      assert.throws(() => parseLoginVerificationCode(body), safeFailure);
    }
    assert.throws(() => parseLoginVerificationCode(JSON.stringify(marker), { profile: 'authenticator' }), safeFailure);
  }
  assert.equal(parseLoginVerificationCode('{"status":200,"code":"001234"}', { profile: 'authenticator' }), '001234');
});

test('authenticator only traverses data/result, with root depth zero and maximum depth six', () => {
  for (const depth of [0, 1, 5, 6, 7, 30]) {
    let object = { totp: '001234' };
    for (let level = 0; level < depth; level++) object = { [level % 2 ? 'result' : 'data']: object };
    const parse = () => parseLoginVerificationCode(JSON.stringify(object), { profile: 'authenticator' });
    if (depth <= 6) assert.equal(parse(), '001234');
    else assert.throws(parse, safeFailure);
  }
});

test('authenticator rejects arbitrary text, error statuses, duplicate/unknown fields and every ambiguous candidate', () => {
  for (const body of [
    '', '200', '12345', '00123456', '1234567', '１２３４５６', 'Your TOTP is 001234',
    '001234 001234', '"001234"', '<html>001234</html>', 'null', 'true', '[]', '[{"totp":"001234"}]',
    '{}', '{"data":{}}', '{"data":"001234"}', '{"result":[{"totp":"001234"}]}',
    '{"payload":{"totp":"001234"}}', '{"data":{"account":{"totp":"001234"}}}',
    '{"totp":{"code":"001234"}}', '{"token":true}', '{"pin":null}', '{"otp":12345.6}',
    '{"otp":-123456}', '{"otp":"12345678"}', '{"code":200}', '{"code":"200"}',
    '{"status":200,"message":"001234"}', '{"success":true,"message":"OTP 001234"}',
    '{"message":"ok","otp":"001234"}', '{"timestamp":123456,"otp":"001234"}',
    '{"success":true,"unknown":{"totp":"001234"}}', '{"success":true,"error":null,"otp":"001234"}',
    '{"status":"error","totp":"001234"}', '{"success":false,"totp":"001234"}',
    '{"success":"true","totp":"001234"}', '{"status":500,"data":{"totp":"001234"}}',
    '{"status":"pending","totp":"001234"}', '{"code":400,"totp":"001234"}',
    '{"status":"success","success":false,"totp":"001234"}',
    '{"code":200,"message":"expired","data":{"totp":"001234"}}',
    '{"status":"success","data":{"status":"error","totp":"001234"}}',
    '{"totp":"001234","pin":"654321"}', '{"totp":"001234","pin":"001234"}',
    '{"data":{"code":"001234"},"result":{"code":"001234"}}',
    '{"code":"001234","data":{"code":"654321"}}',
    '{"totp":"001234","totp":"001234"}', '{"totp":"001234","TOTP":"001234"}',
    '{"totp":"001234","t\\u006ftp":"654321"}',
    '{"status":"error","status":"ok","totp":"001234"}',
    '{"status":"error","STATUS":"ok","totp":"001234"}',
    '{"data":{"totp":"001234","totp":"654321"}}',
    '{"data":{"totp":"001234"},"data":{"totp":"001234"}}',
    '{"totp":"001234"} trailing', ' '.repeat(32763) + '001234', null, 123456, Buffer.from('123456'),
  ]) assert.throws(() => parseLoginVerificationCode(body, { profile: 'authenticator' }), safeFailure, String(body));
  for (const options of [null, { profile: null }, { profile: '' }, { profile: 'totp' }, { profile: 'EMAIL' }]) {
    assert.throws(() => parseLoginVerificationCode('123456', options), safeFailure);
  }
  assert.equal(parseLoginVerificationCode(' '.repeat(32762) + '001234', { profile: 'authenticator' }), '001234');
  // Explicit email remains the legacy profile, including equal-valued aliases.
  assert.equal(parseLoginVerificationCode('{"otp":"00123456","code":"00123456"}', { profile: 'email' }), '00123456');
  assert.throws(() => parseLoginVerificationCode('{"totp":"001234"}', { profile: 'email' }), safeFailure);
});

const COMPAT_PREFIXES = [
  'http://otp.example.invalid/api/', 'https://otp.example.invalid:8443/api/',
  `http://${PUBLIC_V4}:8080/api/`, `https://${PUBLIC_V4}/api/`,
];

test('validator still returns URL; compatibility is confined to explicit origin and directory prefixes', () => {
  const endpointAllowlist = ` ${COMPAT_PREFIXES.slice(0, 2).join(', ')}\r\n${COMPAT_PREFIXES.slice(2).join('\n')}\n`;
  for (const prefix of COMPAT_PREFIXES) {
    const url = `${prefix}otp?token=fixture-secret%2Fopaque`;
    assert.throws(() => validateLoginVerificationCodeUrl(url, { endpointAllowlist: '' }), safeFailure);
    const accepted = validateLoginVerificationCodeUrl(url, { endpointAllowlist });
    assert.ok(accepted instanceof URL);
    assert.equal(accepted.href, url);
    for (const mismatch of [url.replace('/api/', '/apix/'), url.replace('/api/', '/API/'),
      url.replace('/api/', '/'), `${new URL(prefix).origin}/api`,
      `${new URL(prefix).origin}/api?path=/api/otp`]) {
      assert.throws(() => validateLoginVerificationCodeUrl(mismatch, { endpointAllowlist }), safeFailure);
    }
  }
  for (const mismatch of ['http://sub.otp.example.invalid/api/otp', 'http://otp.example.invalid.evil.test/api/otp',
    'http://otp.example.invalid:8080/api/otp', 'https://otp.example.invalid:8444/api/otp',
    `http://${PUBLIC_V4}/api/otp`, `http://${PUBLIC_V4}:8081/api/otp`, `https://${PUBLIC_V4}:8080/api/otp`]) {
    assert.throws(() => validateLoginVerificationCodeUrl(mismatch, { endpointAllowlist }), safeFailure);
  }
  // Normal HTTPS remains open under the existing policy, independent of these exceptions.
  assert.equal(validateLoginVerificationCodeUrl(URL_FIXTURE, { endpointAllowlist }).protocol, 'https:');
  assert.equal(validateLoginVerificationCodeUrl('http://OTP.EXAMPLE.INVALID:80/api/otp', {
    endpointAllowlist: 'http://otp.example.invalid/api/',
  }).origin, 'http://otp.example.invalid');
});

test('allowlist defaults to the environment at call time; explicit empty configuration disables exceptions', async () => {
  const previous = process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST;
  try {
    const url = `${COMPAT_PREFIXES[0]}otp`;
    process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST = COMPAT_PREFIXES[0];
    assert.equal(validateLoginVerificationCodeUrl(url).protocol, 'http:');
    assert.throws(() => validateLoginVerificationCodeUrl(url, { endpointAllowlist: '' }), safeFailure);
    const mock = fixture();
    assert.equal(await fetchLoginVerificationCode(url, { ...mock, endpointAllowlist: undefined }), '123456');
    process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST = 'http://otp.example.invalid/other/';
    assert.throws(() => validateLoginVerificationCodeUrl(url), safeFailure);
  } finally {
    if (previous === undefined) delete process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST;
    else process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST = previous;
  }
});

test('dotted path prefixes are literal strings, with encoded separators and dot segments rejected', () => {
  const origin = 'http://otp.example.invalid:8080';
  const endpointAllowlist = `${origin}/api/v1.0/`;
  const url = `${endpointAllowlist}code.json?token=fixture-secret`;
  assert.equal(validateLoginVerificationCodeUrl(url, { endpointAllowlist }).href, url);
  for (const path of ['/api/v1x0/code.json', '/api/v1.0x/code.json', '/api/v1.0',
    '/api/v1.0/../code.json', '/api/v1.0/.%2e/code.json', '/api/v1.0/%2e%2e/code.json',
    '/api/v1.0/%252e%252e/code.json', '/api/v1.0/%2E%2E%20/code.json',
    '/api/v1.0/%2fcode.json', '/api/v1.0/%252fcode.json', '/api/v1.0/%5ccode.json']) {
    assert.throws(() => validateLoginVerificationCodeUrl(`${origin}${path}`, { endpointAllowlist }), safeFailure);
  }
});

test('malformed allowlist entries fail closed rather than widening an otherwise matching exception', async () => {
  const prefix = COMPAT_PREFIXES[0];
  for (const invalid of [
    'http://otp.example.invalid', 'http://otp.example.invalid/api', '//otp.example.invalid/api/',
    'http://*.example.invalid/api/', 'http://otp.example.invalid/api/?', 'http://otp.example.invalid/api/?x=/',
    'http://otp.example.invalid/api/#', 'http://u:p@otp.example.invalid/api/',
    'http://@otp.example.invalid/api/', 'http://otp.example.invalid:/api/', 'http://otp.example.invalid:080/api/',
    'http://otp.example.invalid:65536/api/', 'http://127.0.0.1/api/', 'http://2130706433/api/',
    'http://otp.example.invalid/other/../api/', 'http://otp.example.invalid/%2e/api/',
    'http://otp.example.invalid/api%2f/', 'http://otp.example.invalid/api/%252e%252e/',
    'http://otp.example.invalid/%61pi%5c/', 'http://otp.example.invalid/google/login/',
    'http://gapi.mailsapi.com/api/', 'http://otp.example.invalid/captcha/',
  ]) {
    const mock = fixture();
    await assert.rejects(fetchLoginVerificationCode(`${prefix}otp`, {
      ...mock, endpointAllowlist: `${prefix},${invalid}`,
    }), safeFailure);
    assert.equal(mock.state.dnsCalls, 0); assert.equal(mock.state.requests.length, 0);
  }
  for (const endpointAllowlist of [null, [], {}, 1, ' '.repeat(32769)]) {
    assert.throws(() => validateLoginVerificationCodeUrl(`${prefix}otp`, { endpointAllowlist }), safeFailure);
  }
});

test('neither an allowlist nor default HTTPS permits normalized IP spellings, private hosts or path escapes', async () => {
  const unsafeHosts = ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1',
    '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
    '240.0.0.1', '168.63.129.16', '0x08080808', '134744072', '010.010.010.010', '8.8.2056',
    '8.8.8.8.', '8.8.8.008', '%38.8.8.8', '[2606:4700:4700::1111]',
    'localhost', 'sub.localdomain', 'sub.internal', 'sub.intranet', 'sub.corp', 'sub.home.arpa',
    'otp.example.invalid.', '%6ftp.example.invalid', 'gapi.mailsapi.com', 'gapi.mailsapi.com.evil.test',
    'gapi.example.invalid', 'accounts.google.com'];
  const unsafePaths = ['api/../otp', 'api/./otp', 'outside/../api/otp', 'api/%2e%2e/otp',
    'api/.%2e/otp', 'api/%2e./otp', 'api/%252e%252e/otp', 'api/%25252e%25252e/otp',
    'api/%2f..%2fotp', 'api/%5c..%5cotp', 'api/%252fotp', 'api/..;/otp', 'api/%00otp',
    'api/%3f../otp', 'api/%23../otp', 'api/google/login', 'api/google/%256cogin',
    'api/signin', 'api/oauth/', 'api/captcha', 'api/image.png', 'api/otp?x=gapi.mailsapi.com'];
  for (const scheme of ['https', 'http']) {
    const rejected = [...unsafeHosts.map(host => `${scheme}://${host}/api/otp`),
      ...unsafePaths.map(path => `${scheme}://otp.example.invalid/${path}`)];
    for (const url of rejected) {
      const mock = fixture();
      const origin = /^https?:\/\/[^/]+/.exec(url)[0];
      await assert.rejects(fetchLoginVerificationCode(url, { ...mock, endpointAllowlist: `${origin}/` }), safeFailure);
      assert.equal(mock.state.dnsCalls, 0); assert.equal(mock.state.requests.length, 0);
    }
  }
});

test('injected request supports both transports and public literals skip DNS without changing headers or bounds', async () => {
  for (const prefix of [...COMPAT_PREFIXES, 'http://otp.example.invalid:8080/api/', `https://${PUBLIC_V4}:8443/api/`]) {
    const url = `${prefix}otp?token=fixture-secret`;
    const isLiteral = new URL(url).hostname === PUBLIC_V4;
    const mock = fixture({ body: '{"code":200,"data":{"totp":"001234"}}' });
    assert.equal(await fetchLoginVerificationCode(url, {
      ...mock, endpointAllowlist: prefix, profile: 'authenticator',
    }), '001234');
    assert.equal(mock.state.dnsCalls, isLiteral ? 0 : 1);
    assert.equal(mock.state.requests.length, 1); assert.equal(mock.state.ends, 1);
    const actual = mock.state.requests[0], parsed = new URL(url);
    assert.equal(actual.protocol, parsed.protocol);
    assert.equal(actual.hostname, parsed.hostname);
    assert.equal(actual.port, Number(parsed.port || (parsed.protocol === 'http:' ? 80 : 443)));
    assert.equal(actual.servername, !isLiteral && parsed.protocol === 'https:' ? parsed.hostname : undefined);
    assert.equal(actual.path, parsed.pathname + parsed.search);
    assert.equal(actual.timeout, 10000); assert.equal(actual.maxHeaderSize, 8192);
    assert.equal(actual.agent, false); assert.equal(actual.rejectUnauthorized, true);
    assert.deepEqual(actual.headers, { accept: 'application/json, text/plain', 'accept-encoding': 'identity' });
    const email = fixture({ body: '{"totp":"001234"}' });
    await assert.rejects(fetchLoginVerificationCode(url, { ...email, endpointAllowlist: prefix }), safeFailure);
  }
});

test('production transport selection uses node:http versus node:https with builtin request functions replaced by fixtures', async t => {
  const plain = fixture(), secure = fixture();
  t.mock.method(http, 'request', plain.request);
  t.mock.method(https, 'request', secure.request);
  syncBuiltinESMExports();
  try {
    for (const [prefix, mock] of [[COMPAT_PREFIXES[0], plain], [COMPAT_PREFIXES[1], secure]]) {
      assert.equal(await fetchLoginVerificationCode(`${prefix}otp`, {
        endpointAllowlist: prefix, lookup: mock.lookup,
      }), '123456');
      assert.equal(mock.state.requests.length, 1);
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('allowlisted HTTP keeps DNS pinning, all-answer validation, no redirects/cookies, cancellation and 32KiB bounds', async () => {
  const prefix = COMPAT_PREFIXES[0], url = `${prefix}otp`;
  const records = [{ address: PUBLIC_V4, family: 4 }];
  const pinned = fixture({ records, onRequest: options => {
    records[0].address = '127.0.0.1';
    options.lookup(options.hostname, { all: true }, (error, addresses) => {
      assert.equal(error, null); assert.deepEqual(addresses, [{ address: PUBLIC_V4, family: 4 }]);
    });
    assert.equal(options.headers.cookie, undefined);
  }, headers: { 'content-type': 'text/plain', 'set-cookie': 'synthetic-cookie=ignored' } });
  assert.equal(await fetchLoginVerificationCode(url, { ...pinned, endpointAllowlist: prefix }), '123456');
  assert.equal(pinned.state.dnsCalls, 1); assert.equal(pinned.state.requests.length, 1);
  for (const config of [
    { records: [{ address: PUBLIC_V4, family: 4 }, { address: '127.0.0.1', family: 4 }] },
    ...[301, 302, 303, 307, 308].map(status => ({ status,
      headers: { 'content-type': 'text/plain', location: `${prefix}other` } })),
    { body: ' '.repeat(32763) + '123456' }, { deliver: () => {} },
  ]) {
    const mock = fixture(config);
    await assert.rejects(fetchLoginVerificationCode(url, { ...mock, endpointAllowlist: prefix, timeoutMs: 15 }), safeFailure);
    assert.equal(mock.state.requests.length, config.records ? 0 : 1);
  }
  const controller = new AbortController();
  const mock = fixture({ deliver: () => controller.abort(new Error(SECRET)) });
  await assert.rejects(fetchLoginVerificationCode(url, {
    ...mock, endpointAllowlist: prefix, signal: controller.signal,
  }), safeFailure);
  assert.equal(mock.state.request.destroyed, true); assert.equal(mock.state.response.destroyed, true);
  for (const options of [{ profile: 'unknown' }, { profile: null }, { timeoutMs: 10001 }]) {
    const invalid = fixture();
    await assert.rejects(fetchLoginVerificationCode(url, { ...invalid, endpointAllowlist: prefix, ...options }), safeFailure);
    assert.equal(invalid.state.dnsCalls, 0); assert.equal(invalid.state.requests.length, 0);
  }
});
