/**
 * Mock provider —— 不联网、不花钱，用来把整条链路先跑通。
 * 用途：开发/演示/CI。真实接口不可用或没拿到令牌时，它就是默认兜底。
 *
 * 行为：createTask 立刻返回 task_id → 经历 queued → processing → succeeded
 *      → download 用 ffmpeg（如果有）生成一段 3 秒的小视频，否则写占位文件。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Status, normalizeTask } from '../core/task.js';
import { TaskFailedError } from '../core/errors.js';

const execFileP = promisify(execFile);

export class MockProvider {
  constructor({ queueDelayMs = 1500, processDelayMs = 6000, failRate = 0, workDir = null } = {}) {
    this.name = 'mock';
    this.queueDelayMs = queueDelayMs;
    this.processDelayMs = processDelayMs;
    this.failRate = failRate; // 0~1，用来测失败分支
    this.workDir = workDir;
    this.tasks = new Map();
    this.balance = 100;
  }

  async login() {
    return { role: 'user', balance: this.balance };
  }

  async createTask({ prompt, ratio = '16:9', seconds = 30, images = [] } = {}) {
    if (!prompt || !String(prompt).trim()) throw new TaskFailedError('prompt 不能为空');
    const id = `mock_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.tasks.set(id, {
      task_id: id,
      status: Status.QUEUED,
      prompt,
      ratio,
      seconds,
      imageCount: images.length,
      created_at: new Date(now).toISOString(),
      charged_points: 10,
      _enterProcessingAt: now + this.queueDelayMs,
      _enterFinalAt: now + this.queueDelayMs + this.processDelayMs,
      _willFail: Math.random() < this.failRate,
      can_delete: true,
      url: null,
    });
    this.balance -= 10;
    return { taskId: id, raw: { task_id: id, status: Status.QUEUED } };
  }

  /** 惰性推进状态：每次被查询时按时间线演进，模拟真实服务 */
  _advance(t) {
    const now = Date.now();
    if (t.status === Status.QUEUED && now >= t._enterProcessingAt) {
      t.status = Status.PROCESSING;
      t.estimated_wait = '预计还需 1 分钟';
    }
    if (t.status === Status.PROCESSING && now >= t._enterFinalAt) {
      if (t._willFail) {
        t.status = Status.FAILED;
        t.error = '模拟失败：上游生成服务返回错误（mock）';
      } else {
        t.status = Status.SUCCEEDED;
        t.url = `mock://video/${t.task_id}.mp4`;
        t.estimated_wait = null;
      }
    }
    return t;
  }

  async getTask(taskId) {
    const t = this.tasks.get(String(taskId));
    if (!t) throw new TaskFailedError(`任务不存在：${taskId}`);
    return normalizeTask(this._advance(t));
  }

  async listTasks({ limit = 50 } = {}) {
    const items = [...this.tasks.values()].map((t) => this._advance(t)).reverse().slice(0, limit);
    return { items: items.map((t) => normalizeTask(t)), nextCursor: null };
  }

  async deleteTask(taskId) {
    const ok = this.tasks.delete(String(taskId));
    return { ok };
  }

  async getBalance() {
    return this.balance;
  }

  /** mock 没有真实直链，这里本地造一个文件返回路径 */
  async download(task, destPath) {
    const t = this.tasks.get(String(task.id ?? task));
    const finalPath = destPath ?? path.join(this.workDir ?? process.cwd(), `${task.id ?? task}.mp4`);
    await fs.mkdir(path.dirname(path.resolve(finalPath)), { recursive: true });
    try {
      await execFileP('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', `color=c=0x1a1a2e:s=640x360:d=3`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', finalPath,
      ]);
    } catch {
      await fs.writeFile(finalPath, Buffer.from('MOCK VIDEO PLACEHOLDER (ffmpeg 不可用，未生成真实 mp4)\n'));
    }
    return { filePath: finalPath, bytes: (await fs.stat(finalPath)).size };
  }
}
