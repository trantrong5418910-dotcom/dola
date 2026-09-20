/**
 * Shared reference-image validation for the admin gateway path.
 *
 * Limits mirror mvp/src/providers/dola-api.js so the user-facing workbench and
 * the control-plane gateway reject the same payloads before any charge.
 *
 * No Dola private upload API is guessed here — validated buffers are only
 * staged to disk for Playwright setInputFiles on a real input[type=file].
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const IMAGE_MAX_COUNT = 9;
export const IMAGE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const REQUEST_MAX_BYTES = 22 * 1024 * 1024;
export const IMAGE_MAX_SIDE = 8_192;
export const IMAGE_MAX_PIXELS = 40_000_000;

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

export function inspectImage(buf, name) {
  const isPng = buf.length >= 24
    && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const mime = isPng ? 'image/png' : isJpeg ? 'image/jpeg' : null;
  if (!mime) {
    throw Object.assign(new Error(`参考图不是有效的 JPG/JPEG/PNG：${name || '未命名文件'}`), {
      status: 400,
      code: 'REFERENCE_IMAGE_INVALID',
    });
  }

  const dimensions = imageDimensions(buf, mime);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
    throw Object.assign(new Error(`无法读取参考图尺寸：${name || '未命名文件'}`), {
      status: 400,
      code: 'REFERENCE_IMAGE_INVALID',
    });
  }
  if (dimensions.width > IMAGE_MAX_SIDE || dimensions.height > IMAGE_MAX_SIDE) {
    throw Object.assign(new Error(`参考图单边不能超过 ${IMAGE_MAX_SIDE}px：${name || '未命名文件'}`), {
      status: 400,
      code: 'REFERENCE_IMAGE_TOO_LARGE',
    });
  }
  if (dimensions.width * dimensions.height > IMAGE_MAX_PIXELS) {
    throw Object.assign(new Error(`参考图像素不能超过 ${IMAGE_MAX_PIXELS.toLocaleString()}：${name || '未命名文件'}`), {
      status: 400,
      code: 'REFERENCE_IMAGE_TOO_LARGE',
    });
  }

  const original = path.basename(String(name || '').replace(/[/\\]/g, ''));
  const fallback = mime === 'image/jpeg' ? 'reference.jpg' : 'reference.png';
  const filename = original || fallback;
  return { buf, mime, filename, width: dimensions.width, height: dimensions.height };
}

/**
 * Accept path string / Buffer / Uint8Array / { dataBase64|data, name }.
 * Same shapes the mvp workbench and dola-api provider already use.
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
