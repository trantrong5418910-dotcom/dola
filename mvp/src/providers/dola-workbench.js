/**
 * DolaWorkbench provider —— 对接 https://43.254.166.145 「视频工作台」。
 *
 * 契约来源：前端 bundle(/assets/index-CNFh3RVH.js) 逆向 + 真实抓包验证，
 * 逐条对应 API_ANALYSIS.md 里的表格。凡"未验证"的字段，代码里都做了兜底，
 * 不会因为它不存在就崩，也不会假装它一定存在。
 *
 * 已知关键事实（已实测）：
 *   - 未登录 GET  /api/session → 401 {"code":"0","message":"请先登录"}
 *   - 错误凭据 POST /api/session → 401 {"code":"0","message":"登录凭据无效"}
 *   - /api/v1/* 未带令牌 → 401 {"code":"0","message":"令牌无效或已禁用"}
 *   - 非 GET 缺 CSRF → 403 {"code":"0","message":"请求校验失败"}
 *   - 业务失败统一是 HTTP 200 + body.code === "0"，只看 HTTP 状态码会漏判
 *   - 前端创建视频时**丢弃了创建响应**，靠刷新列表拿到新任务
 *     ⇒ 创建响应里有没有 task_id 无法从前端确认，必须实测
 *     ⇒ 因此这里实现「响应取 id」+「列表 diff 兜底」两条路
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpClient } from '../core/http.js';
import { normalizeTask, extractTaskId, Status } from '../core/task.js';
import { AuthError, VideoProviderError } from '../core/errors.js';

/** 前端写死的比例选项（来源：bundle 里的 Mk 常量，已验证） */
export const RATIOS = ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'];
/** 前端时长输入框是 disabled + 固定 "30 秒"，所以别乱改 */
export const FIXED_SECONDS = 30;
export const PROMPT_MAX = 12_000;
export const IMAGE_MAX_COUNT = 9;
export const IMAGE_MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MiB

export class DolaWorkbenchProvider {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {string} [opts.credential] 访问令牌；不给就走 credentialEnv / 环境变量
   * @param {string} [opts.credentialEnv] 从哪个环境变量读令牌，默认 DOLA_CREDENTIAL
   * @param {boolean} [opts.insecure] 裸 IP + 证书不匹配时需要
   * @param {number} [opts.timeout]
   * @param {number} [opts.minPollIntervalMs] 查询最小间隔，前端自己是 5s 去抖
   */
  constructor({
    baseUrl = 'https://43.254.166.145',
    credential = null,
    credentialEnv = 'DOLA_CREDENTIAL',
    insecure = false,   // 实测该站点证书可正常通过校验；除非你换了网关否则不用开
    timeout = 60_000,
    minPollIntervalMs = 5_000,
    onTrace = null,
  } = {}) {
    this.name = 'dola-workbench';
    this.baseUrl = baseUrl;
    this.credential = credential ?? process.env[credentialEnv] ?? null;
    this.minPollIntervalMs = minPollIntervalMs;
    this.session = null;
    this._lastQueryAt = 0;

    this.http = new HttpClient({ baseUrl, timeout, insecure, onTrace });
    // 非 GET 请求自动带 CSRF
    this.http.headerHook = async (method) => {
      const h = {};
      if (method !== 'GET' && this.session?.csrf) h['X-CSRF-Token'] = this.session.csrf;
      return h;
    };
  }

  // ---------------- 会话 ----------------

  async login(credential = this.credential) {
    const cred = credential ?? this.credential;
    if (!cred) throw new AuthError('缺少访问令牌：请传 credential 或设置 DOLA_CREDENTIAL 环境变量');
    const { json } = await this.http.post('/api/session', { credential: cred });
    // 登录响应本身就是 session；再 GET 一次拿权威 csrf（前端也是这么做的）
    this.session = json ?? null;
    await this.refreshSession();
    return this.session;
  }

  async refreshSession() {
    const { json } = await this.http.get('/api/session');
    this.session = json ?? this.session;
    return this.session;
  }

  async logout() {
    try {
      await this.http.post('/api/logout');
    } finally {
      this.session = null;
      this.http.jar.clear();
    }
  }

  /**
   * 查余额。
   * ⚠️ 必须每次都 refreshSession 拿权威值 —— 会话里缓存的 balance 只在登录时写入，
   * 别的客户端（CLI / 另一个服务实例）创建任务后，缓存就会过期，
   * 表现是「页面显示 44，实际已经 43」。多一次很便宜的 GET，换数据正确。
   */
  async getBalance() {
    try {
      await this.refreshSession();
    } catch {
      if (!this.session) throw new Error('无法获取会话，请先 login');
    }
    return this.session?.balance ?? null;
  }

  /** 卡密兑换积分：POST /api/v1/cards/redeem {card} */
  async redeemCard(card) {
    const { json } = await this.http.post(
      '/api/v1/cards/redeem',
      { card: String(card).trim() },
      { headers: { 'Idempotency-Key': randomUUID() } }
    );
    await this.refreshSession();
    return json;
  }

  // ---------------- 任务 ----------------

  /**
   * 创建视频任务：POST /api/v1/videos，multipart/form-data
   * @param {object} p
   * @param {string} p.prompt
   * @param {string} [p.ratio]   前端默认 "16:9"
   * @param {string|number} [p.seconds] 前端固定传 "30"
   * @param {Array<string|Buffer|{name,data}>} [p.images] 可选，最多 9 张 JPEG/PNG
   */
  async createTask({ prompt, ratio = '16:9', seconds = 30, images = [], idempotencyKey = null } = {}) {
    if (!prompt || !String(prompt).trim()) throw new VideoProviderError('prompt 不能为空');
    if (String(prompt).length > PROMPT_MAX) {
      throw new VideoProviderError(`prompt 超过 ${PROMPT_MAX} 字上限（当前 ${String(prompt).length}）`);
    }
    if (!RATIOS.includes(String(ratio))) {
      throw new VideoProviderError(`ratio 必须是 ${RATIOS.join(' / ')} 之一，收到：${ratio}`);
    }
    if (Number(seconds) !== FIXED_SECONDS) {
      // 前端锁死 30 秒，传别的没依据，先在本地拦住，别拿真实积分去试错
      throw new VideoProviderError(`该站点前端固定 seconds=${FIXED_SECONDS}，请勿传其他值（收到 ${seconds}）`);
    }
    if ((images?.length ?? 0) > IMAGE_MAX_COUNT) {
      throw new VideoProviderError(`参考图片最多 ${IMAGE_MAX_COUNT} 张（当前 ${images.length}）`);
    }
    if (!this.session) await this.refreshSession();

    // 创建前先记下已有任务 ID，万一创建响应不含 task_id 就用列表 diff 兜底
    const before = new Set((await this.listTasks({ limit: 100 })).items.map((t) => t.id));

    const form = new FormData();
    form.set('prompt', String(prompt));
    form.set('ratio', String(ratio));
    form.set('seconds', String(seconds));
    let totalBytes = 0;
    for (const [i, img] of (images || []).entries()) {
      let buf, name;
      if (typeof img === 'string') {
        buf = await fs.readFile(img);
        name = path.basename(img);
      } else if (Buffer.isBuffer(img)) {
        buf = img;
        name = `image-${i}.png`;
      } else if (img && img.data) {
        buf = Buffer.from(img.data);
        name = img.name || `image-${i}.png`;
      } else continue;
      totalBytes += buf.length;
      form.append('images[]', new Blob([buf]), name);
    }
    if (totalBytes > IMAGE_MAX_TOTAL_BYTES) {
      throw new VideoProviderError(`参考图合计 ${(totalBytes / 1048576).toFixed(1)} MiB，超过 20 MiB 上限`);
    }

    // 幂等键：实测同一个 key 重复提交不会二次扣费（返回 existing:true + 同一个 task_id）。
    // 所以①调用方可传入固定 key 做业务幂等；②网络层失败时用【同一个】key 重试，安全。
    const key = idempotencyKey ?? randomUUID();
    let json;
    try {
      ({ json } = await this.http.post('/api/v1/videos', form, {
        headers: { 'Idempotency-Key': key },
      }));
    } catch (e) {
      const retryable = e.status == null || e.status >= 500; // 网络中断 / 服务端 5xx
      if (!retryable) throw e;
      ({ json } = await this.http.post('/api/v1/videos', form, {
        headers: { 'Idempotency-Key': key },
      }));
    }

    // 创建响应直接带余额，顺手同步，省一次 /api/session
    if (json?.balance != null && this.session) this.session.balance = json.balance;

    // ① 优先从创建响应里取 task_id（实测：响应里确实有 task_id，前端只是没用）
    const directId = extractTaskId(json);
    if (directId) {
      return { taskId: directId, raw: json, via: 'create-response', existing: Boolean(json.existing), balance: json.balance ?? null };
    }

    // ② 兜底：列表 diff
    const after = (await this.listTasks({ limit: 100 })).items;
    const fresh = after.filter((t) => !before.has(t.id)).sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );
    if (fresh.length === 0) {
      throw new VideoProviderError(
        '创建请求已受理，但既没从响应里拿到 task_id，列表里也没出现新任务。' +
        '可能是列表有延迟，稍后用 `list` 命令确认。（原始响应见 raw）',
        { raw: json }
      );
    }
    return { taskId: fresh[0].id, raw: json, via: 'list-diff', candidates: fresh.map((t) => t.id), existing: Boolean(json.existing) };
  }

  /** 查单个任务：GET /api/v1/videos/{task_id} → 实测返回体形如 { task: {...}, query_notice?: string } */
  async getTask(taskId) {
    const wait = this.minPollIntervalMs - (Date.now() - this._lastQueryAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastQueryAt = Date.now();

    const { json } = await this.http.get(`/api/v1/videos/${encodeURIComponent(taskId)}`);
    // 实测：响应是「扁平字段 + 嵌套 task」双份，refreshed / query_notice 只在顶层。
    // 合并时让 task 里的值兜底顶层的空串，避免未完成时的 "" 覆盖掉真实值。
    const top = { ...(json || {}) };
    delete top.task;
    const merged = { ...(json?.task || {}), ...top };
    if (json?.task) {
      for (const k of Object.keys(top)) {
        if ((top[k] === '' || top[k] == null) && json.task[k] !== undefined) merged[k] = json.task[k];
      }
    }
    const t = normalizeTask(merged, { idHint: taskId });
    // query_notice：服务端的查询侧提示（实测正常情况恒为空串）
    t.notice = t.notice ?? json?.query_notice ?? null;
    t.queryNotice = json?.query_notice ?? null;
    return t;
  }

  /** 任务列表：GET /api/v1/videos?cursor= → { tasks: [...], next_cursor } */
  async listTasks({ cursor = '', limit = 50 } = {}) {
    const collected = [];
    let cur = cursor;
    while (collected.length < limit) {
      const qs = cur ? `?cursor=${encodeURIComponent(cur)}` : '';
      const { json } = await this.http.get(`/api/v1/videos${qs}`);
      // 实测响应里 tasks 和 data 是同一份内容的两个别名，兼容取
      const batch = json?.tasks ?? json?.data ?? [];
      collected.push(...batch.map((t) => normalizeTask(t)));
      cur = json?.next_cursor ?? null;
      if (!cur || batch.length === 0) break;
    }
    return { items: collected.slice(0, limit), nextCursor: cur ?? null };
  }

  /** 删除（前端提示：仅隐藏本系统记录，不撤销已提交生成，也不退款） */
  async deleteTask(taskId) {
    const { json } = await this.http.delete(`/api/v1/videos/${encodeURIComponent(taskId)}`);
    return { ok: true, raw: json };
  }

  /**
   * 下载视频。task.url 是服务端给的直链（CSP 里 media-src 指向 dola.com）。
   * 直链是否需要带本站 cookie 未验证 —— 所以这里带上 cookie，不行也无害。
   */
  async download(task, destPath) {
    const id = typeof task === 'string' ? task : task.id;
    let t = typeof task === 'string' ? await this.getTask(task) : task;
    if (!t.url) throw new VideoProviderError(`任务 ${id} 还没有视频直链，当前状态：${t.status}`);

    const finalPath = destPath ?? path.join(process.cwd(), `${id}.mp4`);
    await fs.mkdir(path.dirname(path.resolve(finalPath)), { recursive: true });

    const headers = {};
    const cookie = this.http.jar.headerFor('/');
    if (cookie) headers.Cookie = cookie;

    const res = await fetch(t.url, { headers, redirect: 'follow' });
    if (!res.ok) throw new VideoProviderError(`下载失败 HTTP ${res.status}`, { status: res.status, url: t.url });
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(finalPath, buf);
    return { filePath: finalPath, bytes: buf.length, contentType: res.headers.get('content-type') };
  }
}
