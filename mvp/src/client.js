/**
 * 门面层：业务代码只跟 VideoClient 打交道。
 *
 *   const c = new VideoClient({ provider: 'dola-workbench', credential: 'xxx' });
 *   const t = await c.createAndWait({ prompt: '...' }, { onProgress: console.log });
 *   await c.downloadTo(t, './out/cat.mp4');
 */
import path from 'node:path';
import { createProvider } from './providers/index.js';
import { Status, isTerminal } from './core/task.js';
import { TimeoutError, TaskFailedError } from './core/errors.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class VideoClient {
  /**
   * @param {object} cfg
   * @param {string} [cfg.provider]  'dola-workbench' | 'dola-api' | 'admin-dola' | 'mock'
   * @param {object} [cfg.providerOptions] 透传给具体 provider
   */
  constructor({ provider = process.env.VIDEO_PROVIDER || 'mock', providerOptions = {} } = {}) {
    this.providerName = provider;
    this.p = createProvider(provider, providerOptions);
  }

  login(...a) { return this.p.login(...a); }
  getBalance() { return this.p.getBalance?.() ?? null; }
  listTasks(o) { return this.p.listTasks(o); }
  deleteTask(id) { return this.p.deleteTask(id); }
  createTask(o) { return this.p.createTask(o); }
  getTask(id) { return this.p.getTask(id); }

  /**
   * 创建并轮询到终态。
   * @param {object} task  createTask 的入参
   * @param {object} [opt]
   * @param {number} [opt.pollIntervalMs] 轮询间隔，默认 15s（真实服务建议别太快，会触发 query_notice）
   * @param {number} [opt.timeoutMs]      总超时，默认 30 分钟
   * @param {(t:object, info:object)=>void} [opt.onProgress]
   * @param {AbortSignal} [opt.signal]
   * @returns {Promise<object>} 终态任务；失败时抛 TaskFailedError
   */
  async createAndWait(task, opt = {}) {
    const {
      pollIntervalMs = 30_000,
      timeoutMs = 60 * 60_000,
      onProgress = null,
      signal = null,
    } = opt;

    const created = await this.p.createTask(task);
    const { taskId, via } = created;

    const deadline = Date.now() + timeoutMs;
    let last = null;
    let round = 0;

    while (true) {
      if (signal?.aborted) throw new TimeoutError('已取消', { raw: last?.raw });

      last = await this.p.getTask(taskId);
      round += 1;
      if (onProgress) onProgress(last, { round, elapsedMs: timeoutMs - (deadline - Date.now()), taskId, createdVia: via });

      if (isTerminal(last.status)) break;
      if (Date.now() >= deadline) {
        throw new TimeoutError(
          `等待超时（${timeoutMs / 1000}s），任务 ${taskId} 仍处「${last.status}」。` +
          `任务在服务端仍在跑，可用 video-task status ${taskId} 继续查。`,
          { raw: last.raw }
        );
      }
      await sleep(pollIntervalMs);
    }

    if (last.status === Status.FAILED) {
      throw new TaskFailedError(`任务失败：${last.error || '无错误信息'}`, { raw: last.raw });
    }
    if (last.status !== Status.SUCCEEDED) {
      throw new TimeoutError(`任务停在未知状态「${last.statusText ?? last.status}」`, { raw: last.raw });
    }
    return last;
  }

  /** 只轮询已有任务，不创建 */
  async waitFor(taskId, opt = {}) {
    const { pollIntervalMs = 30_000, timeoutMs = 60 * 60_000, onProgress = null } = opt;
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (true) {
      last = await this.p.getTask(taskId);
      if (onProgress) onProgress(last, { taskId });
      if (isTerminal(last.status)) break;
      if (Date.now() >= deadline) throw new TimeoutError(`等待超时，任务仍处「${last.status}」`, { raw: last.raw });
      await sleep(pollIntervalMs);
    }
    return last;
  }

  /** 下载到指定目录，文件名用 task_id.mp4 */
  async downloadTo(taskOrId, outDir = '.') {
    const t = typeof taskOrId === 'string' ? await this.p.getTask(taskOrId) : taskOrId;
    const id = t.id ?? taskOrId;
    return this.p.download(t, path.join(outDir, `${id}.mp4`));
  }
}

export { Status };
