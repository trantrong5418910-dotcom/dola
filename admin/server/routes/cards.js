/**
 * 充值卡（卡密）管理：生成 / 列表 / 批次 / 撤销 / 删除 / 导出 / 手动兑换。
 *
 * 兑换用 `UPDATE ... WHERE id=? AND status='unused'` 的 changes 做并发保护，
 * 即使两个人同时提交同一张卡，也只有一个能成功。
 */
import express from 'express';
import { db } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { audit } from '../audit.js';
import {
  generateCardCode, maskValue, insertMany, makeBatchNo, MAX_BATCH,
  expiresAtFromDays, toCsv,
} from '../generate.js';

const router = express.Router();
router.use(requireAuth);

const LIST_SQL = `SELECT c.id, c.code, c.prefix, c.points, c.status, c.batch_no, c.note,
                         c.redeemed_by_token, c.redeemed_at, c.expires_at,
                         c.created_at, c.updated_at,
                         t.prefix AS token_prefix, u.username AS created_by_name
                  FROM cards c
                  LEFT JOIN tokens t ON t.id = c.redeemed_by_token
                  LEFT JOIN users u ON u.id = c.created_by`;

function toRow(r) {
  return { ...r, code: maskValue(r.code) };
}

/** GET /api/cards */
router.get('/', requirePerm('card:list'), (req, res) => {
  const { page = 1, pageSize = 20, keyword = '', status = '', batch = '', points = '' } = req.query;
  const where = [];
  const params = [];
  if (keyword) {
    where.push('(c.note LIKE ? OR c.prefix LIKE ? OR c.code LIKE ? OR c.batch_no LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (status) { where.push('c.status = ?'); params.push(status); }
  if (batch) { where.push('c.batch_no = ?'); params.push(batch); }
  if (points !== '') { where.push('c.points = ?'); params.push(Number(points)); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM cards c${w}`).get(...params).c;
  const items = db.prepare(`${LIST_SQL}${w} ORDER BY c.id DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize));
  const summary = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='unused' THEN 1 ELSE 0 END) AS unused,
      SUM(CASE WHEN status='redeemed' THEN 1 ELSE 0 END) AS redeemed,
      SUM(CASE WHEN status='revoked' THEN 1 ELSE 0 END) AS revoked,
      COALESCE(SUM(CASE WHEN status='unused' THEN points ELSE 0 END),0) AS unused_points,
      COALESCE(SUM(CASE WHEN status='redeemed' THEN points ELSE 0 END),0) AS redeemed_points
    FROM cards`).get();
  res.json({ ok: true, items: items.map(toRow), total, page: Number(page), pageSize: Number(pageSize), summary });
});

/** GET /api/cards/summary —— 生成对话框里显示「本次将生成」的参照信息 */
router.get('/summary', requirePerm('card:list'), (req, res) => {
  const s = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='unused' THEN 1 ELSE 0 END) AS unused,
      COALESCE(SUM(CASE WHEN status='unused' THEN points ELSE 0 END),0) AS unused_points
    FROM cards`).get();
  res.json({ ok: true, ...s, maxBatch: MAX_BATCH });
});

/** GET /api/cards/batches —— 批次下拉 */
router.get('/batches', requirePerm('card:list'), (req, res) => {
  const items = db.prepare(`SELECT batch_no,
      COUNT(*) AS total,
      SUM(CASE WHEN status='unused' THEN 1 ELSE 0 END) AS unused,
      SUM(CASE WHEN status='redeemed' THEN 1 ELSE 0 END) AS redeemed,
      MIN(points) AS min_points, MAX(points) AS max_points, MIN(created_at) AS created_at
    FROM cards WHERE batch_no <> '' GROUP BY batch_no ORDER BY created_at DESC LIMIT 200`).all();
  res.json({ ok: true, items });
});

/** POST /api/cards/generate  { count, points, batchNo?, note?, expiresInDays? } */
router.post('/generate', requirePerm('card:generate'), (req, res) => {
  const count = Math.min(Math.max(Number(req.body?.count) || 1, 1), MAX_BATCH);
  const points = Number(req.body?.points);
  if (!Number.isFinite(points) || points <= 0) {
    return res.status(400).json({ ok: false, message: '卡密面额必须是正整数' });
  }
  const batch_no = String(req.body?.batchNo || '').trim() || makeBatchNo();
  const note = String(req.body?.note || '').trim();
  const expires_at = expiresAtFromDays(req.body?.expiresInDays);

  const now = new Date().toISOString();
  const rows = Array.from({ length: count }, () => ({ points, batch_no, note, expires_at, created_by: req.user.id, now }));
  const created = insertMany(db, 'cards', generateCardCode, rows);

  audit(req, 'card.generate', 'card', created.map((c) => c.id).join(','),
    `批次 ${batch_no}，${count} 张 × ${points} 积分`);
  res.status(201).json({ ok: true, items: created, count: created.length, batchNo: batch_no, points });
});

/**
 * POST /api/cards/redeem  { code, tokenId }
 * 手动兑换：把卡密面额加到指定令牌的积分上。后台自测/客服补单都用得上。
 */
router.post('/redeem', requirePerm('card:redeem'), (req, res) => {
  const code = String(req.body?.code || '').trim();
  const tokenId = Number(req.body?.tokenId);
  if (!code) return res.status(400).json({ ok: false, message: '请输入卡密' });
  if (!tokenId) return res.status(400).json({ ok: false, message: '请选择要充值的令牌' });

  const card = db.prepare('SELECT * FROM cards WHERE code = ?').get(code);
  if (!card) return res.status(404).json({ ok: false, message: '卡密不存在' });
  if (card.status === 'redeemed') {
    return res.status(409).json({ ok: false, message: `该卡密已于 ${card.redeemed_at} 被兑换` });
  }
  if (card.status === 'revoked') return res.status(400).json({ ok: false, message: '该卡密已被撤销' });
  if (card.expires_at && new Date(card.expires_at) < new Date()) {
    return res.status(400).json({ ok: false, message: `该卡密已于 ${card.expires_at} 过期` });
  }

  const token = db.prepare('SELECT * FROM tokens WHERE id = ?').get(tokenId);
  if (!token) return res.status(404).json({ ok: false, message: '令牌不存在' });
  if (token.status !== 'active') return res.status(400).json({ ok: false, message: `令牌当前状态为 ${token.status}，不能充值` });

  const now = new Date().toISOString();
  // 关键：带上 status='unused' 条件，靠 changes 兜住并发重复兑换
  const info = db.prepare('UPDATE cards SET status=?, redeemed_by_token=?, redeemed_at=?, updated_at=? WHERE id=? AND status=?')
    .run('redeemed', tokenId, now, now, card.id, 'unused');
  if (!info.changes) {
    return res.status(409).json({ ok: false, message: '卡密已被其他请求兑换，请刷新后重试' });
  }
  db.prepare('UPDATE tokens SET points = points + ?, updated_at=? WHERE id=?').run(card.points, now, tokenId);

  const after = db.prepare('SELECT points FROM tokens WHERE id = ?').get(tokenId).points;
  audit(req, 'card.redeem', 'card', card.id, `${card.prefix} 面额 ${card.points} → 令牌 ${token.prefix}（余额 ${after}）`);
  res.json({ ok: true, points: card.points, tokenId, tokenPoints: after, tokenPrefix: token.prefix });
});

/** GET /api/cards/export */
router.get('/export', requirePerm('card:list'), (req, res) => {
  const { status = '', batch = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (batch) { where.push('batch_no = ?'); params.push(batch); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT id, code, prefix, points, status, batch_no, note, redeemed_at, expires_at, created_at
                           FROM cards${w} ORDER BY id DESC`).all(...params);
  const csv = toCsv(
    ['ID', '卡密', '前缀', '面额', '状态', '批次', '备注', '兑换时间', '过期时间', '创建时间'],
    rows.map((r) => [r.id, r.code, r.prefix, r.points, r.status, r.batch_no, r.note, r.redeemed_at ?? '', r.expires_at ?? '', r.created_at]),
  );
  audit(req, 'card.export', 'card', '', `导出 ${rows.length} 条`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cards-${Date.now()}.csv"`);
  res.send(csv);
});

/** GET /api/cards/:id/reveal —— 看单张卡的完整卡密 */
router.get('/:id/reveal', requirePerm('card:list'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id, code, prefix, status FROM cards WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, message: '卡密不存在' });
  audit(req, 'card.reveal', 'card', id, row.prefix);
  res.json({ ok: true, id: row.id, code: row.code, status: row.status });
});

/** POST /api/cards/:id/action  { action: 'revoke' | 'restore' } */
router.post('/:id/action', requirePerm('card:update'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, message: '卡密不存在' });

  const action = String(req.body?.action || '');
  const now = new Date().toISOString();

  if (action === 'revoke') {
    if (row.status === 'redeemed') return res.status(400).json({ ok: false, message: '已兑换的卡密不能撤销' });
    db.prepare('UPDATE cards SET status=?, updated_at=? WHERE id=?').run('revoked', now, id);
    audit(req, 'card.revoke', 'card', id, row.prefix);
    return res.json({ ok: true, status: 'revoked' });
  }
  if (action === 'restore') {
    if (row.status !== 'revoked') return res.status(400).json({ ok: false, message: '只有已撤销的卡密可以恢复' });
    db.prepare('UPDATE cards SET status=?, updated_at=? WHERE id=?').run('unused', now, id);
    audit(req, 'card.restore', 'card', id, row.prefix);
    return res.json({ ok: true, status: 'unused' });
  }
  return res.status(400).json({ ok: false, message: `不支持的动作：${action}` });
});

/**
 * DELETE /api/cards/:id
 * 已兑换的卡默认不给删（保留兑换记录）。确实要清理测试数据时加 ?force=1，
 * 同样要求 card:delete 权限，并且会写一条 force_delete 审计。
 */
router.delete('/:id', requirePerm('card:delete'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT prefix, status FROM cards WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, message: '卡密不存在' });

  const force = req.query.force === '1' || req.body?.force === true;
  if (row.status === 'redeemed' && !force) {
    return res.status(400).json({
      ok: false,
      message: '已兑换的卡密不能删除，请保留兑换记录（确实要清理请加 force=1，会留审计）',
    });
  }
  db.prepare('DELETE FROM cards WHERE id = ?').run(id);
  audit(req, force && row.status === 'redeemed' ? 'card.force_delete' : 'card.delete', 'card', id, row.prefix);
  res.json({ ok: true, forced: Boolean(force && row.status === 'redeemed') });
});

/** DELETE /api/cards —— 批量删除未使用的，body {ids:[]} */
router.delete('/', requirePerm('card:delete'), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ ok: false, message: '没有选中任何记录' });
  const stmt = db.prepare("DELETE FROM cards WHERE id = ? AND status <> 'redeemed'");
  let deleted = 0;
  for (const id of ids) deleted += stmt.run(id).changes;
  audit(req, 'card.bulk_delete', 'card', ids.join(','), `删除 ${deleted} 张（已兑换的自动跳过）`);
  res.json({ ok: true, deleted, skipped: ids.length - deleted });
});

export default router;
