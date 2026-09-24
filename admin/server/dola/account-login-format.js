import { isIP } from 'node:net';
import { validateLoginVerificationCodeUrl } from './login-verification-code.js';

const MAX_BYTES = 32 * 1024;
const MAX_ENTRIES = 20;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_URL_LENGTH = 8192;
const controls = /[\x00-\x1f\x7f]/;
const domainLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const inputError = (line, reason) => Object.assign(new Error(`第 ${line} 行：${reason}`), { status: 400 });

// Shared by the parser and registry; callers must still use bound SQL parameters.
export function normalizeAccountLoginEmail(value) {
  if (typeof value !== 'string' || controls.test(value)) throw new Error('邮箱格式不正确');
  const email = value.trim().replace(/\\@/g, '@').toLowerCase();
  const parts = email.split('@');
  const [local = '', domain = ''] = parts;
  if (parts.length !== 2 || email.length > 254 || local.length > 64
      || !/^[a-z0-9.!#$%&'*+/=?^_`{}~-]+$/.test(local)
      || local.startsWith('.') || local.endsWith('.') || local.includes('..')
      || !domain.includes('.') || !domain.split('.').every(label => domainLabel.test(label))
      || isIP(domain)) throw new Error('邮箱格式不正确');
  return email;
}

function readEmail(value, line, recovery = false) {
  try { return normalizeAccountLoginEmail(value); }
  catch { throw inputError(line, recovery ? '恢复邮箱格式不正确' : '主邮箱格式不正确'); }
}

function readHttpsUrl(value, line, reason) {
  // Check the original spelling before WHATWG URL can remove controls, interpret
  // backslashes as slashes, or normalize an explicitly supplied default port.
  if (value.length > MAX_URL_LENGTH || !/^https:\/\//i.test(value) || /[\s\\#]/u.test(value) || controls.test(value)
      || /%(?![0-9a-f]{2})/i.test(value)) throw inputError(line, reason);
  try { return new URL(value); }
  catch { throw inputError(line, reason); }
}

function readGoogleSessionUrl(value, line) {
  const reason = '谷歌登录链接格式不正确';
  const url = readHttpsUrl(value, line, reason);
  const authority = value.match(/^https:\/\/([^/?#]+)/i)?.[1];
  const query = value.slice(value.indexOf('?') + 1);
  if (authority?.toLowerCase() !== 'gapi.mailsapi.com'
      || !/^https:\/\/[^/?#]+\/google\/login\?/i.test(value)
      || url.pathname !== '/google/login' || !/^uid=[^&]+$/.test(query)
      || url.searchParams.size !== 1 || !url.searchParams.has('uid')) throw inputError(line, reason);
  let uid;
  try { uid = decodeURIComponent(query.slice(4).replace(/\+/g, ' ')); }
  catch { throw inputError(line, reason); }
  if (!uid.trim() || controls.test(uid) || uid.includes('\\')) throw inputError(line, reason);
  return value;
}

function readVerificationUrl(value, line, endpointAllowlist) {
  try { validateLoginVerificationCodeUrl(value, { endpointAllowlist }); }
  catch { throw inputError(line, '验证码接口必须是有效的公网 HTTPS 链接或明确允许的公网接口'); }
  // Shared syntax screening only; the fetcher validates and pins DNS at runtime.
  // Preserve the validated original spelling, including opaque query tokens.
  return value;
}

/** Parse transient credentials; never persist or include input in error text. */
export function parseAccountLoginEntries(raw, { manual = false, endpointAllowlist } = {}) {
  if (typeof raw !== 'string') throw inputError(1, '请输入账号列表文本');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw inputError(1, '账号列表不能超过 32 KiB');
  const entries = [];
  const seen = new Set();
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (!line.trim()) continue;
    if (entries.length === MAX_ENTRIES) throw inputError(lineNumber, '每批最多支持 20 个账号');
    if (controls.test(line)) throw inputError(lineNumber, '账号内容不能包含控制字符');
    const entry = { email: '', password: '', loginMethod: manual ? 'manual' : 'password',
      recoveryEmail: '', googleSessionUrl: '', verificationUrl: '' };
    if (manual) {
      entry.email = readEmail(line, lineNumber);
    } else {
      // A pipe after the first delimiter belongs to the password. Hyphens in
      // an email local part are not delimiters (including four consecutive ones).
      const pipe = line.indexOf('|');
      const at = line.indexOf('@');
      const dash = line.indexOf('----', at + 1);
      if (pipe >= 0 && (dash < 0 || pipe < dash)) {
        entry.email = readEmail(line.slice(0, pipe), lineNumber);
        entry.password = line.slice(pipe + 1);
      } else if (dash >= 0) {
        const fields = [line.slice(0, dash), ...line.slice(dash + 4).split('----')];
        if (fields.length !== 3 && fields.length !== 4) throw inputError(lineNumber, '账号格式必须为三段或四段');
        entry.email = readEmail(fields[0], lineNumber);
        entry.password = fields[1];
        if (fields.length === 4 && fields[2].trim().toLowerCase() === 'no') {
          entry.loginMethod = 'google_link';
          entry.googleSessionUrl = readGoogleSessionUrl(fields[3].trim(), lineNumber);
        } else {
          entry.recoveryEmail = readEmail(fields[2], lineNumber, true);
          if (fields.length === 4) entry.verificationUrl = readVerificationUrl(fields[3].trim(), lineNumber, endpointAllowlist);
        }
      } else {
        throw inputError(lineNumber, '账号格式不正确，缺少分隔符');
      }
      if (!entry.password.trim()) throw inputError(lineNumber, '密码不能为空');
      if (entry.password.length > MAX_PASSWORD_LENGTH) throw inputError(lineNumber, '密码不能超过 1024 个字符');
    }
    if (seen.has(entry.email)) throw inputError(lineNumber, '账号邮箱重复');
    seen.add(entry.email);
    entries.push(entry);
  }
  if (!entries.length) throw inputError(1, '请至少输入一个账号');
  return entries;
}
