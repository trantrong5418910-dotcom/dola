import { classifyGoogleChallenge } from './google-login-challenge.js';
import { validateLoginVerificationCodeUrl } from './login-verification-code.js';

export const DOLA_ORIGIN = 'https://www.dola.com';
export const GOOGLE_ORIGIN = 'https://accounts.google.com';
export const GOOGLE_EMAIL_LABEL = /^(邮箱或电话号码|電子郵件地址或電話號碼|Email or phone|البريد الإلكتروني أو الهاتف|البريد الإلكتروني أو رقم الهاتف)$/i;
const NEXT_LABEL = /^(Next|Continue|Verify|Confirm|下一步|继续|繼續|验证|驗證|确认|確認|التالي|متابعة|تحقق|تأكيد)$/i;

// 授权同意页（OAuth consent）专用按钮文案：只认「继续 / 允许」这一种动作。
// 刻意**不复用** NEXT_LABEL —— 那里含 Verify/Confirm/验证/确认，一旦被用到安全校验页上，
// 就等于「替用户确认一个安全挑战」，那是绝对不能自动做的事。
const CONSENT_LABEL = /^(?:Continue|Allow|继续|繼續|允许|允許|متابعة|السماح)(?:\s+as\s+.+)?$/i;
// Google 的 OAuth 同意端点（2026-09-29 实测 /signin/oauth/id?authuser=0&part=...）。
const CONSENT_PATH = /^\/signin\/oauth\/(?:consent|id|approval)\/?$/i;
const AUTHENTICATOR_LABEL = /\bGoogle\s+Authenticator\b|(?:Google|谷歌)\s*(?:身份)?(?:验证|驗證)器|(?:مصادقة|المصادقة)\s+(?:Google|جوجل)/i;
const OTHER_OTP_CUES = /sms|text\s+messages?|phone|mobile|voice\s+call|back[\s-]?up|pass\s*key|security\s+key|手机|手機|电话|電話|短信|简讯|簡訊|备用|備用|备份|備份|通行密[钥鑰]|通行金鑰|安全密[钥鑰]|هاتف|(?:رسالة|رسائل)\s+نصية|احتياط|(?:مفتاح|مفاتيح)\s+(?:المرور|الأمان)/i;
const OTP_REJECTION_LABELS = [
  /\b(?:wrong|incorrect|invalid|expired)\s+(?:(?:verification|authentication|security|one[ -]time)\s+)?code\b|\bcode\s+(?:you\s+entered\s+)?(?:(?:is|was|has)\s+)?(?:incorrect|invalid|wrong|expired)\b|\bcode\s+(?:does\s*not|doesn't|did\s*not|didn't)\s+match\b/i,
  /(?:验证码|驗證碼|代码|代碼)(?:不正确|不正確|错误|錯誤|有误|有誤|无效|無效|(?:已|已经|已經)?(?:过期|過期|失效))/,
  /(?:الرمز|رمز(?:\s+التحقق)?)\s+(?:الذي\s+أدخلته\s+)?(?:غير\s+صحيح|خاطئ|غير\s+صالح|منتهي\s+الصلاحية)|انتهت\s+صلاحية\s+(?:الرمز|رمز)/,
];
export const originOf = value => { try { return new URL(value).origin; } catch { return ''; } };

/**
 * 「落在 Google 上」的宽松判定，只用于**判断登录是否已经建立**。
 *
 * 为什么需要（2026-09-29 实测）：`gapi.mailsapi.com` 的「谷歌已登录链接」在
 * 成功登录后会把浏览器落在 **`myaccount.google.com`**（Google 账号中心），
 * 而不是 `accounts.google.com`。原先只认 `GOOGLE_ORIGIN` 精确相等，
 * 于是「明明已经登录成功」也被判成需要人工，整批卡在 `google_step`。
 *
 * ⚠️ 绝不能拿它替代 `GOOGLE_ORIGIN` 去做**填表单/输密码**前的校验
 * （`assertGoogleOrigin`）—— 那里必须精确等于 `accounts.google.com`。
 */
export const isGoogleWebOrigin = value => /^https:\/\/(?:[a-z0-9-]+\.)*google\.com$/i.test(originOf(value));
const invalid = () => { throw new Error('invalid_login_url'); };

// Inspect the original spelling: URL() otherwise normalizes ports and slashes.
export function validateGoogleSessionUrl(value) {
  if (typeof value !== 'string' || value.length > 8192
      || !/^https:\/\/gapi\.mailsapi\.com\/google\/login\?uid=[^&#]+$/i.test(value)
      || /[\s\\#\x00-\x1f\x7f]/u.test(value) || /%(?![\da-f]{2})/i.test(value)) invalid();
  try {
    const url = new URL(value), uid = url.searchParams.get('uid');
    const decoded = decodeURIComponent(value.split('?uid=')[1].replace(/\+/g, ' '));
    if (url.origin !== 'https://gapi.mailsapi.com' || url.pathname !== '/google/login'
        || url.searchParams.size !== 1 || !uid?.trim() || !decoded.trim()
        || /[\\\x00-\x1f\x7f]/.test(decoded)) invalid();
  } catch { invalid(); }
  return value;
}

// Share endpoint policy with the fetcher, retaining the form's stricter syntax
// checks. This helper must never resolve a hostname or fetch a code itself.
export function validateVerificationUrl(value) {
  if (typeof value !== 'string' || value.length > 8192
      || /[\s\\#\x00-\x1f\x7f]/u.test(value) || /%(?![\da-f]{2})/i.test(value)) invalid();
  try {
    const url = validateLoginVerificationCodeUrl(value);
    if (url.hostname.includes('gapi.mailsapi.com') || /\/google\/login(?:\/|$)/i.test(url.pathname)) invalid();
    if (/[\x00-\x1f\x7f\\]/.test(decodeURIComponent(url.pathname + url.search))) invalid();
  } catch { invalid(); }
  return value;
}

export function eraseLoginSecrets(input, { all = false } = {}) {
  if (!input) return;
  for (const key of ['password', 'recoveryEmail', 'googleSessionUrl', 'verificationUrl', 'profileId', 'accountCode', ...(all ? ['email'] : [])]) {
    if (Object.hasOwn(input, key)) input[key] = '';
  }
}

export function displaysEmail(text, email) {
  return Boolean(email) && (String(text).match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/gi) || [])
    .some(candidate => candidate.toLowerCase() === email.toLowerCase());
}

export function classifyGoogleLoginStep({ url = '', text = '', emailVisible = false, passwordVisible = false,
  recoveryVisible = false, pinVisible = false, totpVisible = false, captchaVisible = false, ambiguous = false } = {}) {
  if (originOf(url) !== GOOGLE_ORIGIN) return { kind: 'manual', reason: 'google_step' };
  const pathname = new URL(url).pathname;
  const challenge = classifyGoogleChallenge({ pathname, text, captchaVisible });
  if (challenge === 'captcha' || challenge === 'browser_blocked') return { kind: 'manual', reason: challenge };
  if (ambiguous || [emailVisible, passwordVisible, recoveryVisible, pinVisible, totpVisible].filter(Boolean).length > 1) {
    return { kind: 'manual', reason: 'security' };
  }
  if (recoveryVisible) return { kind: 'recovery' };
  // idvPin/Pin also occur on SMS challenges. Require an email route AND email
  // code wording, and reject phone/authenticator/backup-code instructions.
  if (pinVisible && /\/challenge\/(ipe|email)(?:\/|$)/.test(pathname)
      && /email|e-mail|邮箱|电子邮件|電子郵件|البريد الإلكتروني/i.test(text)
      && /code|验证码|驗證碼|رمز/i.test(text)
      && !/sms|text message|phone|手机|電話|短信|رسالة نصية|هاتف|authenticator|backup code|备用码/i.test(text)) return { kind: 'email_otp' };
  if (totpVisible && /\/challenge\/totp\/?$/.test(pathname)
      && AUTHENTICATOR_LABEL.test(text) && !OTHER_OTP_CUES.test(text)) return { kind: 'authenticator_otp' };
  if (challenge || pinVisible || totpVisible) return { kind: 'manual', reason: challenge || 'security' };
  if (emailVisible) return { kind: 'email' };
  if (passwordVisible) return { kind: 'password' };
  return { kind: 'manual', reason: 'google_step' };
}

async function visibleMatches(locator) {
  const matches = [];
  for (let i = 0, count = await locator.count(); i < count; i++) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible()) matches.push(candidate);
  }
  return matches;
}

export async function readGoogleLoginStep(page, expectedEmail = '') {
  const text = await page.locator('body').innerText({ timeout: 2000 });
  let email = await visibleMatches(page.locator('input#identifierId, input[name="identifier"]'));
  if (!email.length) email = await visibleMatches(page.getByRole('textbox', { name: GOOGLE_EMAIL_LABEL }));
  const password = await visibleMatches(page.locator('input[type="password"]'));
  const recovery = await visibleMatches(page.locator('input[name="knowledgePreregisteredEmailResponse"], input#knowledge-preregistered-email-response'));
  const pin = await visibleMatches(page.locator('input#idvPin, input[name="Pin"]'));
  const totp = await visibleMatches(page.locator('input#totpPin, input[name="totpPin"]'));
  const captcha = await visibleMatches(page.locator('input[name="ca"], input[name="captcha"], input#ca, input[name="recaptcha_response_field"], img[src*="/Captcha"], img#captchaimg, iframe[src*="/recaptcha/"], iframe[title*="reCAPTCHA"]'));
  const otherOtp = await visibleMatches(page.locator('input[autocomplete="one-time-code"]:not(#idvPin):not([name="Pin"]):not(#totpPin):not([name="totpPin"])'));
  const step = classifyGoogleLoginStep({ url: page.url(), text, emailVisible: email.length > 0,
    passwordVisible: password.length > 0, recoveryVisible: recovery.length > 0, pinVisible: pin.length > 0, totpVisible: totp.length > 0,
    captchaVisible: captcha.length > 0, ambiguous: otherOtp.length > 0 || [email, password, recovery, pin, totp].some(values => values.length > 1) });
  const otpRejected = ['email_otp', 'authenticator_otp'].includes(step.kind)
    && OTP_REJECTION_LABELS.some(pattern => pattern.test(text));
  // Account badges on consent pages are not chooser controls. Require the
  // chooser route/wording and no challenge/form, then a unique exact mailbox.
  if (step.kind === 'manual' && step.reason === 'google_step' && expectedEmail
      && originOf(page.url()) === GOOGLE_ORIGIN
      && (/\/(?:accountchooser|chooser)(?:\/|$)/i.test(new URL(page.url()).pathname)
        || /choose an account|选择账号|选择帐号|選擇帳戶|اختيار حساب|اختر حساب/i.test(text))) {
    const cssEmail = expectedEmail.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const name = new RegExp('^' + expectedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
    const choices = page.locator(`[data-identifier="${cssEmail}" i]`)
      .or(page.getByRole('button', { name })).or(page.getByRole('option', { name }));
    const matches = await visibleMatches(choices);
    if (matches.length === 1) return { kind: 'chooser', text, input: matches[0], otpRejected };
  }
  // 「授权同意页」（Sign in to dola.com）既不是安全校验、也不是登录表单，但它需要一次点击
  // 才能走完 OAuth。2026-09-29 生产实测：一个**全新的、从未授权过 dola.com 的**谷歌号必然会
  // 看到它；而服务器上没有人可以点，于是整批在 handoff('google_step') 上耗满 5 分钟超时而失败。
  //
  // 安全边界（缺一不可 —— 宁可漏点交人工，也绝不能点错）：
  //   1) step 已被判为 manual/google_step：说明页面上没有邮箱/密码/恢复/OTP 输入框，
  //      也没有 captcha、没有被判成安全挑战（classifyGoogleLoginStep 只在全部落空时才给这个结论）；
  //   2) origin 精确等于 accounts.google.com，且路径是 OAuth 同意端点（CONSENT_PATH）；
  //      这一条同时挡掉登录成功后落地的 myaccount.google.com（账号中心没有"同意"语义）；
  //   3) 正文里出现**期望邮箱**（displaysEmail）—— 防止替另一个账号点同意；
  //   4) 正文里出现 dola.com —— 授权对象必须就是 dola，不能是别的客户端；
  //   5) 全页**只有一个** Continue/Allow 按钮；多于一个一律交人工。
  if (step.kind === 'manual' && step.reason === 'google_step' && expectedEmail
      && originOf(page.url()) === GOOGLE_ORIGIN && CONSENT_PATH.test(new URL(page.url()).pathname)
      && /dola\.com/i.test(text) && displaysEmail(text, expectedEmail)) {
    const matches = await visibleMatches(page.getByRole('button', { name: CONSENT_LABEL }));
    if (matches.length === 1) return { kind: 'consent', text, input: matches[0], otpRejected };
  }
  return { ...step, text, input: ({ email, password, recovery, email_otp: pin, authenticator_otp: totp })[step.kind]?.[0], otpRejected };
}

/**
 * Dola 自己的「确认你的年龄」弹窗。
 *
 * 为什么需要（2026-09-29 生产实测 + 截图取证）：OAuth 回调落到
 * dola.com/auth/callback#state=… 之后，页面上会弹一个
 * 「确认你的年龄 / 请确认你已满18周岁，未确认可能会影响你继续体验」的模态框（按钮「否」「确认」）。
 * 不点掉它，SPA 就不会发起登录交换（/passport/web/auth/login/），
 * 驱动永远采集不到会话绑定标记 → 必然 handoff('binding')。
 *
 * 判定刻意做窄：必须同时满足「origin 精确等于 dola.com」+「正文命中年龄提示」+
 * 「全页只有一个可见可用的『确认』按钮」。任何一条不满足都不点，退回人工。
 * 「否 / 取消 / Cancel / No」永远不在可点名单里。
 */
export const DOLA_AGE_TEXT = /确认你的年龄|请确认你已满\s*18|已满\s*18\s*周岁|confirm your age|are you (?:at least )?18|over 18 years old|18\s*周岁/i;
const DOLA_AGE_CONFIRM_LABEL = /^(?:确认|確定|确定|确认年龄|Confirm|Yes)$/i;

export async function readDolaAgeConfirm(page) {
  if (originOf(page.url()) !== DOLA_ORIGIN) return null;
  const text = await page.locator('body').innerText({ timeout: 2000 });
  if (!DOLA_AGE_TEXT.test(text)) return null;
  const matches = await visibleMatches(page.getByRole('button', { name: DOLA_AGE_CONFIRM_LABEL }));
  return matches.length === 1 ? matches[0] : null;
}

export function assertGoogleOrigin(page, signal) {
  if (signal?.aborted || originOf(page.url()) !== GOOGLE_ORIGIN) throw new Error('google_form_unavailable');
}

export async function clickGoogleStepNext(page, kind, { signal } = {}) {
  assertGoogleOrigin(page, signal);
  const id = kind === 'email' ? '#identifierNext' : kind === 'password' ? '#passwordNext'
    : kind === 'authenticator_otp' ? '#totpNext' : '';
  let matches = id ? await visibleMatches(page.locator(id)) : [];
  if (!matches.length) matches = await visibleMatches(page.getByRole('button', { name: NEXT_LABEL }));
  if (matches.length !== 1) return false;
  assertGoogleOrigin(page, signal);
  await matches[0].click({ timeout: 4000 });
  return !signal?.aborted;
}

export function filterLoginStorageState(state, { manual = false } = {}) {
  const domains = new Set(['dola.com', 'www.dola.com', ...(!manual ? ['google.com', 'accounts.google.com'] : [])]);
  const origins = new Set(['https://dola.com', DOLA_ORIGIN, ...(!manual ? [GOOGLE_ORIGIN] : [])]);
  return {
    cookies: (state?.cookies || []).filter(c => domains.has(String(c.domain).replace(/^\./, '').toLowerCase())
      && !Object.hasOwn(c, 'partitionKey') && !Object.hasOwn(c, 'partitionKeyOpaque') && c.partitioned !== true)
      .map(c => Object.fromEntries(['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite']
        .filter(key => c[key] !== undefined).map(key => [key, c[key]]))),
    origins: (state?.origins || []).filter(o => origins.has(o.origin)).map(o => ({ origin: o.origin,
      localStorage: (o.localStorage || []).map(({ name, value }) => ({ name, value })) })),
  };
}

export function reliableDolaIdentity(session, profile, expectedId = '') {
  const id = typeof profile?.entityId === 'string' ? profile.entityId : '';
  return Boolean(id.trim()) && session?.valid === true && profile?.ok === true && profile.code === 0
    && [session.pullStatus, session.launchStatus, profile.status].every(status => status === 200)
    && ![710012001, 710012014].includes(Number(session.pullCode))
    && ![710012001, 710012014].includes(Number(session.launchCode))
    && (!expectedId || id === String(expectedId)) && (!session.secUid || id === String(session.secUid));
}
