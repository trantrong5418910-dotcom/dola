/**
 * 三层开关：`enabled`（总开关）/ `scope_enabled`（范围）/ `effective_enabled`（实际生效）。
 *
 * ── 为什么需要第三层 ─────────────────────────────────────────────────────
 * 现在只有一层布尔。于是「开关开了、但实际没生效」这种状态**无法表达**，典型两种：
 *   · 提示词包装开了，但前缀/中缀/后缀都留空 → 实际不包装；
 *   · 网关开了，但号池是空的 → 实际不可用。
 * 现象是运维说「我明明开了啊」，然后去翻日志猜。
 *
 * 第三层的价值就是把**配置意图**和**运行时事实**分开显示：
 *   enabled=true, scope_enabled=true, effective_enabled=false
 *   reasons: ['号池没有可用账号', '包装文案三段都为空']
 * —— 一眼看出"不是没开，是开了没条件生效"。
 *
 * ── 范围层（scope）的取值 ─────────────────────────────────────────────────
 * 设置 `<key>_scope` 存 `all` / `v1` / `admin`：
 *   · `all`   所有入口都按总开关走（默认，行为与"只有一层开关"完全一致）
 *   · `v1`    只对 `/v1` 对外接口生效，后台/工作台不受影响
 *   · `admin` 只对后台/工作台生效，对外接口不受影响
 * 默认 `all` 是刻意的：升级之后**不能改变任何既有行为**。
 */
import { getSetting } from '../db.js';

/** 参与三层开关的开关 key。集中在这里避免拼错（拼错的表现是"开关点了没反应"）。 */
export const SWITCH_KEYS = Object.freeze({
  gateway: 'gateway_enabled',
  promptWrap: 'gateway_prompt_wrap_enabled',
});

export const SWITCH_SCOPES = Object.freeze(['all', 'v1', 'admin']);

/** 旧的布尔设置语义：**严格等于字符串 'true'** 才算开（与全项目一致）。 */
export const isOn = (raw) => String(raw ?? 'false').trim().toLowerCase() === 'true';

export const scopeKeyOf = (key) => `${key}_scope`;

/**
 * 读一个开关的三层状态。
 *
 * @param {object} p
 * @param {string} p.key              开关的设置 key
 * @param {string} [p.scope='all']    调用方所在的入口：`all` / `v1` / `admin`
 * @param {Array<{ok:boolean, reason:string}>} [p.prerequisites=[]]
 *        运行时前提。**只有 ok=false 的会被收进 reasons**，`ok=true` 的不产生噪音。
 * @param {string} [p.fallback='false']
 *        设置行不存在时按什么值算。⚠️ 这个参数是**兼容性保险**：既有代码里
 *        `gateway_enabled` 的默认是 `'true'`（缺行 = 开），如果这里硬编 `'false'`，
 *        一次"设置行丢失"就会把对外网关静默关掉。迁移到本模块时必须把默认值带过来。
 * @returns {{key:string, enabled:boolean, scope_enabled:boolean, effective_enabled:boolean,
 *            scope:string, configuredScope:string, reasons:string[]}}
 */
export function switchView({ key, scope = 'all', prerequisites = [], fallback = 'false', readSetting = getSetting } = {}) {
  const enabled = isOn(readSetting(key, fallback));

  const configuredScope = String(readSetting(scopeKeyOf(key), 'all') || 'all').trim().toLowerCase();
  const scopeKnown = SWITCH_SCOPES.includes(configuredScope);
  // 认不出来的 scope 一律当 all：宁可多生效，也不要因为写错一个词让功能静默全关
  // （后者表现为"开关开着但哪都不生效"，比多生效难查得多）。理由会写进 reasons。
  const effectiveScope = scopeKnown ? configuredScope : 'all';
  const scope_enabled = effectiveScope === 'all' || effectiveScope === scope;

  const reasons = [];
  if (!scopeKnown && configuredScope) reasons.push(`范围值「${configuredScope}」无法识别，已按 all 处理`);
  if (!enabled) reasons.push('总开关未开启');
  else if (!scope_enabled) reasons.push(`范围限定了「${effectiveScope}」，当前入口是「${scope}」`);
  for (const p of prerequisites) if (p && p.ok === false) reasons.push(p.reason || '前提条件不满足');

  return {
    key,
    enabled,
    scope_enabled,
    // 三层都过才算"实际生效"。注意 enabled=true 且 scope_enabled=true 但前提不满足时
    // 这里会是 false —— 那正是这个模块存在的意义。
    effective_enabled: enabled && scope_enabled && !prerequisites.some((p) => p && p.ok === false),
    scope,
    configuredScope: effectiveScope,
    reasons,
  };
}

/**
 * 只回报布尔的简写。给"我只需要知道到底生不生效"的调用点用。
 * ⚠️ 与 `prompt-wrap.js` 的 `promptWrapEnabled` 同样的理由：
 *    对外接口只该拿到布尔，不该拿到我们内部的判定细节。
 */
export const switchEffective = (opts) => switchView(opts).effective_enabled;
