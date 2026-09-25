/**
 * 上游文本分类 + 协议漂移告警。
 *
 * ── 抄的是参考站的哪一块 ──────────────────────────────────────────────────
 * 参考站 68.64.176.15（dola2api 2.3.13）的 Prometheus 指标里有：
 *   dola2api_chain_text_rules_total{rule="prompt_echo|quota|voided|accepted|none"}
 *   alerts: { protocol_drift, consecutive_protocol_failures, threshold: 3 }
 * 它把「上游消息链原文」每一轮都分类计数，连续 3 轮认不出来就报协议漂移。
 *
 * ── 为什么值得有（这是我们真实吃过的一类故障） ────────────────────────────
 * 上游改一句文案（「今日剩余 N 个视频生成额度」→ 别的说法），我们的正则就**静默失效**：
 * 不报错、不抛异常，只是额度读不到了 / 成片等不到了，最后表现成
 * 「任务一直卡在生成中，没人知道为什么」。有了这个计数器，
 * `rule=none` 连续上升的那一天，日志里会直接吵出来。
 *
 * ── 本模块的约束 ──────────────────────────────────────────────────────────
 * 纯函数 + 进程内计数：**不碰数据库、不发网络、不引新依赖、不读文件**。
 * 这样才能单测，也才敢挂在每 30 秒一次的轮询里。
 *
 * ── 规则顺序为什么重要（这是本文件最容易写错的地方）──────────────────────
 * 判定顺序是 voided → quota_exhausted → quota → accepted → upstream_error → prompt_echo → none。
 * `prompt_echo` **必须排在最后做兜底**：我们拉的是整条消息链（cmd 3100），
 * 里面本来就有自己刚提交的那条用户消息 —— 要是把它排前面，
 * 它会把每一轮都判成 prompt_echo，后面所有规则全部失效，等于白做。
 * `upstream_error` / `quota_exhausted` 同理必须排在 `prompt_echo` **之前**，否则永远轮不到它们。
 *
 * 一个容易看漏的点：成功判定**不依赖**规则。
 * 轮询循环是先看 `a.vids.length`（真实成片直链）再判 `a.failed`，
 * 所以链里即便残留一句旧的拒绝文案，也不会把已经出片的成功任务判成失败。
 */
import { parseVideoQuotaReceipt } from './account-observations.js';

/**
 * 规则枚举，与参考站的 metric label 一致（`upstream_error` / `quota_exhausted` 是本项目扩展）。
 *
 * ⚠️ 往 classifyChainText 里加新规则时**必须同时加进这个数组**：
 *    createChainTextObserver.record() 第一行就是
 *      `if (!CHAIN_TEXT_RULES.includes(rule)) return snapshot();`
 *    —— 漏加的话计数会被**静默丢弃**：不报错、不告警，只是那个规则的计数永远是 0，
 *    而它又因为 rule !== 'none' 把漂移计数清零了。等于"看起来在工作，其实没有"。
 */
export const CHAIN_TEXT_RULES = Object.freeze(['prompt_echo', 'quota', 'quota_exhausted', 'voided', 'accepted', 'upstream_error', 'none']);

/** 默认阈值，与参考站的 alerts.threshold 一致。 */
export const DEFAULT_DRIFT_THRESHOLD = 3;

/**
 * 上游「明确作废」的文案。
 * 前两条与 dola/generator.js 里 analyzeChain 一直在用的口径保持一致（不是新编的）。
 */
const VOIDED_PATTERN = /视频生成失败|生成失败|审核不通过|未通过审核|内容违规|违规内容/;

/**
 * 上游的**通用错误回执**（本项目扩展规则，参考站的 label 里没有）。
 *
 * 为什么必须单列一条 —— 这是 2026-09-25 在生产上实测到的真实回执：
 *   任务 #144 提交成功（会话 38417845063359249、journal=acknowledged），
 *   上游对该轮生成只回了一句「**出了点问题，请稍后重试。**」。
 * 这句话既不含「生成失败」，也不含任何额度数字，于是旧规则**全部落空**，
 * 最后被 prompt_echo 兜底吃掉（消息链里必然有我们自己提交的提示词）。
 * 后果不是报错，而是**静默空转**：轮询一路跑到 20 分钟时限，
 * 终态只报「到达时限、待核对」—— 上游到底说了什么，被彻底丢掉。
 *
 * ⚠️ 与 VOIDED_PATTERN 的语义差别（这个差别决定要不要判死任务）：
 *    voided        = 上游对**本次请求**的确定性拒绝（审核不通过、内容违规）→ 可以判终态
 *    upstream_error= 通用抖动措辞（「请稍后重试」本身就说明了）→ **只作证据，不作终态**
 *    直接把它当失败会把偶发抖动变成任务失败，而且用户积分已经扣了。
 */
export const UPSTREAM_ERROR_PATTERN = /出了点问题|稍后重试|服务(?:器)?繁忙|系统繁忙/;

/**
 * 上游**明确拒绝**：当日生成次数已用尽（免费号额度）。
 *
 * 真实样本，逐字取自生产任务 #145（会话 38417918852111121，账号 #419）：
 *   "今天的生成次数已经达到上限，明天再来免费生成吧"
 *
 * 为什么它必须是**终态**规则（与 upstream_error 相反）：
 *   · 它是确定性的 —— 同一个号今天再提交多少次都是这句，重试毫无意义；
 *   · 继续按「未知」处理只会让它跑满 20 分钟时限，然后被重启/时限判成 uncertain，
 *     而 uncertain 会通过 accountHasUnsettledSubmission **永久锁死该账号**。
 *     实测就是这样把唯一有完整 Dola 会话的 #419 锁住的。
 *   所以：立刻判失败 + 退款 + 放行账号，这才是诚实的终态。
 *
 * ⚠️ 这里同样不能只认一种措辞 —— 上游换个说法（「已达到上限」/「明天再来」/
 *    「次数用完」）就会静默穿透成 prompt_echo，重新变回空转。
 *    2026-09-25 一天之内就见到了两种不同措辞（#144 的「出了点问题」、
 *    #145 的「今天…上限」），所以宽口径是必要的，不是过度设计。
 *
 * ⚠️⚠️ 「宽口径」不等于「随手把同义词用 | 拼起来」——**分支顺序会决定捕获到什么**。
 *    JS 的正则 `|` 是**最左优先（leftmost-first）**，不是最长优先（POSIX longest）。
 *    第一版写成 `…|今天(?:的)?生成次数|明天再来|…` 时，生产任务 #146 的终态回执被截成：
 *        「今天的生成次数」                                  ← 实际输出（丢了后半句）
 *        「今天的生成次数已经达到上限，明天再来免费生成吧」      ← 上游原话
 *    原因：`今天(?:的)?生成次数` 这条分支在**更靠左的位置（index 0）**先命中，
 *    而能给出完整子句的 `生成次数…上限` 最早只能从 index 3 起匹配，于是永远轮不到它。
 *    教训：**想捕获完整子句，就要让能覆盖最左起始位置的那条分支同时覆盖完整语义**，
 *    而不是把「短但靠左」的分支摆在前面。
 *
 * 语义上也收紧了一处：必须出现「到顶/用尽」的动词，不能只出现「上限」。
 *    否则「免费用户每日生成次数上限为 10 次」这种**描述性文案**会被误判成
 *    额度用尽 → 任务被误判终态失败并退款（假阳性比漏判更贵，钱已经退了）。
 */
export const QUOTA_EXHAUSTED_PATTERN = /(?:今天|今日)?[^。！!\n]{0,4}(?:次数|额度)[^。！!\n]{0,20}(?:达到上限|已到上限|超过上限|已达上限|用尽|用完|耗尽)|明天再来/;

/** prompt 太短时不参与回显判定 —— 一个「猫」字会匹配到整条链的任何地方，全是假阳性。 */
const MIN_ECHO_PROMPT_LENGTH = 8;

/**
 * 把上游原文分类成一条规则。
 *
 * @param {string} raw          上游原文（pullChain 的 text，也就是整个响应体）
 * @param {object} [opts]
 * @param {string} [opts.prompt=''] 本次任务提交的提示词，用于识别 prompt_echo
 * @param {boolean} [opts.hasVideo=false] 调用方已从原文里解析出成片直链
 * @returns {{rule:string, evidence:string, classifiable:boolean, upstreamError?:string}}
 *   classifiable=false 表示「这次根本没条件判」（没给 prompt 或 prompt 太短），
 *   此时 rule 仍然是 none，但**不应该**被计入协议漂移 —— 否则会造出一堆假告警。
 *   这正是本项目已经踩过一次的那种坑（探测参数不对，把好模型判成坏的）。
 *   upstreamError 只在 rule==='upstream_error' 时出现，是上游原话里命中的那一段。
 */
export function classifyChainText(raw, { prompt = '', hasVideo = false } = {}) {
  const text = String(raw ?? '');
  if (!text.trim()) return { rule: 'none', evidence: '上游原文为空', classifiable: true };

  const voided = VOIDED_PATTERN.exec(text);
  if (voided) return { rule: 'voided', evidence: `命中「${voided[0]}」`, classifiable: true };

  // 当日额度用尽 —— 也判终态（理由见 QUOTA_EXHAUSTED_PATTERN 的说明）。
  // upstreamError 一并带出，让 stage / 终态说明能显示上游原话。
  const exhausted = QUOTA_EXHAUSTED_PATTERN.exec(text);
  if (exhausted) {
    return {
      rule: 'quota_exhausted',
      evidence: `上游回执「${exhausted[0]}」（当日额度用尽，今天重试无意义）`,
      upstreamError: exhausted[0],
      classifiable: true,
    };
  }

  const receipt = parseVideoQuotaReceipt(text);
  if (receipt.remaining != null || receipt.cost != null) {
    const bits = [];
    if (receipt.remaining != null) bits.push(`今日剩余 ${receipt.remaining}`);
    if (receipt.cost != null) bits.push(`本条消耗 ${receipt.cost}`);
    return { rule: 'quota', evidence: bits.join('，'), classifiable: true };
  }

  // accepted 只认「成片直链已经出现」这一条实证 —— 不去编「正在生成」之类的文案正则，
  // 因为我们手上没有它的真实样本。hasVideo 由调用方用既有的直链提取逻辑算出来。
  if (hasVideo) return { rule: 'accepted', evidence: '原文里已出现成片直链', classifiable: true };

  // 必须排在下面 prompt_echo 兜底之前，否则永远轮不到（详见 UPSTREAM_ERROR_PATTERN 的说明）。
  // 返回值多带一个 upstreamError 字段：调用方要把它带进 stage / 终态说明，
  // 让操作者看见上游的原话，而不是一个光秃秃的「到时限了」。
  const upstreamError = UPSTREAM_ERROR_PATTERN.exec(text);
  if (upstreamError) {
    return {
      rule: 'upstream_error',
      evidence: `上游回执「${upstreamError[0]}」`,
      upstreamError: upstreamError[0],
      classifiable: true,
    };
  }

  const needle = String(prompt ?? '').trim();
  if (needle.length < MIN_ECHO_PROMPT_LENGTH) {
    return {
      rule: 'none',
      evidence: needle ? `提示词过短（${needle.length} 字），无法做回显判定` : '本次没有提示词，无法做回显判定',
      classifiable: false,
    };
  }
  // 链里的内容经常是**嵌套 JSON**（消息 content 本身又是一段 JSON 字符串），
  // 所以提示词可能是原样、转义一层、或转义两层。三种形态都试。
  // 只试一层的话，嵌套链会漏判成 none —— 那就变成假漂移告警了。
  // ⚠️ 这里是「原始 + 1 层 + 2 层」共 3 种，循环写 < 2 会漏掉最后一层（踩过）。
  const ESCAPE_VARIANTS = 3;
  const needles = [];
  let variant = needle;
  for (let level = 0; level < ESCAPE_VARIANTS && variant; level++) {
    needles.push(variant);
    const next = JSON.stringify(variant).slice(1, -1);
    if (next === variant) break;      // 没有可转义字符了，再转也一样
    variant = next;
  }
  if (needles.some((n) => text.includes(n))) {
    return { rule: 'prompt_echo', evidence: '原文里只有我们提交的提示词，没有生成/额度/失败信号', classifiable: true };
  }

  return { rule: 'none', evidence: '原文里既没有提示词回显，也没有任何已知信号', classifiable: true };
}

/**
 * 进程内观察者：计数 + 「连续 N 次认不出来」的漂移告警。
 *
 * 计数器的语义（务必看清，这里决定告警真假）：
 *   · rule === 'none' 且 classifiable  → 连续失败 +1
 *   · rule 是别的任何规则              → 连续失败清零（说明协议还认得）
 *   · rule === 'none' 但 !classifiable → **既不加也不清零**（我们没条件判，不是上游的错）
 */
export function createChainTextObserver({
  threshold = DEFAULT_DRIFT_THRESHOLD,
  historyLimit = 50,
  now = () => new Date().toISOString(),
  warn = (msg) => console.warn(msg),
} = {}) {
  const totals = Object.fromEntries(CHAIN_TEXT_RULES.map((r) => [r, 0]));
  const history = [];
  let consecutiveProtocolFailures = 0;
  let protocolDrift = false;
  let driftNotified = false;
  let lastRule = null;
  let lastEvidence = '';
  let lastAt = null;
  let unclassifiable = 0;

  function record(result) {
    const { rule, evidence = '', classifiable = true } = typeof result === 'string' ? { rule: result } : result;
    if (!CHAIN_TEXT_RULES.includes(rule)) return snapshot();
    totals[rule] += 1;
    lastRule = rule;
    lastEvidence = evidence;
    lastAt = now();

    history.push({ rule, evidence, at: lastAt });
    if (history.length > historyLimit) history.splice(0, history.length - historyLimit);

    if (rule === 'none') {
      if (classifiable) consecutiveProtocolFailures += 1;
      else unclassifiable += 1;
    } else {
      consecutiveProtocolFailures = 0;
    }

    const drifting = consecutiveProtocolFailures >= threshold;
    if (drifting && !driftNotified) {
      driftNotified = true;
      warn(`[chain-text] ⚠️ 疑似上游协议漂移：连续 ${consecutiveProtocolFailures} 轮消息链都认不出来`
        + `（最近一次：${lastEvidence}）。先抓一份原文对比，别急着改正则 —— 也可能只是文案微调。`);
    } else if (!drifting && driftNotified) {
      driftNotified = false;   // 恢复了，下次再坏要能重新提醒
    }
    protocolDrift = drifting;
    return snapshot();
  }

  function snapshot() {
    return {
      rules: { ...totals },
      consecutiveProtocolFailures,
      threshold,
      protocolDrift,
      unclassifiable,
      lastRule,
      lastEvidence,
      lastAt,
      recent: history.map((h) => ({ ...h })),
    };
  }

  function reset() {
    for (const r of CHAIN_TEXT_RULES) totals[r] = 0;
    history.length = 0;
    consecutiveProtocolFailures = 0;
    protocolDrift = false;
    driftNotified = false;
    lastRule = null;
    lastEvidence = '';
    lastAt = null;
    unclassifiable = 0;
    return snapshot();
  }

  return { record, snapshot, reset };
}

/** 生产用的单例。生成链路每轮轮询都会喂它一次。 */
export const chainTextObserver = createChainTextObserver();

/** 便捷入口：分类 + 记账一步到位。 */
export function recordChainText(input, opts) {
  // 允许直接传一个已分类的结果（generator 里已经算过 hasVideo，不想算两遍）
  const result = input && typeof input === 'object' && typeof input.rule === 'string'
    ? input
    : classifyChainText(input, opts);
  chainTextObserver.record(result);
  return result;
}

/** 只读快照，给接口/诊断用。 */
export function chainTextSnapshot() {
  return chainTextObserver.snapshot();
}
