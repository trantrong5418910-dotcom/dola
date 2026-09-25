// Read-only task cohorts. This module never imports the application database.
export const FAILURE_REASONS = Object.freeze({
  rate_limit: { label: '上游限流', action: '保留账号并等待冷却；核验代理和请求频率。限流回执不能单独证明是共享 IP 导致。' },
  capability: { label: '时长 / 模型 / 视频入口未确认', action: '暂停该账号对应时长，先做只读能力复核；通过后再提交。' },
  reference: { label: '参考图控件未确认', action: '暂停该账号参考图任务，先复核图片上传控件。' },
  login: { label: '登录未确认（创作页未出现输入框）', action: '先做只读复核确认页面已登录且创作输入框出现；通过前不要重复提交，也不要把账号标成失效。' },
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

/**
 * ★ 「页面根本没加载」的判据 —— 必须排在「登录」之前。
 *
 * 实测（2026-09-25，同一个只读探测函数、同一天）：
 *   #420（udearproxy 会话失效）→ diagnostic.phase = `navigate`，报「未确认已登录的创作页面」；
 *   #408（登录正常）           → diagnostic.phase = `entry`（**输入框已经出现**），报「创作条时长控件未完成加载」。
 *
 * 也就是说：**死代理和匿名态抛出的是同一句话**。原因是 provider.js / generator.js 里
 * `page.goto(...).catch(() => {})` 把导航异常吞掉了，页面没打开也照样往下等控件、等不到就归因到"没登录"。
 *
 * 后果是双向的、都很贵：可用账号（#420）被当成匿名态，而真正坏掉的出口（代理）没人去修。
 * 所以先认出这一类，并归到 proxy —— proxy 没有作用域，只提示、不封号
 * （对照参考站 §4：`logged_in` 与 `proxy_enabled/egress` 是**两个独立字段**，不能混为一谈）。
 */
export const VIDEO_NAVIGATION_FAILURE_PATTERN = /页面未能加载|net::ERR_|ERR_TUNNEL|ERR_PROXY|ERR_CONNECTION|NS_ERROR_/i;

/**
 * ★ 「登录未确认」的判据（对照参考站 §4 把 unsigned「未登录」列成独立状态、§11 单列「登录握手」日志类别）。
 *
 * 只认「创作页的输入框始终没出现」这一类文案：它才是"拿不到创作面板"的直接证据。
 * 注意**不能**把「创作条时长控件未完成加载」也算进来 —— 实测那说明输入框**已经出现**、
 * 页面是登录态，只是时长控件没加载完，属于能力/页面性能问题，不是登录问题。
 */
export const LOGIN_NOT_CONFIRMED_PATTERN = /未确认已登录|创作页(?:面)?未登录|未登录的创作页/;

export function classifyFailure(message = '') {
  const text = String(message);
  let code = 'other';
  if (/710022002|上游限流|访问频繁|Too Many Requests|HTTP 429/i.test(text)) code = 'rate_limit';
  // ★ 顺序即语义，别随意调：
  //   ① 限流是上游的独立事实，先认。
  //   ② 「页面根本没打开」次之 —— 此时关于登录态什么都推不出来（死代理会伪装成未登录）。
  //   ③ **登录未确认必须排在 capability/reference 之前**：只读探测的报错带包装前缀
  //      「原生 N 秒能力探测未完成：…」，那个前缀会被 capability 先吃掉，
  //      于是经「生成前只读预检」进来的真实登录失败（预检原样转发 result.error）
  //      会被降级成"某个时长的能力问题"，账号级防护就建不起来了。
  //      语义上也该如此：页面是匿名态时，时长/模型/参考图的结论全都是派生现象。
  //   ④ 其余照旧。
  //   （注意 `|` 是**最左优先**不是最长匹配 —— 这几条判据互不重叠，所以不受影响；
  //     这一点在 chain-text-rules.js 里踩过坑，见那里的注释。）
  else if (VIDEO_NAVIGATION_FAILURE_PATTERN.test(text)) code = 'proxy';
  else if (LOGIN_NOT_CONFIRMED_PATTERN.test(text)) code = 'login';
  else if (/参考图.*(?:能力探测|控件|未确认|文件控件)/.test(text)) code = 'reference';
  // ★ 「控件/创作条未完成加载」也是 capability 的一种：输入框已出现说明登录没问题，
  //   是模型或时长控件没加载完。原先落到 `other`（待人工核实），标签误导。
  else if (/能力探测未完成|未确认原生|没有可见的视频生成入口|页面未能确认.*模型|没有唯一可选.*时长|模型控件未完成|控件未完成加载|创作条.*未完成加载/.test(text)) code = 'capability';
  else if (/已拦截提交|submissionBlocked/.test(text)) code = 'request';
  else if (/重启|服务中断/.test(text)) code = 'interrupted';
  else if (/计费|扣费|退款|charge/i.test(text)) code = 'billing';
  // ★ 兜底：真正的身份/会话问题仍然归 session（不要因为新增 login 而把 session 弄丢）
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
