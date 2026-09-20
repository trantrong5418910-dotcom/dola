import { db } from './db.js';

/**
 * 写一条操作日志。所有会改数据的接口都该调它。
 *
 * ⚠️ 血泪教训：不要用 `{...req, user: {...}}` 这种方式换操作人 ——
 * Node 的 `req.headers` / `req.socket` 是原型上的 getter，展开运算符不会复制它们，
 * 结果 `clientIp()` 抛 TypeError，被下面的 catch 静默吞掉，表现是「登录日志永远不落库、
 * 但接口一切正常」。要换操作人请用第 6 个参数 actor。
 *
 * @param {object} req
 * @param {string} action
 * @param {string} [targetType]
 * @param {string|number} [targetId]
 * @param {string} [detail]
 * @param {{id?:number|null, username?:string}} [actor] 覆盖记录的操作人（登录接口用）
 */
export function audit(req, action, targetType = '', targetId = '', detail = '', actor = null) {
  try {
    const user = actor ?? req?.user ?? null;
    db.prepare(`INSERT INTO audit_logs (user_id,username,action,target_type,target_id,detail,ip,created_at)
                VALUES (?,?,?,?,?,?,?,?)`).run(
      user?.id ?? null,
      user?.username ?? 'anonymous',
      action,
      targetType,
      String(targetId ?? ''),
      typeof detail === 'string' ? detail : JSON.stringify(detail),
      clientIp(req),
      new Date().toISOString(),
    );
  } catch (e) {
    // 日志失败不能影响主流程，但也绝不能一声不吭 —— 否则这类 bug 会藏很久
    console.error('[audit] 写日志失败:', e.message, '| action =', action);
  }
}

export function clientIp(req) {
  const xf = req?.headers?.['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req?.socket?.remoteAddress || '';
}

/** 列表查询的统一分页/搜索辅助 */
export function paged(sql, countSql, params, { page = 1, pageSize = 20 }) {
  const total = db.prepare(countSql).get(...params).c;
  const rows = db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize));
  return { items: rows, total, page: Number(page), pageSize: Number(pageSize) };
}
