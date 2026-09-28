/**
 * AdminDolaProvider —— 生成能力来自「管理后台的 dola 账号池」。
 *
 * 跟 dola-workbench.js 的区别（为什么不是同一个 provider）：
 *   dola-workbench 对接的是**老视频工作台**（43.254.166.145），它是"提交 prompt → 拿 task_id → 查状态"。
 *   本 provider 对接的是**我们自己的管理后台网关**，多了一层语义：
 *     - 计费由网关扣（用的是后台发的访问令牌，不是上游令牌）
 *     - 后端自己挑 dola 账号、自己开浏览器提交、自己等成片
 *     - ★ 完成时返回的是**无水印直链**（后台解析好再给出来）
 *
 * 关键：这个 provider 的每个方法都要**带用户令牌**。
 *   网关密钥（X-Gateway-Key）只证明"调用方是那个工作台服务"，
 *   而任务归属/计费必须知道是"哪个用户"，所以令牌逐调用传入。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeTask, Status } from '../core/task.js';
import { VideoProviderError, AuthError } from '../core/errors.js';

/** 后台的生成状态 → 统一状态。比通用别名表更精确，所以这里显式映射。 */
const GEN_STATUS_MAP = {
  queued: Status.QUEUED,
  submitting: Status.PROCESSING,
  generating: Status.PROCESSING,
  resolving: Status.PROCESSING,
  ready: Status.SUCCEEDED,
  failed: Status.FAILED,
  cancelled: Status.FAILED,
};
// 档位精简（2026-09-27）：10 秒与 20 秒已下线，只剩 15（专家模式）与 30（主档位）。
const SUPPORTED_SECONDS = Object.freeze([15, 30]);
/** 已下线档位：只用于给出更明确的报错，不做任何静默降级。 */
const RETIRED_SECONDS = Object.freeze([10, 20]);

export class AdminDolaProvider {
  /**
   * @param {object} opts
   * @param {object} opts.gateway  createGateway() 的返回值（必须 enabled）
   */
  constructor({ gateway = null } = {}) {
    this.name = 'admin-dola';
    this.gateway = gateway;
    this.token = null;          // 当前登录用户令牌
    this.session = null;
    /** Synced from gateway health by the workbench server. */
    this.referenceImagesReady = false;
  }

  _requireGateway() {
    if (!this.gateway?.enabled) {
      throw new AuthError('生成 provider「admin-dola」需要配置 ADMIN_GATEWAY_URL + ADMIN_GATEWAY_KEY');
    }
  }

  /**
   * 后台可能返回**相对路径**（如 `/api/gateway/gen/3/file?token=...`）——
   * 那是"本地归档文件"的流式地址，比会过期的 TOS 直链可靠。
   * 相对路径不能直接 fetch，这里补成绝对地址（走网关基址）。
   */
  _absUrl(u) {
    if (!u) return u;
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('/')) return String(this.gateway.base || '').replace(/\/+$/, '') + u;
    return u;
  }

  /** 登录 = 让后台校验令牌（令牌是不是有效、余额多少，后台说了算） */
  async login(credential = this.token) {
    this._requireGateway();
    const cred = String(credential || '').trim();
    if (!cred) throw new AuthError('缺少访问令牌');
    const v = await this.gateway.verify(cred);
    this.token = cred;
    this.session = v;
    return v;
  }

  async getBalance() {
    this._requireGateway();
    if (!this.token) throw new AuthError('未登录');
    const v = await this.gateway.verify(this.token);
    this.session = v;
    return v.points ?? null;
  }

  /** 提交生成。**计费在后端做**（先建任务占坑再扣，扣不动就撤） */
  async createTask({ prompt, ratio = '16:9', mode = 'standard', seconds = 30, forceSeconds = null, accountId = null, images = [] } = {}) {
    this._requireGateway();
    if (!this.token) throw new AuthError('未登录');
    if (!prompt || !String(prompt).trim()) throw new VideoProviderError('prompt 不能为空');
    if (String(prompt).length > 12000) throw new VideoProviderError('prompt 超过 12000 字上限');
    const requestedSeconds = Number(seconds);
    if (RETIRED_SECONDS.includes(Number(seconds))) {
      throw Object.assign(
        new VideoProviderError(`${seconds} 秒档位已下线，当前工作台仅支持 15 秒（专家模式）或 30 秒`),
        { status: 400, code: 'DURATION_RETIRED' },
      );
    }
    if (!Number.isInteger(requestedSeconds) || !SUPPORTED_SECONDS.includes(requestedSeconds)) {
      throw new VideoProviderError(`当前工作台支持 ${SUPPORTED_SECONDS.join('、')} 秒视频（收到 ${seconds}）`);
    }
    const generationMode = String(mode || 'standard').trim().toLowerCase();
    if (!['standard', 'expert'].includes(generationMode)) {
      throw new VideoProviderError('mode 仅支持 standard 或 expert');
    }
    if (requestedSeconds === 15 && generationMode !== 'expert') {
      throw new VideoProviderError('15 秒视频只能在专家模式提交');
    }
    const requestedForceSeconds = forceSeconds == null ? requestedSeconds : Number(forceSeconds);
    if (requestedForceSeconds !== requestedSeconds) {
      throw new VideoProviderError('seconds 与 forceSeconds 必须一致');
    }
    if (!Array.isArray(images)) {
      throw Object.assign(new VideoProviderError('images 必须是数组'), { status: 400, code: 'REFERENCE_IMAGES_INVALID' });
    }
    if (images.length && !this.referenceImagesReady) {
      throw Object.assign(new VideoProviderError('当前后台暂不支持参考图片，请使用纯文本提示词'), {
        status: 400, code: 'REFERENCE_IMAGES_UNSUPPORTED',
      });
    }

    const gatewayImages = images.map((image, index) => {
      if (image?.dataBase64) {
        return { name: image.name || `image-${index}.png`, dataBase64: String(image.dataBase64) };
      }
      const buf = Buffer.isBuffer(image?.data) ? image.data
        : Buffer.isBuffer(image) ? image
          : image?.data ? Buffer.from(image.data) : null;
      if (!buf) {
        throw Object.assign(new VideoProviderError(`第 ${index + 1} 张参考图格式不受支持`), {
          status: 400, code: 'REFERENCE_IMAGES_INVALID',
        });
      }
      return {
        name: image?.name || `image-${index}.png`,
        dataBase64: buf.toString('base64'),
      };
    });

    const r = await this.gateway.generation.create({
      token: this.token,
      prompt: String(prompt),
      ratio,
      mode: generationMode,
      seconds: requestedSeconds,
      forceSeconds: requestedForceSeconds,
      accountId,
      images: gatewayImages,
    });
    this.session = this.session ? { ...this.session, points: r.balance } : this.session;
    return {
      taskId: String(r.taskId),
      via: 'admin-gateway',
      balance: r.balance ?? null,
      chargedPoints: r.chargedPoints ?? null,
      account: r.account ?? '',
      raw: r,
    };
  }

  async getTask(taskId) {
    this._requireGateway();
    if (!this.token) throw new AuthError('未登录');
    const r = await this.gateway.generation.status({ token: this.token, taskId });
    // 先过通用归一化（拿 id/url/error/createdAt 那套），再用后台的精确状态覆盖
    const base = normalizeTask(
      { id: r.taskId, status: r.status, url: this._absUrl(r.url), error: r.error || null, created_at: r.createdAt },
      { idHint: taskId },
    );
    return {
      ...base,
      status: GEN_STATUS_MAP[r.status] ?? Status.UNKNOWN,
      statusText: r.status,
      stage: r.stage || null,
      /** 是不是无水印（后台解析成功才有）；前端用它显示角标 */
      isUnwatermarked: Boolean(r.isUnwatermarked),
      /** 是不是本地归档（=不会过期） */
      archived: Boolean(r.archived),
      urlSource: r.urlSource || null,
      watermarkedUrl: this._absUrl(r.watermarkedUrl),
      unwatermarkedUrl: this._absUrl(r.unwatermarkedUrl),
      unwatermarkNote: r.unwatermarkNote || '',
      done: Boolean(r.done),
      refunded: Boolean(r.refunded),
      balance: r.balance ?? null,
      seconds: r.seconds,
      durationSec: r.durationSec ?? null,
      forceSeconds: r.forceSeconds ?? null,
      bytes: r.bytes ?? null,
      raw: r,
    };
  }

  async listTasks({ limit = 20 } = {}) {
    this._requireGateway();
    if (!this.token) throw new AuthError('未登录');
    const r = await this.gateway.generation.list({ token: this.token, limit });
    const items = (r.items || []).map((t) => ({
      ...normalizeTask({ id: t.id, status: t.status, url: this._absUrl(t.url), error: t.error || null, created_at: t.created_at }, { idHint: t.id }),
      status: GEN_STATUS_MAP[t.status] ?? Status.UNKNOWN,
      statusText: t.status,
      stage: t.stage || null,
      isUnwatermarked: Boolean(t.is_unwatermarked),
      archived: Boolean(t.archived),
      watermarkedUrl: this._absUrl(t.watermarked_url),
      unwatermarkedUrl: this._absUrl(t.unwatermarked_url),
      unwatermarkNote: t.unwatermark_note || '',
      seconds: t.seconds,
      durationSec: t.duration_sec ?? null,
      prompt: t.prompt,
      ratio: t.ratio,
      finishedAt: t.finished_at,
      bytes: t.local_bytes ?? t.bytes ?? null,
      raw: t,
    }));
    return { items, nextCursor: null };
  }

  /**
   * 删除 = 取消 + 退款（后台决定能不能退：已经提交到上游的不退）。
   * 语义上跟老 provider 的"仅隐藏记录"不同，所以把后台的话原样带回去。
   */
  async deleteTask(taskId) {
    this._requireGateway();
    if (!this.token) throw new AuthError('未登录');
    const r = await this.gateway.generation.cancel({ token: this.token, taskId });
    return { ok: true, refunded: Boolean(r.refunded), message: r.message || '', raw: r };
  }

  /** 下载（task.url 已经是「本地归档 或 无水印优先」的直链） */
  async download(task, destPath) {
    const id = typeof task === 'string' ? task : task.id;
    const t = typeof task === 'string' ? await this.getTask(task) : task;
    if (!t.url) throw new VideoProviderError(`任务 ${id} 还没有视频直链，当前状态：${t.status}（${t.stage || ''}）`);

    const finalPath = destPath ?? path.join(process.cwd(), `${id}.mp4`);
    await fs.mkdir(path.dirname(path.resolve(finalPath)), { recursive: true });
    const res = await this.gateway.fetchMedia(t.url);
    if (!res.ok) throw new VideoProviderError(`下载失败 HTTP ${res.status}`, { status: res.status, url: t.url });
    if (!/^(video\/|application\/octet-stream\b)/i.test(res.headers.get('content-type') || '')) {
      await res.body?.cancel();
      throw new VideoProviderError('媒体响应不是视频文件');
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(finalPath, buf);
    return {
      filePath: finalPath,
      bytes: buf.length,
      contentType: res.headers.get('content-type'),
      isUnwatermarked: Boolean(t.isUnwatermarked),
    };
  }

}
