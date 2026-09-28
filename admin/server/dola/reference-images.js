/**
 * Shared reference-image validation for the admin gateway path.
 *
 * Limits mirror mvp/src/providers/dola-api.js so the user-facing workbench and
 * the control-plane gateway reject the same payloads before any charge.
 *
 * No Dola private upload API is guessed here — validated buffers are only
 * staged to disk for Playwright setInputFiles on a real input[type=file].
 *
 * ★★ 2026-09-28 改动（A + D，起因：飞哥上传 GIF 提交失败）
 * ==================================================================
 * 背景：校验是**逐张串行 + 遇错即抛**（`validateReferenceImages` 的 for 循环里
 * `await readImage()` 一抛就结束整个函数）。所以只要 9 张里有 1 张 GIF，
 * **后面 8 张正常 PNG 连检查的机会都没有，整批全废**。
 * 现场证据：`admin.fei85.cn.log` 里 08:43–08:44 连续 4 次 `POST /v1/videos`
 * 返回 400（响应体 141 字节 = 128 固定 + 13 字节文件名），08:47 去掉 GIF 后 202 成功。
 *
 *   D. **GIF 自动取首帧转 PNG** —— 参考图本来也不需要动图，所以看到 GIF 就
 *      用系统 ffmpeg 抽第一帧转成 PNG 再走正常校验，不再连坐其它 8 张。
 *   A. **报错说人话** —— 以前一律「参考图不是有效的 JPG/JPEG/PNG」，
 *      用户看到只会反复重试（飞哥就连试了 4 次）。现在会**指明文件 + 格式 +
 *      具体转换建议**（WEBP / HEIC / AVIF / BMP 各有各的说法）。
 *
 * ⚠️ 转码用**系统 ffmpeg，不引新依赖**。服务器实测：`/usr/bin/ffmpeg`（7.0.2）。
 *    路径探测顺序与 `dola/media-probe.js` 找 ffprobe 的口径一致：
 *    环境变量 `FFMPEG_PATH` → 常见绝对路径。找不到就**明确报错，不静默降级**。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { accessSync, constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';

export const IMAGE_MAX_COUNT = 9;
export const IMAGE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const REQUEST_MAX_BYTES = 22 * 1024 * 1024;
export const IMAGE_MAX_SIDE = 8_192;
export const IMAGE_MAX_PIXELS = 40_000_000;

/** GIF 原始体积上限。防「超大动图 → 写巨量临时文件 → ffmpeg 卡住」这条路。 */
export const GIF_MAX_RAW_BYTES = 20 * 1024 * 1024;

/** ffmpeg 单次转码超时。抽一帧是毫秒级的事，15 秒已经很宽。 */
const FFMPEG_TIMEOUT_MS = 15_000;

/**
 * Short DOM evidence appended to probe notes (accept / multiple / name).
 * Keeps notes under ~300 chars when sliced by the caller.
 */
export function referenceImageEvidenceNote(imageInputs = []) {
  const list = Array.isArray(imageInputs) ? imageInputs : [];
  if (!list.length) return '';
  const bits = list.slice(0, 3).map((input, index) => {
    const accept = String(input?.accept || '').slice(0, 40);
    const multiple = input?.multiple ? 'multi' : 'single';
    const name = String(input?.name || input?.id || `input${index + 1}`).slice(0, 24);
    return `${name}:${accept || 'image/*'}:${multiple}`;
  });
  return `；证据 ${bits.join(' | ')}`;
}


// ---------------------------------------------------------------- 格式嗅探

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 按**文件头魔数**判断真实格式（不看扩展名 —— 改个后缀就能绕过扩展名检查）。
 *
 * 为什么必须靠魔数：飞哥那张 GIF 的文件名是中文（`参考图.gif` = 13 字节），
 * 我们的诊断正是从**响应体字节数** 141 = 128 + 13 反推出来的。
 *
 * @returns {'png'|'jpeg'|'gif'|'webp'|'avif'|'heic'|'bmp'|'unknown'}
 */
export function sniffImageFormat(buf) {
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

/**
 * A 的核心：每种不支持的格式给一句**能照着做**的话，而不是一句笼统的
 * 「不是有效的 JPG/JPEG/PNG」—— 后者会让用户以为文件坏了，于是反复重试。
 */
const FORMAT_HINT = Object.freeze({
  webp: '暂不支持 WEBP 格式，请先转成 PNG 或 JPG 再上传',
  avif: '暂不支持 AVIF 格式，请先转成 PNG 或 JPG 再上传',
  heic: '暂不支持 HEIC 格式（iPhone 相册默认格式），请在相册里导出成 JPG 再上传',
  bmp: '暂不支持 BMP 格式，请先转成 PNG 再上传',
  gif: 'GIF 未被预处理（内部错误），请重新上传',
  unknown: '这不是有效的图片文件，请上传 JPG 或 PNG',
});


// ---------------------------------------------------------------- ffmpeg

let ffmpegResolved = false;
let ffmpegBin = null;

/**
 * 找 ffmpeg。与 `dola/media-probe.js` 找 ffprobe 的口径一致：
 * 环境变量优先，然后常见绝对路径。
 *
 * ⚠️ 刻意**不做**「找不到就跳过 GIF」这种静默降级 —— 那会让人以为改动生效了
 *    （不再报格式错），实际 GIF 还是进不去，排查起来更难。
 */
export function resolveFfmpeg() {
  if (ffmpegResolved) return ffmpegBin;
  ffmpegResolved = true;
  const candidates = [
    process.env.FFMPEG_PATH,
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      ffmpegBin = candidate;
      break;
    } catch { /* 试下一个 */ }
  }
  return ffmpegBin;
}

/** execFile 的 Promise 包装：把 stderr 挂到 error 上，错误信息才够定位。 */
function execFileP(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr || '') }));
      else resolve({ stdout, stderr });
    });
  });
}

/** 换扩展名（GIF 转成 PNG 后文件名也要跟着改，否则下游按名字判断会误判）。 */
function swapExtension(name, ext) {
  const base = path.basename(String(name || '').replace(/[/\\]/g, ''));
  if (!base) return `reference${ext}`;
  return base.replace(/\.[A-Za-z0-9]+$/, '') + ext;
}

/**
 * D 的核心：GIF → 第一帧 PNG。
 *
 * 为什么落临时文件而不是走 stdin/stdout 管道：ffmpeg 读 GIF 这种带全局调色板的
 * 容器时需要 seek 回头读，管道会让它退化甚至失败。临时文件最稳。
 *
 * 失败时抛的是**带具体建议**的 400（A），不是裸的 ffmpeg 报错。
 */
export async function gifFirstFrameToPng(buf, name = 'reference.gif') {
  const bin = resolveFfmpeg();
  if (!bin) {
    throw Object.assign(
      new Error(`参考图「${name}」是 GIF 动图，但服务器上没有可用的 ffmpeg，无法自动转成静态图。请先把它转成 PNG 或 JPG 再上传`),
      { status: 400, code: 'REFERENCE_IMAGE_INVALID' },
    );
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refgif-'));
  const src = path.join(dir, 'in.gif');
  const dst = path.join(dir, 'out.png');
  try {
    await fs.writeFile(src, buf);
    await execFileP(bin, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', src,
      '-frames:v', '1',
      dst,
    ], { timeout: FFMPEG_TIMEOUT_MS });

    const png = await fs.readFile(dst);
    if (!png.length) throw new Error('ffmpeg 输出为空');
    // 转出来的 PNG 继续走正常校验（尺寸 / 像素上限对新图同样生效）。
    return inspectImage(png, swapExtension(name, '.png'));
  } catch (e) {
    if (e && e.code === 'REFERENCE_IMAGE_INVALID') throw e;
    // 清洗 ffmpeg 的报错：去掉 `[模块 @ 0x内存地址]` 前缀，只留人看得懂的那半句。
    const raw = String((e && e.stderr) || (e && e.message) || e);
    const detail = raw
      .replace(/\[[^\]]{0,40}@\s*0x[0-9a-f]+\]\s*/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90);
    throw Object.assign(
      new Error(`参考图「${name}」是 GIF 动图，但首帧提取失败${detail ? `（${detail}）` : ''}。这可能是损坏的动图，建议转成 PNG 或 JPG 后重新上传`),
      { status: 400, code: 'REFERENCE_IMAGE_INVALID' },
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}


// ---------------------------------------------------------------- 校验

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

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

/**
 * 校验**单个**已解码的 buffer。只接受 PNG / JPEG。
 *
 * ⚠️ GIF 不在这里处理（它需要 async 转码），入口在 `readImage()`。
 *    这里保留 gif 分支，只是为了在有人绕过 readImage 直接调用时给个明确信号。
 *
 * A：所有失败文案都带上「文件名」和「怎么办」，别让用户靠猜。
 */
export function inspectImage(buf, name) {
  const format = sniffImageFormat(buf);
  const mime = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : null;
  if (!mime) {
    const hint = FORMAT_HINT[format] || FORMAT_HINT.unknown;
    throw Object.assign(new Error(`参考图「${name || '未命名文件'}」无法使用：${hint}`), {
      status: 400,
      code: 'REFERENCE_IMAGE_INVALID',
    });
  }

  const dimensions = imageDimensions(buf, mime);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
    throw Object.assign(new Error(`无法读取参考图尺寸：「${name || '未命名文件'}」`), {
      status: 400,
      code: 'REFERENCE_IMAGE_INVALID',
    });
  }
  if (dimensions.width > IMAGE_MAX_SIDE || dimensions.height > IMAGE_MAX_SIDE) {
    throw Object.assign(
      new Error(`参考图「${name || '未命名文件'}」单边 ${Math.max(dimensions.width, dimensions.height)}px，超过 ${IMAGE_MAX_SIDE}px 上限，请先缩小再上传`),
      { status: 400, code: 'REFERENCE_IMAGE_TOO_LARGE' },
    );
  }
  if (dimensions.width * dimensions.height > IMAGE_MAX_PIXELS) {
    throw Object.assign(
      new Error(`参考图「${name || '未命名文件'}」共 ${(dimensions.width * dimensions.height).toLocaleString()} 像素，超过 ${IMAGE_MAX_PIXELS.toLocaleString()} 上限，请先缩小再上传`),
      { status: 400, code: 'REFERENCE_IMAGE_TOO_LARGE' },
    );
  }

  const original = path.basename(String(name || '').replace(/[/\\]/g, ''));
  const fallback = mime === 'image/jpeg' ? 'reference.jpg' : 'reference.png';
  const filename = original || fallback;
  return { buf, mime, filename, width: dimensions.width, height: dimensions.height };
}

/**
 * Accept path string / Buffer / Uint8Array / { dataBase64|data, name }.
 * Same shapes the mvp workbench and dola-api provider already use.
 *
 * ★ D 的入口：拿到 buffer 后先嗅格式，是 GIF 就先转成 PNG 首帧再校验。
 *   这样 GIF 不会因为「排在第几张」而决定整批的生死。
 */
export async function readImage(input, index) {
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
    throw Object.assign(new Error(`第 ${index + 1} 张参考图格式不受支持`), {
      status: 400,
      code: 'REFERENCE_IMAGE_INVALID',
    });
  }

  if (sniffImageFormat(buf) === 'gif') {
    if (buf.length > GIF_MAX_RAW_BYTES) {
      throw Object.assign(
        new Error(`参考图「${name}」是 GIF，原始体积 ${(buf.length / 1048576).toFixed(1)} MiB，超过 ${GIF_MAX_RAW_BYTES / 1048576} MiB 上限，请先转成 PNG 再上传`),
        { status: 400, code: 'REFERENCE_IMAGE_LIMIT' },
      );
    }
    return gifFirstFrameToPng(buf, name);
  }

  return inspectImage(buf, name);
}

/**
 * Validate a list of reference images before charge / task creation.
 * @returns {Promise<Array<{buf:Buffer,mime:string,filename:string,width:number,height:number}>>}
 */
export async function validateReferenceImages(images, { prompt = '' } = {}) {
  if (images == null) return [];
  if (!Array.isArray(images)) {
    throw Object.assign(new Error('images 必须是数组'), { status: 400, code: 'REFERENCE_IMAGE_INVALID' });
  }
  if (!images.length) return [];
  if (images.length > IMAGE_MAX_COUNT) {
    throw Object.assign(new Error(`参考图片最多 ${IMAGE_MAX_COUNT} 张（当前 ${images.length} 张）`), {
      status: 400,
      code: 'REFERENCE_IMAGE_LIMIT',
    });
  }

  const inspected = [];
  let totalBytes = 0;
  for (const [index, image] of images.entries()) {
    const item = await readImage(image, index);
    inspected.push(item);
    totalBytes += item.buf.length;
  }
  if (totalBytes > IMAGE_MAX_TOTAL_BYTES) {
    throw Object.assign(
      new Error(`参考图合计 ${(totalBytes / 1048576).toFixed(1)} MiB，超过 20 MiB 上限`),
      { status: 400, code: 'REFERENCE_IMAGE_LIMIT' },
    );
  }
  const estimatedRequestBytes = totalBytes
    + Buffer.byteLength(String(prompt || ''), 'utf8')
    + 4096
    + inspected.reduce((sum, item) => sum + Buffer.byteLength(item.filename) + 128, 0);
  if (estimatedRequestBytes > REQUEST_MAX_BYTES) {
    throw Object.assign(new Error('整个请求预计超过 22 MiB 上限'), {
      status: 400,
      code: 'REFERENCE_IMAGE_LIMIT',
    });
  }
  return inspected;
}
