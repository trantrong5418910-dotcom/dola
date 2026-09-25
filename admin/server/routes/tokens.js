/**
 * 令牌管理：生成 / 列表 / 查看完整值 / 启停 / 改积分 / 删除 / 导出。
 *
 * 安全约定：
 *   - 列表只返回前缀和掩码，完整值只在「生成响应」和「reveal 接口」里出现
 *   - reveal 会写审计日志（谁在什么时候看了哪个令牌）
 */
import express from 'express';
import { db } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { audit } from '../audit.js';
import {
  generateTokenValue, maskValue, insertMany, MAX_BATCH,
  expiresAtFromDays, toCsv,
} from '../generate.js';
import { parseDailyPointsLimit } from '../dola/gateway-quota.js';

const router = express.Router();
router.use(requireAuth);

// `daily_points_limit` 要回给前端：否则界面上没法显示「这个令牌是跟随全局还是自己设了」。
const LIST_SQL = `SELECT t.id, t.name, t.value, t.prefix, t.points, t.status, t.expires_at, t.note,
                         t.created_at, t.updated_at, t.daily_points_limit,
                         u.username AS created_by_name
                  FROM tokens t LEFT JOIN users u ON u.id = t.created_by`;

/** 列表项：完整值换成掩码 */
function toRow(r, { full = false } = {}) {
  return { ...r, value: full ? r.value : maskValue(r.value), hasFull: !full };
}

const STATUSES = ['active', 'disabled', 'revoked'];

/** GET /api/tokens */
router.get('/', requirePerm('token:list'), (req, res) => {
  const { page = 1, pageSize = 20, keyword = '', status = '' } = req.query;
  const where = [];
  const params = [];
  if (keyword) {
    where.push('(t.name LIKE ? OR t.prefix LIKE ? OR t.value LIKE ? OR t.note LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (status) { where.push('t.status = ?'); params.push(status); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM tokens t${w}`).get(...params).c;
  const items = db.prepare(`${LIST_SQL}${w} ORDER BY t.id DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize));
  const summary = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status='disabled' THEN 1 ELSE 0 END) AS disabled,
      SUM(CASE WHEN status='revoked' THEN 1 ELSE 0 END) AS revoked,
      COALESCE(SUM(points),0) AS points
    FROM tokens`).get();
  res.json({ ok: true, items: items.map((r) => toRow(r)), total, page: Number(page), pageSize: Number(pageSize), summary });
});

/** POST /api/tokens/generate  { count, points, name, note, expiresInDays, dailyPointsLimit } */
router.post('/generate', requirePerm('token:generate'), (req, res) => {
  const count = Math.min(Math.max(Number(req.body?.count) || 1, 1), MAX_BATCH);
  const points = Number(req.body?.points) || 0;
  const name = String(req.body?.name || '').trim();
  const note = String(req.body?.note || '').trim();
  const expires_at = expiresAtFromDays(req.body?.expiresInDays);

  if (points < 0) return res.status(400).json({ ok: false, message: '初始积分不能为负' });
  const limit = parseDailyPointsLimit(req.body?.dailyPointsLimit ?? null);
  if (!limit.ok) return res.status(400).json({ ok: false, message: limit.message });

  const now = new Date().toISOString();
  const rows = Array.from({ length: count }, () => ({ points, name, note, expires_at, created_by: req.user.id, now }));
  const created = insertMany(db, 'tokens', generateTokenValue, rows);

  // 生成时带上日上限。`insertMany` 的列是硬编码的（改它会连带影响卡密），
  // 所以这里在插入之后补一次 UPDATE —— 新行此刻还没有别的调用方，不存在竞态。
  if (limit.value !== null && created.length) {
    db.prepare(`UPDATE tokens SET daily_points_limit=? WHERE id IN (${created.map(() => '?').join(',')})`)
      .run(limit.value, ...created.map((c) => c.id));
  }

  audit(req, 'token.generate', 'token', created.map((c) => c.id).join(','),
    [`生成 ${count} 个，每个 ${points} 积分`, describeDailyLimit(limit.value)].filter(Boolean).join('；'));
  // 完整值只在这里返回一次，前端要提示用户复制走
  res.status(201).json({ ok: true, items: created, count: created.length, daily_points_limit: limit.value });
});

/** 审计文案：把三态说成人话。 */
function describeDailyLimit(v) {
  if (v === null || v === undefined) return '';
  if (v === 0) return '每日上限：不限（覆盖全局）';
  return `每日上限：${v} 积分`;
}

/**
 * GET /api/tokens/export —— 导出 CSV，**含完整令牌值**。
 *
 * 权限必须是 `token:reveal` 而不是 `token:list`。
 * 踩过的坑：这里原本只要求 `token:list`（语义是「查看令牌」），
 * 但 SQL 里 `SELECT ... value ...` 把完整令牌明文写进了 CSV ——
 * 于是一个只读角色导出一次，就能拿到所有令牌，等于接管所有人的积分。
 * 项目里其实已经有专门的 `token:reveal` 权限点，这里漏用了。
 *
 * 另注：原注释写着「body 不带完整值」，与实现完全相反，已一并订正。
 */
router.get('/export', requirePerm('token:reveal'), (req, res) => {
  const status = req.query.status || '';
  const rows = db.prepare(`SELECT id, name, prefix, value, points, status, expires_at, created_at
                           FROM tokens ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC`)
    .all(...(status ? [status] : []));
  const csv = toCsv(
    ['ID', '名称', '前缀', '完整令牌', '积分', '状态', '过期时间', '创建时间'],
    rows.map((r) => [r.id, r.name, r.prefix, r.value, r.points, r.status, r.expires_at ?? '', r.created_at]),
  );
  audit(req, 'token.export', 'token', '', `导出 ${rows.length} 条（含完整令牌值）`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tokens-${Date.now()}.csv"`);
  res.send(csv);
});

/**
 * GET /api/tokens/options —— 兑换对话框用的轻量选项。
 * 只要求登录、不要求 token:list：兑换卡密时得选令牌，
 * 但「能兑换」和「能查令牌列表」是两件事，别互相卡住。
 */
router.get('/options', (req, res) => {
  const items = db.prepare(`SELECT id, name, prefix, points FROM tokens
                            WHERE status = 'active' ORDER BY id DESC LIMIT 500`).all();
  res.json({ ok: true, items });
});

/** GET /api/tokens/:id/reveal —— 查看完整值（写日志） */
router.get('/:id/reveal', requirePerm('token:reveal'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id, name, value, prefix FROM tokens WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, message: '令牌不存在' });
  audit(req, 'token.reveal', 'token', id, row.prefix);
  res.json({ ok: true, id: row.id, name: row.name, value: row.value });
});

/**
 * POST /api/tokens/:id/action  { action, delta?, days?, dailyPointsLimit? }
 *   disable / enable / revoke   —— 改状态
 *   points { delta }            —— 增减积分
 *   expire { days }             —— 设/清过期时间（days<=0 清除）
 *   daily_limit { dailyPointsLimit } —— 设每令牌每日积分上限
 *       留空/null = 跟随全局设置；0 = 该令牌不限；正数 = 上限
 */
router.post('/:id/action', requirePerm('token:update'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM tokens WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, message: '令牌不存在' });

  const now = new Date().toISOString();
  const action = String(req.body?.action || '');

  if (action === 'disable' || action === 'enable' || action === 'revoke') {
    if (row.status === 'revoked' && action !== 'revoke') {
      return res.status(400).json({ ok: false, message: '已撤销的令牌不可再启用' });
    }
    const status = action === 'enable' ? 'active' : action === 'disable' ? 'disabled' : 'revoked';
    db.prepare('UPDATE tokens SET status=?, updated_at=? WHERE id=?').run(status, now, id);
    audit(req, `token.${action}`, 'token', id, row.prefix);
    return res.json({ ok: true, status });
  }

  if (action === 'points') {
    const delta = Number(req.body?.delta);
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ ok: false, message: '请给出非零的积分增减值' });
    }
    const next = row.points + delta;
    if (next < 0) return res.status(400).json({ ok: false, message: `扣减后积分为负（当前 ${row.points}）` });
    db.prepare('UPDATE tokens SET points=?, updated_at=? WHERE id=?').run(next, now, id);
    audit(req, 'token.points', 'token', id, `${delta > 0 ? '+' : ''}${delta} → ${next}`);
    return res.json({ ok: true, points: next });
  }

  if (action === 'expire') {
    const expires_at = expiresAtFromDays(req.body?.days);
    db.prepare('UPDATE tokens SET expires_at=?, updated_at=? WHERE id=?').run(expires_at, now, id);
    audit(req, 'token.expire', 'token', id, expires_at ?? '清除过期时间');
    return res.json({ ok: true, expires_at });
  }

  if (action === 'daily_limit') {
    const parsed = parseDailyPointsLimit(req.body?.dailyPointsLimit ?? null);
    if (!parsed.ok) return res.status(400).json({ ok: false, message: parsed.message });
    db.prepare('UPDATE tokens SET daily_points_limit=?, updated_at=? WHERE id=?').run(parsed.value, now, id);
    audit(req, 'token.daily_limit', 'token', id, describeDailyLimit(parsed.value) || '恢复跟随全局设置');
    return res.json({ ok: true, daily_points_limit: parsed.value });
  }

  return res.status(400).json({ ok: false, message: `不支持的动作：${action}` });
});

/**
 * DELETE /api/tokens/:id
 * 有兑换记录 / 积分流水的令牌默认不给删（保留资金流水）。
 * 清理测试数据加 ?force=1，会写 force_delete 审计。
 */
router.delete('/:id', requirePerm('token:delete'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT prefix FROM tokens WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, message: '令牌不存在' });

  const used = db.prepare('SELECT COUNT(*) AS c FROM cards WHERE redeemed_by_token = ?').get(id).c;
  const ptx = db.prepare('SELECT COUNT(*) AS c FROM point_transactions WHERE token_id = ?').get(id).c;
  const force = req.query.force === '1' || req.body?.force === true;

  if ((used > 0 || ptx > 0) && !force) {
    const why = [
      used ? `${used} 条兑换记录` : null,
      ptx ? `${ptx} 条积分流水` : null,
    ].filter(Boolean).join('、');
    return res.status(400).json({
      ok: false,
      message: `该令牌有${why}，建议改为「撤销」而不是删除（确实要清理请加 force=1，会留审计）`,
    });
  }

  // 强删：先把引用它的流水清掉，否则外键会拦（用户端消费记录 → 令牌）
  if (ptx > 0) db.prepare('DELETE FROM point_transactions WHERE token_id = ?').run(id);
  db.prepare('DELETE FROM tokens WHERE id = ?').run(id);

  audit(req, (used > 0 || ptx > 0) ? 'token.force_delete' : 'token.delete', 'token', id,
    [row.prefix, used ? `含 ${used} 条兑换记录` : null, ptx ? `含 ${ptx} 条积分流水` : null].filter(Boolean).join('，'));
  res.json({ ok: true, forced: Boolean((used > 0 || ptx > 0) && force) });
});

export { STATUSES };
export default router;
