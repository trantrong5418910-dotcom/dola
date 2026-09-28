/**
 * 提示词包装（前缀 / 中缀 / 后缀）—— 对标参考站 68.64.176.15 的 `/admin/prompt-wrap`。
 *
 * 参考站的原话是：「拼装顺序：前缀 → 用户提示词 → 中缀 → 后缀。**接口返回的 prompt 仍是用户原文**。」
 * 两句话都要抄，第二句比第一句更重要。
 *
 * ── 两条硬约束（写错任何一条都会造成难以排查的后果）────────────────────────
 *
 * ① **只作用于"发给上游的那一刻"**，绝不写回 `dola_videos.prompt`。
 *    否则：调用方在 `/v1/videos` 里会看到一堆自己从没写过的话术；
 *    改了包装文案之后，历史任务的 prompt 与新任务的 prompt 口径不一致，
 *    对账/复现/取证据全部失真。
 *
 * ② **不能破坏「回显判定」（chain-text-rules 的 prompt_echo）**。
 *    那个规则是拿 `text.includes(prompt)` 判"上游只是把我的话原样回显了、并没有真生成"。
 *    我们只在提交时包装、轮询时仍用原文 —— 这**恰好是安全的**，因为包装后的文本
 *    是 `前缀 + 原prompt + 中缀 + 后缀`，**原文始终是它的子串**，所以 `includes` 依然命中。
 *    ⇒ 这条性质是"包装必须拼接、不许改写"的原因：一旦哪天有人想做「替换」式包装
 *      （把用户的话改掉），回显判定就会静默失效、漂移计数开始误报。
 *
 * ── 为什么包装要放在服务端、还要能热改 ────────────────────────────────────
 * 上游风控/文案一变，运营需要立刻调整"给上游的话术"，但不该为此重新发版。
 * 且包装统一在服务端，所有调用方（/v1 客户、8787 工作台、后台手点）口径一致。
 */
import { getSetting } from '../db.js';
import { switchView, SWITCH_SCOPES } from './feature-switch.js';

/** 设置项 key。集中在这里，避免各处字符串拼错（拼错的表现是"开关点了没反应"）。 */
export const PROMPT_WRAP_KEYS = Object.freeze({
  enabled: 'gateway_prompt_wrap_enabled',
  prefix: 'gateway_prompt_prefix',
  middle: 'gateway_prompt_middle',
  suffix: 'gateway_prompt_suffix',
});

/**
 * 包装后总长度上限，与 `/v1` 对 prompt 的 12000 字上限对齐。
 *
 * 超限时**放弃包装**而不是截断：截断会悄悄改掉用户的话（还可能把后缀里的关键约束截掉），
 * 那种错误在上游侧表现为"视频内容和预期不符"，根本查不到这里。
 */
export const PROMPT_WRAP_MAX_LENGTH = 12000;

/** 各段之间的分隔符。用换行让上游把包装段和用户提示词分成两句，而不是粘成一句话。 */
const JOINER = '\n';

/**
 * 提交前要改写的「时长描述」。
 *
 * ── 为什么要有这一步
 * 上游 dola 只要在**提交文案里**读到时长（「30 秒」「15s」「0:10」…），就会在会话里回一句
 * `… exceeds the current maximum supported duration of 15 seconds…`。
 * 那是它的**降档话术模板**，与这次到底出多长**无关** —— skill `dola-30s-video-2-credits`
 * 里有实测：服务端口头说「我将按最接近的支持时长 15 秒生成」，成片 mvhd 照样是
 * 30.080 秒。但这句回执会污染会话，也让运营误以为请求被降档。
 *
 * ── 口径演进（2026-09-29 飞哥三次收紧，最后落在"改写"而不是"删除"）
 * ① 「提交上去的文案不要出现 30s 的字样」       → 只清 30 这一档；
 * ② 「所有提交的文案里都自动去除关于时长的描述」  → 不限档位，任意数字 / 任意单位；
 * ③ 「将 xx秒—xx秒 按顺序替换成镜头一、镜头二」+「全部统一换成镜头N」
 *    → **不再删字，而是把时长描述按出现顺序改写成「镜头一」「镜头二」…**
 *      为什么改成"改写"：时长描述在分镜稿里本来就承担「这一段是哪一镜」的分段作用，
 *      直接删字会把镜头结构一起抹平，上游收到的会是一整段没有分段的长文。
 *
 * ── 改写（而不是删除）带来的两个必须守住的约束
 * ⚠️ **幂等**：`镜头一` 里没有「数字 + 单位」，再跑一次不会二次编号。
 * ⚠️ **编号接续已有最大号**（见 maxExistingShotIndex）：包装开启时 `upstreamPrompt`
 *    会调用本函数两次（一次对原文、一次对拼装结果），第二次不会从「镜头一」重新数，
 *    所以不会出现"一份文案里两个镜头一"。
 */
/** 阿拉伯数字（含小数）。 */
const DUR_AR = String.raw`\d{1,4}(?:\.\d+)?`;
/**
 * 中文数字。
 * ⚠️ 刻意**不含「半」**：线上真实文案里有「闭目半秒后骤然睁开」，
 *    那是画面描述，不是时长规格（`半` 也不该被当成数字）。
 */
const DUR_CN = String.raw`[零〇一二三四五六七八九十百两]+`;
const DUR_NUM = String.raw`(?:${DUR_AR}|${DUR_CN})`;
/**
 * 时长单位。**长的必须写前面**，否则 `s` 会抢先吃掉 `seconds` / `分钟` 的开头。
 * ⚠️ 刻意**不收裸的「分」**：「十分」「部分」「分手」里都有它，收了就是大面积误伤。
 */
const DUR_UNIT = String.raw`(?:秒钟|秒|分钟|小时|seconds?|secs?|minutes?|mins?|hours?|hrs?|s)`;
/** 区间连接符：`10秒—20秒` / `5-10s` / `3~5 秒` / `4 到 15 秒`。 */
const DUR_RANGE_SEP = String.raw`(?:[-–—~～]|到|至|to)`;
const DUR_GAP = String.raw`[ \t]*`;

/**
 * 一段「时长」。三种写法：
 *   · `30秒` / `30s`               —— 单个
 *   · `10秒—20秒`（单位在两边）      —— 区间
 *   · `10—20秒`（单位只在右边）      —— 区间
 *
 * ⚠️ 分支顺序必须**长的在前**：反过来先命中 `10秒`，就会把 `—20秒` 剩在原地，
 *    结果变成「镜头一—镜头二」两个标签，编号直接串位。
 */
const DUR_SPAN = String.raw`(?:`
  + String.raw`${DUR_NUM}${DUR_GAP}${DUR_UNIT}${DUR_GAP}${DUR_RANGE_SEP}${DUR_GAP}${DUR_NUM}${DUR_GAP}${DUR_UNIT}?`
  + String.raw`|${DUR_NUM}${DUR_GAP}${DUR_RANGE_SEP}${DUR_GAP}${DUR_NUM}${DUR_GAP}${DUR_UNIT}`
  + String.raw`|${DUR_NUM}${DUR_GAP}${DUR_UNIT}`
  + String.raw`)`;
/** 数字前的修饰词。一起改写成标签，避免留下「第」「大约」这种半截话。 */
const DUR_LEAD = String.raw`(?:(?:第|大约|大概|约|将近|接近|超过|不到|至少|最多|最长|平均|为|是|控制在|限制在|不超过)${DUR_GAP})?`;
/** 数字后的收尾词。同理：`3 秒后` 要整体换掉，只换 `3 秒` 会留下一个「后」。 */
const DUR_TAIL = String.raw`(?:之后|以后|之前|之内|之间|以内|后|前|内|左右|上下|处|许|时|一次)?`;
/** 显式时长标签。带标签时标签也一起换掉，否则会留下「时长：镜头一」这种半截话。 */
const DUR_LABELS = String.raw`(?:时长|片长|总时长|总长|长度|秒数|length|duration)`;
/**
 * 没有单位时，标签后面必须紧跟分隔符或行尾。
 * 不加这一条，`长度 1080 像素` 会被当成时长改写掉 —— 那种误伤查起来极其困难。
 */
const DUR_LABEL_BARE_TAIL = String.raw`(?=[，,、；;。．.!！?？]|${DUR_GAP}$)`;

/**
 * 带显式时长标签的写法：`时长：30 秒` / `片长 15 秒` / `duration 30sec` / `时长：30`。
 * `时长：30` 这种没有单位的元数据写法靠第二个分支覆盖。
 */
const DURATION_LABELED_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9])${DUR_LABELS}${DUR_GAP}[:：=]?${DUR_GAP}`
  + String.raw`(?:${DUR_LEAD}${DUR_SPAN}|${DUR_LEAD}${DUR_NUM}${DUR_LABEL_BARE_TAIL})`,
  'gim',
);

/** 通用的时长描述（`30s` / `10秒—20秒`）。 */
const DURATION_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9])${DUR_LEAD}${DUR_SPAN}${DUR_TAIL}(?![A-Za-z0-9])`,
  'gi',
);

/**
 * 时间码区间：`0:00-0:10` / `00:10~00:20` / `1:20 到 1:30`。
 * ⚠️ 必须排在单个时间码**前面**：否则会被拆成「镜头一-镜头二」两个标签，编号直接串位。
 */
const TIMECODE_SPAN_PATTERN = /(?<![\d.:])\d{1,3}:\d{2}[ \t]*[-–—~～][ \t]*\d{1,3}:\d{2}(?![\d:])/g;
/**
 * 时间码：`0:10` / `00:10` / `1:20`。
 *
 * ⚠️ 必须和**宽高比**区分开，两者形状几乎一样：
 *    · 宽高比 `16:9` / `4:3` / `21:9` 的第二段是**1 位**数字 → 本模式要求 2 位，天然挡住；
 *    · 但 `9:16` / `16:10` 这种第二段也是 2 位，挡不住 → 再加白名单 + 上下文词两层兜底。
 * ⚠️ `23:47:31` 这类三段时钟戳也要挡住：要求前后都不再挨着 `:` 或数字。
 */
const TIMECODE_PATTERN = /(?<![\d.:])\d{1,3}:\d{2}(?![\d:])/g;
/** 白名单：这些数字组合是宽高比，不是时间码。只列"第二段是 2 位"的那些（其余本来就匹配不到）。 */
const ASPECT_RATIO_LITERALS = new Set([
  '9:16', '16:10', '10:16', '9:10', '9:14', '25:16', '1:16', '21:16',
]);
/** 紧挨在左边出现这些词 → 一定是在说画幅，不是时间码。 */
const ASPECT_CONTEXT = /(?:比例|宽高比|画幅|幅面|尺寸|aspect|ratio)[ \t]*[:：]?[ \t]*$/i;

/**
 * 行首的纯数字区间 `00-10`（不带单位），当作镜头标记改写。
 *
 * ⚠️ **只认行首**：不带单位时，`10-20` 和普通数字区间（`10-20人`）在形状上完全一样。
 *    所以同时上三条锁：必须在行首、两段各 ≤2 位、后面紧跟空白或分隔符或行尾。
 *    飞哥点名要处理的 `00-10` 三条全中；`10-20人` 后面紧跟的是汉字，不会被误伤；
 *    `1080-1920` 位数超了，也不会被误伤。
 */
const LINE_HEAD_RANGE_PATTERN = new RegExp(
  String.raw`^[ \t]*\d{1,2}${DUR_GAP}[-–—~～]${DUR_GAP}\d{1,2}(?=[ \t]|[｜|:：、，,]|$)`,
  'gm',
);

/** 中文数字表（1~99 够用；镜头数不会上百）。 */
const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

function cnOrdinal(n) {
  if (!Number.isInteger(n) || n <= 0) return String(n);
  if (n < 10) return CN_DIGITS[n];
  if (n === 10) return '十';
  if (n < 20) return `十${CN_DIGITS[n % 10]}`;
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return `${CN_DIGITS[tens]}十${ones ? CN_DIGITS[ones] : ''}`;
  }
  return String(n);
}

/** 中文数字 → 阿拉伯数字（只支持 1~99，够镜头号用）。认不出来返回 NaN。 */
const CN_VALUE = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnToNumber(text) {
  const s = String(text);
  if (!/[十百]/.test(s)) {
    let n = 0;
    for (const ch of s) {
      if (!(ch in CN_VALUE)) return NaN;
      n = n * 10 + CN_VALUE[ch];
    }
    return n;
  }
  const at = s.indexOf('十');
  const high = s.slice(0, at);
  const low = s.slice(at + 1);
  const h = high === '' ? 1 : CN_VALUE[high];
  const l = low === '' ? 0 : CN_VALUE[low];
  if (!Number.isFinite(h) || !Number.isFinite(l)) return NaN;
  return h * 10 + l;
}

/** 文本里已经存在的「镜头N」（中文数字或阿拉伯数字都认）。 */
const EXISTING_SHOT_LABEL = /镜头([一二三四五六七八九十百零〇两]+|\d+)/g;

/**
 * 找出文本里**已经存在的最大镜头号**，让新编号从它往后接。
 *
 * ⚠️ 不加这一步会撞号：包装开启时 `upstreamPrompt` 会调用本函数两次
 *    （原文一次、拼装结果一次）。如果运营把「控制 30 秒以内」写进了后缀，
 *    第二次调用会从 1 重新数 —— 结果一份文案里出现**两个「镜头一」**。
 *    接续已有最大号之后：原文那处是镜头一，后缀那处自动变镜头二。
 * ⚠️ 顺带解决另一个场景：分镜稿本来就用「镜头一/镜头二」分段、末尾又挂了个 `30s`，
 *    新标签会接着 三 往后数，而不是插一个重复的「镜头一」进去。
 */
function maxExistingShotIndex(text) {
  let max = 0;
  for (const m of String(text).matchAll(EXISTING_SHOT_LABEL)) {
    const raw = m[1];
    const n = /^\d+$/.test(raw) ? Number(raw) : cnToNumber(raw);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * 把文案里的时长描述按**出现顺序**改写成「镜头一」「镜头二」…
 *
 * **幂等**；**没命中时逐字节返回原文** —— 后半条很重要：只要命中过就做一次
 * 「合并多余空格 / 去行尾空白」的收尾，那会顺手改动别处的排版；
 * 没命中就一个字都别碰，避免给"本来就没问题"的文案引入差异。
 *
 * ⚠️ 五个模式必须从"最具体"到"最泛"依次跑，且**共用一个计数器**：
 *    1. 带标签的（`时长：30 秒`）—— 不先跑，通用模式会先吃掉数字，留下「时长：镜头一」；
 *    2. 时间码区间（`0:00-0:10`）—— 不先跑会被拆成「镜头一-镜头二」两个标签；
 *    3. 时间码（`0:10`）—— 它没有"数字 + 秒单位"的形状，通用模式根本抓不到；
 *    4. 行首纯数字区间（`00-10`）—— 同理；
 *    5. 通用的（`30s` / `10秒—20秒`）。
 *
 * @param {string} text
 * @returns {string}
 */
export function replaceDurationMentions(text) {
  const raw = String(text ?? '');
  if (!raw) return raw;

  let seq = maxExistingShotIndex(raw);
  const nextLabel = () => `镜头${cnOrdinal(++seq)}`;

  const out = raw
    .replace(DURATION_LABELED_PATTERN, nextLabel)
    .replace(TIMECODE_SPAN_PATTERN, nextLabel)
    .replace(TIMECODE_PATTERN, (match, offset, whole) => {
      if (ASPECT_RATIO_LITERALS.has(match)) return match;
      if (ASPECT_CONTEXT.test(whole.slice(Math.max(0, offset - 10), offset))) return match;
      return nextLabel();
    })
    .replace(LINE_HEAD_RANGE_PATTERN, nextLabel)
    .replace(DURATION_PATTERN, nextLabel);

  if (out === raw) return raw;               // 没命中 → 逐字节返回原文

  const tidied = out
    .split('\n')
    .map((line) => line
      .replace(/[ \t]{2,}/g, ' ')                        // 合并多余空格
      .replace(/^[ \t]+|[ \t]+$/g, '')                   // 行首/行尾残留空白
      .replace(/[，、,；;]+(?=\s*(?:[。！？!?…~～]|$))/g, '') // 「，。」这种逗号残缺
      .replace(/([。！？!?…～~])\1+/g, '$1'))              // 「。。」这种叠标点
    .join('\n')
    .trim();

  return tidied || raw;
}

/**
 * @deprecated 旧名字。语义已经从「剥掉」变成「改写成镜头序号」，别再按"删除"理解。
 * 保留导出只是不让外部引用炸掉。
 */
export const stripDurationLabels = replaceDurationMentions;


/**
 * 纯函数：按「前缀 → 用户提示词 → 中缀 → 后缀」拼装。
 * 空段直接跳过（不产生多余空行）。
 */
export function composePrompt(prompt, { prefix = '', middle = '', suffix = '' } = {}) {
  const body = String(prompt ?? '');
  const parts = [prefix, body, middle, suffix]
    .map((p) => String(p ?? '').trim())
    .filter((p) => p !== '');
  return parts.join(JOINER);
}

/** 三段包装文案的取值。`readSetting` 缺失时给空串，与"没配过"等价。 */
const readParts = (readSetting) => ({
  prefix: readSetting(PROMPT_WRAP_KEYS.prefix, '') || '',
  middle: readSetting(PROMPT_WRAP_KEYS.middle, '') || '',
  suffix: readSetting(PROMPT_WRAP_KEYS.suffix, '') || '',
});

const allBlank = ({ prefix, middle, suffix }) =>
  !String(prefix).trim() && !String(middle).trim() && !String(suffix).trim();

/**
 * 取"实际发给上游的文本"。**这是生成链路唯一该调用的入口。**
 *
 * @param {string} prompt 用户原文
 * @param {object} [opts]
 * @param {(key: string, fallback?: string) => string} [opts.readSetting] 便于单测注入
 * @param {'all'|'v1'|'admin'} [opts.scope='v1'] 当前入口属于哪一侧，用于三层开关的范围层。
 *        默认 `v1`：包装最终是发给上游的，调用方是用户端/网关，算"对外"这一侧。
 * @returns {{text: string, applied: boolean, reason: string, switch: object}}
 *   `text` 永远是可直接使用的（未包装时就是原文），调用方不需要分支。
 *   `reason ∈ disabled | scope_off | empty | too_long | applied`
 */
export function upstreamPrompt(prompt, { readSetting = getSetting, scope = 'v1' } = {}) {
  const original = String(prompt ?? '');
  // 三段先读出来：既用于"是不是全空"这个前提判断，也用于真正拼装（只读一次设置）。
  const parts = readParts(readSetting);

  // 三层开关，判定逻辑集中在 promptWrapView（与状态接口共用同一份判定）。
  // 第三层（实际生效）在这里的价值就是最常见的那个场景：
  // **开关开了、但三段都没填** —— 改造前这只能靠人去翻设置才发现。
  // 总开关默认**关**（feature-switch 的 fallback='false'）：包装会改变上游看到的内容，
  // 属于运营决策，不该在升级后"自动生效"。
  const view = promptWrapView({ readSetting, scope });

  /**
   * ★ 时长描述改写对**每一条返回路径**都生效。
   *
   * 它是"内容净化"，不是"运营话术"，所以与三层开关**无关** ——
   * 开关关着（默认）时也必须生效，否则「包装没开」就成了这道净化的后门。
   * 没命中时逐字节返回原文（见 replaceDurationMentions），不会给正常文案引入差异。
   */
  if (!view.effective_enabled) {
    const text = replaceDurationMentions(original);
    // 保留原有 reason 词表（disabled / empty），只新增一个"被范围挡住"的分支。
    // `switch` 一起回传，让调用方/状态接口能给出"为什么没生效"而不是一个干瘪的 false。
    if (!view.enabled) return { text, applied: false, reason: 'disabled', switch: view };
    if (!view.scope_enabled) return { text, applied: false, reason: 'scope_off', switch: view };
    return { text, applied: false, reason: 'empty', switch: view };
  }

  /**
   * ⚠️ **拼好之后只改一次**，不要"先改写原文、再改写拼装结果"。
   *
   * 两段式写法（本函数早先的版本）会踩一个顺序坑：正文先改写 → 拿到「镜头一」，
   * 第二次改写时计数器已经从 1 起跳，前缀里的时长只能领到更大的号；
   * 可拼完之后前缀是排在正文**前面**的 —— 读起来就是「镜头二 … 镜头一 … 镜头三」，
   * 明明没有重号，顺序却是乱的。
   * 一次改写 + `maxExistingShotIndex` 接续，编号自然跟着最终文本顺序走。
   */
  const text = replaceDurationMentions(composePrompt(original, parts));
  if (text.length > PROMPT_WRAP_MAX_LENGTH) {
    // 明确放弃并留痕，绝不静默截断（见 PROMPT_WRAP_MAX_LENGTH 的说明）。
    console.warn(`[prompt-wrap] 包装后长度 ${text.length} 超过上限 ${PROMPT_WRAP_MAX_LENGTH}，本次未包装`);
    return { text: replaceDurationMentions(original), applied: false, reason: 'too_long', switch: view };
  }
  return { text, applied: true, reason: 'applied', switch: view };
}

/**
 * 提示词包装的三层开关视图（`enabled` / `scope_enabled` / `effective_enabled` + `reasons`）。
 *
 * 把这段独立出来，是为了让 `promptWrapEnabled`（只要布尔）和状态接口（要三层细节）
 * **走同一份判定**。复制两份判定的后果是它们迟早会漂移，
 * 而漂移的表现恰好就是"状态接口说关了、实际还在包"。
 */
export function promptWrapView({ readSetting = getSetting, scope = 'v1' } = {}) {
  const parts = readParts(readSetting);
  return switchView({
    key: PROMPT_WRAP_KEYS.enabled,
    scope,
    readSetting,
    prerequisites: allBlank(parts) ? [{ ok: false, reason: '包装文案三段（前缀/中缀/后缀）都为空' }] : [],
  });
}

/**
 * 只给状态接口用的"是否**实际**生效"摘要。
 *
 * ⚠️ 这里**故意只回布尔、不回包装文案**：前缀/中缀/后缀是我们给上游的话术，
 * 属于运营 know-how，把它下发到 `/v1/status` 等于把提示词工程交给了调用方
 * （参考站也只在自己后台的管理接口里暴露 `prompt-wrap`）。
 *
 * ⚠️ 这个布尔必须与 `upstreamPrompt().applied` 同口径（有专门的测试钉住）：
 *    "状态说关了、实际却包了"是这类功能最经典的翻车方式。
 */
export function promptWrapEnabled({ readSetting = getSetting, scope = 'v1' } = {}) {
  return promptWrapView({ readSetting, scope }).effective_enabled;
}

export { SWITCH_SCOPES };
