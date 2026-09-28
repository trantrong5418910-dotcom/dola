/**
 * Dola API provider —— 对接《新Dola_API接口说明.md》里的 Bearer Token 接口。
 *
 * 这套接口和 dola-workbench 不是同一个认证契约：
 *   - 新接口：Authorization: Bearer <token>，默认 https://43.254.166.196
 *   - 老接口：Cookie + CSRF，默认 https://43.254.166.145
 *
 * 因此这里单独实现，不把新接口的假设混进已经抓包验证过的旧 provider。
 * 代码只按文档声明的 30 秒能力提交，任何其他秒数在本地直接拒绝。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { accessSync, constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { HttpClient } from '../core/http.js';
import { normalizeTask, extractTaskId, Status } from '../core/task.js';
import { AuthError, BusinessError, VideoProviderError } from '../core/errors.js';

export const BASE_URL = 'https://43.254.166.196';
export const RATIOS = ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'];
export const FIXED_SECONDS = 30;
export const PROMPT_MAX = 3_000;
export const IMAGE_MAX_COUNT = 9;
export const IMAGE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const REQUEST_MAX_BYTES = 22 * 1024 * 1024;
export const IMAGE_MAX_SIDE = 8_192;
export const IMAGE_MAX_PIXELS = 40_000_000;

const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]+$/;
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

// ---------------------------------------------------------------- GIF → PNG 首帧
// ★ 2026-09-28 同步（与 admin/server/dola/reference-images.js 同一口径）：
//   原来一张 GIF 会让整批 9 张参考图全部被拒（校验逐张串行、遇错即抛）。
//   现在 GIF 用系统 ffmpeg 抽首帧转 PNG 再走正常校验，不再连坐其它 8 张。
//   ⚠️ 本文件有意保持独立（见文件头），所以这里**复制**一份实现，而不是 import admin 那份。
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniffImageFormat(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return 'unknown';
  if (buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  const six = buf.subarray(0, 6).toString('latin1');
  if (six === 'GIF87a' || six === 'GIF89a') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1').toLowerCase();
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'avif';
    if (brand.startsWith('heic') || brand.startsWith('heix')
      || brand.startsWith('hevc') || brand.startsWith('mif1')) return 'heic';
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return 'unknown';
}

const FORMAT_HINT = Object.freeze({
  webp: '暂不支持 WEBP 格式，请先转成 PNG 或 JPG 再上传',
  avif: '暂不支持 AVIF 格式，请先转成 PNG 或 JPG 再上传',
  heic: '暂不支持 HEIC 格式（iPhone 相册默认格式），请在相册里导出成 JPG 再上传',
  bmp: '暂不支持 BMP 格式，请先转成 PNG 再上传',
  gif: 'GIF 未被预处理（内部错误），请重新上传',
  unknown: '这不是有效的图片文件，请上传 JPG 或 PNG',
});

let ffmpegResolved = false;
let ffmpegBin = null;

function resolveFfmpeg() {
  if (ffmpegResolved) return ffmpegBin;
  ffmpegResolved = true;
  const candidates = [
    process.env.FFMPEG_PATH,
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { accessSync(candidate, fsConstants.X_OK); ffmpegBin = candidate; break; } catch { /* 下一个 */ }
  }
  return ffmpegBin;
}

function execFileP(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr || '') }));
      else resolve({ stdout, stderr });
    });
  });
}

function swapExtension(name, ext) {
  const base = path.basename(String(name || '').replace(/[/\\]/g, ''));
  if (!base) return `reference${ext}`;
  return base.replace(/\.[A-Za-z0-9]+$/, '') + ext;
}

async function gifFirstFrameToPng(buf, name = 'reference.gif') {
  const bin = resolveFfmpeg();
  if (!bin) {
    throw new VideoProviderError(`参考图「${name}」是 GIF 动图，但服务器上没有可用的 ffmpeg，无法自动转成静态图。请先把它转成 PNG 或 JPG 再上传`);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refgif-'));
  const src = path.join(dir, 'in.gif');
  const dst = path.join(dir, 'out.png');
  try {
    await fs.writeFile(src, buf);
    await execFileP(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', dst], { timeout: 15_000 });
    const png = await fs.readFile(dst);
    if (!png.length) throw new Error('ffmpeg 输出为空');
    return inspectImage(png, swapExtension(name, '.png'));
  } catch (e) {
    const raw = String((e && e.stderr) || (e && e.message) || e);
    const detail = raw.replace(/\[[^\]]{0,40}@\s*0x[0-9a-f]+\]\s*/gi, '').replace(/\s+/g, ' ').trim().slice(0, 90);
    throw new VideoProviderError(`参考图「${name}」是 GIF 动图，但首帧提取失败${detail ? `（${detail}）` : ''}。这可能是损坏的动图，建议转成 PNG 或 JPG 后重新上传`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function jsonOrNull(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function responseError({ status, headers, json, text, url }) {
  const message = json?.message || `HTTP ${status}`;
  const raw = json ?? text?.slice(0, 2000) ?? null;
  const opts = { code: json?.code ?? null, status, url, raw };
  const error = status === 401 || /令牌无效|令牌已禁用|未授权|token is invalid|unauthorized/i.test(message)
    ? new AuthError(message, opts)
    : new BusinessError(message, opts);
  const retryAfter = headers?.get?.('retry-after');
  if (retryAfter != null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) error.retryAfterSeconds = Math.max(0, seconds);
  }
  return error;
}

function imageDimensions(buf, mime) {
  if (mime === 'image/png') {
    if (buf.length < 24) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  if (mime !== 'image/jpeg' || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    while (i < buf.length && buf[i] === 0xff) i += 1;
    const marker = buf[i++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (i + 1 >= buf.length) break;
    const length = buf.readUInt16BE(i);
    if (length < 2 || i + length > buf.length) break;
    if (SOF_MARKERS.has(marker) && i + 7 < buf.length) {
      return {
        height: buf.readUInt16BE(i + 3),
        width: buf.readUInt16BE(i + 5),
      };
    }
    i += length;
  }
  return null;
}

function inspectImage(buf, name) {
  const format = sniffImageFormat(buf);
  const mime = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : null;
  if (!mime) {
    const hint = FORMAT_HINT[format] || FORMAT_HINT.unknown;
    throw new VideoProviderError(`参考图「${name || '未命名文件'}」无法使用：${hint}`);
  }

  const dimensions = imageDimensions(buf, mime);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
    throw new VideoProviderError(`无法读取参考图尺寸：${name || '未命名文件'}`);
  }
  if (dimensions.width > IMAGE_MAX_SIDE || dimensions.height > IMAGE_MAX_SIDE) {
    throw new VideoProviderError(`参考图单边不能超过 ${IMAGE_MAX_SIDE}px：${name || '未命名文件'}`);
  }
  if (dimensions.width * dimensions.height > IMAGE_MAX_PIXELS) {
    throw new VideoProviderError(`参考图像素不能超过 ${IMAGE_MAX_PIXELS.toLocaleString()}：${name || '未命名文件'}`);
  }

  const original = path.basename(String(name || ''));
  const fallback = mime === 'image/jpeg' ? 'reference.jpg' : 'reference.png';
  const filename = original || fallback;
  return { buf, mime, filename, width: dimensions.width, height: dimensions.height };
}

async function readImage(input, index) {
  let buf;
  let name;
  if (typeof input === 'string') {
    buf = await fs.readFile(input);
    name = path.basename(input);
  } else if (Buffer.isBuffer(input)) {
    buf = input;
    name = `image-${index}.png`;
  } else if (input instanceof Uint8Array) {
    buf = Buffer.from(input);
    name = `image-${index}.png`;
  } else if (input && input.dataBase64) {
    buf = Buffer.from(String(input.dataBase64), 'base64');
    name = input.name || `image-${index}.png`;
  } else if (input && input.data) {
    buf = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);
    name = input.name || `image-${index}.png`;
  } else {
    throw new VideoProviderError(`第 ${index + 1} 张参考图格式不受支持`);
  }
  if (sniffImageFormat(buf) === 'gif') {
    return gifFirstFrameToPng(buf, name);
  }
  return inspectImage(buf, name);
}

export class DolaApiProvider {
  constructor({
    baseUrl = BASE_URL,
    credential = null,
    credentialEnv = 'DOLA_API_TOKEN',
    insecure = false,
    timeout = 300_000,
    minPollIntervalMs = 5_000,
    onTrace = null,
  } = {}) {
    this.name = 'dola-api';
    this.baseUrl = String(baseUrl || BASE_URL).replace(/\/+$/, '');
    this.credential = credential ?? process.env[credentialEnv] ?? null;
    this.minPollIntervalMs = minPollIntervalMs;
    this.balance = null;
    this._lastQueryAt = new Map();

    this.http = new HttpClient({
      baseUrl: this.baseUrl,
      timeout,
      insecure,
      onTrace,
    });
    this.http.headerHook = async () => {
      const token = String(this.credential || '').trim();
      return token ? { Authorization: `Bearer ${token}` } : {};
    };
  }

  _requireCredential() {
    const token = String(this.credential || '').trim();
    if (!token) throw new AuthError('缺少 Dola API Bearer Token：请传 credential 或设置 DOLA_API_TOKEN');
    return token;
  }

  async _requestJson(method, url, { body = undefined, headers = {}, allowBusinessFailure = false } = {}) {
    this._requireCredential();
    const response = await this.http.request(method, url, {
      body,
      headers,
      rawResponse: true,
    });
    const json = jsonOrNull(response.text);
    if (response.status < 200 || response.status >= 300) {
      throw responseError({ ...response, json, url });
    }
    if (!json || typeof json !== 'object') {
      throw new BusinessError('Dola API 返回的不是 JSON', {
        status: response.status,
        url,
        raw: response.text?.slice(0, 2000) ?? null,
      });
    }
    if (String(json.code) === '0' && !allowBusinessFailure) {
      throw responseError({ ...response, json, url });
    }
    return json;
  }

  async login(credential = this.credential) {
    const next = String(credential || '').trim();
    if (!next) throw new AuthError('缺少 Dola API Bearer Token：请传 credential 或设置 DOLA_API_TOKEN');
    const previous = this.credential;
    this.credential = next;
    try {
      // 文档没有独立的 session endpoint，用列表接口验证 token。
      const json = await this._requestJson('GET', '/api/v1/videos');
      this.balance = json.balance ?? json.points ?? this.balance;
      return { role: 'user', balance: this.balance, raw: json };
    } catch (error) {
      this.credential = previous;
      throw error;
    }
  }

  /** 新 API 只有部分写接口返回 balance，不能伪造一个实时余额。 */
  async getBalance() {
    this._requireCredential();
    return this.balance;
  }

  async redeemCard(card) {
    this._requireCredential();
    const value = String(card || '').trim();
    if (!value) throw new BusinessError('卡密不能为空');
    const json = await this._requestJson('POST', '/api/v1/cards/redeem', {
      body: { card: value },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    if (json.balance != null) this.balance = json.balance;
    return json;
  }

  async createTask({ prompt, ratio = '16:9', seconds = FIXED_SECONDS, images = [], idempotencyKey = null } = {}) {
    this._requireCredential();
    const text = String(prompt ?? '').trim();
    if (!text) throw new BusinessError('prompt 不能为空');
    if (Array.from(text).length > PROMPT_MAX) {
      throw new BusinessError(`prompt 超过 ${PROMPT_MAX} 个 Unicode 字符上限`);
    }
    if (!RATIOS.includes(String(ratio))) {
      throw new BusinessError(`ratio 必须是 ${RATIOS.join(' / ')} 之一，收到：${ratio}`);
    }
    if (Number(seconds) !== FIXED_SECONDS) {
      throw new BusinessError(`Dola API 固定只支持 ${FIXED_SECONDS} 秒，收到：${seconds}`);
    }
    if (!Array.isArray(images)) throw new BusinessError('images 必须是数组');
    if (images.length > IMAGE_MAX_COUNT) {
      throw new BusinessError(`参考图片最多 ${IMAGE_MAX_COUNT} 张（当前 ${images.length} 张）`);
    }

    const inspected = [];
    let totalBytes = 0;
    for (const [index, image] of images.entries()) {
      const item = await readImage(image, index);
      inspected.push(item);
      totalBytes += item.buf.length;
    }
    if (totalBytes > IMAGE_MAX_TOTAL_BYTES) {
      throw new BusinessError(`参考图合计 ${(totalBytes / 1048576).toFixed(1)} MiB，超过 20 MiB 上限`);
    }
    const estimatedRequestBytes = totalBytes
      + Buffer.byteLength(text, 'utf8')
      + 4096
      + inspected.reduce((sum, item) => sum + Buffer.byteLength(item.filename) + 128, 0);
    if (estimatedRequestBytes > REQUEST_MAX_BYTES) {
      throw new BusinessError('整个 multipart 请求预计超过 22 MiB 上限');
    }

    const key = idempotencyKey ?? randomUUID();
    if (String(key).length < 8 || String(key).length > 128 || !IDEMPOTENCY_RE.test(String(key))) {
      throw new BusinessError('Idempotency-Key 必须是 8–128 位字母、数字或 . _ : -');
    }

    const form = new FormData();
    form.set('prompt', text);
    form.set('ratio', String(ratio));
    form.set('seconds', String(FIXED_SECONDS));
    for (const item of inspected) {
      form.append('images[]', new Blob([item.buf], { type: item.mime }), item.filename);
    }

    const request = () => this._requestJson('POST', '/api/v1/videos', {
      body: form,
      headers: { 'Idempotency-Key': String(key) },
    });
    let json;
    try {
      json = await request();
    } catch (error) {
      // 文档明确要求网络/500/502/504 用相同幂等键重试，不能生成新 key。
      const retryable = error.status == null || [500, 502, 504].includes(error.status);
      if (!retryable) throw error;
      json = await request();
    }

    if (json.balance != null) this.balance = json.balance;
    const taskId = extractTaskId(json);
    if (!taskId) {
      throw new VideoProviderError('创建接口返回成功，但响应里没有 task_id，已停止继续猜测任务编号', { raw: json });
    }
    return {
      taskId,
      via: 'create-response',
      existing: Boolean(json.idempotent_replay || json.existing),
      balance: json.balance ?? null,
      chargedPoints: json.charged_points ?? null,
      raw: json,
    };
  }

  async getTask(taskId) {
    this._requireCredential();
    const id = String(taskId);
    const last = this._lastQueryAt.get(id) ?? 0;
    const wait = this.minPollIntervalMs - (Date.now() - last);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this._lastQueryAt.set(id, Date.now());

    // queued / processing / failed 都可能是 HTTP 200 + code:"0"，这里不能交给
    // 通用 HTTP 层按失败处理，而要继续看 task.status。
    const json = await this._requestJson(
      'GET',
      `/api/v1/videos/${encodeURIComponent(id)}`,
      { allowBusinessFailure: true },
    );
    if (String(json.code) === '0' && !json.task && json.status == null && json.task_id == null) {
      // code:"0" 也可能只是请求失败；没有任何任务状态时不能把它伪装成 unknown 任务。
      throw new BusinessError(json.message || '任务查询失败', {
        code: json.code,
        status: 200,
        url: `/api/v1/videos/${encodeURIComponent(id)}`,
        raw: json,
      });
    }
    const nested = json?.task && typeof json.task === 'object' ? json.task : {};
    const merged = { ...nested };
    const fields = [
      'task_id', 'id', 'status', 'state', 'public_state', 'url', 'video_url', 'result_url',
      'error', 'public_error', 'estimated_wait', 'query_notice', 'charged_points',
      'created_at', 'updated_at', 'billing_state', 'can_delete', 'refreshed',
    ];
    for (const field of fields) {
      if (json?.[field] !== undefined && json[field] !== null && json[field] !== '') {
        merged[field] = json[field];
      }
    }
    // 顶层 message 在处理中通常是提示语，不应被 normalizeTask 误当成 error。
    delete merged.message;
    const t = normalizeTask(merged, { idHint: id });
    if (t.status === Status.FAILED && !t.error) t.error = json?.message ?? null;
    t.notice = t.notice ?? json?.query_notice ?? (
      t.status !== Status.SUCCEEDED && t.status !== Status.FAILED ? json?.message ?? null : null
    );
    t.queryNotice = json?.query_notice ?? null;
    t.raw = json;
    return t;
  }

  async listTasks({ cursor = '', limit = 50 } = {}) {
    this._requireCredential();
    const max = Math.max(1, Math.min(Number(limit) || 50, 100));
    const items = [];
    let next = cursor ? String(cursor) : '';
    while (items.length < max) {
      const query = next ? `?cursor=${encodeURIComponent(next)}` : '';
      const json = await this._requestJson('GET', `/api/v1/videos${query}`);
      const batch = json?.tasks ?? json?.data ?? [];
      if (!Array.isArray(batch)) throw new BusinessError('任务列表响应格式不正确', { raw: json });
      items.push(...batch.map((task) => normalizeTask(task)));
      const candidate = json?.next_cursor ?? null;
      if (!candidate || candidate === next || batch.length === 0) {
        next = candidate ?? null;
        break;
      }
      next = String(candidate);
    }
    return { items: items.slice(0, max), nextCursor: next || null };
  }

  async deleteTask(taskId) {
    const json = await this._requestJson('DELETE', `/api/v1/videos/${encodeURIComponent(taskId)}`);
    return { ok: true, raw: json };
  }

  async download(task, destPath) {
    const id = typeof task === 'string' ? task : task.id;
    const t = typeof task === 'string' ? await this.getTask(task) : task;
    if (!t?.url) throw new VideoProviderError(`任务 ${id} 还没有视频直链，当前状态：${t?.status ?? 'unknown'}`);

    const finalPath = destPath ?? path.join(process.cwd(), `${id}.mp4`);
    await fs.mkdir(path.dirname(path.resolve(finalPath)), { recursive: true });
    const url = new URL(t.url, this.baseUrl).toString();
    // 文档说明成功后的 url 是可直接下载的短时直链，不把 Bearer Token 泄漏给媒体域名。
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new VideoProviderError(`下载失败 HTTP ${response.status}`, { status: response.status, url });
    const buf = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(finalPath, buf);
    return { filePath: finalPath, bytes: buf.length, contentType: response.headers.get('content-type') };
  }
}
