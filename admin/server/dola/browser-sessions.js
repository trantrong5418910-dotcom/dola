/**
 * 常驻浏览器会话池（按 dola 账号）。
 *
 * ★ 为什么要有这个模块
 *
 * 生成链路原本是「每次任务 launchPersistentContext → 用完 ctx.close()」。
 * profile 虽然是持久的（指纹稳定 + HTTP 缓存），但**每次开都等于一次全新的
 * 浏览器会话**——上游风控（shark_admin / 710022004 滑块）把「换设备登录」
 * 当成强信号。交接与研究结论都把这一点列为滑块高频触发的主因，
 * 优先级高于签名本身（纯协议方案已判定不投入）。
 *
 * 本模块把「开一次 → 关一次」改成「开一次 → 复用 → 空闲才回收」。
 *
 * ★ 三个不这么做就会出错的约束
 *
 *   ① persistent context 的 proxy 是**启动参数**，运行期改不了。
 *      账号换代理 ⇒ 必须销毁重建。所以调用方要传 launchKey（代理等配置的指纹），
 *      本模块比对不一致就重建，避免"以为复用了其实用的旧出口"。
 *
 *   ② ctx.route() 是**叠加**的，不清就累积。
 *      生成链路每次任务都挂 ctx.route('**\/*') 装 wireGate（含本次的 seconds/model），
 *      复用同一个 ctx 时上一轮的 handler 还在，请求会被旧规则处理。
 *      ⇒ 复用前必须 unrouteAll()。
 *
 *   ③ 关浏览器才是「把 HTTP 缓存 flush 到磁盘」的时刻（generator.js 原注释）。
 *      常驻期间缓存只留在内存，所以回收时（空闲超时 / 显式 invalidate）
 *      必须真的 close，否则下次冷启动又要重下 ~10MB 的 JS 包。
 *
 * 用法：
 *   const ctx = await acquireSession(accountId, { launch, launchKey });
 *   try { ... } finally { releaseSession(accountId); }
 *
 * 出错想强制重建：invalidateSession(accountId)。
 */

const SESSIONS = new Map();

const IDLE_MS = Number(process.env.DOLA_SESSION_IDLE_MS || 10 * 60_000);
const MAX_SESSIONS = Number(process.env.DOLA_SESSION_MAX || 3);

/** 调一次 process.env 读取，便于测试时改 */
const idleMs = () => Number(process.env.DOLA_SESSION_IDLE_MS || IDLE_MS);
const maxSessions = () => Number(process.env.DOLA_SESSION_MAX || MAX_SESSIONS);

function keyOf(accountId) {
  return String(accountId ?? 'anonymous');
}

/** 会话还活着吗：browser 已断连或 pages() 抛错都算死 */
async function isAlive(ctx) {
  try {
    const browser = typeof ctx.browser === 'function' ? ctx.browser() : null;
    if (browser && typeof browser.isConnected === 'function' && !browser.isConnected()) return false;
    ctx.pages();
    return true;
  } catch {
    return false;
  }
}

async function destroy(key) {
  const s = SESSIONS.get(key);
  if (!s) return;
  SESSIONS.delete(key);
  if (s.timer) clearTimeout(s.timer);
  // ★ 真关：这一步才会把 HTTP 缓存 flush 到磁盘（见文件头约束 ③）
  try {
    await s.ctx.close();
  } catch {
    /* 已经死了就无所谓 */
  }
}

/** 池满时回收最久未用的**空闲**会话；全忙则不回收（宁可超也不要打断在跑的任务） */
async function evictIfNeeded() {
  const idle = [...SESSIONS.entries()]
    .filter(([, s]) => !s.busy)
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  while (SESSIONS.size >= maxSessions() && idle.length) {
    const [key] = idle.shift();
    await destroy(key);
  }
}

/**
 * 复用前把上一轮的痕迹清掉。
 * 只做必要清理：route 与残留页面。cookie 由调用方自己 addCookies。
 */
async function prepareReuse(ctx) {
  // 约束 ②：route 叠加会累积，必须清
  if (typeof ctx.unrouteAll === 'function') {
    await ctx.unrouteAll().catch(() => {});
  }
  // 关掉上一轮留下的页面：滑块 iframe / 弹窗 / 已完成的会话页都不该带进下一轮
  const pages = ctx.pages();
  for (const p of pages) {
    await p.close().catch(() => {});
  }
}

/**
 * 取一个可复用的会话；不存在或配置变了就新建。
 *
 * @param {string|number} accountId
 * @param {{ launch: () => Promise<object>, launchKey: string }} opts
 *        launch 只在真的要新建时才被调用（避免每次都付启动成本）
 */
export async function acquireSession(accountId, opts = {}) {
  const { launch, launchKey = '' } = opts;
  const key = keyOf(accountId);
  const existing = SESSIONS.get(key);

  if (existing) {
    if (existing.busy) {
      // 同一账号并发：调用方应该用 account-browser-lock 挡住，这里再兜一道
      throw new Error('browser_session_busy');
    }
    if (existing.launchKey !== launchKey) {
      await destroy(key);          // 约束 ①：代理变了必须重建
    } else if (await isAlive(existing.ctx)) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.busy = true;
      existing.lastUsedAt = Date.now();
      existing.reuses += 1;
      await prepareReuse(existing.ctx);
      return existing.ctx;
    } else {
      await destroy(key);          // 崩了：重建
    }
  }

  await evictIfNeeded();
  const ctx = await launch();
  SESSIONS.set(key, {
    ctx,
    launchKey,
    busy: true,
    lastUsedAt: Date.now(),
    timer: null,
    reuses: 0,
  });
  return ctx;
}

/** 归还会话：不关，只标空闲并起回收计时器 */
export function releaseSession(accountId) {
  const key = keyOf(accountId);
  const s = SESSIONS.get(key);
  if (!s) return;
  s.busy = false;
  s.lastUsedAt = Date.now();
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    void destroy(key);
  }, idleMs());
  // 别让这个 timer 拖住进程退出
  if (typeof s.timer.unref === 'function') s.timer.unref();
}

/** 本次用坏了（页面状态异常 / 被登出）：下次强制新建 */
export async function invalidateSession(accountId) {
  await destroy(keyOf(accountId));
}

/** 诊断用：池里现在有什么 */
export function sessionStats() {
  return [...SESSIONS.entries()].map(([key, s]) => ({
    account: key,
    busy: s.busy,
    reuses: s.reuses,
    idleMs: Date.now() - s.lastUsedAt,
    launchKey: s.launchKey,
  }));
}

/** 进程退出前把所有会话真关掉（flush 缓存） */
export async function closeAllSessions() {
  await Promise.all([...SESSIONS.keys()].map((k) => destroy(k)));
}
