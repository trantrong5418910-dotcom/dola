import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

/** launchd does not inherit the interactive shell's Homebrew PATH. Resolve an
 * absolute executable before spending generation quota; never invoke a shell.
 * An explicit override is authoritative and must not silently fall back.
 */
export async function resolveFfprobePath({ env = process.env, platform = process.platform, access = fs.access } = {}) {
  const override = env.FFPROBE_PATH;
  const paths = override ? [override] : [
    ...String(env.PATH || '').split(path.delimiter).filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, 'ffprobe')),
    ...(platform === 'darwin' ? ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'] : []),
  ];
  for (const file of new Set(paths)) {
    if (!path.isAbsolute(file)) continue;
    try { await access(file, constants.X_OK); return file; } catch { /* Try next declared location. */ }
  }
  throw Object.assign(new Error('本地视频验收工具 ffprobe 不可用，请安装或配置绝对路径 FFPROBE_PATH；未提交生成'), {
    status: 503, code: 'GENERATION_PREFLIGHT_MEDIA_UNAVAILABLE',
  });
}

/**
 * 纯 Node 的 MP4 时长兜底：ffprobe 不可用时用。
 *
 * 只读文件头/尾各 256KB（moov 可能在文件尾），扫描 mvhd box 解析
 * timescale/duration。只做容器级验证——替代不了 ffprobe 的逐帧读取，
 * 但足以区分"工具缺失"和"文件真损坏"，避免把已下好的好片误判为失败。
 * 成功返回秒数（>0），否则返回 null。
 */
export async function probeMp4ContainerDuration(filePath) {
  const HEAD = 256 * 1024;
  const TAIL = 256 * 1024;
  let fh = null;
  try {
    fh = await fs.open(filePath, 'r');
    const { size } = await fh.stat();
    if (!Number.isSafeInteger(size) || size <= 0) return null;
    const headLen = Math.min(HEAD, size);
    const tailLen = Math.min(TAIL, Math.max(0, size - headLen));
    const buf = Buffer.alloc(headLen + tailLen);
    await fh.read(buf, 0, headLen, 0);
    if (tailLen > 0) await fh.read(buf, headLen, tailLen, size - tailLen);
    // 在头/尾扫描 'mvhd'：其前 4 字节是 box size，之后是 version/flags/timescale/duration。
    let from = -1;
    for (;;) {
      const idx = buf.indexOf('mvhd', from + 1);
      if (idx === -1) return null;
      from = idx;
      if (idx < 4) continue;
      const version = buf[idx + 4];
      if (version !== 0 && version !== 1) continue;
      try {
        let timescale, duration;
        if (version === 0) {
          if (idx + 24 > buf.length) continue;
          timescale = buf.readUInt32BE(idx + 16);
          duration = buf.readUInt32BE(idx + 20);
        } else {
          if (idx + 36 > buf.length) continue;
          timescale = buf.readUInt32BE(idx + 24);
          const hi = buf.readUInt32BE(idx + 28);
          const lo = buf.readUInt32BE(idx + 32);
          if (hi > 0x1fffff) continue; // 时长大得离谱，八成是 mdat 里的误匹配
          duration = hi * 0x100000000 + lo;
        }
        if (!Number.isSafeInteger(timescale) || timescale <= 0) continue;
        if (!Number.isSafeInteger(duration) || duration <= 0) continue;
        const seconds = duration / timescale;
        if (!(seconds > 0 && seconds < 86400)) continue; // 超过 1 天必是误匹配
        return seconds;
      } catch {
        continue; // 越界：继续找下一个候选
      }
    }
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}
