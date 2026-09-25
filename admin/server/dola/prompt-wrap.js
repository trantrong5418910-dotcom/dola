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

  if (!view.effective_enabled) {
    // 保留原有 reason 词表（disabled / empty），只新增一个"被范围挡住"的分支。
    // `switch` 一起回传，让调用方/状态接口能给出"为什么没生效"而不是一个干瘪的 false。
    if (!view.enabled) return { text: original, applied: false, reason: 'disabled', switch: view };
    if (!view.scope_enabled) return { text: original, applied: false, reason: 'scope_off', switch: view };
    return { text: original, applied: false, reason: 'empty', switch: view };
  }

  const text = composePrompt(original, parts);
  if (text.length > PROMPT_WRAP_MAX_LENGTH) {
    // 明确放弃并留痕，绝不静默截断（见 PROMPT_WRAP_MAX_LENGTH 的说明）。
    console.warn(`[prompt-wrap] 包装后长度 ${text.length} 超过上限 ${PROMPT_WRAP_MAX_LENGTH}，本次未包装`);
    return { text: original, applied: false, reason: 'too_long', switch: view };
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
