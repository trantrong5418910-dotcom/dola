import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join, parse, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_BYTES = 1024 * 1024;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const MAGIC = Buffer.from('DOLAVLT1');
const HEADER_BYTES = MAGIC.length + 12 + 16;
const ORIGINS = new Set(['https://www.dola.com', 'https://dola.com', 'https://accounts.google.com']);
const COOKIE_FIELDS = new Set(['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite']);
const SESSION_FIELDS = new Set(['identity', 'dolaId', 'cookies', 'origins', 'manual']);
const RECORD_FIELDS = new Set(['version', 'savedAt', 'accountHash', 'proxyHash', 'session']);
const IDENTITY_FIELDS = new Set(['sub', 'email', 'email_verified']);
const ORIGIN_FIELDS = new Set(['origin', 'localStorage']);
const STORAGE_FIELDS = new Set(['name', 'value']);
const hash = value => createHash('sha256').update(value).digest('hex');
const own = (value, key) => Object.getOwnPropertyDescriptor(value, key)?.value;
const has = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const requireValid = condition => { if (!condition) throw new Error('invalid_login_session_vault'); };
const fields = (value, allowed) => Object.keys(value).every(key => allowed.has(key));
const bounded = (value, max) => typeof value === 'string' && value.length <= max && Buffer.byteLength(value) <= max;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const cancelled = signal => requireValid(!signal?.aborted);
const control = /[\x00-\x1f\x7f]/;

function emailKey(value) {
  requireValid(bounded(value, 512));
  const normalized = value.trim().replace(/\\@/g, '@').toLowerCase();
  const parts = normalized.split('@');
  requireValid(normalized.length <= 254 && parts.length === 2
    && /^[a-z0-9!#$%&'*+/=?^_`{}~.-]{1,64}$/.test(parts[0])
    && !parts[0].startsWith('.') && !parts[0].endsWith('.') && !parts[0].includes('..')
    && parts[1].includes('.') && validHost(parts[1]));
  return normalized;
}

function validHost(host) {
  return host.length > 0 && host.length <= 253
    && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function proxyDigest(raw) {
  requireValid(bounded(raw, 4096) && raw.length > 0 && !/[\s\x00-\x1f\x7f\\]/.test(raw));
  const url = new URL(raw);
  requireValid(['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)
    && bounded(url.hostname, 253) && url.hostname.length > 0
    && !url.search && !url.hash && (!url.pathname || url.pathname === '/')
    && bounded(decodeURIComponent(url.username), 1024) && bounded(decodeURIComponent(url.password), 1024)
    && !control.test(decodeURIComponent(url.username + url.password)));
  // Bind the exact proxy string, including credentials; never persist that string.
  return hash(raw);
}

function cleanIdentity(input, email, strict) {
  requireValid(plain(input) && (!strict || fields(input, IDENTITY_FIELDS)));
  const sub = own(input, 'sub');
  const claimed = own(input, 'email');
  requireValid(bounded(sub, 512) && sub.trim().length > 0 && !control.test(sub)
    && own(input, 'email_verified') === true && emailKey(claimed) === email && (!strict || claimed === email));
  return { sub, email, email_verified: true };
}

function cookieDomain(value) {
  if (!bounded(value, 254)) return null;
  const domain = value.toLowerCase();
  const host = domain.replace(/^\./, '');
  if (!validHost(host)) return null;
  return host === 'dola.com' || host === 'www.dola.com' || host === 'google.com'
    || host.endsWith('.google.com') ? domain : null;
}

function cleanCookies(input, strict, reserve) {
  requireValid(Array.isArray(input) && input.length <= 500);
  const cookies = [];
  for (const source of input) {
    requireValid(plain(source) && (!strict || fields(source, COOKIE_FIELDS)));
    // Dropping a partition key would widen scope. Exclude the entire cookie.
    if (has(source, 'partitionKey') || has(source, 'partitionKeyOpaque') || own(source, 'partitioned') === true) continue;
    requireValid(bounded(own(source, 'domain'), 254));
    const domain = cookieDomain(own(source, 'domain'));
    if (!domain) { requireValid(!strict); continue; }
    const name = own(source, 'name');
    const value = own(source, 'value');
    const path = own(source, 'path') ?? '/';
    requireValid(bounded(name, 256) && /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)
      && bounded(value, 16 * 1024) && !/[\x00-\x20\x7f;]/.test(value)
      && bounded(path, 2048) && path.startsWith('/') && !/[\x00-\x1f\x7f;]/.test(path));
    const cookie = { name, value, domain, path };
    const expires = own(source, 'expires');
    if (expires !== undefined) {
      requireValid(typeof expires === 'number' && Number.isFinite(expires)
        && (expires === -1 || (expires >= 0 && expires <= Number.MAX_SAFE_INTEGER)));
      cookie.expires = expires;
    }
    for (const key of ['httpOnly', 'secure']) {
      const flag = own(source, key);
      if (flag !== undefined) { requireValid(typeof flag === 'boolean'); cookie[key] = flag; }
    }
    const sameSite = own(source, 'sameSite');
    if (sameSite !== undefined) { requireValid(['Strict', 'Lax', 'None'].includes(sameSite)); cookie.sameSite = sameSite; }
    reserve(cookie);
    cookies.push(cookie);
  }
  return cookies;
}

function cleanOrigins(input, strict, reserve) {
  requireValid(Array.isArray(input) && input.length <= 1000);
  const origins = [], seen = new Set();
  for (const source of input) {
    requireValid(plain(source) && (!strict || fields(source, ORIGIN_FIELDS)));
    const origin = own(source, 'origin');
    requireValid(bounded(origin, 2048));
    if (!ORIGINS.has(origin)) { requireValid(!strict); continue; }
    requireValid(!seen.has(origin));
    seen.add(origin);
    const entries = own(source, 'localStorage');
    requireValid(Array.isArray(entries) && entries.length <= 1000);
    const localStorage = [], names = new Set();
    for (const item of entries) {
      requireValid(plain(item) && (!strict || fields(item, STORAGE_FIELDS)));
      const name = own(item, 'name'), value = own(item, 'value');
      requireValid(bounded(name, 1024) && bounded(value, 64 * 1024) && !names.has(name));
      names.add(name);
      const entry = { name, value };
      reserve(entry);
      localStorage.push(entry);
    }
    origins.push({ origin, localStorage });
  }
  return origins;
}

function cleanSession(input, email, strict = false) {
  requireValid(plain(input) && (!strict || fields(input, SESSION_FIELDS)));
  // Stop while copying bounded entries, before a large storage array can cause
  // a hundreds-of-MiB JSON allocation. save also checks the exact final size.
  let remaining = MAX_BYTES - HEADER_BYTES;
  const reserve = value => {
    remaining -= Buffer.byteLength(JSON.stringify(value));
    requireValid(remaining >= 0);
  };
  const manual = own(input, 'manual');
  requireValid(manual === undefined || manual === true);
  const identity = own(input, 'identity');
  const dolaId = own(input, 'dolaId');
  requireValid(bounded(dolaId, 512) && dolaId.trim().length > 0 && !control.test(dolaId));
  const session = {
    identity: manual === true && identity === null ? null : cleanIdentity(identity, email, strict),
    dolaId,
    cookies: cleanCookies(own(input, 'cookies'), strict, reserve),
  };
  if (own(input, 'origins') !== undefined) session.origins = cleanOrigins(own(input, 'origins'), strict, reserve);
  if (manual === true) session.manual = true;
  return session;
}

/**
 * An encrypted cache, NOT evidence of authentic credentials. Driver/store MUST
 * verify the live Dola identity through the bound proxy after restoration,
 * including manual sessions with identity:null. No legacy directory is read.
 *
 * AES-256-GCM with a local random master.key protects stored bytes under OS
 * ownership/permission controls. It does NOT resist compromise of this system
 * user, who can read the key or replace the running code. No keychain/network.
 *
 * Construction does no I/O. hasRecord(email) -> false ONLY for a confirmed
 * absent root/account record; unsafe paths, corruption and inspection errors
 * conservatively return true. Callers may consult a read-only legacy cache only
 * when hasRecord is false. When true and load returns null, require manual
 * review: NEVER fall back to plaintext identity or automatically retype a
 * password. load -> session|null; save -> undefined or the secret-safe
 * login_session_vault_save_failed error; clear -> boolean. clear deletes only
 * an account record and can work even if the key was lost.
 */
export function createLoginSessionVault({
  directory = join(homedir(), 'Library', 'Application Support', 'DolaLogin', 'encrypted-sessions'),
  clock = Date.now,
} = {}) {
  requireValid(typeof directory === 'string' && directory.length > 0 && !directory.includes('\0') && typeof clock === 'function');
  const root = resolve(directory);
  requireValid(root !== parse(root).root);
  const uid = process.geteuid?.() ?? process.getuid?.();
  const keyPath = join(root, 'master.key');
  const filename = accountHash => join(root, `${accountHash}.enc`);
  const now = () => {
    const value = clock();
    requireValid(Number.isSafeInteger(value) && value >= 0);
    return value;
  };
  const aad = (accountHash, proxyHash) => Buffer.from(JSON.stringify(['DolaLogin/session-vault', 1, accountHash, proxyHash]));

  function privateStat(info, directoryEntry = false, keyPublication = false) {
    requireValid(uid !== undefined && info.uid === uid && !info.isSymbolicLink()
      && (info.mode & 0o7777) === (directoryEntry ? 0o700 : 0o600)
      && (directoryEntry ? info.isDirectory() : info.isFile()));
    if (!directoryEntry && info.nlink === 0) {
      const error = new Error('unlinked_vault_inode');
      error.code = 'UNLINKED_VAULT_INODE';
      throw error;
    }
    if (!directoryEntry && keyPublication && info.nlink === 2) {
      const error = new Error('key_publication_pending');
      error.code = 'KEY_PUBLICATION_PENDING';
      throw error;
    }
    requireValid(directoryEntry || info.nlink === 1);
  }

  async function openRoot(create = false, absenceAllowed = false) {
    requireValid(constants.O_NOFOLLOW && constants.O_DIRECTORY && constants.O_NONBLOCK);
    // Check ancestors too: O_NOFOLLOW alone protects only the last component.
    const ancestors = [];
    let path = parse(root).root;
    for (const component of root.slice(path.length).split(sep)) {
      path = join(path, component);
      let info;
      try { info = await fs.lstat(path); }
      catch (error) {
        if (absenceAllowed && error.code === 'ENOENT') return null;
        if (!create || error.code !== 'ENOENT') throw error;
        await fs.mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        info = await fs.lstat(path);
      }
      requireValid(info.isDirectory() && !info.isSymbolicLink());
      ancestors.push({ path, info });
    }
    const info = ancestors.at(-1).info;
    privateStat(info, true);
    const handle = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const entry = { handle, info, ancestors };
    try { await checkRoot(entry); return entry; }
    catch (error) { await handle.close(); throw error; }
  }

  async function checkRoot(entry) {
    for (const { path, info } of entry.ancestors) {
      const current = await fs.lstat(path);
      requireValid(current.isDirectory() && !current.isSymbolicLink()
        && current.uid === info.uid && sameFile(current, info));
      if (path === root) privateStat(current, true);
    }
    const opened = await entry.handle.stat();
    privateStat(opened, true);
    requireValid(sameFile(opened, entry.info));
  }

  async function targetStat(path, max, absentAllowed = false, keyPublication = false) {
    try {
      const info = await fs.lstat(path);
      privateStat(info, false, keyPublication);
      requireValid(info.size > 0 && info.size <= max);
      return info;
    } catch (error) {
      if (absentAllowed && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function writableRecord(entry, path) {
    for (let attempt = 0; ; attempt++) {
      try { return await targetStat(path, MAX_BYTES, true); }
      catch (error) {
        // A concurrent atomic rename can retire the inode while lstat is in
        // flight. Never accept that zero-link snapshot: revalidate the root and
        // inspect the CURRENT path with every ownership/mode/type/size check.
        // No retries for hardlinks, symlinks, bad permissions or other errors.
        if (error.code !== 'UNLINKED_VAULT_INODE' || attempt >= 15) throw error;
        await checkRoot(entry);
      }
    }
  }

  async function readPrivate(entry, path, max, keyPublication = false) {
    let file;
    const bytes = Buffer.alloc(max + 1);
    try {
      await checkRoot(entry);
      const original = await targetStat(path, max, false, keyPublication);
      file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await file.stat();
      privateStat(opened, false, keyPublication);
      requireValid(sameFile(original, opened) && opened.size > 0 && opened.size <= max);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await file.stat();
      privateStat(after, false, keyPublication);
      requireValid(length > 0 && length <= max && after.size === length
        && sameFile(original, await targetStat(path, max, false, keyPublication)));
      await checkRoot(entry);
      return Buffer.from(bytes.subarray(0, length));
    } finally { bytes.fill(0); await file?.close().catch(() => {}); }
  }

  async function removeTemporary(entry, temporary, linkedKey = false) {
    if (!temporary?.info) return;
    try {
      await checkRoot(entry);
      const current = await fs.lstat(temporary.path);
      // The winning key briefly has two links until its staging name is removed.
      requireValid(sameFile(current, temporary.info) && current.isFile() && !current.isSymbolicLink()
        && current.uid === uid && (current.mode & 0o7777) === 0o600
        && (current.nlink === 1 || (linkedKey && current.nlink === 2)));
      await fs.unlink(temporary.path);
    } catch { /* Never clean through a replaced root, or emit a secret-bearing error. */ }
  }

  async function stage(entry, prefix, data, signal) {
    const temporary = { path: join(root, `.${prefix}.${randomUUID()}.tmp`) };
    let file;
    try {
      await checkRoot(entry);
      cancelled(signal);
      file = await fs.open(temporary.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temporary.info = await file.stat();
      privateStat(temporary.info);
      await file.writeFile(data);
      await file.sync();
      cancelled(signal);
      await file.close();
      file = null;
      await checkRoot(entry);
      requireValid(sameFile(temporary.info, await targetStat(temporary.path, data.length)));
      return temporary;
    } catch (error) {
      await file?.close().catch(() => {});
      await removeTemporary(entry, temporary);
      throw error;
    }
  }

  async function readKey(entry, signal) {
    for (let attempt = 0; ; attempt++) {
      cancelled(signal);
      try {
        const key = await readPrivate(entry, keyPath, 32, true);
        if (key.length === 32) return key;
        key.fill(0);
        requireValid(false);
      } catch (error) {
        // Only retry the short hard-link publication window, never bad bytes,
        // missing keys, wrong owners/modes or symlinks.
        if (error.code !== 'KEY_PUBLICATION_PENDING' || attempt >= 99) throw error;
        await delay(5);
      }
    }
  }

  async function getOrCreateKey(entry, signal) {
    try { return await readKey(entry, signal); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await checkRoot(entry);
    // A lost key alongside existing records is an error, not a new-key event.
    if (!(await fs.readdir(root)).every(name => /^\.master-key\.[0-9a-f-]{36}\.tmp$/.test(name))) {
      // Another first writer may have published between readKey and readdir.
      // This read never creates/replaces a missing or damaged key.
      return readKey(entry, signal);
    }
    const candidate = randomBytes(32);
    let temporary;
    try {
      temporary = await stage(entry, 'master-key', candidate, signal);
      cancelled(signal);
      // link is atomic and refuses an existing destination. Unlike rename it
      // cannot replace the winner during concurrent first saves, even in other
      // processes. Publish only fsynced bytes; records below use atomic rename.
      try { await fs.link(temporary.path, keyPath); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally {
      candidate.fill(0);
      await removeTemporary(entry, temporary, true);
    }
    await checkRoot(entry);
    await entry.handle.sync();
    return readKey(entry, signal);
  }

  return {
    async hasRecord(email) {
      let entry;
      try {
        const target = filename(hash(emailKey(email)));
        entry = await openRoot(false, true);
        if (!entry) return false;
        const record = await targetStat(target, MAX_BYTES, true);
        await checkRoot(entry);
        return record !== null;
      } catch { return true; }
      finally { await entry?.handle.close().catch(() => {}); }
    },

    async load(email, proxy) {
      let entry, key, plaintext;
      try {
        const normalized = emailKey(email), accountHash = hash(normalized), proxyHash = proxyDigest(proxy);
        entry = await openRoot();
        key = await readKey(entry);
        const bytes = await readPrivate(entry, filename(accountHash), MAX_BYTES);
        requireValid(bytes.length > HEADER_BYTES && bytes.subarray(0, MAGIC.length).equals(MAGIC));
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(MAGIC.length, MAGIC.length + 12));
        decipher.setAAD(aad(accountHash, proxyHash));
        decipher.setAuthTag(bytes.subarray(MAGIC.length + 12, HEADER_BYTES));
        const pending = decipher.update(bytes.subarray(HEADER_BYTES));
        try { plaintext = Buffer.concat([pending, decipher.final()]); }
        finally { pending.fill(0); }
        const record = JSON.parse(plaintext.toString('utf8'));
        requireValid(plain(record) && fields(record, RECORD_FIELDS) && record.version === 1
          && record.accountHash === accountHash && record.proxyHash === proxyHash);
        const age = now() - record.savedAt;
        requireValid(Number.isSafeInteger(record.savedAt) && record.savedAt >= 0 && age >= 0 && age < MAX_AGE);
        return cleanSession(record.session, normalized, true);
      } catch { return null; }
      finally {
        key?.fill(0); plaintext?.fill(0);
        await entry?.handle.close().catch(() => {});
      }
    },

    async save(email, proxy, input, options = {}) {
      let entry, key, plaintext, temporary;
      try {
        const signal = options?.signal;
        cancelled(signal);
        const normalized = emailKey(email), accountHash = hash(normalized), proxyHash = proxyDigest(proxy);
        plaintext = Buffer.from(JSON.stringify({ version: 1, savedAt: now(), accountHash, proxyHash,
          session: cleanSession(input, normalized) }));
        requireValid(plaintext.length + HEADER_BYTES <= MAX_BYTES);
        cancelled(signal);
        entry = await openRoot(true);
        const target = filename(accountHash);
        await writableRecord(entry, target);
        key = await getOrCreateKey(entry, signal);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(aad(accountHash, proxyHash));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const bytes = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
        temporary = await stage(entry, accountHash, bytes, signal);
        const currentKey = await readKey(entry, signal);
        try { requireValid(timingSafeEqual(key, currentKey)); }
        finally { currentKey.fill(0); }
        await checkRoot(entry);
        requireValid(sameFile(temporary.info, await targetStat(temporary.path, MAX_BYTES)));
        await writableRecord(entry, target);
        // Cancellation is honored until this commit point. An in-flight atomic
        // rename cannot be rolled back without racing a newer successful save.
        cancelled(signal);
        await fs.rename(temporary.path, target);
        temporary = null;
        await entry.handle.sync();
      } catch { throw new Error('login_session_vault_save_failed'); }
      finally {
        key?.fill(0); plaintext?.fill(0);
        if (entry) await removeTemporary(entry, temporary);
        await entry?.handle.close().catch(() => {});
      }
    },

    async clear(email) {
      let entry;
      try {
        const target = filename(hash(emailKey(email)));
        entry = await openRoot();
        const original = await targetStat(target, MAX_BYTES);
        await checkRoot(entry);
        requireValid(sameFile(original, await targetStat(target, MAX_BYTES)));
        await fs.unlink(target);
        await entry.handle.sync();
        return true;
      } catch { return false; }
      finally { await entry?.handle.close().catch(() => {}); }
    },
  };
}
