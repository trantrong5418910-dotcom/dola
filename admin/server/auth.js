/**
 * 密码哈希 + JWT + 鉴权中间件。全部用 node:crypto，不引第三方库。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSetting } from './db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = path.join(HERE, 'data', '.jwt-secret');

// ---------- 密码（scrypt） ----------

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(plain, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split(':');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const calc = crypto.scryptSync(String(plain), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

// ---------- JWT（HS256，自己签） ----------

function loadSecret() {
  if (process.env.ADMIN_JWT_SECRET) return process.env.ADMIN_JWT_SECRET;
  try {
    if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
    const s = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
    return s;
  } catch {
    return 'dev-insecure-secret';
  }
}
const SECRET = loadSecret();

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function signJwt(payload, hours = 12) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + hours * 3600 }));
  const sig = b64u(crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token) {
  try {
    const [h, p, s] = String(token).split('.');
    const expect = b64u(crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest());
    if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expect))) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- 中间件 ----------

function readToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  // 简易 cookie 解析（不引 cookie-parser）
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'admin_token') return decodeURIComponent(v.join('='));
  }
  return null;
}

/** 解析出当前用户（含角色权限），挂在 req.user */
export function authMiddleware(req, res, next) {
  const token = readToken(req);
  const payload = token ? verifyJwt(token) : null;
  if (!payload) {
    req.user = null;
    return next();
  }
  const user = db.prepare(`
    SELECT u.id, u.username, u.nickname, u.email, u.status, u.role_id, r.code AS role_code, r.name AS role_name, r.permissions
    FROM users u LEFT JOIN roles r ON r.id = u.role_id
    WHERE u.id = ?
  `).get(payload.uid);
  if (!user) { req.user = null; return next(); }
  if (user.status !== 'active') { req.user = null; return next(); }

  let perms = [];
  try {
    const parsed = JSON.parse(user.permissions || '[]');
    perms = parsed === '*' ? ['*'] : (Array.isArray(parsed) ? parsed : []);
  } catch { perms = []; }
  req.user = { ...user, permissions: perms };
  next();
}

/** 必须登录 */
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, message: '未登录或登录已过期' });
  next();
}

/** 必须有某个权限点；超级管理员 '*' 直接放行 */
export function requirePerm(code) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, message: '未登录或登录已过期' });
    const perms = req.user.permissions || [];
    if (perms.includes('*') || perms.includes(code)) return next();
    return res.status(403).json({ ok: false, message: `没有权限：${code}` });
  };
}

/** 登录有效期（小时），来自系统设置 */
export function sessionHours() {
  return Number(getSetting('session_hours', '12')) || 12;
}
