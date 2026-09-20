/** Only explicit session-expiry responses justify automatic quarantine. */
const DEAD_CODES = new Set([710012001, 710012014]);

export function accountHealth(session, profile) {
  const responses = [
    [session.pullStatus, session.pullCode],
    [session.launchStatus, session.launchCode],
    [profile.status, profile.code],
  ];
  const dead = responses.find(([status, code]) => status === 200 && DEAD_CODES.has(Number(code)));
  if (dead && profile.ok) return { kind: 'unknown', message: '会话接口结果不一致，等待复查' };
  if (dead) return { kind: 'invalid', message: `会话已失效（code=${dead[1]}）` };
  if (profile.ok && session.valid) return { kind: 'valid', message: '' };
  return { kind: 'unknown', message: `暂未完成校验（HTTP=${profile.status || 0}，code=${profile.code ?? '-'}），保留原状态` };
}

// Account balance fields only. Model configuration, costs and daily limits are not balances.
const BALANCE_ENDPOINTS = new Set([
  '/alice/profile/self_brief', '/alice/user/launch', '/alice/commerce/sale/subscription/entry/config/',
]);
export function creditBalanceFromHits(hits, endpoint) {
  if (!BALANCE_ENDPOINTS.has(endpoint)) return null;
  return (hits || []).find(({ field, value }) => {
    if (!Number.isFinite(value) || value < 0) return false;
    if (/config|model|cost|price|multiplier|total|used|limit|\[/i.test(field)) return false;
    return /^data\.(?:(?:user_info|profile_brief|credit_info|credits_info)\.)?(credit_balance|remaining_credits|available_credits|credits_remaining|credits_available)$/i.test(field)
      || /^data\.(credit_info|credits_info)\.balance$/i.test(field);
  }) || null;
}

export function parseVideoQuotaReceipt(raw) {
  const text = String(raw || '');
  const remaining = text.match(/今日剩余\s*(\d+)\s*个视频生成额度/);
  const cost = text.match(/消耗\s*(\d+)\s*个视频生成额度/);
  return { remaining: remaining ? Number(remaining[1]) : null, cost: cost ? Number(cost[1]) : null };
}

/** UTC-day freshness is a conservative display policy, not a claim about upstream reset time. */
export function quotaObservation(row, at = new Date().toISOString()) {
  const value = row.quota_remaining;
  if (value == null || !Number.isFinite(value) || value < 0) return { state: 'unknown', remaining: null };
  const fresh = row.quota_source === 'generation_receipt' && row.quota_at
    && row.quota_at.slice(0, 10) === at.slice(0, 10) && row.quota_at <= at;
  return { state: fresh ? 'confirmed' : 'stale', remaining: fresh ? value : null };
}

export function summarizeQuota(rows, at = new Date().toISOString()) {
  const usable = rows.filter(r => r.status === 'valid' && (!r.cooldown_until || r.cooldown_until <= at));
  const observations = usable.map(r => quotaObservation(r, at));
  const known = observations.filter(r => r.state === 'confirmed');
  return {
    quotaRemaining: known.length ? known.reduce((sum, r) => sum + r.remaining, 0) : null,
    quotaKnown: known.length,
    quotaUnknown: observations.length - known.length,
    quotaStale: observations.filter(r => r.state === 'stale').length,
  };
}
