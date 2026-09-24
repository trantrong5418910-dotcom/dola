import express from 'express';
import { db } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';

const router = express.Router();
router.use(requireAuth);

/** GET /api/logs —— 分页 + 按人/动作筛选 */
router.get('/', requirePerm('log:list'), (req, res) => {
  const { page = 1, pageSize = 20, keyword = '', action = '' } = req.query;
  const where = [];
  const params = [];
  if (keyword) { where.push('(username LIKE ? OR detail LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  if (action) { where.push('action = ?'); params.push(action); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs${w}`).get(...params).c;
  const items = db.prepare(`SELECT id,user_id,username,action,target_type,target_id,detail,ip,created_at
                            FROM audit_logs${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize));
  res.json({ ok: true, items, total, page: Number(page), pageSize: Number(pageSize) });
});

/** GET /api/logs/actions —— 已有动作列表（筛选下拉用） */
router.get('/actions', requirePerm('log:list'), (req, res) => {
  const rows = db.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all();
  res.json({ ok: true, items: rows.map((r) => r.action) });
});

/** GET /api/logs/diagnostics —— 只导出不含账号/任务原文的汇总诊断包 */
router.get('/diagnostics', requirePerm('log:list'), (_req, res) => {
  const generatedAtDate = new Date();
  const generatedAt = generatedAtDate.toISOString();
  const since = new Date(generatedAtDate.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const countAllowed = (field, allowed) => {
    if (!['status', 'native_15s_state', 'native_30s_state', 'reference_image_state'].includes(field)) {
      throw new Error('诊断字段不在白名单内');
    }
    const placeholders = [...allowed].map(() => '?').join(',');
    const rows = db.prepare(`SELECT CASE WHEN ${field} IN (${placeholders}) THEN ${field} ELSE 'other' END AS state,
                                    COUNT(*) AS count
                             FROM dola_accounts GROUP BY state`).all(...allowed);
    const counts = Object.fromEntries([...allowed].map((value) => [value, 0]));
    counts.other = 0;
    for (const row of rows) {
      counts[row.state] = Number(row.count) || 0;
    }
    return counts;
  };

  const accountStatus = new Set(['unknown', 'valid', 'invalid', 'disabled']);
  const capabilityState = new Set(['unknown', 'available', 'unavailable']);
  const utcDay = generatedAt.slice(0, 10);
  const accountSummary = db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN cooldown_until IS NOT NULL AND cooldown_until > ? THEN 1 ELSE 0 END) AS cooling,
    SUM(CASE WHEN status='valid' AND quota_remaining IS NOT NULL AND quota_remaining >= 0
      AND quota_source='generation_receipt' AND quota_at IS NOT NULL
      AND substr(quota_at,1,10)=? AND quota_at <= ? THEN 1 ELSE 0 END) AS quota_confirmed,
    SUM(CASE WHEN status='valid' AND quota_remaining = 0
      AND quota_source='generation_receipt' AND quota_at IS NOT NULL
      AND substr(quota_at,1,10)=? AND quota_at <= ? THEN 1 ELSE 0 END) AS quota_confirmed_zero,
    SUM(CASE WHEN status='valid' AND quota_remaining IS NOT NULL AND quota_remaining >= 0
      AND NOT (quota_source='generation_receipt' AND quota_at IS NOT NULL
        AND substr(quota_at,1,10)=? AND quota_at <= ?) THEN 1 ELSE 0 END) AS quota_stale,
    SUM(CASE WHEN status='valid' AND (quota_remaining IS NULL OR quota_remaining < 0) THEN 1 ELSE 0 END) AS quota_unknown
    FROM dola_accounts`).get(generatedAt, utcDay, generatedAt, utcDay, generatedAt, utcDay, generatedAt);
  const quota = {
    confirmed: Number(accountSummary.quota_confirmed) || 0,
    stale: Number(accountSummary.quota_stale) || 0,
    unknown: Number(accountSummary.quota_unknown) || 0,
    confirmedZero: Number(accountSummary.quota_confirmed_zero) || 0,
  };

  const videoStatuses = new Set(['queued', 'submitting', 'generating', 'resolving', 'ready', 'failed', 'cancelled']);
  const durations = new Set(['10', '15', '20', '30']);
  const ratios = new Set(['16:9', '9:16', '1:1', '3:4', '4:3']);
  const videoGroups = db.prepare(`SELECT
                                   CASE WHEN status IN ('queued','submitting','generating','resolving','ready','failed','cancelled') THEN status ELSE 'other' END AS safe_status,
                                   CASE WHEN seconds IN (10,15,20,30) THEN CAST(seconds AS TEXT) ELSE 'other' END AS safe_seconds,
                                   CASE WHEN ratio IN ('16:9','9:16','1:1','3:4','4:3') THEN ratio ELSE 'other' END AS safe_ratio,
                                   COUNT(*) AS count
                                 FROM dola_videos WHERE created_at >= ? AND created_at <= ?
                                 GROUP BY safe_status, safe_seconds, safe_ratio`).all(since, generatedAt);
  const generation = { windowDays: 7, windowStart: since, windowEnd: generatedAt, total: 0,
    byStatus: Object.fromEntries([...videoStatuses, 'other'].map((v) => [v, 0])),
    byDurationSeconds: Object.fromEntries([...durations, 'other'].map((v) => [v, 0])),
    byRatio: Object.fromEntries([...ratios, 'other'].map((v) => [v, 0])) };
  for (const row of videoGroups) {
    const count = Number(row.count) || 0;
    const status = videoStatuses.has(row.safe_status) ? row.safe_status : 'other';
    const seconds = durations.has(String(row.safe_seconds)) ? String(row.safe_seconds) : 'other';
    const ratio = ratios.has(row.safe_ratio) ? row.safe_ratio : 'other';
    generation.total += count;
    generation.byStatus[status] += count;
    generation.byDurationSeconds[seconds] += count;
    generation.byRatio[ratio] += count;
  }

  const jobStatuses = new Set(['queued', 'running', 'done', 'failed', 'cancelled']);
  const jobGroups = db.prepare(`SELECT CASE WHEN status IN ('queued','running','done','failed','cancelled') THEN status ELSE 'other' END AS safe_status,
                                       COUNT(*) AS jobs, COALESCE(SUM(total), 0) AS items
                                FROM jobs WHERE created_at >= ? AND created_at <= ? GROUP BY safe_status`).all(since, generatedAt);
  const jobs = { windowDays: 7, windowStart: since, windowEnd: generatedAt,
    byStatus: Object.fromEntries([...jobStatuses, 'other'].map((v) => [v, { jobs: 0, items: 0 }])) };
  for (const row of jobGroups) {
    const status = jobStatuses.has(row.safe_status) ? row.safe_status : 'other';
    jobs.byStatus[status] = { jobs: Number(row.jobs) || 0, items: Number(row.items) || 0 };
  }

  const bundle = {
    schemaVersion: 1,
    generatedAt,
    eventRowsIncluded: 0,
    privacy: '仅含汇总计数；不含账号标识、Cookie、令牌、代理、提示词、任务/日志原文、文件地址或 IP。',
    accounts: {
      total: Number(accountSummary.total) || 0,
      byStatus: countAllowed('status', accountStatus),
      cooling: Number(accountSummary.cooling) || 0,
      quota,
      capabilities: {
        native15Seconds: countAllowed('native_15s_state', capabilityState),
        native30Seconds: countAllowed('native_30s_state', capabilityState),
        referenceImages: countAllowed('reference_image_state', capabilityState),
      },
    },
    generation,
    batchJobs: jobs,
  };
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, fileName: `workbench-diagnostics-${generatedAt.slice(0, 10)}.json`, bundle });
});

export default router;
