import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAccountLoginEntries as parse } from '../server/dola/account-login-format.js';
import { validateLoginVerificationCodeUrl } from '../server/dola/login-verification-code.js';

const EMAIL = 'synthetic-main@example.test';
const RECOVERY = 'synthetic-recovery@example.test';
const PASSWORD = 'synthetic-password|with|pipes';
const GOOGLE = 'https://gapi.mailsapi.com/google/login?uid=synthetic-private-uid';
const VERIFY = 'https://codes.example.test/api/code?token=synthetic-private-token';
const expected = overrides => ({ email: EMAIL, password: PASSWORD, loginMethod: 'password',
  recoveryEmail: '', googleSessionUrl: '', verificationUrl: '', ...overrides });
const dash = (third, fourth) => `${EMAIL}----${PASSWORD}----${third}${fourth === undefined ? '' : `----${fourth}`}`;

function rejects(raw, { manual = false, line, reason, endpointAllowlist } = {}) {
  assert.throws(() => parse(raw, { manual, endpointAllowlist }), error => {
    assert.equal(error.status, 400);
    assert.match(error.message, /^第 \d+ 行：[\s\S]+$/);
    if (line) assert.match(error.message, new RegExp(`^第 ${line} 行：`));
    if (reason) assert.match(error.message, reason);
    const exposed = `${error.stack}\n${JSON.stringify(error)}`;
    for (const secret of [EMAIL, RECOVERY, PASSWORD, GOOGLE, VERIFY, 'synthetic-private-uid', 'synthetic-private-token']) {
      assert.equal(exposed.includes(secret), false, 'errors must not expose credentials or raw input');
    }
    assert.equal(Object.hasOwn(error, 'input'), false);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
}

test('legacy: normalize escaped at/case, skip blank lines, preserve all password pipes and spaces', () => {
  assert.deepEqual(parse(` \r\n SYNTHETIC-MAIN\\@EXAMPLE.TEST | ${PASSWORD} ----literal \r\n\n`), [
    expected({ password: ` ${PASSWORD} ----literal ` }),
  ]);
});

for (const [label, format] of [
  ['legacy', password => `${EMAIL}|${password}`],
  ['three fields', password => `${EMAIL}----${password}----${RECOVERY}`],
  ['Google link', password => `${EMAIL}----${password}----no----${GOOGLE}`],
  ['verification URL', password => `${EMAIL}----${password}----${RECOVERY}----${VERIFY}`],
]) {
  test(`${label}: preserve a 1024-character password, reject 1025 without leaking secrets`, () => {
    for (const password of [PASSWORD.padEnd(1024, 'p'), '密'.repeat(1024)]) {
      assert.equal(parse(format(password))[0].password, password);
      rejects(`\n${format(`${password}|`)}`, { line: 2, reason: /1024/ });
    }
  });
}

test('password limit counts preserved trailing spaces and pipes, matching the legacy parser', () => {
  const password = PASSWORD.padEnd(1023, 'p');
  assert.equal(parse(`${EMAIL}|${password} `)[0].password.length, 1024);
  rejects(`${EMAIL}|${password} |`, { reason: /1024/ });
});

test('three fields: display primary address, normalize recovery address, preserve password', () => {
  assert.deepEqual(parse(` SYNTHETIC-MAIN\\@EXAMPLE.TEST ---- ${PASSWORD} ---- SYNTHETIC-RECOVERY\\@EXAMPLE.TEST `), [
    expected({ password: ` ${PASSWORD} `, recoveryEmail: RECOVERY }),
  ]);
});

test('four fields: no marker selects the strictly validated Google link', () => {
  assert.deepEqual(parse(dash('no', GOOGLE)), [expected({ loginMethod: 'google_link', googleSessionUrl: GOOGLE })]);
  assert.deepEqual(parse(dash(' NO ', GOOGLE)), [expected({ loginMethod: 'google_link', googleSessionUrl: GOOGLE })]);
});

test('four fields: recovery address selects a HTTPS verification endpoint', () => {
  assert.deepEqual(parse(dash(RECOVERY, VERIFY)), [expected({ recoveryEmail: RECOVERY, verificationUrl: VERIFY })]);
});

for (const [label, third, url, field] of [
  ['Google link', 'no', GOOGLE, 'googleSessionUrl'],
  ['verification URL', RECOVERY, VERIFY, 'verificationUrl'],
]) {
  test(`${label}: accept 8192 URL characters, reject 8193 without exposing the URL`, () => {
    const boundary = url.padEnd(8192, 'u');
    assert.equal(parse(dash(third, boundary))[0][field], boundary);
    rejects(dash(third, `${boundary}u`), { line: 1 });
  });
}

test('manual mode accepts non-Google mailboxes and leaves every secret field empty', () => {
  assert.deepEqual(parse(' SYNTHETIC-MAIN\\@EXAMPLE.TEST \r\n owner@outlook.com', { manual: true }), [
    expected({ password: '', loginMethod: 'manual' }),
    expected({ email: 'owner@outlook.com', password: '', loginMethod: 'manual' }),
  ]);
});

test('all formats can coexist with the same fixed six-field shape', () => {
  const input = [`one@example.test|${PASSWORD}`, `two@example.test----${PASSWORD}----${RECOVERY}`,
    `three@example.test----${PASSWORD}----no----${GOOGLE}`,
    `four@example.test----${PASSWORD}----${RECOVERY}----${VERIFY}`];
  const entries = parse(input.join('\n'));
  assert.deepEqual(entries.map(entry => entry.email), ['one', 'two', 'three', 'four'].map(local => `${local}@example.test`));
  for (const entry of entries) assert.deepEqual(Object.keys(entry), Object.keys(expected()));
});

test('delimiter ambiguity: legacy passwords may contain all other format delimiters and URLs', () => {
  const password = `${PASSWORD}----no----${GOOGLE}`;
  assert.deepEqual(parse(`${EMAIL}|${password}`), [expected({ password })]);
});

test('delimiter ambiguity: a pipe inside a dash-delimited password never selects legacy format', () => {
  assert.deepEqual(parse(dash(RECOVERY, VERIFY)), [expected({ recoveryEmail: RECOVERY, verificationUrl: VERIFY })]);
});

test('four hyphens in the email local part remain part of the email', () => {
  for (const suffix of [`|${PASSWORD}`, `----${PASSWORD}----${RECOVERY}`]) {
    const [entry] = parse(`synthetic----main@example.test${suffix}`);
    assert.equal(entry.email, 'synthetic----main@example.test');
    assert.equal(entry.password, PASSWORD);
  }
});

for (const manual of [false, true]) {
  test(`20 entries accepted and 21 rejected, including blank lines (manual=${manual})`, () => {
    const entries = Array.from({ length: 21 }, (_, index) => `synthetic-${index}@example.test${manual ? '' : `|${PASSWORD}`}`);
    assert.equal(parse(entries.slice(0, 20).join('\n\n'), { manual }).length, 20);
    rejects(entries.join('\n\n'), { manual, line: 41, reason: /20/ });
  });
}

test('32 KiB is a UTF-8 byte limit: exact boundary accepted, one byte over rejected', () => {
  for (const character of ['p', '密']) {
    const prefix = Array.from({ length: 10 }, (_, i) => `synthetic-${i}@example.test|${character.repeat(1024)}`).join('\n') + '\n';
    const boundary = prefix + ' '.repeat(32768 - Buffer.byteLength(prefix));
    assert.equal(Buffer.byteLength(boundary), 32768);
    assert.equal(parse(boundary).length, 10);
    rejects(`${boundary} `, { reason: /32 KiB/ });
  }
  const utf8Overflow = Array.from({ length: 11 }, (_, i) => `synthetic-${i}@example.test|${'密'.repeat(1024)}`).join('\n');
  assert.ok(utf8Overflow.length < 32768);
  rejects(utf8Overflow, { reason: /32 KiB/ });
});

test('manual input also obeys the total byte limit, including whitespace', () => {
  const boundary = EMAIL + ' '.repeat(32768 - Buffer.byteLength(EMAIL));
  assert.equal(parse(boundary, { manual: true }).length, 1);
  rejects(`${boundary} `, { manual: true, reason: /32 KiB/ });
});

test('duplicates normalize case and escaped at and report the physical line number', () => {
  rejects(`\n${EMAIL}|${PASSWORD}\n\nSYNTHETIC-MAIN\\@EXAMPLE.TEST----${PASSWORD}----${RECOVERY}`,
    { line: 4, reason: /重复/ });
  rejects(`\n${EMAIL}\n\nSYNTHETIC-MAIN\\@EXAMPLE.TEST`, { manual: true, line: 4, reason: /重复/ });
});

test('recovery addresses are not treated as primary identities for duplicate detection', () => {
  assert.equal(parse([dash(RECOVERY), `${RECOVERY}|${PASSWORD}`].join('\n')).length, 2);
});

const invalidInputs = [undefined, null, 17, {}, [], '', ' \n\r\n', EMAIL, `${EMAIL}|`, `${EMAIL}|   `,
  `|${PASSWORD}`, `bad@@example.test|${PASSWORD}`, `bad name@example.test|${PASSWORD}`,
  `${'a'.repeat(65)}@example.test|${PASSWORD}`, `a@-bad.test|${PASSWORD}`, `a@example..test|${PASSWORD}`,
  `a@localhost|${PASSWORD}`, `${EMAIL}----${PASSWORD}`, dash('no'), dash(GOOGLE),
  dash('', VERIFY), dash(RECOVERY, ''), `${dash(RECOVERY, VERIFY)}----extra`,
  `${EMAIL}--------${RECOVERY}`, `${EMAIL}----   ----no----${GOOGLE}`];
test('invalid types, empty fields, malformed emails and unsupported field counts fail closed', () => {
  for (const raw of invalidInputs) rejects(raw);
});

test('control characters anywhere in a nonblank record are rejected without echoing input', () => {
  for (const control of ['\0', '\t', '\r', '\x1f', '\x7f']) {
    rejects(`${EMAIL}|${PASSWORD}${control}`);
    rejects(`synthetic${control}-main@example.test|${PASSWORD}`);
    rejects(dash('no', `${GOOGLE}${control}`));
  }
});

test('manual mode rejects pasted passwords, recovery fields and URLs', () => {
  for (const raw of [`${EMAIL}|${PASSWORD}`, dash(RECOVERY), dash('no', GOOGLE), dash(RECOVERY, VERIFY), GOOGLE]) {
    rejects(raw, { manual: true });
  }
});

const invalidGoogleUrls = [
  ['HTTP', GOOGLE.replace('https:', 'http:')],
  ['protocol-relative', GOOGLE.replace('https:', '')],
  ['wrong host', GOOGLE.replace('gapi.mailsapi.com', 'evil.example.test')],
  ['subdomain', GOOGLE.replace('gapi.mailsapi.com', 'sub.gapi.mailsapi.com')],
  ['host suffix', GOOGLE.replace('gapi.mailsapi.com', 'gapi.mailsapi.com.evil.test')],
  ['trailing host dot', GOOGLE.replace('gapi.mailsapi.com', 'gapi.mailsapi.com.')],
  ['encoded host', GOOGLE.replace('gapi.mailsapi.com', '%67api.mailsapi.com')],
  ['default port', GOOGLE.replace('.com/', '.com:443/')],
  ['nondefault port', GOOGLE.replace('.com/', '.com:8443/')],
  ['empty port', GOOGLE.replace('.com/', '.com:/')],
  ['userinfo', GOOGLE.replace('https://', 'https://synthetic-private-token@')],
  ['empty userinfo', GOOGLE.replace('https://', 'https://@')],
  ['fragment', `${GOOGLE}#synthetic-private-token`],
  ['empty fragment', `${GOOGLE}#`],
  ['backslash', GOOGLE.replace('/google/', '\\google/')],
  ['extra slash', GOOGLE.replace('https://', 'https:///')],
  ['wrong path', GOOGLE.replace('/google/login', '/google/other')],
  ['path suffix', GOOGLE.replace('/google/login', '/google/login/other')],
  ['trailing slash', GOOGLE.replace('/google/login', '/google/login/')],
  ['path case', GOOGLE.replace('/google/login', '/Google/Login')],
  ['path traversal', GOOGLE.replace('/google/login', '/other/../google/login')],
  ['encoded path traversal', GOOGLE.replace('/google/login', '/other/%2e%2e/google/login')],
  ['encoded path', GOOGLE.replace('/google/login', '/google/%6cogin')],
  ['missing uid', 'https://gapi.mailsapi.com/google/login'],
  ['empty uid', 'https://gapi.mailsapi.com/google/login?uid='],
  ['blank uid', 'https://gapi.mailsapi.com/google/login?uid=%20+'],
  ['duplicate uid', `${GOOGLE}&uid=second`],
  ['encoded duplicate uid', `${GOOGLE}&%75id=second`],
  ['unknown query', `${GOOGLE}&token=synthetic-private-token`],
  ['unknown leading query', GOOGLE.replace('?uid=', '?token=synthetic-private-token&uid=')],
  ['trailing query separator', `${GOOGLE}&`],
  ['encoded control', `${GOOGLE}%00`],
  ['encoded backslash', `${GOOGLE}%5c`],
  ['malformed percent', `${GOOGLE}%ZZ`],
  ['malformed UTF-8', `${GOOGLE}%ff`],
  ['payload text', 'synthetic-private-token'],
  ['payload JSON', `{"url":"${GOOGLE}"}`],
  ['verification endpoint', VERIFY],
];
for (const [label, url] of invalidGoogleUrls) {
  test(`Google link rejects ${label} without downgrading to verification`, () => rejects(dash('no', url)));
}

test('Google uid may be percent-encoded; output preserves the validated original URL', () => {
  for (const url of [GOOGLE, `${GOOGLE}%2F%2B%3D`, GOOGLE.replace('https://gapi', 'HTTPS://GAPI')]) {
    assert.equal(parse(dash('no', url))[0].googleSessionUrl, url);
  }
});

test('Google-shaped payload with a recovery address is rejected rather than reclassified', () => {
  for (const url of [GOOGLE, `${GOOGLE}&other=synthetic-private-token`, GOOGLE.replace('/google/login', '/other'),
    GOOGLE.replace('gapi.mailsapi.com', 'gapi.mailsapi.com.evil.test'),
    GOOGLE.replace('gapi.mailsapi.com', 'other.example.test')]) rejects(dash(RECOVERY, url));
});

const invalidVerificationUrls = [
  ['HTTP', VERIFY.replace('https:', 'http:')],
  ['other scheme', VERIFY.replace('https:', 'file:')],
  ['userinfo', VERIFY.replace('https://', 'https://synthetic:synthetic-private-token@')],
  ['empty userinfo', VERIFY.replace('https://', 'https://@')],
  ['fragment', `${VERIFY}#synthetic-private-token`],
  ['empty fragment', `${VERIFY}#`],
  ['nondefault port', VERIFY.replace('.test/', '.test:8443/')],
  ['empty port', VERIFY.replace('.test/', '.test:/')],
  ['raw backslash', VERIFY.replace('/api/', '\\api/')],
  ['IPv4 loopback', 'https://127.0.0.1/code'],
  ['private IPv4', 'https://10.0.0.1/code'],
  ['public IPv4', 'https://8.8.8.8/code'],
  ['IPv6 loopback', 'https://[::1]/code'],
  ['public IPv6', 'https://[2606:4700:4700::1111]/code'],
  ['IPv4 mapped IPv6', 'https://[::ffff:127.0.0.1]/code'],
  ['IPv4 integer', 'https://2130706433/code'],
  ['IPv4 hex', 'https://0x7f000001/code'],
  ['IPv4 octal', 'https://0177.0.0.1/code'],
  ['IPv4 short', 'https://127.1/code'],
  ['IPv4 trailing dot', 'https://127.0.0.1./code'],
  ['localhost', 'https://localhost/code'],
  ['localhost suffix', 'https://codes.localhost/code'],
  ['local suffix', 'https://codes.local/code'],
  ['localdomain suffix', 'https://codes.localdomain/code'],
  ['internal suffix', 'https://codes.internal/code'],
  ['LAN suffix', 'https://codes.lan/code'],
  ['home suffix', 'https://codes.home/code'],
  ['home ARPA suffix', 'https://codes.home.arpa/code'],
  ['single host label', 'https://metadata/code'],
  ['trailing host dot', 'https://codes.example.test./code'],
  ['encoded hostname', 'https://%63odes.example.test/code'],
  ['invalid label', 'https://-codes.example.test/code'],
  ['empty label', 'https://codes..example.test/code'],
  ['invalid percent', `${VERIFY}%bad%`],
  ['whitespace', VERIFY.replace('/api/', '/api /')],
  ['text payload', 'synthetic-private-token'],
];
for (const [label, url] of invalidVerificationUrls) {
  test(`verification URL rejects ${label} without discarding the fourth field`, () => rejects(dash(RECOVERY, url)));
}

test('verification URL accepts explicit 443 and public domain syntax without DNS lookups', () => {
  for (const url of [VERIFY, VERIFY.replace('.test/', '.test:443/'), 'HTTPS://CODES.EXAMPLE.TEST/code?token=a%2Fb']) {
    assert.deepEqual(parse(dash(RECOVERY, url)), [expected({ recoveryEmail: RECOVERY, verificationUrl: url })]);
  }
});

test('four-field import uses the shared explicit endpoint allowlist and preserves the original URL', () => {
  const prefixes = ['http://codes.example.test/api/', 'http://93.184.216.34:8080/api/',
    'https://codes.example.test:8443/api/', 'https://93.184.216.34/api/'];
  const endpointAllowlist = prefixes.join(',\n');
  for (const prefix of prefixes) {
    const url = `${prefix}code?token=synthetic-private-token%2Fopaque`;
    rejects(dash(RECOVERY, url), { endpointAllowlist: '' });
    assert.ok(validateLoginVerificationCodeUrl(url, { endpointAllowlist }) instanceof URL);
    assert.deepEqual(parse(dash(RECOVERY, url), { endpointAllowlist }), [expected({
      recoveryEmail: RECOVERY, verificationUrl: url,
    })]);
    for (const mismatch of [url.replace('/api/', '/other/'), url.replace('/api/', '/api-other/'),
      `${new URL(prefix).origin}/api`, `${new URL(prefix).origin}/api/%2e%2e/other`]) {
      rejects(dash(RECOVERY, mismatch), { endpointAllowlist });
    }
  }
});

test('import and runtime syntax screening share immutable safety restrictions even with an allowlist', () => {
  const urls = ['http://127.0.0.1/api/code', 'http://169.254.169.254/api/code',
    'http://168.63.129.16/api/code', 'http://0x08080808/api/code', 'http://010.010.010.010/api/code',
    'http://134744072/api/code', 'http://8.8.8.8./api/code', 'http://[2606:4700:4700::1111]/api/code',
    'http://codes.localdomain/api/code', 'http://codes.example.test/api/../other',
    'http://codes.example.test/api/%252e%252e/other', 'http://codes.example.test/api/%2fother',
    'https://codes.example.test/api/%255cother', 'https://codes.example.test/google/%6cogin',
    'http://gapi.mailsapi.com/other', 'https://gapi.example.test/other',
    'https://codes.example.test/%63aptcha', 'https://codes.example.test/image.png'];
  for (const url of urls) {
    const endpointAllowlist = `${/^https?:\/\/[^/]+/.exec(url)[0]}/`;
    assert.throws(() => validateLoginVerificationCodeUrl(url, { endpointAllowlist }));
    rejects(`\n${dash(RECOVERY, url)}`, { endpointAllowlist, line: 2 });
  }
  // Enabling OTP HTTP exceptions does not relax the separate Google-session contract.
  rejects(dash('no', GOOGLE.replace('https:', 'http:')), { endpointAllowlist: 'http://gapi.mailsapi.com/google/' });
});

test('four-field import reads endpoint exceptions from the environment at call time', () => {
  const previous = process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST;
  try {
    const prefix = 'http://codes.example.test:8080/api/';
    const url = `${prefix}code?token=synthetic-private-token`;
    process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST = prefix;
    assert.equal(parse(dash(RECOVERY, url))[0].verificationUrl, url);
    rejects(dash(RECOVERY, url), { endpointAllowlist: '' });
    process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST = 'http://codes.example.test:8080/other/';
    rejects(dash(RECOVERY, url));
  } finally {
    if (previous === undefined) delete process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST;
    else process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST = previous;
  }
});
