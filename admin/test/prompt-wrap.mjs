/**
 * 提示词包装（前缀/中缀/后缀）的单测。
 *
 * 不碰数据库：`prompt-wrap.js` 通过 `readSetting` 注入读取，本测试全部用假设置。
 *
 * 这份测试的重点**不是**"拼出来的字符串长什么样"，而是两条会被静默写坏的硬约束：
 *   ① 包装只能"拼接"，**绝不能"改写"** —— 因为下游 chain-text-rules 的 `prompt_echo`
 *      靠 `text.includes(原文)` 判"上游只是回显了我的话、并没有真生成"。
 *      原文一旦不再是被发出去那段文本的子串，回显判定就会**静默失效**：
 *      不报错、不告警，只是协议漂移检测永远不再命中，等于那套监控白装。
 *      ⇒ 所以下面有一段**直接拿真分类器断言**的测试，而不是自己写个 includes 模拟。
 *   ② 超长时必须**放弃包装**而不是截断 —— 截断会悄悄改掉用户的话。
 *      这种错误的表象是"生成的视频和预期不符"，永远查不到包装这一层。
 *
 * 另外顺手钉死一个经典字符串陷阱：设置项存的是字符串，
 * `gateway_prompt_wrap_enabled = 'false'` 用 `Boolean(v)` 判会得到 **true**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMPT_WRAP_KEYS, PROMPT_WRAP_MAX_LENGTH,
  composePrompt, upstreamPrompt, promptWrapEnabled,
} from '../server/dola/prompt-wrap.js';
// ★ 故意引用**真**分类器，而不是自己写个 includes 复刻一遍：
//   复刻版只证明"我以为的判定是这样"，真分类器才证明"线上跑的那份判定没被破坏"。
import { classifyChainText } from '../server/dola/chain-text-rules.js';

/** 构造一个 readSetting。传对象即可，未提到的 key 走 fallback。 */
const reader = (map) => (key, fallback = null) => (key in map ? map[key] : fallback);

const ON = { [PROMPT_WRAP_KEYS.enabled]: 'true' };
/** 分类器有 8 字下限（MIN_ECHO_PROMPT_LENGTH），短提示词会被判"没条件判"，所以测试里都写长的。 */
const PROMPT = '一只橘猫在窗台上打哈欠，阳光洒进来';

// ─────────────────────── ① 拼装顺序 ───────────────────────
test('composePrompt：顺序必须是 前缀 → 用户提示词 → 中缀 → 后缀', () => {
  const out = composePrompt(PROMPT, { prefix: 'P', middle: 'M', suffix: 'S' });
  assert.equal(out, `P\n${PROMPT}\nM\nS`);
  // 用 indexOf 再钉一次相对顺序（防止有人把 middle/suffix 写反了却拼出同长度字符串）
  assert.ok(out.indexOf('P') < out.indexOf(PROMPT));
  assert.ok(out.indexOf(PROMPT) < out.indexOf('M'));
  assert.ok(out.indexOf('M') < out.indexOf('S'));
});

test('composePrompt：空段不产生多余的换行/空行', () => {
  assert.equal(composePrompt(PROMPT, { prefix: 'P' }), `P\n${PROMPT}`);
  assert.equal(composePrompt(PROMPT, { suffix: 'S' }), `${PROMPT}\nS`);
  assert.equal(composePrompt(PROMPT, { middle: 'M' }), `${PROMPT}\nM`);
  // 只有空白的段等同于空段（不能拼出一个只有空白的"段"）
  assert.equal(composePrompt(PROMPT, { prefix: '   ', suffix: '\n' }), PROMPT);
  assert.equal(composePrompt(PROMPT, {}), PROMPT);
});

test('composePrompt：各段两端空白被裁掉（中缀/后缀前后的空行不会漏进上游）', () => {
  assert.equal(composePrompt(PROMPT, { prefix: '  P  ', suffix: '  S  ' }), `P\n${PROMPT}\nS`);
});

// ─────────────────────── ② 开关语义 ───────────────────────
test('★ 开关默认关闭：没配过（fallback）时不包装，返回用户原文', () => {
  const r = upstreamPrompt(PROMPT, { readSetting: reader({}) });
  assert.equal(r.text, PROMPT);
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'disabled');
});

test('★ 字符串陷阱：enabled = "false" 绝不能开启（Boolean("false") === true）', () => {
  for (const v of ['false', 'FALSE', ' false ', '0', '', 'no', 'off']) {
    const r = upstreamPrompt(PROMPT, {
      readSetting: reader({ ...ON, [PROMPT_WRAP_KEYS.enabled]: v, [PROMPT_WRAP_KEYS.prefix]: 'P' }),
    });
    assert.equal(r.applied, false, `enabled=${JSON.stringify(v)} 不该开启包装`);
    assert.equal(r.text, PROMPT);
    assert.equal(r.reason, 'disabled');
  }
});

test('开关开启判定对大小写/空白宽容（避免后台填 True 却"点了没反应"）', () => {
  for (const v of ['true', 'TRUE', 'True', ' true ']) {
    const r = upstreamPrompt(PROMPT, {
      readSetting: reader({ ...ON, [PROMPT_WRAP_KEYS.enabled]: v, [PROMPT_WRAP_KEYS.prefix]: 'P' }),
    });
    assert.equal(r.applied, true, `enabled=${JSON.stringify(v)} 应当开启`);
  }
});

test('开关开着但三段全空/全空白 → 等于没包装（reason=empty，别记为 applied）', () => {
  for (const parts of [{}, { prefix: '', middle: '', suffix: '' }, { prefix: '  ', suffix: '\n' }]) {
    const r = upstreamPrompt(PROMPT, { readSetting: reader({ ...ON, ...parts }) });
    assert.equal(r.text, PROMPT);
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'empty');
  }
});

test('开关开启且有内容 → applied，且三段都出现', () => {
  const r = upstreamPrompt(PROMPT, {
    readSetting: reader({ ...ON, [PROMPT_WRAP_KEYS.prefix]: 'P', [PROMPT_WRAP_KEYS.middle]: 'M', [PROMPT_WRAP_KEYS.suffix]: 'S' }),
  });
  assert.equal(r.applied, true);
  assert.equal(r.reason, 'applied');
  assert.equal(r.text, composePrompt(PROMPT, { prefix: 'P', middle: 'M', suffix: 'S' }));
});

// ─────────────────────── ③ ★ 不破坏回显判定（本文件最重要的断言）───────────────────────
test('★ 原文始终是"发出去那段文本"的子串（这就是"只许拼接、不许改写"的原因）', () => {
  const readSetting = reader({ ...ON, [PROMPT_WRAP_KEYS.prefix]: '按平台规范生成：', [PROMPT_WRAP_KEYS.middle]: '画面写实。', [PROMPT_WRAP_KEYS.suffix]: '不要出现文字水印。' });
  const { text, applied } = upstreamPrompt(PROMPT, { readSetting });
  assert.equal(applied, true);
  assert.ok(text.includes(PROMPT), '原文必须是子串，否则 prompt_echo 会静默失效');
});

test('★ 真分类器端到端：把包装后的文本丢给 prompt_echo，仍判为回显（漂移检测没被破坏）', () => {
  const readSetting = reader({ ...ON, [PROMPT_WRAP_KEYS.prefix]: '按平台规范生成：', [PROMPT_WRAP_KEYS.middle]: '画面写实。', [PROMPT_WRAP_KEYS.suffix]: '不要出现文字水印。' });
  const wrapped = upstreamPrompt(PROMPT, { readSetting }).text;

  // 提交时发的是 wrapped，轮询时拿的仍是 row.prompt（= 用户原文）—— generator.js 就是这么连的。
  const flat = classifyChainText(wrapped, { prompt: PROMPT, hasVideo: false });
  assert.equal(flat.rule, 'prompt_echo', `包装后应仍能被认成回显，实际=${flat.rule}`);

  // 真实消息链是嵌套 JSON：提示词会被转义 1～2 层，分类器会试 3 种形态。
  // 包装段一起被转义后，原文本的转义形态依然是它的子串，所以三种形态都不该漏判成 none。
  const level1 = JSON.stringify(wrapped).slice(1, -1);
  const level2 = JSON.stringify(level1).slice(1, -1);
  for (const [name, chain] of [['裸文本', wrapped], ['转义1层', level1], ['转义2层', level2]]) {
    const r = classifyChainText(chain, { prompt: PROMPT, hasVideo: false });
    assert.equal(r.rule, 'prompt_echo', `${name}：应为 prompt_echo，实际=${r.rule}（证据：${r.evidence}）`);
  }
});

test('★ 反证：如果哪天改成"改写式"包装，回显判定就会失效（把这条性质钉成测试）', () => {
  const readSetting = reader({ ...ON, [PROMPT_WRAP_KEYS.prefix]: 'P', [PROMPT_WRAP_KEYS.middle]: 'M', [PROMPT_WRAP_KEYS.suffix]: 'S' });
  const wrapped = upstreamPrompt(PROMPT, { readSetting }).text;
  assert.equal(classifyChainText(wrapped, { prompt: PROMPT }).rule, 'prompt_echo');

  // 模拟"改写"：把用户原句从包装结果里抹掉，只留我们的运营话术。
  const rewritten = wrapped.replace(PROMPT, '一只橘猫在窗台上打哈欠');
  const r = classifyChainText(rewritten, { prompt: PROMPT });
  assert.notEqual(r.rule, 'prompt_echo',
    '改写式包装会让回显判定失灵 —— 这正是 prompt-wrap 只做拼接、绝不改写的原因');
  assert.equal(r.rule, 'none');
});

test('★ 原文两端有空白时也安全：分类器对 needle 也 trim，两边口径一致', () => {
  const padded = `  ${PROMPT}  `;
  const readSetting = reader({ ...ON, [PROMPT_WRAP_KEYS.prefix]: 'P', [PROMPT_WRAP_KEYS.suffix]: 'S' });
  const wrapped = upstreamPrompt(padded, { readSetting }).text;
  // 提交时实际发出去的是裁剪过的原文；轮询拿到的 row.prompt 可能带空白 —— 分类器会 trim。
  assert.ok(wrapped.includes(PROMPT));
  assert.equal(classifyChainText(wrapped, { prompt: padded }).rule, 'prompt_echo');
});

// ─────────────────────── ④ 超长：放弃而不是截断 ───────────────────────
test('★ 超长必须放弃包装（不许截断）：text 退回用户原文', () => {
  const readSetting = reader({ ...ON, [PROMPT_WRAP_KEYS.prefix]: 'x'.repeat(PROMPT_WRAP_MAX_LENGTH) });
  const r = upstreamPrompt(PROMPT, { readSetting });
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'too_long');
  assert.equal(r.text, PROMPT, '必须原样退回用户原文，不能返回被截断的包装文本');
  assert.ok(r.text.length < PROMPT_WRAP_MAX_LENGTH);
});

test('长度边界：正好等于上限时仍包装，超 1 字才放弃（边界不许差一）', () => {
  const body = 'x'.repeat(PROMPT_WRAP_MAX_LENGTH - PROMPT.length - 1); // +1 = 中间那个换行
  const exact = upstreamPrompt(PROMPT, { readSetting: reader({ ...ON, [PROMPT_WRAP_KEYS.prefix]: body }) });
  assert.equal(exact.text.length, PROMPT_WRAP_MAX_LENGTH);
  assert.equal(exact.applied, true);

  const over = upstreamPrompt(PROMPT, { readSetting: reader({ ...ON, [PROMPT_WRAP_KEYS.prefix]: `${body}x` }) });
  assert.equal(over.applied, false);
  assert.equal(over.reason, 'too_long');
});

test('上限值与 /v1 对 prompt 的 12000 字上限对齐（改一边必须想到另一边）', () => {
  assert.equal(PROMPT_WRAP_MAX_LENGTH, 12000);
});

// ─────────────────────── ⑤ 状态接口只暴露布尔 ───────────────────────
test('★ promptWrapEnabled 只回布尔，不回包装文案（别把提示词工程下发给调用方）', () => {
  const wrapText = '按平台规范生成：画面写实。不要出现文字水印。';
  const readSetting = reader({ ...ON, [PROMPT_WRAP_KEYS.prefix]: wrapText });
  const value = promptWrapEnabled({ readSetting });
  assert.equal(typeof value, 'boolean');
  assert.equal(value, true);
  // 整个返回值序列化后绝不能出现运营话术
  assert.ok(!JSON.stringify(value).includes('平台规范'), '状态接口不得泄露包装文案');
  assert.ok(!JSON.stringify({ prompt_wrapped: value }).includes(wrapText));
});

test('promptWrapEnabled：未配置 → false（不是 null/undefined/字符串）', () => {
  const value = promptWrapEnabled({ readSetting: reader({}) });
  assert.equal(typeof value, 'boolean');
  assert.equal(value, false);
  assert.equal(promptWrapEnabled({ readSetting: reader({ [PROMPT_WRAP_KEYS.enabled]: 'false' }) }), false);
});

test('promptWrapEnabled 与 upstreamPrompt 对开关口径一致（不能出现"状态说关了、实际包了"）', () => {
  for (const v of ['true', 'false', 'TRUE', '0', '', '  ']) {
    const readSetting = reader({ ...ON, [PROMPT_WRAP_KEYS.enabled]: v, [PROMPT_WRAP_KEYS.prefix]: 'P' });
    const enabled = promptWrapEnabled({ readSetting });
    const applied = upstreamPrompt(PROMPT, { readSetting }).applied;
    assert.equal(applied, enabled, `enabled=${JSON.stringify(v)} 时两个入口口径不一致`);
  }
});

// ─────────────────────── ⑥ 设置 key 本身 ───────────────────────
test('PROMPT_WRAP_KEYS：冻结、四个 key 互不相同、且不是空串', () => {
  assert.ok(Object.isFrozen(PROMPT_WRAP_KEYS));
  const values = Object.values(PROMPT_WRAP_KEYS);
  assert.equal(values.length, 4);
  assert.equal(new Set(values).size, 4);
  for (const v of values) assert.ok(typeof v === 'string' && v.length > 0);
});

test('返回值形状稳定：未包装时 text 也可直接用（调用方不该需要分支）', () => {
  for (const readSetting of [reader({}), reader({ ...ON, [PROMPT_WRAP_KEYS.prefix]: 'P' })]) {
    const r = upstreamPrompt(PROMPT, { readSetting });
    assert.equal(typeof r.text, 'string');
    assert.equal(typeof r.applied, 'boolean');
    assert.ok(['disabled', 'scope_off', 'empty', 'too_long', 'applied'].includes(r.reason));
  }
});

// ─────────────────────── ⑦ 三层开关（enabled / scope / effective）───────────────────────
//
// 这一层解决的是「我明明开了啊」：改造前只有一层布尔，于是
// 「开关开着、但三段都没填」「开关开着、但范围限定了别的入口」都只能算 enabled=true，
// 状态接口回报 true、实际却什么都没包。
test('★ 开关开了但三段全空：reason=empty，且 switch 能说清"不是没开"', () => {
  const r = upstreamPrompt(PROMPT, { readSetting: reader({ ...ON }) });
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'empty');
  assert.equal(r.switch.enabled, true, '总开关确实是开的');
  assert.equal(r.switch.scope_enabled, true);
  assert.equal(r.switch.effective_enabled, false, '实际没生效 —— 这正是第三层要表达的');
  assert.ok(r.switch.reasons.some((x) => x.includes('为空')), `理由里要说清是文案为空，实际=${r.switch.reasons}`);
});

test('★ 范围层：scope=v1 时把包装限制在 v1，后台(admin)不该被包装', () => {
  const readSetting = reader({ ...ON, [PROMPT_WRAP_KEYS.prefix]: 'P', [`${PROMPT_WRAP_KEYS.enabled}_scope`]: 'v1' });
  const asV1 = upstreamPrompt(PROMPT, { readSetting, scope: 'v1' });
  assert.equal(asV1.applied, true, '范围内应当生效');
  const asAdmin = upstreamPrompt(PROMPT, { readSetting, scope: 'admin' });
  assert.equal(asAdmin.applied, false, '范围是 v1，后台入口不该被包装');
  assert.equal(asAdmin.reason, 'scope_off');
  assert.equal(asAdmin.text, PROMPT);
  assert.equal(asAdmin.switch.enabled, true);
  assert.equal(asAdmin.switch.scope_enabled, false);
});

test('★ 范围默认 all：升级后不改变任何既有行为（无 _scope 设置 = 到处生效）', () => {
  const readSetting = reader({ ...ON, [PROMPT_WRAP_KEYS.prefix]: 'P' });
  for (const scope of ['all', 'v1', 'admin']) {
    assert.equal(upstreamPrompt(PROMPT, { readSetting, scope }).applied, true, `scope=${scope} 应当生效`);
  }
});

test('★ 无法识别的范围值按 all 处理（写错一个词不能让功能静默全关）', () => {
  const readSetting = reader({ ...ON, [PROMPT_WRAP_KEYS.prefix]: 'P', [`${PROMPT_WRAP_KEYS.enabled}_scope`]: 'v2' });
  const r = upstreamPrompt(PROMPT, { readSetting, scope: 'admin' });
  assert.equal(r.applied, true, '认不出来的范围应当按 all 处理');
  assert.ok(r.switch.reasons.some((x) => x.includes('v2')), '但必须在理由里留痕');
});

test('★ promptWrapEnabled 与 applied 在"范围"这一层也同口径（不能状态说关、实际包了）', () => {
  const readSetting = reader({ ...ON, [PROMPT_WRAP_KEYS.prefix]: 'P', [`${PROMPT_WRAP_KEYS.enabled}_scope`]: 'v1' });
  for (const scope of ['all', 'v1', 'admin']) {
    const enabled = promptWrapEnabled({ readSetting, scope });
    const applied = upstreamPrompt(PROMPT, { readSetting, scope }).applied;
    assert.equal(applied, enabled, `scope=${scope} 时两个入口口径不一致`);
  }
  // 三段全空时也要一致（enabled=true 但 effective=false）
  const blank = reader({ ...ON });
  assert.equal(promptWrapEnabled({ readSetting: blank }), false);
  assert.equal(upstreamPrompt(PROMPT, { readSetting: blank }).applied, false);
});

test('空提示词也不炸：包装后至少不产生"只有包装段"的怪文本', () => {
  const readSetting = reader({ ...ON, [PROMPT_WRAP_KEYS.prefix]: 'P', [PROMPT_WRAP_KEYS.suffix]: 'S' });
  const r = upstreamPrompt('', { readSetting });
  assert.equal(r.text, 'P\nS');
  assert.equal(upstreamPrompt(null, { readSetting: reader({}) }).text, '');
  assert.equal(upstreamPrompt(undefined, { readSetting: reader({}) }).text, '');
});
