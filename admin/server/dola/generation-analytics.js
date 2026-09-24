// Read-only task cohorts. This module never imports the application database.
export const FAILURE_REASONS = Object.freeze({
  rate_limit: { label: '上游限流', action: '保留账号并等待冷却；核验代理和请求频率。限流回执不能单独证明是共享 IP 导致。' },
  capability: { label: '时长 / 模型 / 视频入口未确认', action: '暂停该账号对应时长，先做只读能力复核；通过后再提交。' },
  reference: { label: '参考图控件未确认', action: '暂停该账号参考图任务，先复核图片上传控件。' },
  session: { label: '登录 / 身份 / 账号状态异常', action: '核验登录及身份，更新授权会话；不要反复重提生成。' },
  proxy: { label: '代理 / 出口未通过检查', action: '检查绑定代理的可达性与实际出口；不要仅凭代理配置判定可用。' },
  network: { label: '网络或等待超时', action: '检查代理、网络及上游任务状态；先排除已提交但回执丢失，避免重复扣额度。' },
  duration: { label: '成片时长验收失败', action: '核对请求时长和成片探测值，修正链路后再验收；不能视为已成功。' },
  archive: { label: '归档 / 媒体校验失败', action: '检查媒体地址、下载和存储空间；优先恢复原任务产物，避免重生成。' },
  interrupted: { label: '服务重启中断', action: '等待队列清空再重启；先核对上游状态和退款记录。' },
  billing: { label: '内部计费校验失败', action: '核对扣费与退款流水，不自动补扣或重提。' },
  receipt: { label: '未获得任务回执', action: '先核对上游是否已有任务，不能直接认定未扣额度或自动重试。' },
  request: { label: '请求参数校验拦截', action: '核对模型、时长和请求适配记录，修复提交链路后再验收；不要通过换号反复试。' },
  other: { label: '待人工核实', action: '查看对应任务记录，证据不足时不自动重试、不判定账号失效。' },
});

export function classifyFailure(message = '') {
  const text = String(message);
  let code = 'other';
  if (/710022002|上游限流|访问频繁|Too Many Requests|HTTP 429/i.test(text)) code = 'rate_limit';
  else if (/参考图.*(?:能力探测|控件|未确认|文件控件)/.test(text)) code = 'reference';
  else if (/能力探测未完成|未确认原生|没有可见的视频生成入口|页面未能确认.*模型|没有唯一可选.*时长|模型控件未完成/.test(text)) code = 'capability';
  else if (/已拦截提交|submissionBlocked/.test(text)) code = 'request';
  else if (/重启|服务中断/.test(text)) code = 'interrupted';
  else if (/计费|扣费|退款|charge/i.test(text)) code = 'billing';
  else if (/身份|登录|cookie|账号已(?:停用|删除)|会话失效|账号.*失效/i.test(text)) code = 'session';
  else if (/出口 IP|代理.*(?:未|缺|失败|变化)|proxy.*(?:fail|required)/i.test(text)) code = 'proxy';
  else if (/时长.*(?:不符|不匹配|验收|无法|未通过)|(?:成片|视频).*(?:仅|实际).*秒/.test(text)) code = 'duration';
  else if (/归档|ffprobe|媒体.*校验/i.test(text)) code = 'archive';
  else if (/timeout|timed out|超时|ECONN|ENOTFOUND|网络/i.test(text)) code = 'network';
  else if (/conversationId|没拿到.*回执/.test(text)) code = 'receipt';
  return { code, ...FAILURE_REASONS[code] };
}

export const ANALYTICS_TIMEZONES = ['America/Chicago', 'Asia/Shanghai', 'UTC'];
const emptyCounts = () => ({ created: 0, succeeded: 0, failed: 0, cancelled: 0, pending: 0, other: 0 });
const countKey = status => status === 'ready' ? 'succeeded'
  : ['failed', 'cancelled'].includes(status) ? status
    : ['queued', 'submitting', 'generating', 'resolving'].includes(status) ? 'pending' : 'other';

export function generationAnalytics(db, { hours = 24, timezone = 'America/Chicago', at = new Date() } = {}) {
  hours = Number(hours);
  if (![24, 72, 168].includes(hours) || !ANALYTICS_TIMEZONES.includes(timezone)) {
    throw Object.assign(new Error('范围仅支持 24 / 72 / 168 小时；时区仅支持芝加哥、北京或 UTC'), { status: 400 });
  }
  const end = new Date(at).getTime();
  const lastHour = Math.floor(end / 3600000) * 3600000;
  const start = lastHour - (hours - 1) * 3600000;
  const from = new Date(start).toISOString(), until = new Date(end).toISOString();
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZoneName: 'shortOffset',
  });
  const hourly = Array.from({ length: hours }, (_, i) => {
    const date = new Date(start + i * 3600000);
    return { hour: date.toISOString(), label: fmt.format(date), ...emptyCounts() };
  });
  const buckets = new Map(hourly.map(row => [row.hour.slice(0, 13), row]));
  const totals = emptyCounts(), allTime = emptyCounts();
  for (const row of db.prepare(`SELECT substr(created_at,1,13) hour, status, COUNT(*) n
    FROM dola_videos WHERE created_at >= ? AND created_at <= ? GROUP BY hour,status`).all(from, until)) {
    const bucket = buckets.get(row.hour);
    if (!bucket) continue;
    bucket.created += row.n; bucket[countKey(row.status)] += row.n;
    totals.created += row.n; totals[countKey(row.status)] += row.n;
  }
  for (const row of db.prepare('SELECT status,COUNT(*) n FROM dola_videos GROUP BY status').all()) {
    allTime.created += row.n; allTime[countKey(row.status)] += row.n;
  }
  const reasons = new Map();
  // Raw errors can contain upstream page text or URLs. Never return them here.
  for (const row of db.prepare(`SELECT error, COUNT(*) n, MAX(id) latestTaskId
    FROM dola_videos WHERE status='failed' AND created_at >= ? AND created_at <= ? GROUP BY error`).all(from, until)) {
    const info = classifyFailure(row.error);
    const group = reasons.get(info.code) || { ...info, count: 0, latestTaskId: 0 };
    group.count += row.n;
    group.latestTaskId = Math.max(group.latestTaskId, row.latestTaskId);
    reasons.set(info.code, group);
  }
  const settled = totals.succeeded + totals.failed;
  return { ok: true, hours, timezone, from, until, totals, allTime,
    successRate: settled ? Math.round(totals.succeeded / settled * 1000) / 10 : null,
    hourly: hourly.reverse(), reasons: [...reasons.values()].sort((a, b) => b.count - a.count) };
}
