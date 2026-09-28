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
 * 判定顺序是 content_refused → voided → duration_inquiry → quota_exhausted → quota → accepted → upstream_error → prompt_echo → none。
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
export const CHAIN_TEXT_RULES = Object.freeze(['prompt_echo', 'quota', 'quota_exhausted', 'voided', 'content_refused', 'duration_inquiry', 'accepted', 'upstream_error', 'none']);

/** 默认阈值，与参考站的 alerts.threshold 一致。 */
export const DEFAULT_DRIFT_THRESHOLD = 3;

/**
 * 上游「明确作废」的文案。
 * 前两条与 dola/generator.js 里 analyzeChain 一直在用的口径保持一致（不是新编的）。
 *
 * ★ 2026-09-28 新增「肖像保护 / 未认证人脸」—— 真实样本，逐字取自生产任务 #188
 *   （会话 38417956948437265、账号 #436、30 秒 + 参考图、提示词「古代修仙」）：
 *
 *      「出于肖像保护考虑，未认证人脸暂不支持用 Dreamina Seedance 2.5 生成视频。
 *        你可以尝试换其它参考图或文生视频。」
 *
 * 为什么必须归到 `voided`（判终态）而不是 `upstream_error`（只作证据）：
 *   · 它是**确定性的** —— 同一张参考图再提交多少次都是这一句，重试毫无意义；
 *   · 但它是**内容层面**的拒绝，**账号是好的、出口是好的、额度也够** ——
 *     所以不能惩罚账号（`analyzeChain` 的 `failed` 路径走
 *     `settleRejectedSubmission` → 「已退款并放行账号」，实测不写 fail_score）。
 *   · 归 `upstream_error` 会白等满 40 分钟时限 → `uncertain`（不终局、不退款、锁号）。
 *
 * ⚠️ 这条最阴的地方是**它会完全静默**：提示词「古代修仙」只有 4 字，
 *    低于 `MIN_ECHO_PROMPT_LENGTH` ⇒ 兜底判 `none` 且 `classifiable:false`
 *    ⇒ 连「协议漂移」告警都不会响（`createChainTextObserver` 对不可分类的 none
 *    既不加也不清零）。所以 #188 是**跑了 15 分钟、轮询 30 次、零告警**。
 *    ⇒ 教训：**靠 prompt_echo 兜底的前提是提示词够长**；短提示词场景必须靠
 *    这种「上游明确拒绝文案」的正向规则兜住，不能指望兜底。
 *
 * ⚠️ 口径刻意收窄：只认「肖像保护」「未认证人脸」「人脸未认证」这三个明确短语。
 *    不要扩成 `/不支持用.*生成视频/` 这类宽匹配 —— 描述性文案
 *    （例：「当前模型不支持用 4K 分辨率生成视频」）会被误判成终态失败并退款，
 *    假阳性比漏判更贵（钱已经退了）。
 *
 * ⚠️ 合并注意：本文件**线上同时还有 `duration_inquiry`（时长问询）那一整套**
 *    （`DURATION_INQUIRY_PATTERN` / `readChainClarifying` / `classifyChainText` 的
 *    `clarifying` 参数，2026-09-28 的 #202 修复）。本次只动 `VOIDED_PATTERN`，
 *    **绝不能整份覆盖** —— 那会把时长问询删掉，等于把 #202「白等 40 分钟 + 锁号」放回去。
 */
const VOIDED_PATTERN = /视频生成失败|生成失败|审核不通过|未通过审核|内容违规|违规内容|肖像保护|未认证人脸|人脸未认证/;

/**
 * 上游「内容生成限制」—— 直接拒绝生成，本轮**不会出片**。命中必须判终态。
 *
 * ★ 真实样本，逐字取自生产任务 #210（会话 38417957424987153、账号 #453、30 秒、pure-http）：
 *
 *      我暂时无法生成你要求的内容。请尝试输入其他要求，我会尽力为你提供帮助。
 *
 * 为什么它必须像 voided / quota_exhausted / duration_inquiry 一样判终态：
 *   · 我们的轮询循环里**没有「换个提示词再试」这一步** —— 上游拒了就是拒了；
 *   · 不判终态就只能跑满时限（`dola_gen_timeout_min`，线上 40 分钟），
 *     然后落进 `holdUncertainSubmission` → **不退款 + 通过
 *     `accountHasUnsettledSubmission` 永久排除该账号**（#210 实测空转到时限）。
 *
 * ★★ 首选是**结构化字段**（见 readChainRefused），文案正则只作兜底。
 *    #210 vs #208/#205/#204 实测对照，两类字段完全互斥：
 *
 *      拒绝（#210）           ：volcano_refused="1" + finish_reason_chat="safety_terminated:completion"
 *      出片（#208/#205/#204）：volcano_refused 不存在 + finish_reason_chat="succeed:completion"
 *
 *    ⚠️ 顺带排掉一个**差点误用**的字段：`use_content_block="1"` 在**成功样本上也是 1**
 *       （#208/#205/#204 的每条消息都带）—— **它不是判据**。只因为名字像"内容拦截"
 *       就拿它判终态，会把全部正常任务判成失败。**假阳性比漏判更贵，钱已经退了。**
 *
 * 正则兜底为什么必须**两半都命中**（同 DURATION_INQUIRY_PATTERN 的做法）：
 *   「无法生成」这半句单独出现会误伤描述性文案（例：「该模型无法生成长视频」），
 *   所以必须同时出现**「让你换个要求」那半句**（「请尝试输入其他要求」等）。
 */
const CONTENT_REFUSED_HINT =
  '(?:暂时|目前|当前|现在)?(?:无法|不能)(?:为你)?生成'
  + '(?:你要求的内容|该内容|此内容|这个内容|这段内容|此类内容|该视频|此视频)?';

/** 「让你重说一个」那半句：命中任一个才算真拒绝。**缺了这一半一律不判。** */
const CONTENT_REFUSED_SUGGEST_HINT =
  '请尝试输入其他要求|尝试输入其他要求|输入其他要求'
  + '|换个(?:其他|别的|其它)(?:的)?(?:要求|内容|提示词)'
  + '|请(?:尝试)?(?:换|改)(?:个|一个)?(?:其他|别的|其它)?(?:要求|内容|提示词)'
  + '|尽力为你提供帮助|尽力为您提供帮助';

/** 窗口给 80 字：实测样本里两半只隔「。请」2 个字，窗开太大只会增加误伤面。 */
export const CONTENT_REFUSED_PATTERN = new RegExp(
  `${CONTENT_REFUSED_HINT}[\\s\\S]{0,80}(?:${CONTENT_REFUSED_SUGGEST_HINT})`);

/** 上游「安全/内容拦截」的收尾原因前缀。正常出片是 `succeed:completion`（实测 #208/#205/#204）。
 *
 *  ⚠️ 只收**明确的拒绝前缀**，绝不用「不等于 succeed 就算拒绝」的写法 ——
 *     上游还有 length / stop 之类的正常收尾，那样写会把正常任务判失败。 */
const REFUSAL_FINISH_HINT = /^(?:safety_terminated|content_?block|refus)/i;

/**
 * 从 `pullChain()` 的 json 里读「上游拒绝了本次生成」的**结构化确证**（比文案正则可靠）。
 *
 * @returns {string} 命中时返回**人话形式的证据**（可直接拼进 stage / 终态说明）；
 *                   没命中返回空字符串（falsy，可直接当布尔用）。
 *
 * 判据（实测自 #210 vs #208/#205/#204，两类互斥）：
 *   · `ext.volcano_refused === '1'` —— 上游自己标的「这次被模型侧拒了」，最干净；
 *   · `ext.finish_reason_chat` 命中 REFUSAL_FINISH_HINT —— 同一件事的收尾原因口径。
 * 只扫 `ext`，不碰 content / cookie；纯函数、不写库、不发网络（符合本模块约束）。
 */
export function readChainRefused(json) {
  const messages = json?.downlink_body?.pull_singe_chain_downlink_body?.messages;
  if (!Array.isArray(messages)) return '';
  for (const message of messages) {
    const ext = message?.ext;
    if (!ext || typeof ext !== 'object') continue;
    const refused = ext.volcano_refused;
    if (refused === '1' || refused === 1 || refused === true) {
      return `上游消息标记 volcano_refused=${JSON.stringify(refused)}`;
    }
    const finish = String(ext.finish_reason_chat ?? '');
    if (REFUSAL_FINISH_HINT.test(finish)) {
      return `上游收尾原因 finish_reason_chat=${finish}`;
    }
  }
  return '';
}

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

/**
 * 上游「时长问询」—— 它在等你回答，**不会自己出片**。命中必须判终态。
 *
 * ★ 真实样本，逐字取自生产任务 #202（会话 38417920542418193、账号 #448、30 秒、pure-http）：
 *
 *      「视频生成目前支持 4 到 15 秒。我可以按最接近的支持时长生成：
 *        - 方案 A：生成 15 秒版本，压缩保留核心动作与台词
 *        - 方案 B：拆成两段生成：第一段 15 秒，第二段 15 秒，再由你后期拼接成 30 秒
 *        你回复 A 或 B，我就直接生成。」
 *
 * 为什么它必须像 voided / quota_exhausted 一样判终态：
 *   · 它是**确定性**的 —— 我们的轮询循环里**没有"回答提问"这一步**，
 *     上游会一直停在"等你回复"，不判终态就只能跑满时限 → uncertain
 *     → **不退款 + 通过 accountHasUnsettledSubmission 永久锁号**。
 *     实测 #202 就是这样白等 40 分钟、锁掉账号 #448、扣了 1 积分不退。
 *
 * ⚠️⚠️ 与它长得极像、但**必须放行**的那一类（别误伤 —— 这一条最要紧）：
 *      「视频生成目前支持 4 到 15 秒。**我将**按最接近的支持时长生成：15 秒。
 *        本次使用 Dreamina Seedance 2.5 生成，将消耗 2 个视频生成额度…」
 *      —— 这是**陈述句（话术）**，上游随后照样按 30 秒出片（#199 实测 30.080 秒）。
 *   ⇒ **判据是「有没有在问你要回答」，不是「有没有提到 4 到 15 秒」。**
 *      所以下面这条正则**必须同时命中两半**：既要有「4 到 15 秒」这个区间，
 *      又要在附近出现「方案 A/B」「你回复」「是否按」「确认后」这类**提问词**。
 *      只匹配区间会把 #199 那种正常出片的任务判成失败 —— **假阳性比漏判更贵，钱已经退了**。
 *
 * ★ 首选其实是**结构化字段**（见 readChainClarifying），正则只作兜底：
 *   结构化字段不受上游换措辞影响，实测能把两类分得干干净净 ——
 *     出片：`ai_creation_res_code="0"` + `fc` 步骤有耗时（#199 实测 1007ms）
 *     问询：`is_creation_clarifying="1"` + `ai_creation_res_code="710082041"`
 *           + `task_id=""` + `fc` 耗时 0（#202 实测）
 */
export const DURATION_INQUIRY_RES_CODE = '710082041';

/** 区间那一半：`4 到 15 秒`。容忍空格、半/全角破折号、中文数字，以及上游的英文措辞
 *  （上游会**双语回答** —— 英文样本见 dola-generation-channel-triage 里的 #192：
 *   `Video generation currently supports durations from 4 to 15 seconds. …`）。
 *  区间这一半单独命中**不会**判终态，所以放宽它是安全的。 */
const DURATION_RANGE_HINT =
  '(?:4|四)\\s*(?:到|至|–|—|-|~|～|to|through)\\s*(?:15|十五)\\s*(?:秒|seconds|second)';

/** 提问那一半：命中任一个才算"在问你要回答"。**缺了这一半一律不判。**
 *
 * 中文词是实测来的（#202 原文「你回复 A 或 B，我就直接生成」「方案 A／方案 B」）。
 * 英文词里 `\\bI\\s+can\\b` 是**按中英对照推出来的**，不是实测 ——
 * 依据是同一句话的两个语言版本在措辞上严格对应：
 *
 *     中文「**我可以**按最接近的支持时长生成：方案A…你回复 A 或 B」 = 提问（实测不出片，#202）
 *     中文「**我将**按最接近的支持时长生成：15 秒」                  = 陈述（实测照出 30.080 秒，#199）
 *     英文「**I can** generate it at the nearest supported duration of 15 seconds」= 对应上表第一行
 *
 * ⇒ **`I can` 对应"提问"、`I will` 对应"陈述"**，所以只收 `I can`，故意**不收** `I will`。
 *   这条属推断，等拿到英文出片样本后再校正；它被 400 字内的区间约束着，波及面很小。
 */
const DURATION_ASK_HINT = '方案\\s*[AＡaBbＢ]|你回复|请回复|是否按|确认后我|确认后再'
  + '|\\bplan\\s*[AB]\\b|\\breply\\b|\\bconfirm\\b|\\bwhich\\s+(?:option|one)\\b'
  + '|\\blet\\s+me\\s+know\\b|\\bI\\s+can\\b';

export const DURATION_INQUIRY_PATTERN = new RegExp(
  `${DURATION_RANGE_HINT}[\\s\\S]{0,400}(?:${DURATION_ASK_HINT})`);

/**
 * 从 `pullChain()` 的 json 里读「上游在问我们」的**结构化确证**（比正则可靠）。
 *
 * @returns {string} 命中时返回**人话形式的证据**（可直接拼进 stage / 终态说明）；
 *                   没命中返回空字符串（falsy，可直接当布尔用）。
 *
 * 判据（实测自 #202 vs #199，两类字段互斥）：
 *   · `ext.is_creation_clarifying === '1'` —— 上游自己标的"这是一次澄清追问"，最干净；
 *   · `ext.ai_creation_res_code === '710082041'` —— 同一件事的错误码口径，防上游不改 flag。
 * 只扫 `ext`，不碰 content / cookie；纯函数、不写库、不发网络（符合本模块约束）。
 */
export function readChainClarifying(json) {
  const messages = json?.downlink_body?.pull_singe_chain_downlink_body?.messages;
  if (!Array.isArray(messages)) return '';
  for (const message of messages) {
    const ext = message?.ext;
    if (!ext || typeof ext !== 'object') continue;
    const flag = ext.is_creation_clarifying;
    if (flag === '1' || flag === 1 || flag === true) {
      return `上游消息标记 is_creation_clarifying=${JSON.stringify(flag)}`;
    }
    if (String(ext.ai_creation_res_code ?? '') === DURATION_INQUIRY_RES_CODE) {
      return `上游回执码 ai_creation_res_code=${DURATION_INQUIRY_RES_CODE}`;
    }
  }
  return '';
}

/** prompt 太短时不参与回显判定 —— 一个「猫」字会匹配到整条链的任何地方，全是假阳性。 */
const MIN_ECHO_PROMPT_LENGTH = 8;

/**
 * 把上游原文分类成一条规则。
 *
 * @param {string} raw          上游原文（pullChain 的 text，也就是整个响应体）
 * @param {object} [opts]
 * @param {string} [opts.prompt=''] 本次任务提交的提示词，用于识别 prompt_echo
 * @param {boolean} [opts.hasVideo=false] 调用方已从原文里解析出成片直链
 * @param {string} [opts.clarifying=''] 结构化确证：调用方用 readChainClarifying(json) 取到的
 *   证据串（非空即表示"上游在等我们回答"）。传了就**优先**于下面所有文案正则。
 * @param {string} [opts.refused=''] 结构化确证：调用方用 readChainRefused(json) 取到的
 *   证据串（非空即表示"上游已拒绝本次生成"）。**优先级高于 clarifying** ——
 *   已经明确被拒了，就不该再当成"在等你回答"。
 * @returns {{rule:string, evidence:string, classifiable:boolean, upstreamError?:string}}
 *   classifiable=false 表示「这次根本没条件判」（没给 prompt 或 prompt 太短），
 *   此时 rule 仍然是 none，但**不应该**被计入协议漂移 —— 否则会造出一堆假告警。
 *   这正是本项目已经踩过一次的那种坑（探测参数不对，把好模型判成坏的）。
 *   upstreamError 在几条**要判终态**的规则上都会出现（quota_exhausted / duration_inquiry /
 *   content_refused，以及 upstream_error 本身），内容是**上游原话里命中的那一段**
 *   （走结构化确证时是人话证据串）。调用方拿它拼 stage 的「上游回执：…」和终态说明。
 *   ⚠️ 别以为是「只在 upstream_error 时才有」—— 那样写消费方代码会漏掉其他三条。
 */
export function classifyChainText(raw, { prompt = '', hasVideo = false, clarifying = '', refused = '' } = {}) {
  // ★ 结构化确证优先（两个都来自 json，不受文案措辞漂移影响，比任何正则都可靠）。
  //   顺序：**拒绝 > 问询** —— 上游已经明确拒了这次生成，就不能再当"在等你回答"。
  if (refused) {
    return {
      rule: 'content_refused',
      evidence: `上游拒绝了本次生成（${refused}），本轮不会出片`,
      upstreamError: '上游因内容生成限制直接拒绝',
      classifiable: true,
    };
  }

  // ★ 结构化确证：调用方已从 json 里读到「上游在等你回答」（见 readChainClarifying）。
  if (clarifying) {
    return {
      rule: 'duration_inquiry',
      evidence: `上游在等你回答时长方案（${clarifying}），本轮不会出片`,
      upstreamError: '上游回的是时长问询（等你选 15 秒方案 A / 两段方案 B）',
      classifiable: true,
    };
  }

  const text = String(raw ?? '');
  if (!text.trim()) return { rule: 'none', evidence: '上游原文为空', classifiable: true };

  const voided = VOIDED_PATTERN.exec(text);
  if (voided) return { rule: 'voided', evidence: `命中「${voided[0]}」`, classifiable: true };

  // 内容生成限制的**文案兜底**（结构化字段没命中时才走到这里）。理由见 CONTENT_REFUSED_PATTERN。
  // 放在 voided 之后、duration_inquiry 之前：三者语义上互斥，这个位置只是让"最硬的拒绝"先出。
  const refusedByText = CONTENT_REFUSED_PATTERN.exec(text);
  if (refusedByText) {
    // upstreamError 与 quota_exhausted / duration_inquiry / upstream_error 的文案路径保持一致：
    // 都把**命中的上游原话**带出去（调用方拿它拼 stage「上游回执：…」和终态说明）。
    // 少了这一行的表现很隐蔽：结构化路径能显示原话、文案路径显示不出来，
    // 后来人照着其中一条路径写消费方代码时，另一条路径就静默给空。
    return { rule: 'content_refused', evidence: `命中「${refusedByText[0]}」`,
      upstreamError: refusedByText[0], classifiable: true };
  }

  // 时长问询 —— 也判终态（理由见 DURATION_INQUIRY_PATTERN 的说明）。
  // 必须排在 quota 之前：否则上游哪天把额度句一并带上，就会被 quota 先吃掉，
  // 把"在等你回答"误当成"已经在生成了"。
  const inquiry = DURATION_INQUIRY_PATTERN.exec(text);
  if (inquiry) {
    return {
      rule: 'duration_inquiry',
      evidence: `上游回执「${inquiry[0]}」`,
      upstreamError: inquiry[0],
      classifiable: true,
    };
  }

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
