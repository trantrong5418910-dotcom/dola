/** Generation billing is synchronous and transactional; no network or global DB. */
function atomic(db, work) {
  db.exec('SAVEPOINT generation_billing');
  try {
    const result = work();
    db.exec('RELEASE SAVEPOINT generation_billing');
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT generation_billing');
    db.exec('RELEASE SAVEPOINT generation_billing');
    throw error;
  }
}

export function chargeVideoTask(db, { taskId, tokenId, points }) {
  if (!Number.isSafeInteger(points) || points <= 0) throw new Error('invalid_video_price');
  return atomic(db, () => {
    const row = db.prepare('SELECT * FROM dola_videos WHERE id=?').get(taskId);
    const token = db.prepare('SELECT * FROM tokens WHERE id=?').get(tokenId);
    if (!row || row.owner_token_id !== tokenId || row.status !== 'queued') {
      throw Object.assign(new Error('任务不可扣费'), { status: 409 });
    }
    const at = new Date().toISOString();
    if (!token || token.status !== 'active' || (token.expires_at && Date.parse(token.expires_at) <= Date.now())) {
      throw Object.assign(new Error('访问令牌已停用或过期'), { status: 403 });
    }
    const ref = `gen-${row.id}`;
    const existing = db.prepare("SELECT * FROM point_transactions WHERE kind='consume' AND ref=?").get(ref);
    if (existing && (existing.token_id !== tokenId || existing.delta !== points)) throw new Error('video_charge_conflict');
    if (!existing) {
      const updated = db.prepare("UPDATE tokens SET points=points-?,updated_at=? WHERE id=? AND status='active' AND points>=?")
        .run(points, at, tokenId, points);
      if (!updated.changes) throw Object.assign(new Error(`积分不足（需要 ${points}，当前 ${token.points}）`), { status: 402, balance: token.points });
      db.prepare(`INSERT INTO point_transactions (token_id,token_prefix,delta,kind,reason,ref,created_at)
                  VALUES (?,?,?,'consume','video',?,?)`).run(tokenId, token.prefix, points, ref, at);
    }
    db.prepare('UPDATE dola_videos SET charge_ref=? WHERE id=?').run(ref, taskId);
    return { chargeRef: ref, balance: db.prepare('SELECT points FROM tokens WHERE id=?').get(tokenId).points, duplicated: Boolean(existing) };
  });
}

/** Reads the current state again; a stale polling result cannot refund a live task. */
export function settleFailedVideoRefund(db, row, { cancelledBeforeSubmit = false } = {}) {
  if (!row) return { refunded: false };
  return atomic(db, () => {
    const current = db.prepare('SELECT * FROM dola_videos WHERE id=?').get(row.id);
    if (!current || (current.status !== 'failed'
        && !(cancelledBeforeSubmit && row.status === 'queued' && current.status === 'cancelled' && !current.conversation_id))) {
      return { refunded: false };
    }
    const ref = current.charge_ref || `gen-${current.id}`;
    const consume = db.prepare("SELECT * FROM point_transactions WHERE kind='consume' AND ref=?").get(ref);
    if (!consume || consume.token_id !== current.owner_token_id) return { refunded: false };
    if (!Number.isSafeInteger(consume.delta) || consume.delta <= 0) throw new Error('invalid_video_charge');
    const existing = db.prepare("SELECT * FROM point_transactions WHERE kind='refund' AND ref=?").get(ref);
    if (existing && (existing.token_id !== consume.token_id || existing.delta !== consume.delta)) throw new Error('video_refund_conflict');
    if (!existing) {
      const at = new Date().toISOString();
      const updated = db.prepare('UPDATE tokens SET points=points+?,updated_at=? WHERE id=?').run(consume.delta, at, consume.token_id);
      if (!updated.changes) throw new Error('video_refund_account_missing');
      db.prepare(`INSERT INTO point_transactions (token_id,token_prefix,delta,kind,reason,ref,created_at)
                  VALUES (?,?,?,'refund',?,?,?)`).run(consume.token_id, consume.token_prefix, consume.delta,
        current.status === 'cancelled' ? '提交前取消退款' : '生成失败自动退款', ref, at);
    }
    return { refunded: true, duplicated: Boolean(existing), points: consume.delta,
      balance: db.prepare('SELECT points FROM tokens WHERE id=?').get(consume.token_id).points };
  });
}
