// Pure fixtures only: no browser, DB, cache reads, DNS or HTTP.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyGoogleLoginStep, GOOGLE_EMAIL_LABEL, validateGoogleSessionUrl, validateVerificationUrl,
  displaysEmail, filterLoginStorageState, reliableDolaIdentity, eraseLoginSecrets, clickGoogleStepNext,
  readGoogleLoginStep } from '../server/dola/google-login-form.js';

const G = 'https://accounts.google.com';
const link = 'https://gapi.mailsapi.com/google/login?uid=synthetic-only';
const TOTP_TEXT = 'Get a verification code from the Google Authenticator app';

// In-memory DOM subset: union selectors deduplicate the same node, while :not
// exclusions and visibility work independently of the implementation's strings.
function matchesSelector(node, selector) {
  const exclusions = [...selector.matchAll(/:not\(([^)]+)\)/g)].map(match => match[1]);
  if (exclusions.some(excluded => matchesSelector(node, excluded))) return false;
  const positive = selector.replace(/:not\([^)]+\)/g, '').trim();
  const tag = /^\w+/.exec(positive)?.[0], id = /#([\w-]+)/.exec(positive)?.[1];
  if (tag && node.tag !== tag || id && node.id !== id) return false;
  return [...positive.matchAll(/\[([\w-]+)(\*=|=)"([^"]*)"( i)?\]/g)].every(([, key, op, expected, insensitive]) => {
    if (node[key] === undefined) return false;
    const value = insensitive ? String(node[key]).toLowerCase() : String(node[key]);
    const wanted = insensitive ? expected.toLowerCase() : expected;
    return op === '*=' ? value.includes(wanted) : value === wanted;
  });
}

function formPage({ url = G + '/v3/signin/challenge/totp', text = TOTP_TEXT,
  nodes = [{ tag: 'input', id: 'totpPin', name: 'totpPin', autocomplete: 'one-time-code' }] } = {}) {
  const page = { currentUrl: url, text, nodes, clicks: [], url: () => page.currentUrl };
  const locator = selected => ({
    nodes: selected,
    count: async () => selected.length,
    nth: index => locator([selected[index]]),
    or: other => locator([...new Set([...selected, ...other.nodes])]),
    isVisible: async () => {
      await selected[0]?.onVisibility?.(page);
      return Boolean(selected[0] && selected[0].visible !== false);
    },
    innerText: async () => page.text,
    click: async () => { assert.equal(selected.length, 1); page.clicks.push(selected[0]); },
  });
  page.locator = selector => locator(selector === 'body' ? [{ tag: 'body' }]
    : nodes.filter(node => selector.split(',').some(part => matchesSelector(node, part))));
  page.getByRole = (role, { name }) => locator(nodes.filter(node => node.role === role && name.test(node.label || '')));
  return page;
}

test('only the exact Google link spelling and one nonempty uid are accepted', () => {
  assert.equal(validateGoogleSessionUrl(link), link);
  assert.equal(validateGoogleSessionUrl(link.replace('https://gapi.mailsapi.com', 'HTTPS://GAPI.MAILSAPI.COM')), link.replace('https://gapi.mailsapi.com', 'HTTPS://GAPI.MAILSAPI.COM'));
  for (const value of [link + '&other=x', link + '&uid=y', link + '#', link.replace('uid=', 'u%69d='),
    link.replace('uid=synthetic-only', 'uid='), link.replace('uid=synthetic-only', 'uid=%20'),
    link.replace('uid=synthetic-only', 'uid=%0A'), link.replace('uid=synthetic-only', 'uid=%zz'),
    link.replace('uid=synthetic-only', 'uid=%5c'), link.replace('https:', 'http:'),
    link.replace('.com/', '.com:443/'), link.replace('.com/', '.com./'), link.replace('gapi.', 'user@gapi.'),
    link.replace('/google/', '/x/../google/'), link.replace('/login?', '/login/?'),
    link.replace('/google/', '/%67oogle/'), link.replace('https://', 'https:\\'),
    ' ' + link, link + '\n', link.replace('.com/', '.com.evil.test/')]) {
    assert.throws(() => validateGoogleSessionUrl(value), { message: 'invalid_login_url' });
  }
});

test('verification URL syntax rejects private targets, credentials and normalization tricks', () => {
  assert.equal(validateVerificationUrl('https://mail.example.test/read?token=synthetic'), 'https://mail.example.test/read?token=synthetic');
  for (const value of ['http://mail.example.test/', 'https://127.0.0.1/', 'https://2130706433/', 'https://[::1]/',
    'https://mail.local/', 'https://mail.internal/', 'https://mail.arpa/', 'https://mail.example.test:444/',
    'https://x@y.example.test/', 'https://mail.example.test/#', 'https://mail.example.test/%0A',
    'https://mail.example.test/%zz', 'https://mail.example.test/%FF', 'https://mail.example.test/?token=%0D',
    'https://mail.example.test/?token=%5c', 'https://mail.example.test/%',
    'https://mail.example.test/captcha', 'https://mail.example.test/image.png',
    'https://mail.example.test/?type=image', 'https://mail.example.test/%2563aptcha',
    link, 'https://mail.example.test/google/login?uid=a']) {
    assert.throws(() => validateVerificationUrl(value), { message: 'invalid_login_url' });
  }
});

test('verification URL shares explicit endpoint-prefix policy and returns the original spelling', t => {
  const previous = process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST;
  t.after(() => {
    if (previous === undefined) delete process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST;
    else process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST = previous;
  });
  process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST = '';
  const endpoints = ['http://93.184.216.34:8080/totp/', 'https://mail.example.test:8443/otp/'];
  for (const prefix of endpoints) {
    assert.throws(() => validateVerificationUrl(prefix + 'read?token=synthetic'), { message: 'invalid_login_url' });
  }
  process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST = endpoints.join(',');
  for (const prefix of endpoints) {
    const value = prefix + 'read?token=synthetic%2Bvalue&other=one+two';
    assert.equal(validateVerificationUrl(value), value);
    for (const invalid of [prefix.replace(/\/(totp|otp)\/$/, '/outside/'), prefix + 'read?token=%0D',
      prefix + 'read?token=%5c', prefix + 'read?token=%FF', prefix + 'read?token=%zz',
      prefix + 'google/login?uid=synthetic', prefix + 'captcha', prefix + 'image.png']) {
      assert.throws(() => validateVerificationUrl(invalid), { message: 'invalid_login_url' });
    }
  }
  const original = 'HTTPS://MAIL.EXAMPLE.TEST:443/read?token=synthetic%2Bvalue';
  assert.equal(validateVerificationUrl(original), original);
  process.env.DOLA_LOGIN_OTP_ENDPOINT_ALLOWLIST = 'http://127.0.0.1:8080/otp/';
  assert.throws(() => validateVerificationUrl('http://127.0.0.1:8080/otp/read'), { message: 'invalid_login_url' });
});

test('Arabic identifier labels and whole-email identity matching', () => {
  for (const label of ['البريد الإلكتروني أو الهاتف', 'البريد الإلكتروني أو رقم الهاتف', 'Email or phone', '邮箱或电话号码']) assert.ok(GOOGLE_EMAIL_LABEL.test(label));
  assert.ok(displaysEmail('Sign in synthetic@example.test', 'synthetic@example.test'));
  assert.equal(displaysEmail('other-synthetic@example.test', 'synthetic@example.test'), false);
  assert.equal(displaysEmail('synthetic@example.test.evil', 'synthetic@example.test'), false);
});

test('only explicit recovery/email-OTP forms qualify; CAPTCHA always wins', () => {
  const emailOtp = { url: G + '/v3/signin/challenge/ipe', pinVisible: true, text: 'Enter the code sent to your recovery email' };
  assert.equal(classifyGoogleLoginStep(emailOtp).kind, 'email_otp');
  assert.equal(classifyGoogleLoginStep({ ...emailOtp, text: 'أدخل رمز البريد الإلكتروني' }).kind, 'email_otp');
  assert.equal(classifyGoogleLoginStep({ url: G + '/challenge/kpe', recoveryVisible: true }).kind, 'recovery');
  for (const extra of [{ url: G + '/challenge/ipp' }, { text: 'SMS code sent to phone' }, { text: 'Enter code' },
    { text: 'Use your authenticator email code' }, { ambiguous: true }, { passwordVisible: true }, { totpVisible: true },
    { url: 'https://evil.example.test/challenge/ipe' }]) assert.equal(classifyGoogleLoginStep({ ...emailOtp, ...extra }).kind, 'manual');
  assert.deepEqual(classifyGoogleLoginStep({ ...emailOtp, captchaVisible: true }), { kind: 'manual', reason: 'captcha' });
  assert.deepEqual(classifyGoogleLoginStep({ ...emailOtp, text: 'This browser or app may not be secure' }), { kind: 'manual', reason: 'browser_blocked' });
});

test('TOTP requires the exact challenge route and Google Authenticator wording', () => {
  for (const pathname of ['/challenge/totp', '/challenge/totp/', '/v3/signin/challenge/totp', '/signin/v2/challenge/totp']) {
    for (const text of [TOTP_TEXT, 'Enter the code from Google Authenticator',
      '输入 Google 身份验证器应用中的验证码', '輸入 Google 身份驗證器的驗證碼', '输入谷歌验证器中的验证码',
      'أدخل رمز التحقق من تطبيق Google Authenticator', 'أدخل الرمز من أداة مصادقة Google',
      'أدخل الرمز من تطبيق المصادقة جوجل']) {
      assert.deepEqual(classifyGoogleLoginStep({ url: G + pathname + '?hl=ar', text, totpVisible: true }), { kind: 'authenticator_otp' });
    }
  }
  const totp = { url: G + '/v3/signin/challenge/totp', text: TOTP_TEXT, totpVisible: true };
  for (const url of [G + '/challenge/totp-extra', G + '/challenge/totp/unknown', G + '/challenge/TOTP',
    G + '/challenge/%74otp', G + '/challenge/ipp', G + '/challenge/ipe', G + '/signin?next=/challenge/totp',
    G + '/signin#challenge/totp', 'https://accounts.google.com.evil.test/challenge/totp',
    'https://accounts.google.com@evil.test/challenge/totp', 'http://accounts.google.com/challenge/totp',
    'https://accounts.google.com:444/challenge/totp', 'https://mail.google.com/challenge/totp', 'not a URL']) {
    assert.equal(classifyGoogleLoginStep({ ...totp, url }).kind, 'manual', url);
  }
  for (const text of ['', 'Enter a code', 'Enter an authenticator code', 'Use your authenticator app',
    'Use Microsoft Authenticator', '输入验证码', 'أدخل رمز التحقق']) {
    assert.equal(classifyGoogleLoginStep({ ...totp, text }).kind, 'manual', text);
  }
  assert.equal(classifyGoogleLoginStep({ ...totp, totpVisible: false }).kind, 'manual');
  assert.equal(classifyGoogleLoginStep({ ...totp, totpVisible: false, pinVisible: true }).kind, 'manual');
});

test('TOTP rejects phone, SMS, backup and passkey cues in supported languages', () => {
  for (const cue of ['SMS', 'text message', 'phone', 'mobile', 'voice call', 'backup code', 'back-up code',
    'passkey', 'security key', '手机', '手機', '电话', '電話', '短信', '簡訊', '备用码', '備用碼',
    '备份代码', '通行密钥', '通行金鑰', 'هاتف', 'رسالة نصية', 'رسائل نصية',
    'رمز احتياطي', 'الرموز الاحتياطية', 'مفتاح المرور', 'مفاتيح الأمان']) {
    assert.deepEqual(classifyGoogleLoginStep({ url: G + '/challenge/totp', totpVisible: true,
      text: TOTP_TEXT + '\n' + cue }), { kind: 'manual', reason: 'security' }, cue);
  }
});

test('CAPTCHA, browser blocking and ambiguous forms take precedence over TOTP', () => {
  const totp = { url: G + '/challenge/totp', text: TOTP_TEXT, totpVisible: true };
  for (const extra of [{ ambiguous: true }, { emailVisible: true }, { passwordVisible: true },
    { recoveryVisible: true }, { pinVisible: true }]) {
    assert.deepEqual(classifyGoogleLoginStep({ ...totp, ...extra }), { kind: 'manual', reason: 'security' });
    assert.deepEqual(classifyGoogleLoginStep({ ...totp, ...extra, captchaVisible: true }), { kind: 'manual', reason: 'captcha' });
  }
  for (const text of [TOTP_TEXT + '\nCAPTCHA', TOTP_TEXT + '\nEnter the characters you see']) {
    assert.deepEqual(classifyGoogleLoginStep({ ...totp, text }), { kind: 'manual', reason: 'captcha' });
  }
  assert.deepEqual(classifyGoogleLoginStep({ ...totp, ambiguous: true,
    text: TOTP_TEXT + '\nThis browser or app may not be secure' }), { kind: 'manual', reason: 'browser_blocked' });
});

test('DOM reader finds a distinct visible TOTP input by ID or name without treating it as unknown OTP', async () => {
  for (const attributes of [{ id: 'totpPin' }, { name: 'totpPin' }, { id: 'totpPin', name: 'totpPin' }]) {
    const input = { tag: 'input', ...attributes, autocomplete: 'one-time-code' };
    const page = formPage({ nodes: [input, { tag: 'input', id: 'totpPin', visible: false },
      { tag: 'input', autocomplete: 'one-time-code', visible: false }, { tag: 'input', name: 'captcha', visible: false }] });
    const step = await readGoogleLoginStep(page);
    assert.equal(step.kind, 'authenticator_otp');
    assert.equal(step.text, TOTP_TEXT);
    assert.equal(step.input.nodes[0], input);
    assert.equal(step.otpRejected, false);
  }
});

test('DOM reader leaves duplicates, unsupported OTP inputs and mixed forms manual', async () => {
  const input = { tag: 'input', id: 'totpPin', autocomplete: 'one-time-code' };
  for (const extra of [{ tag: 'input', name: 'totpPin' }, { tag: 'input', autocomplete: 'one-time-code' },
    { tag: 'input', id: 'idvPin' }, { tag: 'input', type: 'password' },
    { tag: 'input', name: 'identifier' }, { tag: 'input', name: 'knowledgePreregisteredEmailResponse' }]) {
    const step = await readGoogleLoginStep(formPage({ nodes: [input, extra] }));
    assert.equal(step.kind, 'manual'); assert.equal(step.reason, 'security');
    assert.equal(step.input, undefined); assert.equal(step.otpRejected, false);
  }
  for (const nodes of [[{ ...input, visible: false }], [{ tag: 'div', id: 'totpPin' }],
    [{ tag: 'input', autocomplete: 'one-time-code' }]]) {
    assert.equal((await readGoogleLoginStep(formPage({ nodes }))).kind, 'manual');
  }
  for (const captcha of [{ tag: 'input', name: 'captcha' }, { tag: 'img', id: 'captchaimg' },
    { tag: 'iframe', src: 'https://www.google.com/recaptcha/api' }]) {
    const step = await readGoogleLoginStep(formPage({ nodes: [input, { ...input }, captcha], text: TOTP_TEXT + '\nWrong code' }));
    assert.equal(step.reason, 'captcha'); assert.equal(step.input, undefined); assert.equal(step.otpRejected, false);
  }
  for (const extra of [{ url: 'https://evil.test/challenge/totp' }, { text: TOTP_TEXT + '\nThis browser or app may not be secure' },
    { text: TOTP_TEXT + '\nSMS' }, { url: G + '/challenge/ipp' }]) {
    const step = await readGoogleLoginStep(formPage(extra));
    assert.equal(step.kind, 'manual'); assert.equal(step.input, undefined);
  }
});

test('OTP rejection flags require specific wrong or expired code wording', async () => {
  for (const otp of [{}, { url: G + '/challenge/ipe', text: 'Enter the code sent to your email', nodes: [{ tag: 'input', id: 'idvPin' }] }]) {
    for (const error of ['Wrong code. Try again.', 'Incorrect verification code', 'Invalid code', 'Code has expired',
      'Your code is incorrect', 'The code you entered is invalid', "Code doesn't match", '验证码错误，请重试',
      '验证码已过期', '驗證碼不正確', '验证码有误', 'الرمز غير صحيح', 'رمز التحقق غير صالح',
      'الرمز الذي أدخلته غير صحيح', 'انتهت صلاحية الرمز', 'رمز التحقق منتهي الصلاحية']) {
      const page = formPage(otp); page.text += '\n' + error;
      assert.equal((await readGoogleLoginStep(page)).otpRejected, true, error);
    }
    for (const message of ['', 'Try again', 'Please try again later', '重试', 'حاول مرة أخرى',
      'Codes expire after 30 seconds', 'Your session has expired', 'Wrong password', 'Invalid email address', 'Try another way']) {
      const page = formPage(otp); page.text += '\n' + message;
      assert.equal((await readGoogleLoginStep(page)).otpRejected, false, message);
    }
  }
  const password = await readGoogleLoginStep(formPage({ url: G + '/challenge/pwd', text: 'Wrong code', nodes: [{ tag: 'input', type: 'password' }] }));
  assert.equal(password.kind, 'password'); assert.equal(password.otpRejected, false);
});

test('DOM reader preserves email OTP and exact account chooser behavior', async () => {
  const emailInput = { tag: 'input', id: 'idvPin', name: 'Pin', autocomplete: 'one-time-code' };
  const email = await readGoogleLoginStep(formPage({ url: G + '/challenge/ipe', text: 'Enter the code sent to your email', nodes: [emailInput] }));
  assert.equal(email.kind, 'email_otp'); assert.equal(email.input.nodes[0], emailInput);
  const expectedEmail = 'synthetic@example.test';
  const choice = { tag: 'button', role: 'button', label: expectedEmail, 'data-identifier': expectedEmail };
  const chooser = await readGoogleLoginStep(formPage({ url: G + '/accountchooser', text: 'Choose an account', nodes: [choice] }), expectedEmail);
  assert.equal(chooser.kind, 'chooser'); assert.equal(chooser.input.nodes[0], choice); assert.equal(chooser.otpRejected, false);
  const consent = await readGoogleLoginStep(formPage({ url: G + '/consent', text: expectedEmail, nodes: [choice] }), expectedEmail);
  assert.equal(consent.kind, 'manual'); assert.equal(consent.input, undefined);
});

test('unknown RTL buttons and duplicate semantic buttons are never clicked', async () => {
  let clicks = 0;
  const locator = values => ({ count: async () => values.length, nth: i => values[i] });
  const button = name => ({ name, isVisible: async () => true, click: async () => { clicks++; } });
  let buttons = [button('مجهول')];
  const page = { url: () => G, locator: () => locator([]),
    getByRole: (_, { name }) => locator(buttons.filter(b => name.test(b.name))) };
  assert.equal(await clickGoogleStepNext(page, 'recovery'), false);
  buttons = [button('التالي')];
  assert.equal(await clickGoogleStepNext(page, 'recovery'), true);
  buttons.push(button('Next'));
  assert.equal(await clickGoogleStepNext(page, 'email_otp'), false);
  assert.equal(clicks, 1);
});

test('TOTP Next uses a unique visible ID, with only unique semantic fallback', async () => {
  const next = { tag: 'div', id: 'totpNext' };
  const unrelated = { tag: 'button', role: 'button', label: 'Next' };
  const page = formPage({ nodes: [next, { ...next, visible: false }, unrelated] });
  assert.equal(await clickGoogleStepNext(page, 'authenticator_otp'), true);
  assert.deepEqual(page.clicks, [next]);

  const duplicate = formPage({ nodes: [next, { ...next }, unrelated] });
  assert.equal(await clickGoogleStepNext(duplicate, 'authenticator_otp'), false);
  assert.deepEqual(duplicate.clicks, []);
  for (const label of ['Next', 'Verify', '下一步', '驗證', 'التالي', 'تحقق']) {
    const button = { tag: 'button', role: 'button', label };
    const fallback = formPage({ nodes: [{ ...next, visible: false }, button] });
    assert.equal(await clickGoogleStepNext(fallback, 'authenticator_otp'), true);
    assert.deepEqual(fallback.clicks, [button]);
  }
  for (const nodes of [[], [{ tag: 'button', role: 'button', label: 'مجهول' }],
    [unrelated, { tag: 'button', role: 'button', label: 'التالي' }]]) {
    const fallback = formPage({ nodes });
    assert.equal(await clickGoogleStepNext(fallback, 'authenticator_otp'), false);
    assert.deepEqual(fallback.clicks, []);
  }
});

test('TOTP Next checks origin and cancellation before lookup and immediately before clicking', async () => {
  for (const url of ['https://evil.test/challenge/totp', 'http://accounts.google.com/challenge/totp',
    'https://accounts.google.com.evil.test/challenge/totp', 'https://accounts.google.com:444/challenge/totp']) {
    const page = formPage({ url });
    page.locator = () => assert.fail('foreign origin must fail before control lookup');
    await assert.rejects(clickGoogleStepNext(page, 'authenticator_otp'), { message: 'google_form_unavailable' });
    assert.deepEqual(page.clicks, []);
  }
  const controller = new AbortController(); controller.abort();
  const cancelled = formPage();
  cancelled.locator = () => assert.fail('aborted action must fail before control lookup');
  await assert.rejects(clickGoogleStepNext(cancelled, 'authenticator_otp', { signal: controller.signal }), { message: 'google_form_unavailable' });

  for (const useId of [true, false]) {
    for (const change of ['origin', 'abort']) {
      const abort = new AbortController();
      const next = { tag: 'button', role: 'button', label: 'التالي', ...(useId ? { id: 'totpNext' } : {}),
        onVisibility: page => { if (change === 'origin') page.currentUrl = 'https://evil.test/'; else abort.abort(); } };
      const page = formPage({ nodes: [next] });
      await assert.rejects(clickGoogleStepNext(page, 'authenticator_otp', { signal: abort.signal }), { message: 'google_form_unavailable' });
      assert.deepEqual(page.clicks, []);
    }
  }
});

test('storageState keeps exact origins and excludes unrelated and partitioned cookies', () => {
  const state = { cookies: ['.google.com', 'accounts.google.com', 'mail.google.com', '.dola.com', 'www.dola.com', 'evil.dola.com', 'gapi.mailsapi.com']
    .map(domain => ({ domain, name: 'synthetic', value: 'value', path: '/' })),
  origins: ['https://www.dola.com', 'https://dola.com', G, 'https://mail.google.com', 'https://gapi.mailsapi.com', 'http://www.dola.com']
    .map(origin => ({ origin, localStorage: [{ name: 'synthetic', value: 'value' }] })) };
  state.cookies.push({ domain: '.google.com', name: 'partitioned', value: 'value', partitionKey: 'test' });
  assert.deepEqual(filterLoginStorageState(state).cookies.map(c => c.domain), ['.google.com', 'accounts.google.com', '.dola.com', 'www.dola.com']);
  assert.deepEqual(filterLoginStorageState(state).origins.map(o => o.origin), ['https://www.dola.com', 'https://dola.com', G]);
  assert.deepEqual(filterLoginStorageState(state, { manual: true }).cookies.map(c => c.domain), ['.dola.com', 'www.dola.com']);
  assert.deepEqual(filterLoginStorageState(state, { manual: true }).origins.map(o => o.origin), ['https://www.dola.com', 'https://dola.com']);
});

test('manual identity needs reliable live results, entityId and matching account binding', () => {
  const session = { valid: true, pullStatus: 200, launchStatus: 200, pullCode: 0, launchCode: 0 };
  const profile = { ok: true, status: 200, code: 0, entityId: 'synthetic-id' };
  assert.ok(reliableDolaIdentity(session, profile, 'synthetic-id'));
  assert.equal(reliableDolaIdentity(session, profile, 'other'), false);
  for (const extra of [{ pullStatus: 503 }, { launchStatus: 0 }, { valid: false }, { pullCode: 710012001 }, { secUid: 'other' }]) {
    assert.equal(reliableDolaIdentity({ ...session, ...extra }, profile), false);
  }
  for (const extra of [{ entityId: '', id: 'synthetic-id' }, { entityId: '  ' }, { ok: false }, { code: 1 }, { status: 429 }]) {
    assert.equal(reliableDolaIdentity(session, { ...profile, ...extra }), false);
  }
});

test('close secret erasure includes profile/account identifiers and the input email', () => {
  const input = Object.fromEntries(['email', 'password', 'recoveryEmail', 'googleSessionUrl', 'verificationUrl', 'profileId', 'accountCode'].map(k => [k, 'synthetic']));
  eraseLoginSecrets(input, { all: true });
  assert.ok(Object.values(input).every(v => v === ''));
});
