import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const MAX_BYTES = 512 * 1024;
const MAX_COOKIES = 500;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const COOKIE_FIELDS = new Set(['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite']);
const RECORD_FIELDS = new Set(['version', 'savedAt', 'identity', 'dolaId', 'proxyHash', 'cookies']);
const IDENTITY_FIELDS = new Set(['sub', 'email', 'email_verified']);
const hash = value => createHash('sha256').update(value).digest('hex');
const own = (value, key) => Object.getOwnPropertyDescriptor(value, key)?.value;
const plain = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const requireValid = condition => { if (!condition) throw new Error('invalid_cache'); };
const onlyFields = (value, allowed) => Object.keys(value).every(key => allowed.has(key));
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

function emailKey(value) {
  requireValid(typeof value === 'string');
  const normalized = value.trim().replace(/\\@/g, '@').toLowerCase();
  requireValid(normalized.length <= 254 && !/[\x00-\x1f\x7f]/.test(normalized)
    && /^[^\s@|]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(normalized));
  return normalized;
}

// Deliberately node-only: importing the cache never opens a DB or loads a browser.
function proxyHash(raw) {
  requireValid(typeof raw === 'string' && raw.length > 0 && !/[\s\x00-\x1f\x7f]/.test(raw));
  const url = new URL(raw);
  requireValid(['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) && url.hostname
    && !url.search && !url.hash && (!url.pathname || url.pathname === '/')
    && !/[\x00-\x1f\x7f]/.test(decodeURIComponent(url.username + url.password)));
  return hash(raw); // Do not canonicalize: a different proxy string needs a fresh login.
}

function cleanIdentity(input, email, strict) {
  requireValid(plain(input) && (!strict || onlyFields(input, IDENTITY_FIELDS)));
  const sub = own(input, 'sub');
  const claimedEmail = own(input, 'email');
  requireValid(typeof sub === 'string' && sub.trim().length > 0 && sub.length <= 512
    && !/[\x00-\x1f\x7f]/.test(sub) && own(input, 'email_verified') === true
    && emailKey(claimedEmail) === email && (!strict || claimedEmail === email));
  return { sub, email, email_verified: true };
}

function allowedDomain(value) {
  if (typeof value !== 'string' || value.length > 254) return null;
  const domain = value.toLowerCase();
  const host = domain.replace(/^\./, '');
  if (!host || host.length > 253 || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return host === 'dola.com' || host === 'www.dola.com' || host === 'google.com' || host.endsWith('.google.com') ? domain : null;
}

function cleanCookies(input, strict) {
  requireValid(Array.isArray(input) && input.length <= MAX_COOKIES);
  const result = [];
  for (const source of input) {
    requireValid(plain(source) && (!strict || onlyFields(source, COOKIE_FIELDS)));
    // Omitting a partition key while keeping the cookie would widen its scope.
    // Partitioned cookies are therefore excluded, never converted on restore.
    if (own(source, 'partitionKey') !== undefined) continue;
    requireValid(typeof own(source, 'domain') === 'string');
    const domain = allowedDomain(own(source, 'domain'));
    if (!domain) { requireValid(!strict); continue; }
    const name = own(source, 'name');
    const value = own(source, 'value');
    const path = own(source, 'path') ?? '/';
    requireValid(typeof name === 'string' && name.length <= 256 && /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)
      && typeof value === 'string' && !/[\x00-\x20\x7f;]/.test(value)
      && typeof path === 'string' && path.startsWith('/') && path.length <= 2048 && !/[\x00-\x1f\x7f;]/.test(path));
    const cookie = { name, value, domain, path };
    const expires = own(source, 'expires');
    if (expires !== undefined) {
      requireValid(typeof expires === 'number' && Number.isFinite(expires) && (expires === -1 || expires >= 0));
      cookie.expires = expires;
    }
    for (const key of ['httpOnly', 'secure']) {
      const flag = own(source, key);
      if (flag !== undefined) { requireValid(typeof flag === 'boolean'); cookie[key] = flag; }
    }
    const sameSite = own(source, 'sameSite');
    if (sameSite !== undefined) { requireValid(['Strict', 'Lax', 'None'].includes(sameSite)); cookie.sameSite = sameSite; }
    result.push(cookie);
  }
  return result;
}

function cleanSession(input, email, strict = false) {
  requireValid(plain(input));
  const dolaId = own(input, 'dolaId');
  requireValid(typeof dolaId === 'string' && dolaId.trim().length > 0 && dolaId.length <= 512
    && !/[\x00-\x1f\x7f]/.test(dolaId));
  return {
    identity: cleanIdentity(own(input, 'identity'), email, strict),
    dolaId,
    cookies: cleanCookies(own(input, 'cookies'), strict),
  };
}

/**
 * Cookie-only private cache, never proof of a currently authenticated session.
 * load -> { identity, dolaId, cookies } or null; save -> undefined (generic error
 * on failure); clear -> true if removed, false if absent or unsafe to remove.
 * Callers must reverify Dola identity through the same proxy after restoration.
 */
export function createGoogleLoginCache({
  directory = join(homedir(), 'Library', 'Application Support', 'DolaLogin', 'sessions'),
  clock = Date.now,
} = {}) {
  requireValid(typeof directory === 'string' && directory.length > 0 && typeof clock === 'function');
  const root = resolve(directory);
  const uid = process.geteuid?.() ?? process.getuid?.();
  const filename = email => join(root, `${hash(email)}.json`);
  const now = () => {
    const value = clock();
    requireValid(Number.isSafeInteger(value) && value >= 0);
    return value;
  };

  function privateStat(info, directoryEntry = false) {
    requireValid(uid !== undefined && info.uid === uid && !info.isSymbolicLink()
      && (info.mode & 0o7777) === (directoryEntry ? 0o700 : 0o600)
      && (directoryEntry ? info.isDirectory() : info.isFile() && info.nlink === 1));
  }

  async function openRoot(create = false) {
    if (create) await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(root);
    privateStat(info, true);
    requireValid(constants.O_NOFOLLOW && constants.O_DIRECTORY);
    const handle = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      privateStat(opened, true);
      requireValid(sameFile(info, opened));
      return { handle, info };
    } catch (error) { await handle.close(); throw error; }
  }

  async function checkRoot(entry) {
    const current = await fs.lstat(root);
    privateStat(current, true);
    requireValid(sameFile(current, entry.info));
    privateStat(await entry.handle.stat(), true);
  }

  async function targetStat(path, absentAllowed = false) {
    try {
      const info = await fs.lstat(path);
      privateStat(info);
      return info;
    } catch (error) {
      if (absentAllowed && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  return {
    async load(email, proxy) {
      let entry, file;
      try {
        const normalized = emailKey(email);
        const expectedProxyHash = proxyHash(proxy);
        entry = await openRoot();
        const path = filename(normalized);
        const original = await targetStat(path);
        requireValid(original.size > 0 && original.size <= MAX_BYTES);
        file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const opened = await file.stat();
        privateStat(opened);
        requireValid(sameFile(original, opened) && opened.size > 0 && opened.size <= MAX_BYTES);
        // Bound the read itself, even if a file grows after the metadata check.
        const bytes = Buffer.alloc(MAX_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        requireValid(length > 0 && length <= MAX_BYTES);
        privateStat(await file.stat());
        await checkRoot(entry);
        const record = JSON.parse(bytes.toString('utf8', 0, length));
        requireValid(plain(record) && onlyFields(record, RECORD_FIELDS)
          && own(record, 'version') === 1 && own(record, 'proxyHash') === expectedProxyHash);
        const savedAt = own(record, 'savedAt');
        const age = now() - savedAt;
        requireValid(Number.isSafeInteger(savedAt) && savedAt >= 0 && age >= 0 && age <= MAX_AGE);
        return cleanSession(record, normalized, true);
      } catch { return null; }
      finally {
        await file?.close().catch(() => {});
        await entry?.handle.close().catch(() => {});
      }
    },

    async save(email, proxy, input, { signal } = {}) {
      let entry, temporary, temporaryInfo, file;
      try {
        requireValid(!signal?.aborted);
        const normalized = emailKey(email);
        const record = { version: 1, savedAt: now(), ...cleanSession(input, normalized), proxyHash: proxyHash(proxy) };
        const data = Buffer.from(JSON.stringify(record), 'utf8');
        requireValid(data.length <= MAX_BYTES);
        entry = await openRoot(true);
        const target = filename(normalized);
        await targetStat(target, true);
        temporary = join(root, `.${hash(normalized)}.${randomUUID()}.tmp`);
        file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        temporaryInfo = await file.stat();
        privateStat(temporaryInfo);
        requireValid(!signal?.aborted);
        await file.writeFile(data);
        await file.sync();
        await file.close();
        file = null;
        await checkRoot(entry);
        const pending = await targetStat(temporary);
        requireValid(sameFile(pending, temporaryInfo));
        await targetStat(target, true);
        requireValid(!signal?.aborted);
        await fs.rename(temporary, target);
        temporary = null;
      } catch { throw new Error('google_login_cache_save_failed'); }
      finally {
        await file?.close().catch(() => {});
        if (temporary && temporaryInfo && entry) {
          try {
            await checkRoot(entry);
            const pending = await targetStat(temporary);
            if (sameFile(pending, temporaryInfo)) await fs.unlink(temporary);
          } catch { /* Never follow a replacement root/file or log an error payload. */ }
        }
        await entry?.handle.close().catch(() => {});
      }
    },

    async clear(email) {
      let entry;
      try {
        const normalized = emailKey(email);
        entry = await openRoot();
        const target = filename(normalized);
        const original = await targetStat(target);
        await checkRoot(entry);
        requireValid(sameFile(original, await targetStat(target)));
        await fs.unlink(target);
        return true;
      } catch { return false; }
      finally { await entry?.handle.close().catch(() => {}); }
    },
  };
}
