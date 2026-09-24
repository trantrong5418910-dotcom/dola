import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveFfprobePath, probeMp4ContainerDuration } from '../server/dola/media-probe.js';

test('macOS launchd minimal PATH falls back to the installed Homebrew executable', async () => {
  const checked = [];
  const file = await resolveFfprobePath({ env: { PATH: '/usr/bin:/bin' }, platform: 'darwin',
    access: async p => { checked.push(p); if (p !== '/opt/homebrew/bin/ffprobe') throw Error('missing'); } });
  assert.equal(file, '/opt/homebrew/bin/ffprobe');
  assert.deepEqual(checked, ['/usr/bin/ffprobe', '/bin/ffprobe', '/opt/homebrew/bin/ffprobe']);
});

test('PATH priority is respected and relative/current-directory entries are never executed', async () => {
  const checked = [];
  const file = await resolveFfprobePath({ env: { PATH: ':.:relative:/custom/bin:/usr/bin' }, platform: 'linux',
    access: async p => { checked.push(p); } });
  assert.equal(file, '/custom/bin/ffprobe');
  assert.deepEqual(checked, ['/custom/bin/ffprobe']);
});

test('invalid or unavailable explicit override fails before browser generation, never falling back', async () => {
  for (const override of ['/missing/ffprobe', 'ffprobe']) {
    const checked = [];
    await assert.rejects(resolveFfprobePath({ env: { PATH: '/usr/bin', FFPROBE_PATH: override }, platform: 'darwin',
      access: async p => { checked.push(p); throw Error('not executable'); } }),
    e => e.code === 'GENERATION_PREFLIGHT_MEDIA_UNAVAILABLE' && e.status === 503);
    assert.deepEqual(checked, override.startsWith('/') ? [override] : []);
  }
});

// ---- probeMp4ContainerDuration：ffprobe 不可用时的纯 Node 兜底 ----

function box(type, payload) {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + payload.length);
  return Buffer.concat([size, Buffer.from(type, 'ascii'), payload]);
}

function mvhdBox({ version = 0, timescale = 1000, duration = 10000 } = {}) {
  const payload = Buffer.alloc(version === 0 ? 100 : 112);
  payload[0] = version;
  if (version === 0) {
    payload.writeUInt32BE(timescale, 12);
    payload.writeUInt32BE(duration, 16);
  } else {
    payload.writeUInt32BE(timescale, 20);
    payload.writeBigUInt64BE(BigInt(duration), 24);
  }
  return box('mvhd', payload);
}

function minimalMp4({ version = 0, timescale = 1000, duration = 10000, moovAtEnd = false } = {}) {
  const ftyp = box('ftyp', Buffer.from('isom\x00\x00\x00\x00isom', 'latin1'));
  const moov = box('moov', mvhdBox({ version, timescale, duration }));
  // moovAtEnd：moov 藏在文件尾（模拟非 faststart），只能靠尾部 256KB 读到
  return moovAtEnd
    ? Buffer.concat([ftyp, Buffer.alloc(600 * 1024, 0), moov])
    : Buffer.concat([ftyp, moov]);
}

async function withTempFile(buf, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mp4probe-'));
  const file = path.join(dir, 'a.mp4');
  await fs.writeFile(file, buf);
  try {
    return await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('兜底解析 v0 mvhd（moov 在文件头）', async () => {
  const seconds = await withTempFile(minimalMp4({ timescale: 1000, duration: 10500 }), probeMp4ContainerDuration);
  assert.equal(seconds, 10.5);
});

test('兜底解析 v1 mvhd（64 位 duration）', async () => {
  const seconds = await withTempFile(minimalMp4({ version: 1, timescale: 90000, duration: 900000 }), probeMp4ContainerDuration);
  assert.equal(seconds, 10);
});

test('moov 在文件尾也能从尾部读到', async () => {
  const seconds = await withTempFile(minimalMp4({ moovAtEnd: true, timescale: 1000, duration: 8000 }), probeMp4ContainerDuration);
  assert.equal(seconds, 8);
});

test('没有 mvhd 的垃圾文件返回 null', async () => {
  const seconds = await withTempFile(Buffer.alloc(4096, 0xab), probeMp4ContainerDuration);
  assert.equal(seconds, null);
});

test('timescale/duration 非法（0 值）返回 null', async () => {
  const seconds = await withTempFile(minimalMp4({ timescale: 0, duration: 0 }), probeMp4ContainerDuration);
  assert.equal(seconds, null);
});

test('文件不存在返回 null', async () => {
  const seconds = await probeMp4ContainerDuration(path.join(os.tmpdir(), 'mp4probe-no-such-file.mp4'));
  assert.equal(seconds, null);
});
