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
  composePrompt, upstreamPrompt, promptWrapEnabled, replaceDurationMentions,
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

// ─────────────────────── ⑧ ★ 时长描述改写（2026-09-29 飞哥三次收紧口径）───────────────────────
//
// ① 「提交上去的文案不要出现 30s 的字样」
// ② 「所有提交的文案里都自动去除关于时长的描述」
// ③ 「将 xx秒—xx秒 按顺序替换成镜头一、镜头二」+「全部统一换成镜头N」
//
// ⇒ 最终口径是**改写**而不是删除：时长描述在分镜稿里本来就承担「这一段是哪一镜」的
//   分段作用，直接删字会把镜头结构抹平。所以按出现顺序改写成「镜头一」「镜头二」…
//
// ⚠️ 这些测试的另一半价值是**误伤面**：宽高比、时钟戳、中文数字叙事（三十万彩礼、
//    闭目半秒）必须一个字都不动 —— 那些误伤改坏的是剧本正文，比"时长没清干净"严重得多。
test('replaceDurationMentions：各档位/各写法的时长都改写成「镜头N」，且编号连续', () => {
  const cases = [
    ['…眼神不断斜瞟林晚。 30s', '…眼神不断斜瞟林晚。 镜头一'],
    ['橘猫翻滚。总时长 30 秒', '橘猫翻滚。镜头一'],
    ['橘猫翻滚。时长：30秒', '橘猫翻滚。镜头一'],
    ['橘猫翻滚。时长：30', '橘猫翻滚。镜头一'],        // 没单位的元数据写法也要覆盖
    ['橘猫翻滚。duration 30sec', '橘猫翻滚。镜头一'],
    ['片长 15 秒，横屏', '镜头一，横屏'],              // 不再只清 30 这一档
    ['3 秒后她缓缓抬起头', '镜头一她缓缓抬起头'],       // 「后」要一起吃掉，否则留下半截话
    ['请控制在 20 秒左右，不要太长', '请镜头一，不要太长'],
    ['A  30s  B', 'A 镜头一 B'],                       // 删字留下的多余空格要合并
  ];
  for (const [input, expected] of cases) {
    assert.equal(replaceDurationMentions(input), expected, `输入 ${JSON.stringify(input)}`);
  }

  // 一整条分镜轨：编号必须连续
  assert.equal(
    replaceDurationMentions('30s 林晚攥紧拳头\n30s 王桂兰拍桌\n10秒—20秒 张富贵翘腿\n30s 林晚反问'),
    '镜头一 林晚攥紧拳头\n镜头二 王桂兰拍桌\n镜头三 张富贵翘腿\n镜头四 林晚反问',
  );
  // 超过 10 镜也要正常（中文数字两位数）
  const many = Array.from({ length: 12 }, () => '30s 一段画面').join('\n');
  assert.ok(replaceDurationMentions(many).includes('镜头十二'), '第 12 镜应写成「镜头十二」');
});

test('★ 飞哥点名的形态：时间码 / 区间，且一个区间只吃一个编号（不能串位）', () => {
  const cases = [
    ['0:10 林晚攥紧拳头', '镜头一 林晚攥紧拳头'],
    ['00:10 林晚攥紧拳头', '镜头一 林晚攥紧拳头'],
    ['00-10 林晚攥紧拳头', '镜头一 林晚攥紧拳头'],       // 行首纯数字区间
    ['10秒—20秒 林晚攥紧拳头', '镜头一 林晚攥紧拳头'],   // 飞哥原话里的形态
    ['10秒-20秒 王桂兰拍桌', '镜头一 王桂兰拍桌'],
    ['10—20秒 张富贵翘腿', '镜头一 张富贵翘腿'],
    // ⚠️ 带冒号的区间必须整体吃掉，否则会被拆成「镜头一-镜头二」两个标签、编号直接串位
    ['0:00-0:10 开场宴会厅全景', '镜头一 开场宴会厅全景'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(replaceDurationMentions(input), expected, `输入 ${JSON.stringify(input)}`);
  }
});

test('★★ 误伤面：宽高比 / 时钟戳 / 分辨率区间 / 中文数字叙事，一个字都不许动', () => {
  const mustKeep = [
    '画面比例 16:9，写实风格',                    // 宽高比（第二段 1 位，天然不匹配）
    '9:16 竖屏，画幅 21:9 上下留黑',               // ⚠️ 9:16 第二段是 2 位 → 靠白名单挡
    '比例 16:10 的横幅构图',                      // ⚠️ 16:10 同样靠白名单挡
    '缓慢推进收尾 23:47:31',                      // 三段时钟戳，不是时间码
    '拍摄时间 00:15:02',
    '三十万彩礼，是给你弟买房的！',                 // 中文数字 + 无单位
    '@image1胸口深深起伏，闭目半秒后骤然睁开',      // 「半」不该被当成数字
    '八年，我每个月都往家里打钱',
    '视频 id 是 vid30s01',                        // 标识符（前界是字母）
    '长度 1080 像素',                             // 标签 + 数字，但没有时长单位
    '第 1080 帧',                                 // 帧不是时长单位
    '今天十五号，天气不错',
    '【16:9横屏】【4K】【24帧】',
    '10-20人 的群演站在桌旁',                      // ⚠️ 不在行首的数字区间，不许动
    '这是 1080-1920 的分辨率区间',
    '严格遵循提示词，直接执行，不要进行任何修改和自动联想。',
  ];
  for (const text of mustKeep) {
    assert.equal(replaceDurationMentions(text), text, `不该动：${JSON.stringify(text)}`);
  }
});

test('★ 没命中时逐字节返回原文（不许顺手改排版）', () => {
  const clean = '第一行   有三个空格\n\n第二行末尾有空格   \n';
  assert.equal(replaceDurationMentions(clean), clean);
  assert.equal(replaceDurationMentions(''), '');
  assert.equal(replaceDurationMentions(null), '');
});

test('★ 改写先于包装、且与三层开关无关：包装关着（默认）也必须生效', () => {
  const dirty = '一只橘猫在窗台上打哈欠，阳光洒进来 30s';
  const off = upstreamPrompt(dirty, { readSetting: reader({}) });
  assert.equal(off.applied, false, '包装默认关着');
  assert.equal(off.reason, 'disabled');
  assert.ok(!/30\s*(?:秒钟?|seconds?|secs?|s)/i.test(off.text), `发出去的文本仍有 30s：${off.text}`);
  assert.ok(off.text.includes('镜头一'), `应当改写成镜头一：${off.text}`);

  // 运营把时长写进了包装话术里 → 那也算"提交上去的文案"，同样要改
  const on = upstreamPrompt(dirty, {
    readSetting: reader({
      ...ON,
      [PROMPT_WRAP_KEYS.prefix]: '请生成一段 30s 的竖屏短视频',
      [PROMPT_WRAP_KEYS.suffix]: '请控制在 30 秒以内',
    }),
  });
  assert.equal(on.applied, true);
  assert.ok(!/\d{1,4}\s*(?:秒钟?|秒|secs?|s)/i.test(on.text), `包装段里的时长也该改：${on.text}`);
  // ⚠️ 编号必须跟着**最终文本顺序**走（前缀 → 正文 → 后缀），不能出现
  //    「镜头二 … 镜头一 … 镜头三」这种没有重号、顺序却乱掉的结果。
  //    早先"先改写原文、再改写拼装结果"的两段式写法就会踩这个坑，这条断言把它钉死。
  assert.equal(
    on.text,
    '请生成一段 镜头一 的竖屏短视频\n一只橘猫在窗台上打哈欠，阳光洒进来 镜头二\n请镜头三',
    `编号顺序不对：${JSON.stringify(on.text)}`,
  );
  assert.equal((on.text.match(/镜头一/g) || []).length, 1, '不能出现两个「镜头一」');
});

test('★★ 改写后回显判定的口径：轮询必须传"实际发出去的那份"，不能传 row.prompt', () => {
  const dirty = '一只橘猫在窗台上打哈欠，阳光洒进来 30s';
  const sent = upstreamPrompt(dirty, { readSetting: reader({}) }).text;
  assert.ok(!sent.includes('30s'), '发出去的文本里不该再有 30s');

  // ✅ 正确口径 —— 就是 generator.js 的 submittedPromptText(row.prompt)：
  //    提交用什么、轮询就拿什么，prompt_echo 照常命中。
  assert.equal(classifyChainText(sent, { prompt: sent }).rule, 'prompt_echo',
    '提交与轮询同口径时，回显判定必须仍然成立');

  // ⛔ 错误口径 —— 轮询若还拿库里的原文 dirty，includes 失败 → 判成 none。
  //    这正是"改了提交侧却忘了轮询侧"会踩的坑：不报错、不告警，
  //    只是协议漂移检测永远不再命中，等于那套监控白装。
  //    这条断言把 generator.js「必须用 submittedPromptText」这个契约钉死。
  assert.notEqual(classifyChainText(sent, { prompt: dirty }).rule, 'prompt_echo',
    '两边口径不一致时必须能被这条测试抓住');
});

test('★ 幂等：同一份文本过两遍等于过一遍（提交/轮询各自调用也不会漂移）', () => {
  const once = replaceDurationMentions('镜头 30s 慢慢推进，控制 30 秒以内\n0:10 第二镜');
  assert.equal(replaceDurationMentions(once), once);
  // upstreamPrompt 的值也不能再喂回给它自己（它带包装、不幂等）—— 这里只钉纯函数那一层。
  const twice = upstreamPrompt(once, { readSetting: reader({}) }).text;
  assert.equal(twice, once);
});

// ⚠️ 上线前还额外做过一次"真实文案回归"（不在本文件里，因为要连生产库）：
//    把线上 `dola_videos.prompt` 全 18 条原文喂给本函数做逐字 diff → **改动 0 条**。
//    脚本：/tmp/export-prompts.py（导出）+ /tmp/diff-live-prompts.mjs（比对）。


