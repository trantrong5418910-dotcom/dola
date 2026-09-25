/**
 * `GET /metrics` —— Prometheus 抓取端点。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────────
 * 它挂在 `/api` **之外**（Prometheus 默认习惯抓 `/metrics`），
 * 而 `server/index.js` 末尾有一条 SPA 兜底 `app.get(/^(?!\/api)…/)` ——
 * 任何不以 `/api` 开头、又没在兜底之前注册的路由，都会返回 index.html（200 + 一堆 HTML）。
 * 所以这个路由**必须在 SPA 兜底之前 mount**，见 index.js 的挂载位置注释。
 *
 * ⚠️ 写注释时别把正则原样贴进来：`(?!\/api).*` 后面紧跟 `/` 会凑出一个 `*​/`，
 *    直接把块注释提前闭合、后面整段变成代码（本文件第一次 `node --check` 就是这么挂的）。
 *    上面那行特意写成省略号 `…` 就是为了避开这个坑。
 *
 * ── 鉴权（**这里刻意不照抄参考站**）────────────────────────────────────────
 * 参考站 68.64.176.15 的 `/metrics` 与 `/health` 都是**免鉴权公开**的，其中 `/health`
 * 697 KB、含 164 个账号的 email/uid/代理串/额度。我们不做这种事。
 *
 * 本端点的放行条件（二选一，**没有"默认敞开"这一档**）：
 *   ① 管理员会话 cookie —— 人在后台时能直接打开看；
 *   ② 请求头 `x-metrics-key` 命中系统设置 `metrics_key`。
 *      没配置 `metrics_key` 时这条**永远不通过**（不是"配了空就等于放行"）。
 *
 * 另外指标本身也不带账号 id / cookie / 代理串 / 出口 IP 作为标签 ——
 * 只有状态聚合计数（见 metrics.js 文件头的两条硬约束）。
 */
import express from 'express';
import { db, getSetting } from '../db.js';
import { chainTextSnapshot } from '../dola/chain-text-rules.js';
import { generationStatus } from '../dola/generator.js';
import { buildAlerts, buildMetricsPayload, collectMetrics } from '../metrics.js';

const router = express.Router();

/** 抓取密钥校验：用**定长比较**避免早退（早退会泄漏"前缀对了几个字符"）。 */
function scrapeKeyOk(provided) {
  const expected = String(getSetting('metrics_key', '') || '').trim();
  if (!expected) return false;            // 未配置 ⇒ 一律不放行
  const got = String(provided || '');
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function allow(req) {
  if (req.user) return true;
  if (scrapeKeyOk(req.headers['x-metrics-key'])) return true;
  return false;
}

router.get('/metrics', (req, res) => {
  if (!allow(req)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
    return res.status(401).type('text/plain').send('unauthorized: metrics 需要管理员会话或 x-metrics-key\n');
  }
  try {
    const { text } = buildMetricsPayload({ db, chainTextSnapshot, generationStatus });
    return res.type('text/plain; version=0.0.4; charset=utf-8').send(text);
  } catch (error) {
    // 采集失败不要回 200 + 半截指标：Prometheus 会把缺失的序列当成"没数据"，
    // 静默丢掉一个坏掉的导出器，比响亮地报 500 危险得多。
    console.error('[metrics] 采集失败:', error);
    return res.status(500).type('text/plain').send(`# metrics collection failed: ${error.message}\n`);
  }
});

/**
 * `GET /metrics.json` —— 同一份快照的结构化版本 + 告警列表。
 *
 * 存在的理由：人排障时不该去 grep 文本指标。文本格式给机器，JSON 给人。
 * 数据同源（同一个 collectMetrics），所以两边永远不会不一致。
 */
router.get('/metrics.json', (req, res) => {
  if (!allow(req)) return res.status(401).json({ ok: false, message: '未授权' });
  try {
    const snapshot = collectMetrics({ db, chainTextSnapshot, generationStatus });
    return res.json({ ok: true, snapshot, alerts: buildAlerts(snapshot) });
  } catch (error) {
    console.error('[metrics] 快照失败:', error);
    return res.status(500).json({ ok: false, message: error.message });
  }
});

export default router;
