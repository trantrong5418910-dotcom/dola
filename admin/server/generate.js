/**
 * 令牌 / 卡密生成。
 *
 * 前缀对齐视频工作台那套模型（dv_ 令牌、card_ 卡密），以后要对接外部系统字段不用改。
 * 随机数一律用 crypto.randomBytes，不用 Math.random。
 */
import crypto from 'node:crypto';

export const TOKEN_PREFIX = 'dv_';
export const CARD_PREFIX = 'card_';

/** 令牌要复制粘贴，用全字符集 */
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** 卡密可能要用户手输，去掉易混字符 0O1lI */
const CARD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const TOKEN_BODY_LEN = 32;
const CARD_BODY_LEN = 20;

/** 单次生成上限（防止误点把库写爆） */
export const MAX_BATCH = 1000;

/** 无模偏差的安全随机串（拒绝采样） */
function randomString(length, alphabet) {
  const out = [];
  const max = 256 - (256 % alphabet.length); // 丢弃会让分布不均的尾部字节
  while (out.length < length) {
    for (const b of crypto.randomBytes(length * 2)) {
      if (b >= max) continue;
      out.push(alphabet[b % alphabet.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

/** 展示用前缀：dv_ + 6 位 / card_ + 6 位 */
const prefixOf = (value, base) => value.slice(0, base.length + 6);

export function generateTokenValue() {
  const value = TOKEN_PREFIX + randomString(TOKEN_BODY_LEN, TOKEN_ALPHABET);
  return { value, prefix: prefixOf(value, TOKEN_PREFIX) };
}

export function generateCardCode() {
  const value = CARD_PREFIX + randomString(CARD_BODY_LEN, CARD_ALPHABET);
  return { value, prefix: prefixOf(value, CARD_PREFIX) };
}

/** 把中间段打码，列表里只显示这个 */
export function maskValue(value) {
  const v = String(value || '');
  if (v.length < 12) return v;
  return `${v.slice(0, 10)}${'*'.repeat(8)}${v.slice(-4)}`;
}

/**
 * 批量生成并落库。撞码就重试（唯一索引兜底）。
 * 只用位置参数，兼容 better-sqlite3 与 node:sqlite 两套引擎。
 * @returns {{id:number, value:string, prefix:string, points:number, status:string}[]}
 */
export function insertMany(db, table, makeFn, rows) {
  const isToken = table === 'tokens';
  const cols = isToken
    ? '(name,value,prefix,points,status,expires_at,note,created_by,created_at,updated_at)'
    : '(code,prefix,points,status,batch_no,note,expires_at,created_by,created_at,updated_at)';
  const stmt = db.prepare(`INSERT INTO ${table} ${cols} VALUES (?,?,?,?,?,?,?,?,?,?)`);

  const out = [];
  for (const r of rows) {
    let inserted = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      const { value, prefix } = makeFn();
      const params = isToken
        ? [r.name ?? '', value, prefix, r.points ?? 0, r.status ?? 'active', r.expires_at ?? null, r.note ?? '', r.created_by ?? null, r.now, r.now]
        : [value, prefix, r.points ?? 0, r.status ?? 'unused', r.batch_no ?? '', r.note ?? '', r.expires_at ?? null, r.created_by ?? null, r.now, r.now];
      try {
        const info = stmt.run(...params);
        inserted = {
          id: info.lastInsertRowid,
          value,
          prefix,
          points: r.points ?? 0,
          status: isToken ? (r.status ?? 'active') : (r.status ?? 'unused'),
        };
      } catch (e) {
        lastErr = e;
        if (!String(e.message).includes('UNIQUE')) throw e;
      }
    }
    if (!inserted) throw new Error(`生成失败：连续 5 次撞码（${lastErr?.message || ''}）`);
    out.push(inserted);
  }
  return out;
}

/** 生成批次号：B20260919-3F2A */
export function makeBatchNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `B${ymd}-${randomString(4, CARD_ALPHABET)}`;
}

/** 把秒数/天数换算成 ISO 过期时间；不传就 null（永不过期） */
export function expiresAtFromDays(days) {
  const n = Number(days);
  if (!n || n <= 0) return null;
  return new Date(Date.now() + n * 86400_000).toISOString();
}

/** 生成 CSV（导出用）。加了 BOM，Excel 打开中文不乱码。 */
export function toCsv(headers, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(',')];
  for (const r of rows) lines.push(r.map(esc).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
