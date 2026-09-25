/**
 * 成片库 / 无水印资源 —— 自包含路由模块（挂载在 `/api/media`）
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么单独一个文件（而不是塞进 routes/dola.js）
 * ─────────────────────────────────────────────────────────────────────────
 * `routes/dola.js`、`db.js`、`dola/generator.js`、`web/views/Dola.vue`
 * 正在被另一条开发线改（未提交）。为了不和它抢同一个文件，
 * 这里做成**自带路由、自带权限**的独立模块，只在 `index.js` 加两行挂载。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 它补的是哪个缺口
 * ─────────────────────────────────────────────────────────────────────────
 * 后台原本的「生成任务」表格已经会显示「归档：已归档 / —」，
 * 但**整个后端连一个下载端点都没有** —— 标了已归档却拿不到文件。
 * 而 `is_unwatermarked` 字段后端也返回了，前端压根没用上。
 *
 * 所以本模块补三件事：
 *   ① 成片库列表 + 下载（本地归档优先，直链兜底）
 *   ② 「列出会话成片」—— 给一个会话 id，把里面的成片全列出来（只读，不写库）
 *   ③ 补录 + 补归档 —— 把会话里的成片抢存进本地（直链带签名会过期，不存就是死链）
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 三条不能违背的规矩（都有血泪来源）
 * ─────────────────────────────────────────────────────────────────────────
 * 1. **归档下载不走代理。** TOS 直链带签名、与账号 IP 无关，而视频几十 MB、
 *    住宅代理按 GB 计费 —— 走代理纯烧钱。浏览器提交/接口调用才走代理。
 * 2. **扫描会话必须用该账号自己的代理。** `pullChain` 默认走本机出口，
 *    而同一个账号的提交走的是它的代理 —— 30 秒内从两个 IP 出现，
 *    对风控来说比一直用同一个机房 IP 更可疑。
 * 3. **直链对后台是明给的 —— 后台本来就可以绕计费，这不是漏洞。**
 *    计费的边界在**用户面**（`/api/gateway`，用户令牌 + 积分）。后台是运营侧，
 *    管理员用直链把成片导走、喂给自己的剪辑流程、批处理，都是正常用法。
 *    ⚠️ 所以别在后台这一层做"防止绕过计费"的设计 —— 那是错位的防护，
 *    只会让运营动作变难（这条是踩过的：一开始我把直链掩码了，纯属多余）。
 *    ⚠️ 唯一真正要守的是**cookie 不外泄**（那要 `dola:reveal`，见 rbac）。
 *
 * 播放/下载仍然走短期凭证（`/library/:id/ticket`），但它**不是为了保密**，
 * 是因为 `<video src>` / `<a href>` 没法自定义请求头 —— 见 §②的注释。
 */

import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db } from './db.js';
import { requirePerm } from './auth.js';
import { audit } from './audit.js';
import { streamVideoFile } from './dola/video-file.js';
import { pullChain, extractUnwatermarked } from './dola/unwatermark.js';
import { parseCookies } from './dola/provider.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * 归档目录。默认与 generator.js 的 VIDEO_DIR 指向同一个目录 —— 故意共用，
 * 这样补录进来的成片，用户工作台的 `/api/gateway/gen/:id/file` 也能下到。
 *
 * 可用 `MEDIA_VIDEO_DIR` 覆盖。这不是为了生产灵活，是为了**测试能隔离**：
 * 归档会真的往磁盘写几十 MB 的文件，测试必须能写到临时目录去，
 * 否则跑一次冒烟就往仓库的 data/ 里塞垃圾。
 * （本项目的既有约定就是这样：`ADMIN_DB` / `PORT` / `DOLA_BASE` 都能被环境变量接管。）
 */
const VIDEO_DIR = process.env.MEDIA_VIDEO_DIR
  ? path.resolve(process.env.MEDIA_VIDEO_DIR)
  : path.join(HERE, 'data', 'videos');

const router = express.Router();
const now = () => new Date().toISOString();

/** 单条归档的硬超时。和 generator.js 的 archiveVideo 对齐（大文件 + 慢链）。 */
const ARCHIVE_TIMEOUT_MS = 5 * 60_000;
/** 小于这个字节数一定不是视频（HTML 错误页、重定向提示页都会落在这里）。 */
const MIN_VIDEO_BYTES = 1024;

// ───────────────────────────────────────────────────────────────────────────
// 扫描 ticket：把带签名的直链留在服务端，前端只拿掩码
// ───────────────────────────────────────────────────────────────────────────

/**
 * 扫描结果暂存区。**故意做成进程内存**而不是入库：
 * 这东西是「一次操作的中间态」，带签名的直链不该被持久化
 * （持久化就等于把绕过计费的钥匙写进了磁盘）。
 *
 * 代价说清楚：服务重启后旧 ticket 失效，导入会报「会话凭证已过期，请重新扫描」。
 * 这是可接受的 —— 重扫一次约 2~5 秒。
 */
const SCAN_TTL_MS = 10 * 60_000;
const SCAN_MAX_TICKETS = 60;
const scanTickets = new Map();

function putScanTicket(payload) {
  // 顺手清理过期项，避免长跑进程里无限堆积
  const cutoff = Date.now() - SCAN_TTL_MS;
  for (const [k, v] of scanTickets) if (v.createdAtMs < cutoff) scanTickets.delete(k);
  while (scanTickets.size >= SCAN_MAX_TICKETS) {
    const oldest = scanTickets.keys().next().value;
    if (oldest === undefined) break;
    scanTickets.delete(oldest);
  }
  const ticket = crypto.randomBytes(18).toString('base64url');
  scanTickets.set(ticket, { ...payload, createdAtMs: Date.now() });
  return ticket;
}

function takeScanTicket(ticket) {
  const rec = scanTickets.get(String(ticket || ''));
  if (!rec) return null;
  if (Date.now() - rec.createdAtMs > SCAN_TTL_MS) {
    scanTickets.delete(String(ticket));
    return null;
  }
  return rec;
}

/** 只用于**展示**的掩码：签名参数不出去，但保留足够信息让人看出是哪条。 */
function maskUrl(url) {
  const s = String(url || '');
  if (!s) return '';
  try {
    const u = new URL(s);
    return `${u.host}${u.pathname.slice(0, 48)}…`;
  } catch {
    return `${s.slice(0, 56)}…`;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 归档
// ───────────────────────────────────────────────────────────────────────────

/**
 * 把一条直链抓成本地文件。**不走代理**（见文件头规矩 1）。
 *
 * 返回值区分三种结局，因为它们对操作员的**下一步动作完全不同**：
 *   - `{ path, bytes }`      成功，可以下载了
 *   - `{ failed: 'gone' }`   直链已过期/403 —— 只能回会话重扫，重试没用
 *   - `{ failed: 'other' }`  网络抖动之类 —— 值得重试
 */
async function archiveTo(videoId, url, { unwatermarked = false } = {}) {
  if (!url) return { failed: 'gone' };
  const dir = path.resolve(VIDEO_DIR);
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${videoId}${unwatermarked ? '-nowatermark' : ''}.mp4`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('归档超时')), ARCHIVE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) {
      // 403/404 基本就是签名过期（dy_q 超时）—— 重试不会变好
      return { failed: res.status === 403 || res.status === 404 ? 'gone' : 'other', http: res.status };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < MIN_VIDEO_BYTES) return { failed: 'other', note: `文件太小（${buf.length} 字节）` };
    await fs.promises.writeFile(dest, buf);
    return { path: dest, bytes: buf.length };
  } catch (e) {
    return { failed: 'other', note: e?.name === 'AbortError' ? '归档超时' : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 磁盘上还有没有这个文件（数据库里有 local_path 不代表文件还在）。 */
function fileExistsSync(p) {
  if (!p) return false;
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * 取本地归档路径。
 *
 * 这里**故意内联**而不是 `import { localFileOf } from './dola/generator.js'`：
 * generator.js 有 90 KB、还会把 playwright 那一串依赖一起拖进来，
 * 而这个模块只是个只读的成片取回层，没必要为一行取值函数背上整个生成引擎。
 * （语义与 generator.js 导出的同名函数完全一致：local_path 为空即视为没有。）
 */
const localFileOf = (row) => (row?.local_path ? row.local_path : null);

/** 拼「这条成片能不能下 / 为什么不能下」，让前端不用自己推算。 */
function deliveryState(row) {
  const file = localFileOf(row);
  const onDisk = fileExistsSync(file);
  const hasUw = Boolean(row.unwatermarked_url);
  const hasWm = Boolean(row.watermarked_url);
  return {
    archived: Boolean(file),
    onDisk,
    /** 有本地文件 → 直接下；没有但还有直链 → 可以「抢存后下」 */
    downloadable: onDisk,
    recoverable: !onDisk && (hasUw || hasWm),
    /** 直链拿不到无水印时，只能给带水印兜底 —— 要让人看见这个降级 */
    unwatermarkedSource: row.is_unwatermarked ? (onDisk ? 'local' : 'url') : (hasUw ? 'url' : 'none'),
    /** 「归档丢了」是最需要报警的状态：库里记着有、磁盘上没了 */
    lost: Boolean(file) && !onDisk,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// ① 成片库列表
// ───────────────────────────────────────────────────────────────────────────

/**
 * GET /api/media/library
 * query: status / unwatermarked=1 / archived=1|0 / q（提示词模糊）/ limit / offset
 *
 * 只读。返回**不包含**任何直链（哪怕带水印的也不给）——
 * 前端要下载就走 `/library/:id/file`，由服务端决定用本地还是直链。
 */
router.get('/library', requirePerm('dola:list'), (req, res) => {
  const allowed = new Set(['queued', 'submitting', 'generating', 'resolving', 'ready', 'failed', 'cancelled']);
  const status = allowed.has(String(req.query.status || '')) ? String(req.query.status) : '';
  const q = String(req.query.q || '').trim();
  const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);

  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (String(req.query.unwatermarked || '') === '1') where.push('is_unwatermarked = 1');
  if (String(req.query.archived || '') === '1') where.push("local_path IS NOT NULL AND local_path <> ''");
  if (String(req.query.archived || '') === '0') where.push("(local_path IS NULL OR local_path = '')");
  if (q) { where.push('prompt LIKE ?'); args.push(`%${q}%`); }
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM dola_videos ${sql}`).get(...args).n;
  const rows = db.prepare(`
    SELECT id, account_id, account_label, conversation_id, prompt, ratio, seconds, force_seconds,
           status, stage, error, duration_sec, bytes, local_bytes, is_unwatermarked, unwatermark_note,
           unwatermarked_url, watermarked_url,
           CASE WHEN unwatermarked_url IS NOT NULL AND unwatermarked_url <> '' THEN 1 ELSE 0 END AS has_uw_url,
           CASE WHEN watermarked_url   IS NOT NULL AND watermarked_url   <> '' THEN 1 ELSE 0 END AS has_wm_url,
           local_path, owner_token_id, owner_prefix, created_at, updated_at, finished_at
      FROM dola_videos ${sql}
     ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);

  res.json({
    ok: true,
    total,
    limit,
    offset,
    items: rows.map((row) => {
      const d = deliveryState(row);
      return {
        id: row.id,
        accountLabel: row.account_label || '',
        accountId: row.account_id ?? null,
        conversationId: row.conversation_id || '',
        prompt: String(row.prompt || '').slice(0, 240),
        promptTruncated: String(row.prompt || '').length > 240,
        ratio: row.ratio,
        seconds: row.seconds,
        durationSec: row.duration_sec ?? null,
        bytes: row.local_bytes ?? row.bytes ?? null,
        status: row.status,
        stage: row.stage || '',
        error: row.error || '',
        isUnwatermarked: Boolean(row.is_unwatermarked),
        unwatermarkNote: row.unwatermark_note || '',
        hasUnwatermarkedUrl: Boolean(row.has_uw_url),
        hasWatermarkedUrl: Boolean(row.has_wm_url),
        /**
         * 直链明文给出（见文件头规矩 3）。带签名会过期 —— 想长期可用就走归档。
         * 列表里直接带上，是为了让运营能一键复制链接喂给剪辑/批处理流程，
         * 不用为每一条再点一次接口。
         */
        unwatermarkedUrl: row.unwatermarked_url || '',
        watermarkedUrl: row.watermarked_url || '',
        ownerTokenId: row.owner_token_id ?? null,
        ownerPrefix: row.owner_prefix || '',
        createdAt: row.created_at,
        finishedAt: row.finished_at || '',
        ...d,
      };
    }),
  });
});

/** GET /api/media/stats —— 成片库概况。数字口径与列表筛选一一对应，可直接点进去。 */
router.get('/stats', requirePerm('dola:list'), (_req, res) => {
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  const videoDir = path.resolve(VIDEO_DIR);
  const total = one('SELECT COUNT(*) AS n FROM dola_videos');
  const ready = one("SELECT COUNT(*) AS n FROM dola_videos WHERE status = 'ready'");
  const unwatermarked = one('SELECT COUNT(*) AS n FROM dola_videos WHERE is_unwatermarked = 1');
  const archived = one("SELECT COUNT(*) AS n FROM dola_videos WHERE local_path IS NOT NULL AND local_path <> ''");
  const withUrlOnly = one(`SELECT COUNT(*) AS n FROM dola_videos
                            WHERE (local_path IS NULL OR local_path = '')
                              AND ((unwatermarked_url IS NOT NULL AND unwatermarked_url <> '')
                                OR (watermarked_url IS NOT NULL AND watermarked_url <> ''))`);
  const bytes = db.prepare('SELECT COALESCE(SUM(local_bytes), 0) AS n FROM dola_videos').get().n;
  res.json({
    ok: true, total, ready, unwatermarked, archived, withUrlOnly, bytes,
    /** 磁盘实际占用。和 bytes 对不上就说明有孤儿文件或有文件被外部删了。 */
    diskBytes: dirBytesSync(videoDir),
    videoDir,
  });
});

function dirBytesSync(dir) {
  try {
    let sum = 0;
    for (const name of fs.readdirSync(dir)) {
      try { const st = fs.statSync(path.join(dir, name)); if (st.isFile()) sum += st.size; } catch { /* 跳过 */ }
    }
    return sum;
  } catch { return 0; }
}

// ───────────────────────────────────────────────────────────────────────────
// ② 播放 / 下载
// ───────────────────────────────────────────────────────────────────────────

/**
 * 短期播放凭证。
 *
 * ── 它解决的是「请求头」，不是「保密」──────────────────────────────────
 * 直链对后台是明给的（见文件头规矩 3）。这张凭证存在的唯一原因是：
 * `<video src>` 和 `<a href>` **没法自定义请求头**，拿不到
 * `Authorization: Bearer <后台 JWT>`。
 *
 * 三条路对比：
 *   ① `fetch → blob → objectURL`（项目里导出 CSV 用的写法）
 *      → 几 KB 的 CSV 没问题，但成片是几十上百 MB，全量读进内存会让页面卡死，
 *        而且 blob URL **不支持 Range**，进度条拖动和秒起播全没了。
 *   ② 把 JWT 塞进 query
 *      → 后台 JWT 是 12 小时有效的全权限凭据，进 URL 就会落进
 *        nginx access log、浏览器历史、Referer。为了看个视频漏这个不值。
 *   ③ **短期凭证 + 原生流式**（本文件的写法）
 *      → 支持 Range、可拖进度条、零内存占用、凭据 2 分钟就死。
 *
 * ⚠️ TTL 内**必须可重复使用** —— 播一个视频浏览器会发多个 Range 请求，
 *    做成"用过即焚"会让拖动进度条直接 403。
 */
const STREAM_TTL_MS = 2 * 60_000;
const STREAM_MAX_TICKETS = 200;
const streamTickets = new Map();

function issueStreamTicket(videoId, userId) {
  const cutoff = Date.now() - STREAM_TTL_MS;
  for (const [k, v] of streamTickets) if (v.expMs < cutoff) streamTickets.delete(k);
  while (streamTickets.size >= STREAM_MAX_TICKETS) {
    const oldest = streamTickets.keys().next().value;
    if (oldest === undefined) break;
    streamTickets.delete(oldest);
  }
  const ticket = crypto.randomBytes(18).toString('base64url');
  streamTickets.set(ticket, { videoId: Number(videoId), userId: userId ?? null, expMs: Date.now() + STREAM_TTL_MS });
  return ticket;
}

function resolveStreamTicket(ticket) {
  const rec = streamTickets.get(String(ticket || ''));
  if (!rec) return null;
  if (rec.expMs < Date.now()) { streamTickets.delete(String(ticket)); return null; }
  return rec;
}

/** 拼「重新抢存」的提示。三处复用，措辞必须一致，否则操作员会以为是三个不同的问题。 */
function refreshHint(r) {
  return r.failed === 'gone'
    ? '成片直链已过期（签名超时），无法再取回。请到「会话成片」用原会话重新扫描并补录。'
    : `抢存失败：${r.note || '网络异常'}。可以直接重试。`;
}

/**
 * 真正把一条成片吐出去。三个入口（JWT 直调 / 凭证流 / 补归档）共用这一段。
 *
 * 取值链（与项目既有约定一致）：**本地归档 > 无水印直链 > 带水印直链**。
 * `allowRefresh` 打开时，磁盘上没有但直链还在 → 当场再抓一次再流出去。
 * 这是「签名过期兜底」的正面：直链还在有效期内就还能救。
 */
async function serveVideoById(req, res, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, message: '任务 id 不合法' });

  const row = db.prepare(`SELECT id, status, is_unwatermarked, local_path,
                                 unwatermarked_url, watermarked_url
                            FROM dola_videos WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ ok: false, message: '任务不存在' });

  const filename = `${row.id}${row.is_unwatermarked ? '-nowatermark' : ''}.mp4`;
  const isUw = Boolean(row.is_unwatermarked);

  // 路径 A：磁盘上有 → 直接流（支持 Range，<video> 起播快、能拖进度条）
  if (fileExistsSync(row.local_path)) {
    return streamVideoFile(req, res, { file: row.local_path, filename, isUnwatermarked: isUw });
  }

  const src = row.unwatermarked_url || row.watermarked_url;
  if (!src) {
    return res.status(404).json({
      ok: false,
      message: '该任务既没有本地归档，也没有可用的成片直链。请到「会话成片」里重新扫描这个会话。',
    });
  }
  if (String(req.query.refresh || '') !== '1') {
    // 不替调用方做决定：抓一次几十 MB，得前端明确说要
    return res.status(409).json({
      ok: false,
      refreshable: true,
      message: '本地归档已丢失，但成片直链还在。点「重新抢存」会再下载一次并归档，然后才能提供文件。',
    });
  }

  const r = await archiveTo(id, src, { unwatermarked: isUw && Boolean(row.unwatermarked_url) });
  if (!r.path) {
    audit(req, 'media.refresh', 'dola_video', id, `抢存失败：${r.failed}${r.http ? ` HTTP ${r.http}` : ''}`);
    return res.status(410).json({ ok: false, gone: r.failed === 'gone', message: refreshHint(r) });
  }
  db.prepare('UPDATE dola_videos SET local_path = ?, local_bytes = ?, updated_at = ? WHERE id = ?')
    .run(r.path, r.bytes, now(), id);
  audit(req, 'media.refresh', 'dola_video', id, `抢存成功 ${(r.bytes / 1048576).toFixed(2)} MiB`);
  return streamVideoFile(req, res, { file: r.path, filename, isUnwatermarked: isUw });
}

/** 统一兜住 async 抛错 + 「响应头已发出就不能再写 JSON」这个流式传输特有的坑。 */
function serveGuard(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      if (!res.headersSent) return res.status(500).json({ ok: false, message: `成片读取失败：${e.message}` });
      try { res.end(); } catch { /* 已经断了，忽略 */ }
    }
  };
}

/**
 * GET /api/media/library/:id/file?download=1&refresh=1
 *
 * 带 JWT 直接调（curl / 脚本用）。浏览器里的 `<video>` 走下面的凭证通道。
 * `download=1` 由 streamVideoFile 转成 Content-Disposition: attachment。
 */
router.get('/library/:id/file', requirePerm('dola:list'), serveGuard((req, res) => serveVideoById(req, res, req.params.id)));

/**
 * POST /api/media/library/:id/ticket —— 换一张 2 分钟有效的播放/下载凭证。
 * 返回的是**相对路径**，前端直接塞给 `<video src>` / `<a href>` 即可。
 * 凭证与视频 id 绑定，换不了别的片子。
 */
router.post('/library/:id/ticket', requirePerm('dola:list'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, message: '任务 id 不合法' });
  const row = db.prepare('SELECT id, is_unwatermarked FROM dola_videos WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, message: '任务不存在' });
  const ticket = issueStreamTicket(id, req.user?.id ?? null);
  const base = `/api/media/stream/${ticket}`;
  res.json({
    ok: true,
    ticket,
    expirySec: Math.floor(STREAM_TTL_MS / 1000),
    isUnwatermarked: Boolean(row.is_unwatermarked),
    /** 播放在线看/拖进度条 */
    streamUrl: base,
    /** 存盘（服务端加 Content-Disposition） */
    downloadUrl: `${base}?download=1`,
    /** 本地归档丢了时，先带这个地址点一次触发抢存 */
    refreshUrl: `${base}?refresh=1&download=1`,
  });
});

/**
 * GET /api/media/stream/:ticket —— 凭证通道（**不带 requirePerm，凭证本身就是鉴权**）。
 *
 * 注意这里**不能**加 `requirePerm`：`<video>` 发来的请求没有 Authorization 头，
 * 加了就永远 403。安全性由「凭证随机 144 bit + 2 分钟 + 绑定单个视频」保证。
 * 每一次使用都写审计，事后能查「谁在什么时候把哪条成片拖走了」。
 */
router.get('/stream/:ticket', serveGuard(async (req, res) => {
  const rec = resolveStreamTicket(req.params.ticket);
  if (!rec) {
    return res.status(403).json({ ok: false, message: '播放凭证已过期，请刷新页面重试。' });
  }
  if (String(req.query.download || '') === '1') {
    audit(req, 'media.download', 'dola_video', rec.videoId, '经播放凭证下载');
  }
  return serveVideoById(req, res, rec.videoId);
}));

/** POST /api/media/library/:id/archive —— 只补归档，不下载（批量修「有直链没文件」用） */
router.post('/library/:id/archive', requirePerm('dola:check'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = db.prepare(`SELECT id, is_unwatermarked, local_path, unwatermarked_url, watermarked_url
                              FROM dola_videos WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ ok: false, message: '任务不存在' });
    if (fileExistsSync(row.local_path)) {
      return res.json({ ok: true, already: true, path: row.local_path, message: '本地归档已存在，无需重抓' });
    }
    const src = row.unwatermarked_url || row.watermarked_url;
    if (!src) return res.status(400).json({ ok: false, message: '该任务没有任何成片直链，无法归档' });

    const useUw = Boolean(row.unwatermarked_url);
    const r = await archiveTo(id, src, { unwatermarked: useUw });
    if (!r.path) {
      audit(req, 'media.archive', 'dola_video', id, `补归档失败：${r.failed}${r.http ? ` HTTP ${r.http}` : ''}`);
      // 与 serveVideoById 用同一句提示 —— 同一类故障在不同入口给出不同说法，
      // 会让人以为是两个问题，白查一遍
      return res.status(410).json({ ok: false, gone: r.failed === 'gone', message: refreshHint(r) });
    }
    db.prepare(`UPDATE dola_videos
                   SET local_path = ?, local_bytes = ?, is_unwatermarked = CASE WHEN ? = 1 THEN 1 ELSE is_unwatermarked END,
                       updated_at = ?
                 WHERE id = ?`)
      .run(r.path, r.bytes, useUw ? 1 : 0, now(), id);
    audit(req, 'media.archive', 'dola_video', id, `补归档成功 ${(r.bytes / 1048576).toFixed(2)} MiB`);
    return res.json({ ok: true, path: r.path, bytes: r.bytes, isUnwatermarked: useUw });
  } catch (e) {
    return res.status(500).json({ ok: false, message: `归档失败：${e.message}` });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// ③ 账号选择器（给「会话成片」用）
// ───────────────────────────────────────────────────────────────────────────

/**
 * GET /api/media/accounts —— 只回「能不能用 / 有没有代理」，**绝不回 cookie**。
 *
 * 为什么不复用 `/api/dola/accounts`：那个接口属于另一条开发线的文件，
 * 而且它返回的字段面很大（含 cookie 名称等）。这里只要一个下拉框的数据，
 * 自己查一行就够了，也顺带避免把 cookie 相关字段扩散到新页面。
 */
router.get('/accounts', requirePerm('dola:list'), (_req, res) => {
  const rows = db.prepare(`SELECT id, label, status, membership, cooldown_until,
                                  CASE WHEN proxy IS NOT NULL AND proxy <> '' THEN 1 ELSE 0 END AS has_proxy,
                                  CASE WHEN cookie IS NOT NULL AND cookie <> '' THEN 1 ELSE 0 END AS has_cookie,
                                  exit_ip, last_used_at
                             FROM dola_accounts ORDER BY id`).all();
  res.json({
    ok: true,
    items: rows.map((r) => ({
      id: r.id,
      label: r.label || `#${r.id}`,
      status: r.status,
      membership: r.membership || '',
      hasProxy: Boolean(r.has_proxy),
      hasCookie: Boolean(r.has_cookie),
      exitIp: r.exit_ip || '',
      cooling: Boolean(r.cooldown_until && String(r.cooldown_until) > now()),
      lastUsedAt: r.last_used_at || '',
    })),
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ④ 列出会话成片（只读，不写库）
// ───────────────────────────────────────────────────────────────────────────

/**
 * POST /api/media/conversation/scan
 * body: { accountId, conversationId }
 *
 * 只读：拉一次消息链 → 解析无水印 → 返回清单。**不写任何表。**
 *
 * 这一步的成本几乎为零（不消耗生成额度），所以它同时也是
 * 「不花额度的端到端验证」手段 —— 账号额度烧完了也能用它确认链路好不好。
 *
 * 权限用 `dola:check`：它会发一次真实出站请求到上游，
 * 语义上属于「操作」而不是「查看」（与 `accounts/proxy/verify` 的判断一致）。
 */
router.post('/conversation/scan', requirePerm('dola:check'), async (req, res) => {
  try {
    const accountId = Number(req.body?.accountId);
    const conversationId = String(req.body?.conversationId || '').trim();
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return res.status(400).json({ ok: false, message: '请选择账号' });
    }
    if (!conversationId) return res.status(400).json({ ok: false, message: '请填会话 id' });

    const acc = db.prepare('SELECT id, label, cookie, proxy FROM dola_accounts WHERE id = ?').get(accountId);
    if (!acc) return res.status(404).json({ ok: false, message: '账号不存在' });
    if (!acc.cookie) return res.status(400).json({ ok: false, message: '该账号没有 cookie，无法读取会话' });

    const cookies = parseCookies(acc.cookie);
    const proxy = String(acc.proxy || '').trim() || null;

    // 规矩 2：必须用账号自己的代理，否则同一账号从两个 IP 出现
    const chain = await pullChain(conversationId, cookies, { limit: 50, proxy });
    if (!chain?.json) {
      return res.status(502).json({
        ok: false,
        message: `读不到会话（HTTP ${chain?.status ?? '—'}）。可能是会话 id 写错、cookie 过期，或账号的代理不通。`,
        hint: String(chain?.text || '').slice(0, 300),
      });
    }

    const uw = await extractUnwatermarked(chain.json, chain.text, { cookies, proxy });

    // 带水印直链：从原始报文里正则兜底扫（与 import-conv.mjs 同一条规则）
    const flat = String(chain.text).replace(/\\\//g, '/');
    const watermarked = [...new Set([...flat.matchAll(/https?:\/\/[^"\\\s]{20,240}?(?:\.mp4|video\/tos)[^"\\\s]{0,160}/g)].map((m) => m[0]))];

    // 已经补录过的（按会话 + 直链指纹去重，见下）
    const existing = db.prepare(`SELECT id, watermarked_url, unwatermarked_url, is_unwatermarked
                                   FROM dola_videos WHERE conversation_id = ?`).all(conversationId);
    const existingIds = new Set();
    for (const e of existing) {
      if (e.watermarked_url) existingIds.add(`wm:${e.watermarked_url}`);
      if (e.unwatermarked_url) existingIds.add(`uw:${e.unwatermarked_url}`);
    }

    // 把无水印结果按「第几条」对齐 —— 截图里那个面板就是「视频 1 / 视频 2」的形态
    const items = uw.videos.map((v, i) => {
      const wm = watermarked[i] || null;
      return {
        index: i,
        label: `视频 ${i + 1}`,
        unwatermarkedUrl: v.url,
        watermarkedUrl: wm,
        tokenForm: v.tokenForm || '',
        bitrate: v.bitrate ?? null,
        unwatermarkedPreview: maskUrl(v.url),
        watermarkedPreview: maskUrl(wm),
        alreadyImported: existingIds.has(`uw:${v.url}`) || (wm ? existingIds.has(`wm:${wm}`) : false),
      };
    });

    // 解析到了无水印、但没扫到带水印直链的也列出来，别让成片凭空消失
    if (!items.length) {
      watermarked.forEach((wm, i) => items.push({
        index: i, label: `视频 ${i + 1}`,
        unwatermarkedUrl: null, watermarkedUrl: wm,
        tokenForm: '', bitrate: null,
        unwatermarkedPreview: '', watermarkedPreview: maskUrl(wm),
        alreadyImported: existingIds.has(`wm:${wm}`),
      }));
    }

    const account = { id: acc.id, label: acc.label || `#${acc.id}`, hasProxy: Boolean(proxy) };
    const ticket = putScanTicket({
      accountId: acc.id, accountLabel: account.label,
      conversationId,
      items: items.map(({ index, label, unwatermarkedUrl, watermarkedUrl, tokenForm, alreadyImported }) =>
        ({ index, label, unwatermarkedUrl, watermarkedUrl, tokenForm, alreadyImported })),
    });

    audit(req, 'media.scan', 'dola_conversation', conversationId,
      `账号 ${account.label}：找到 ${items.length} 条（无水印 ${uw.videos.length} 条）`);

    res.json({
      ok: true,
      ticket,
      /** 凭证有效期。**必须回给前端** —— 让它自己算倒计时，
       *  否则前端只能硬编码一个 600，服务端改 TTL 就会两边不一致。 */
      expirySec: Math.floor(SCAN_TTL_MS / 1000),
      conversationId,
      account,
      usedProxy: Boolean(proxy),
      count: items.length,
      unwatermarkedCount: uw.videos.length,
      /**
       * 直链**明文给出**（见文件头规矩 3：后台本来就可以绕计费）。
       * `*Preview` 只是给表格做紧凑展示用的，别拿它当权限边界。
       * ⚠️ 这些链接**带签名会过期**（URL 里的 `dy_q` 就是过期时间，几小时到几天）。
       *    要长期可用必须走补录的「同时归档到本地」。
       */
      items,
      attempts: (uw.attempts || []).map((a) => ({ ok: a.ok, reason: a.reason || '', http: a.http ?? null, api: maskUrl(a.api) })),
      note: proxy ? '' : '⚠️ 该账号没有配代理，本次是走服务器机房出口读的会话 —— 多账号场景下这本身是个风控信号。',
      linkHint: '直链带签名会过期（几小时到几天）。要长期可用请勾选「同时归档到本地」再补录。',
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: `扫描失败：${e.message}` });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// ⑤ 补录入库（带归档）
// ───────────────────────────────────────────────────────────────────────────

/**
 * POST /api/media/conversation/import
 * body: { ticket, indexes: [0,1], prompt?, ratio?, seconds?, ownerTokenId?, archive?: true }
 *
 * 从 ticket 取真直链（前端拿不到），逐条落库 + 可选归档。
 *
 * **逐条独立成败，不做整体事务**：补录 5 条里有 2 条已存在、1 条直链过期时，
 * 剩下的 2 条不该跟着失败。操作员需要看到「哪条进去了、哪条没有、为什么」。
 * （这一点和资金类操作相反 —— 那里必须全或全无，这里必须尽量多成。）
 */
router.post('/conversation/import', requirePerm('dola:create'), async (req, res) => {
  try {
    const rec = takeScanTicket(req.body?.ticket);
    if (!rec) {
      return res.status(410).json({
        ok: false,
        message: '会话凭证已过期或服务刚重启过（扫描结果不落盘，这是有意的）。请重新扫描一次。',
      });
    }

    const wanted = Array.isArray(req.body?.indexes) && req.body.indexes.length
      ? new Set(req.body.indexes.map(Number).filter(Number.isInteger))
      : new Set(rec.items.map((i) => i.index));

    const prompt = String(req.body?.prompt || '').trim();
    const ratio = String(req.body?.ratio || '16:9').trim() || '16:9';
    const seconds = Number.parseInt(req.body?.seconds, 10) || 10;
    const doArchive = req.body?.archive !== false; // 默认归档：不归档就等于留了个会过期的死链
    const ownerTokenId = Number.parseInt(req.body?.ownerTokenId, 10);

    let owner = null;
    if (Number.isInteger(ownerTokenId)) {
      owner = db.prepare('SELECT id, prefix FROM tokens WHERE id = ?').get(ownerTokenId);
      if (!owner) return res.status(400).json({ ok: false, message: '指定的归属令牌不存在' });
    }

    const results = [];
    for (const item of rec.items) {
      if (!wanted.has(item.index)) continue;
      const uwUrl = item.unwatermarkedUrl || null;
      const wmUrl = item.watermarkedUrl || null;

      if (!uwUrl && !wmUrl) {
        results.push({ index: item.index, ok: false, status: 'skipped', message: '这条既没有无水印源也没有带水印直链' });
        continue;
      }

      // 幂等：同一会话 + 同一个直链不重复录（重复录会让成片库出现并排的两条）
      const dup = db.prepare(`SELECT id FROM dola_videos
                               WHERE conversation_id = ?
                                 AND ((? <> '' AND unwatermarked_url = ?) OR (? <> '' AND watermarked_url = ?))
                               LIMIT 1`)
        .get(rec.conversationId, uwUrl || '', uwUrl || '', wmUrl || '', wmUrl || '');
      if (dup) {
        results.push({ index: item.index, ok: true, status: 'duplicate', id: dup.id, message: `已存在（任务 #${dup.id}），跳过` });
        continue;
      }

      const isUw = Boolean(uwUrl);
      const note = isUw
        ? `会话 ${rec.conversationId} 补录（无水印解析成功${item.tokenForm ? `，${item.tokenForm}` : ''}）`
        : `会话 ${rec.conversationId} 补录（只拿到带水印源）`;

      // 先落库拿到 id，再用 id 命名归档文件 —— 和 generator.js 的命名约定一致，
      // 这样用户工作台的 /api/gateway/gen/:id/file 也能直接下到它。
      const info = db.prepare(`INSERT INTO dola_videos
        (account_id, account_label, conversation_id, prompt, ratio, seconds, status, stage,
         watermarked_url, unwatermarked_url, unwatermark_note, is_unwatermarked,
         owner_token_id, owner_prefix, charge_ref, created_at, updated_at, finished_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          rec.accountId, rec.accountLabel, rec.conversationId, prompt, ratio, seconds,
          'ready', '补录（已完成）',
          wmUrl, uwUrl, note, isUw ? 1 : 0,
          owner?.id ?? null, owner?.prefix ?? '',
          '', now(), now(), now(),
        );
      const videoId = Number(info.lastInsertRowid);

      let archived = null;
      if (doArchive) {
        const r = await archiveTo(videoId, uwUrl || wmUrl, { unwatermarked: isUw });
        if (r.path) {
          db.prepare('UPDATE dola_videos SET local_path = ?, local_bytes = ?, bytes = ?, updated_at = ? WHERE id = ?')
            .run(r.path, r.bytes, r.bytes, now(), videoId);
          archived = { bytes: r.bytes };
        } else {
          // 归档失败**不算补录失败** —— 直链当次还有效，只是本地没留底
          db.prepare('UPDATE dola_videos SET unwatermark_note = ?, updated_at = ? WHERE id = ?')
            .run(`${note}；⚠️ 归档失败（${r.failed === 'gone' ? '直链已过期' : r.note || '网络异常'}）`, now(), videoId);
        }
      }

      results.push({
        index: item.index, ok: true, status: 'imported', id: videoId,
        isUnwatermarked: isUw,
        isUw,
        archived: Boolean(archived),
        bytes: archived?.bytes ?? null,
        message: archived ? `已补录为任务 #${videoId} 并完成归档` : `已补录为任务 #${videoId}（未归档）`,
      });
    }

    const imported = results.filter((r) => r.status === 'imported').length;
    const dup = results.filter((r) => r.status === 'duplicate').length;
    audit(req, 'media.import', 'dola_conversation', rec.conversationId,
      `账号 ${rec.accountLabel}：新录 ${imported} 条，已存在 ${dup} 条`);
    res.json({ ok: true, conversationId: rec.conversationId, imported, duplicate: dup, results });
  } catch (e) {
    return res.status(500).json({ ok: false, message: `补录失败：${e.message}` });
  }
});

/**
 * GET /api/media/tokens —— 给补录选「归属令牌」用。
 * 只回 id / 前缀 / 备注 / 状态，**绝不回令牌值**（那要 `token:reveal`，见 rbac）。
 */
router.get('/tokens', requirePerm('dola:list'), (_req, res) => {
  const rows = db.prepare('SELECT id, name, prefix, note, status, points FROM tokens ORDER BY id').all();
  res.json({
    ok: true,
    items: rows.map((r) => ({ id: r.id, name: r.name || '', prefix: r.prefix || '', note: r.note || '', status: r.status, points: r.points })),
  });
});

export default router;
