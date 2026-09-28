#!/usr/bin/env node
/**
 * 后台服务入口：Express + SQLite。
 *
 *   npm run dev:api   起 API（前端另起 vite dev，走代理）
 *   npm run build     构建前端到 server/public
 *   npm start         单端口同时提供 API + 前端（推荐，生产用这个）
 *
 * 端口默认 8788（8787 被隔壁的视频任务服务占着）。改： PORT=9000 npm start
 */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initDb, db, DB_PATH } from './db.js';
import { createErrorHandler } from './error-middleware.js';
import { authMiddleware, requireAuth, verifyPassword } from './auth.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import roleRoutes from './routes/roles.js';
import contentRoutes from './routes/content.js';
import settingRoutes from './routes/settings.js';
import logRoutes from './routes/logs.js';
import tokenRoutes from './routes/tokens.js';
import cardRoutes from './routes/cards.js';
import dolaRoutes, { startDolaMaintenance } from './routes/dola.js';
import dolaGoogleLoginRoutes, { stopGoogleLogins } from './routes/dola-google-login.js';
import frontendRoutes from './routes/frontend.js';
import gatewayRoutes from './routes/gateway.js';
import materialRoutes from './routes/materials.js';
import referenceImageRoutes from './routes/reference-images.js';
import scriptRoutes, { recoverStaleScripts } from './routes/scripts.js';
import proxyPoolRoutes, { ensureProxyPoolSchema } from './proxy-pool.js';
// 成片库 / 无水印资源（自包含模块，见 server/media-routes.js 文件头）。
// 建表用不上 —— 它读写的 dola_videos 是既有表，只加挂载。
import mediaRoutes from './media-routes.js';
// /v1 对外开放生成 API（对标参考站 68.64.176.15 的 /v1 契约，见 server/v1-routes.js 文件头）。
// ⚠️ 必须挂在下面的 SPA fallback **之前**：那条兜底是 /^(?!\/api).*/，
//    而 /v1 不以 /api 开头，漏挂的话任何 /v1 请求都会回 index.html。
import v1Routes from './v1-routes.js';
// Prometheus 抓取端点 /metrics 与 /metrics.json（对标参考站，但**带鉴权**，见文件头）。
// ⚠️ 同样必须挂在 SPA 兜底之前：它不以 /api 开头。
import metricsRoutes from './routes/metrics.js';
import { recoverStaleJobs } from './jobs.js';
import { recoverStaleVideoTasks } from './dola/generator.js';
import { seedHistoricalGenerationGuards } from './dola/generation-guards.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const PORT = Number(process.env.PORT || 8788);
/**
 * 监听地址。**默认必须钉死在 127.0.0.1。**
 *
 * 踩过的坑：`app.listen(PORT)` 不传 host 时 Node 会绑到 `0.0.0.0`（所有网卡），
 * 而启动日志打印的是 `http://127.0.0.1:PORT` —— 日志给了「只监听本机」的错觉，
 * 实际门是敞开的。配合「默认口令 admin123 未强制修改」，等于同网段任何人
 * 都能登进后台、读走网关密钥和全部账号 cookie。
 *
 * 确实需要对外暴露时，显式设 HOST=0.0.0.0，并且**必须**先改掉默认口令。
 * 用 127.0.0.1 之外的地址启动会打醒目警告。
 */
const HOST = String(process.env.HOST || '127.0.0.1').trim();
const EXPOSED = !['127.0.0.1', 'localhost', '::1'].includes(HOST);

await initDb();
// A crash/restart can interrupt an LLM request before its route handler writes
// the failure state.  Do not leave those script rows permanently locked in
// `generating` after the new process comes up.
const staleScripts = recoverStaleScripts();
if (staleScripts) console.log(`[script] 已把 ${staleScripts} 个中断的脚本标记为 failed`);
// 代理池建表（自包含模块，见 server/proxy-pool.js 文件头）。
// ⚠️ 必须 try/catch：这个模块是后加的，建表若出错**不能**把整个服务拦在启动阶段
//    —— 后台进不去，比没有代理池严重得多。
try {
  ensureProxyPoolSchema();
  console.log('[proxy-pool] 代理池表已就绪');
} catch (e) {
  console.error('[proxy-pool] 建表失败，代理池相关接口将不可用（其余功能不受影响）:', e.message);
}
const guarded = seedHistoricalGenerationGuards(db);
if (guarded) console.log(`[gen] 已为 ${guarded} 项未确认能力启用重复失败保护`);
// 上次进程没跑完的任务不会自动续跑，标成中断，别让前端一直转圈
const stale = recoverStaleJobs();
if (stale) console.log(`[job] 已把 ${stale} 个中断的任务标记为 failed`);
// 已有可靠回执的生成任务只恢复查询；未知提交保留待核对，不再统一标失败。
const staleVideos = recoverStaleVideoTasks();
if (staleVideos) console.log(`[gen] 已核对 ${staleVideos} 个中断任务：可靠回执恢复查询，未知提交保留待核对`);

// 账号池自动维护：约 15 秒后首次巡检，之后按系统设置周期运行。
// 只做健康/额度读取；明确失效的账号标记为 invalid，cookie 记录保留以便重新导入或人工恢复。
const stopDolaMaintenance = startDolaMaintenance();

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(authMiddleware);

// ---------------- API ----------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'admin-console', db: path.basename(DB_PATH), loggedIn: Boolean(req.user) });
});

/** 仪表盘统计 */
app.get('/api/stats', requireAuth, (req, res) => {
  const q = (sql, ...p) => db.prepare(sql).get(...p);
  const byStatus = db.prepare('SELECT status, COUNT(*) AS c FROM contents GROUP BY status').all();
  const recentLogs = db.prepare('SELECT id,username,action,target_type,created_at FROM audit_logs ORDER BY id DESC LIMIT 8').all();
  const cardStats = q(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='unused' THEN 1 ELSE 0 END) AS unused,
      SUM(CASE WHEN status='redeemed' THEN 1 ELSE 0 END) AS redeemed,
      COALESCE(SUM(CASE WHEN status='unused' THEN points ELSE 0 END),0) AS unused_points
    FROM cards`);
  const tokenStats = q(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
      COALESCE(SUM(points),0) AS points
    FROM tokens`);
  const dolaStats = q(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='valid' THEN 1 ELSE 0 END) AS valid,
      SUM(CASE WHEN status='invalid' THEN 1 ELSE 0 END) AS invalid,
      COALESCE(SUM(credits),0) AS credits,
      COALESCE(SUM(converted_credits),0) AS converted
    FROM dola_accounts`);
  // 近 7 天每日新增内容
  const days = db.prepare(`
    SELECT substr(created_at,1,10) AS d, COUNT(*) AS c
    FROM contents WHERE created_at >= datetime('now','-7 days')
    GROUP BY d ORDER BY d`).all();
  res.json({
    ok: true,
    counts: {
      users: q('SELECT COUNT(*) AS c FROM users').c,
      roles: q('SELECT COUNT(*) AS c FROM roles').c,
      contents: q('SELECT COUNT(*) AS c FROM contents').c,
      logs: q('SELECT COUNT(*) AS c FROM audit_logs').c,
      tokens: tokenStats.total ?? 0,
      tokensActive: tokenStats.active ?? 0,
      tokenPoints: tokenStats.points ?? 0,
      cards: cardStats.total ?? 0,
      cardsUnused: cardStats.unused ?? 0,
      cardsRedeemed: cardStats.redeemed ?? 0,
      cardsUnusedPoints: cardStats.unused_points ?? 0,
      dolaAccounts: dolaStats.total ?? 0,
      dolaValid: dolaStats.valid ?? 0,
      dolaInvalid: dolaStats.invalid ?? 0,
      dolaCredits: dolaStats.credits ?? 0,
      dolaConverted: dolaStats.converted ?? 0,
    },
    contentByStatus: byStatus,
    cardByStatus: db.prepare('SELECT status, COUNT(*) AS c FROM cards GROUP BY status').all(),
    recentLogs,
    contentTrend: days,
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/contents', contentRoutes);
app.use('/api/settings', settingRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/tokens', tokenRoutes);
app.use('/api/cards', cardRoutes);
app.use('/api/dola', dolaRoutes);
app.use('/api/dola/google-login', dolaGoogleLoginRoutes);
app.use('/api/frontend', frontendRoutes);
app.use('/api/gateway', gatewayRoutes);
app.use('/api/materials', materialRoutes);
app.use('/api/reference-images', referenceImageRoutes);
app.use('/api/scripts', scriptRoutes);
app.use('/api/proxy-pool', proxyPoolRoutes);
app.use('/api/media', mediaRoutes);
app.use('/v1', v1Routes);
// 必须在这里（SPA 兜底 app.get(/^(?!\/api).*/) 之前）—— 否则 /metrics 会回 index.html，
// 而 Prometheus 拿到 200 + HTML 只会解析出零条序列，静默以为"服务没有任何指标"。
app.use('/', metricsRoutes);

app.use('/api', (req, res) => res.status(404).json({ ok: false, message: `未找到接口 ${req.method} ${req.path}` }));

// ---------------- 前端静态资源 ----------------

if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  // SPA fallback：非 /api 的路径都回 index.html
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
} else {
  app.get('/', (req, res) => {
    res.status(200).type('html').send(
      `<h2>前端还没构建</h2><p>先跑 <code>npm run build</code>，再 <code>npm start</code>。</p>
       <p>开发模式：另开一个终端跑 <code>npm run dev:web</code>（端口 5173，已配代理到 ${PORT}）。</p>`,
    );
  });
}

// ---------------- 错误兜底 ----------------

/**
 * 进程级安全网。
 *
 * ⚠️ Express 4 **不会**捕获 async handler 抛出的异常 —— 未被 catch 的 rejection
 * 在 Node 里默认会直接终止进程（整个后台挂掉，而不是返回 500）。
 * 真踩过：一个 async 路由把校验写在 try 外面，配置里填个非法值就把服务搞崩了。
 *
 * 所以：① 每个 async 路由自己 try/catch（首选）；② 这里兜底，只记录不退出，
 * 免得一个边角请求把整个服务带走。日志要吵，别静默吞掉。
 */
process.on('unhandledRejection', (reason) => {
  console.error('[fatal?] 未处理的 Promise rejection（路由忘了 try/catch？）:', reason);
});

/**
 * 取出框架/中间件**已经分好类**的 HTTP 状态码（实现与说明见 error-middleware.js）。
 */
app.use(createErrorHandler());

// 退出时收尾：把「打开前台」起的真实浏览器关掉，别留孤儿进程
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    stopDolaMaintenance();
    await stopGoogleLogins();
    await fetch(`http://127.0.0.1:${PORT}/api/frontend/close`, { method: 'POST' }).catch(() => {});
    process.exit(0);
  });
}

app.listen(PORT, HOST, () => {
  console.log(`\n  管理后台已启动  http://${EXPOSED ? HOST : '127.0.0.1'}:${PORT}`);
  console.log(`  监听地址：${HOST}${EXPOSED ? '  ⚠️ 非本机回环，同网段/公网可访问' : '（仅本机可访问）'}`);
  console.log(`  数据库：${DB_PATH}`);
  if (usingDefaultAdminPassword()) {
    console.log('\n  ⚠️⚠️  管理员口令仍是默认值 admin123，请立刻修改！');
    console.log('        改动位置：后台 → 用户管理 → admin → 重置密码\n');
  } else {
    console.log('  默认账号：admin（口令已自定义）\n');
  }
  if (EXPOSED) {
    console.log(`  ⚠️  已绑定非回环地址 ${HOST}：后台将对外网开放。`);
    console.log('     暴露前请确认：① admin 口令已改 ② 网关密钥已轮换 ③ 前面有反代/防火墙\n');
  }
});

/**
 * 启动时检查管理员口令是否还是出厂默认值。
 * 只读校验，失败一律当「已改过」，不能因为查不到就把服务拦住。
 */
function usingDefaultAdminPassword() {
  try {
    const admin = db.prepare("SELECT password_hash FROM users WHERE username='admin'").get();
    return Boolean(admin && verifyPassword('admin123', admin.password_hash));
  } catch {
    return false;
  }
}
