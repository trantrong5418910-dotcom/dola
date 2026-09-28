/**
 * 上游文本分类器 + 协议漂移告警的单测。
 *
 * 不碰数据库、不发网络、不读文件 —— 被测模块本身就是纯的（见 chain-text-rules.js 文件头）。
 * 重点验两类最容易被写错的东西：
 *   ① **规则顺序**：prompt_echo 必须垫底，否则会把每一轮都吃掉，其余规则全部失效
 *   ② **假告警防护**：没法判定（没提示词/提示词太短）时不能计入漂移，
 *      否则上游没变、我们自己天天报警
 *
 * 另外：几条**终态规则**（quota_exhausted / voided / content_refused / duration_inquiry）
 * 都对应着真实事故，每条都配了「认得出 + 不误伤」成对的用例。
 * 误伤方向也要钉死 —— 判错的代价是任务被判死并**自动退款**，
 * 假阳性比漏判更贵（钱已经退了）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyChainText, createChainTextObserver, recordChainText,
  CHAIN_TEXT_RULES, DEFAULT_DRIFT_THRESHOLD,
  readChainRefused, readChainClarifying, DURATION_INQUIRY_RES_CODE,
} from '../server/dola/chain-text-rules.js';

const PROMPT = '一只橘猫在窗台上打哈欠，阳光洒进来';

// ─────────────────────── ① 各规则都认得出来 ───────────────────────
test('★ quota_exhausted：认得出「当日生成次数用尽」（这是必须判终态的一类）', () => {
  // 真实样本，逐字取自生产任务 #145（会话 38417918852111121，账号 #419）：
  //   {"text_block":{"text":"今天的生成次数已经达到上限，明天再来免费生成吧"}}
  // 为什么必须判终态：同一号今天再提交也是同一句，继续轮询只会跑满 20 分钟时限、
  // 再被判成 uncertain，而 uncertain 会永久锁死账号（实测锁掉过 419）。
  for (const text of [
    '今天的生成次数已经达到上限，明天再来免费生成吧',
    '生成次数已达到上限',
    '今日生成次数已用完',
    '生成次数用尽',
  ]) {
    const r = classifyChainText(text, { prompt: PROMPT });
    assert.equal(r.rule, 'quota_exhausted', `「${text}」应判 quota_exhausted，实际 ${r.rule}`);
    assert.equal(typeof r.upstreamError, 'string', '要带出上游原话，终态说明要显示它');
  }
});

test('★ quota_exhausted 不得误伤「还有额度」的成功回执', () => {
  // 判据是"有没有 上限/用尽 语义"，不是"提没提到生成次数"。
  // 把正常回执判成用尽 = 好号被误判成没额度，直接少一个可用账号。
  for (const text of ['今日剩余 4 个视频生成额度', '本条消耗 2 个视频生成额度', '今日剩余 0 个视频生成额度']) {
    assert.equal(classifyChainText(text, { prompt: PROMPT }).rule, 'quota', `「${text}」不该判成用尽`);
  }
});

test('★ quota_exhausted 的回执必须完整（防「最左优先」截断 —— 这是 #146 实测出的真实缺陷）', () => {
  // 第一版实现把终态回执截成了「今天的生成次数」，丢掉了「已经达到上限，明天再来免费生成吧」。
  // 原因不是笔误，是 JS 正则的语义：`|` 是**最左优先**而不是最长优先。
  // `今天(?:的)?生成次数` 在 index 0 就命中，而更完整的 `生成次数…上限` 最早只能从 index 3 起，
  // 于是永远轮不到后者 —— 代码看起来"认得出来"，输出却是半截话。
  // 把完整子句钉成断言，否则将来有人重排分支又会静默退化。
  const r = classifyChainText('今天的生成次数已经达到上限，明天再来免费生成吧', { prompt: PROMPT });
  assert.equal(r.rule, 'quota_exhausted');
  assert.equal(r.upstreamError, '今天的生成次数已经达到上限',
    '必须连「已经达到上限」一起捕获；只拿到「今天的生成次数」说明分支顺序又退化了');
});

test('★ quota_exhausted 不得把「描述性额度文案」当成用尽（假阳性比漏判更贵：会白退款）', () => {
  // 「次数上限为 10 次」是在说明规则，不是在上报用尽。
  // 只要出现「上限」而不要求「到顶/用尽」的动词，就会在这里误判：
  // 任务被判终态失败 + 自动退款 —— 而视频其实还在正常生成。
  for (const text of ['免费用户每日生成次数上限为 10 次', '当前套餐额度上限 20 个', '视频生成次数上限说明']) {
    const r = classifyChainText(text, { prompt: PROMPT });
    assert.notEqual(r.rule, 'quota_exhausted', `「${text}」只是描述性文案，不该判成额度用尽`);
  }
});

test('voided：上游明确报生成失败', () => {
  for (const text of ['视频生成失败', '本次生成失败，请重试', '审核不通过：内容违规', '未通过审核']) {
    const r = classifyChainText(text, { prompt: PROMPT });
    assert.equal(r.rule, 'voided', `「${text}」应判 voided，实际 ${r.rule}`);
  }
});

test('★ voided：肖像保护软拒绝（生产任务 #188 原话，逐字）', () => {
  // 真实样本：账号 #436 / 30 秒 + 参考图 / 会话 38417956948437265。
  // 上游没建视频任务、只回了这句话（chain 里 ai_create_show_mode=text、content_type=9999），
  // 旧规则全部落空 ⇒ 白跑满时限 ⇒ uncertain（不终局、不退款、锁号）。
  const text = '出于肖像保护考虑，未认证人脸暂不支持用 Dreamina Seedance 2.5 生成视频。'
    + '你可以尝试换其它参考图或文生视频。';
  const r = classifyChainText(text, { prompt: PROMPT });
  assert.equal(r.rule, 'voided', `肖像保护软拒绝应判 voided，实际 ${r.rule}`);
  assert.match(r.evidence, /肖像保护/);
});

test('★ voided：肖像保护必须在**短提示词**下也认得出（#188 完全静默的真正原因）', () => {
  // #188 的提示词是「古代修仙」——4 个字，低于 MIN_ECHO_PROMPT_LENGTH(8)。
  // 旧行为：兜底判 rule='none' 且 classifiable=false ⇒ 连协议漂移告警都不响。
  // 新规则必须排在兜底**之前**，与提示词长短无关。
  const text = '出于肖像保护考虑，未认证人脸暂不支持用 Dreamina Seedance 2.5 生成视频。';
  const short = classifyChainText(text, { prompt: '古代修仙' });
  assert.equal(short.rule, 'voided', `短提示词下也应判 voided，实际 ${short.rule}`);
  assert.equal(short.classifiable, true);
  // 对照：只有短提示词、没有任何上游拒绝信号时，仍应保持"无法判定"而不是假漂移
  const onlyEcho = classifyChainText('生成视频：古代修仙，30s', { prompt: '古代修仙' });
  assert.equal(onlyEcho.rule, 'none');
  assert.equal(onlyEcho.classifiable, false, '短提示词不应被计入协议漂移');
});

test('★ voided：肖像保护口径必须收窄，不能误伤描述性文案（假阳性会白退款）', () => {
  for (const text of [
    '当前模型不支持用 4K 分辨率生成视频，可以选择 1080P。',
    '参考图功能已上线，你可以用参考图生成视频。',
  ]) {
    const r = classifyChainText(text, { prompt: PROMPT });
    assert.notEqual(r.rule, 'voided', `「${text}」不应判 voided`);
  }
});

// ─────────────── ①b 内容生成限制（content_refused）───────────────
/**
 * 事故来源：生产任务 #210（会话 38417957424987153、账号 #453、30 秒、pure-http）。
 * 上游对本次生成只回了一句拒绝，旧规则全部落空 ⇒ 轮询一路空转到 40 分钟时限
 * ⇒ 落 uncertain（**不退款 + 永久锁号**）。
 *
 * 用户原话：**「碰到这种,应该直接返回失败,不要让 #210 生成中 976s｜已轮询 17 次 一直轮训」**
 *
 * 这组用例就是这次事故的回归网 —— 判错的方向有两个，两个都贵：
 *   · 漏判 → 白等 40 分钟 + 锁号 + 不退钱（本次事故）
 *   · 误判 → 视频还在正常生成，任务却被判死并退款（假阳性比漏判更贵，钱已经退了）
 */
const CONTENT_REFUSED_SAMPLE = '我暂时无法生成你要求的内容。请尝试输入其他要求，我会尽力为你提供帮助。';

/** 把若干个 `ext` 包成 pullChain 的真实 JSON 形状，用于测两个 readChain* 结构化读取器。 */
const wrapExt = (...exts) => ({
  downlink_body: { pull_singe_chain_downlink_body: { messages: exts.map((ext) => ({ ext })) } },
});

test('★ content_refused：认得出 #210 的真实拒绝原话（逐字）', () => {
  const r = classifyChainText(CONTENT_REFUSED_SAMPLE, { prompt: PROMPT });
  assert.equal(r.rule, 'content_refused', `实际 ${r.rule}`);
  // upstreamError 要带**上游原话里命中的那一段**，且与 evidence 同步 ——
  // 这条一开始是红过的：文案兜底路径漏了 upstreamError，结构化路径却带，
  // 同类规则（quota_exhausted / duration_inquiry）的文案路径也都带。属于真实的不对称。
  assert.equal(typeof r.upstreamError, 'string', '终态说明要带出上游口径，不能只说"到时限了"');
  assert.match(r.upstreamError, /无法生成你要求的内容/);
  assert.match(r.evidence, /无法生成你要求的内容/, 'evidence 要留下命中的原话，方便对着日志复盘');
});

test('★ content_refused：上游换措辞也要认得出（宽口径，同 quota_exhausted / voided 的做法）', () => {
  // 上游一天之内在同类事故上换过多次措辞（见 QUOTA_EXHAUSTED_PATTERN 的注释），
  // 只钉一种说法 = 下次改文案又静默穿透回空转。
  for (const text of [
    '我目前不能生成该内容。请尝试输入其他要求。',
    '当前无法为你生成这段内容，请换个其他要求试试。',
    '抱歉，我暂时无法生成此视频。请尝试输入其他要求，我会尽力为您提供帮助。',
  ]) {
    assert.equal(classifyChainText(text, { prompt: PROMPT }).rule, 'content_refused', `「${text}」应判 content_refused`);
  }
});

test('★⚠️ content_refused 必须**两半都命中**：只有「无法生成」那半句一律不判', () => {
  // 「无法生成」单独出现时基本是**描述性文案**，不是对本次请求的拒绝。
  // 判错的代价：视频还在正常生成，任务却被判终态失败并自动退款。
  for (const text of [
    '该模型无法生成长视频，建议拆成两段。',
    '当前配置无法生成 4K 分辨率视频。',
    '如果无法生成视频，请检查网络后重试。',
    '我暂时无法生成你要求的内容。',                     // ← 缺"让你重说一个"那半句：不许判
  ]) {
    assert.notEqual(classifyChainText(text, { prompt: PROMPT }).rule, 'content_refused', `「${text}」不该判 content_refused`);
  }
});

test('★ content_refused：窗口有界 —— 拒绝句与「换个要求」隔太远不算同一次拒绝', () => {
  // 窗口是 80 字。实测样本里两半只隔「。请」2 个字；窗开太大只会扩大误伤面。
  const nope = `我暂时无法生成你要求的内容。${'。'.repeat(100)}请尝试输入其他要求。`;
  assert.notEqual(classifyChainText(nope, { prompt: PROMPT }).rule, 'content_refused', '超过 80 字窗口不该命中');
});

test('★ content_refused：结构化字段优先于文案（refused 非空即判，完全不看措辞）', () => {
  const r = classifyChainText('随便一句完全没有拒绝含义的话', {
    prompt: PROMPT, refused: '上游消息标记 volcano_refused="1"',
  });
  assert.equal(r.rule, 'content_refused');
  assert.match(r.evidence, /volcano_refused/);
  assert.equal(r.classifiable, true);
});

test('★ content_refused > duration_inquiry：两个结构化确证同时到达时，拒绝优先', () => {
  // 上游已经明确拒了这次生成，就不该再被当成"在等你回答时长方案"。
  // 顺序反了的表现是：一条本该退款+放行的任务，变成"已在等你回复"的终态说明。
  const r = classifyChainText(CONTENT_REFUSED_SAMPLE, {
    prompt: PROMPT,
    clarifying: '上游回执码 ai_creation_res_code=710082041',
    refused: '上游收尾原因 finish_reason_chat=safety_terminated:completion',
  });
  assert.equal(r.rule, 'content_refused');
});

test('★ readChainRefused：两个结构化判据都认得出（实测自 #210）', () => {
  assert.match(readChainRefused(wrapExt({ volcano_refused: '1', finish_reason_chat: 'safety_terminated:completion' })),
    /volcano_refused/, '上游自己标的"被模型侧拒了"最干净，应优先报它');
  assert.match(readChainRefused(wrapExt({ finish_reason_chat: 'safety_terminated:completion' })),
    /finish_reason_chat/, '同一件事的收尾原因口径，防上游不改 flag');
  // 形状健壮性：这个函数会被挂在每一轮轮询里，不能因为上游改结构就抛异常
  assert.equal(readChainRefused(null), '');
  assert.equal(readChainRefused({}), '');
  assert.equal(readChainRefused(wrapExt()), '');
  assert.equal(readChainRefused({ downlink_body: { pull_singe_chain_downlink_body: { messages: 'x' } } }), '');
});

test('★⚠️ readChainRefused 的头号负向：正常出片样本绝不能被判成拒绝（实测 #208/#205/#204）', () => {
  // 正常出片：finish_reason_chat="succeed:completion"，且**不存在** volcano_refused。
  assert.equal(readChainRefused(wrapExt({ finish_reason_chat: 'succeed:completion' })), '');
  // ⚠️⚠️ 这条最要紧：`use_content_block="1"` 在**成功样本的每条消息上也是 1**。
  //    名字像"内容拦截"，差点被当成判据 —— 真用了就会把全部正常任务判死并退款。
  assert.equal(readChainRefused(wrapExt({ use_content_block: '1', finish_reason_chat: 'succeed:completion' })), '',
    'use_content_block 不是判据！它在成功样本上同样是 1');
  // 只收**明确的拒绝前缀**，绝不用"不等于 succeed 就算拒绝"的写法
  for (const finish of ['succeed:completion', 'length:completion', 'stop', '']) {
    assert.equal(readChainRefused(wrapExt({ finish_reason_chat: finish })), '', `finish_reason_chat=${finish} 不该判拒绝`);
  }
});

// ─────────────── ①c 时长问询（duration_inquiry）───────────────
/**
 * 事故来源：生产任务 #202（会话 38417920542418193、账号 #448、30 秒、pure-http）——
 * 上游回「视频生成目前支持 4 到 15 秒…你回复 A 或 B，我就直接生成」，
 * 它在**等你回答**、永远不自己出片；而我们的轮询循环里没有"回答提问"这一步
 * ⇒ 白等 40 分钟 ⇒ uncertain（不退款 + 永久锁号）。
 *
 * 这组用例是**补的**：当时修完没带测试（`admin/test` 里一直缺这一组）。
 */
const DURATION_INQUIRY_SAMPLE = '视频生成目前支持 4 到 15 秒。我可以按最接近的支持时长生成：\n'
  + '- 方案 A：生成 15 秒版本，压缩保留核心动作与台词\n'
  + '- 方案 B：拆成两段生成：第一段 15 秒，第二段 15 秒，再由你后期拼接成 30 秒\n'
  + '你回复 A 或 B，我就直接生成。';

test('★ duration_inquiry：认得出 #202 的真实问询原话（逐字）', () => {
  const r = classifyChainText(DURATION_INQUIRY_SAMPLE, { prompt: PROMPT });
  assert.equal(r.rule, 'duration_inquiry', `实际 ${r.rule}`);
  assert.match(r.evidence, /4 到 15 秒/, 'evidence 要留下命中的原话');
  assert.equal(typeof r.upstreamError, 'string', '终态说明要显示"上游在等你选方案"');
});

test('★⚠️ duration_inquiry 的头号负向：#199 那种**陈述句**必须放行（假阳性会白退款）', () => {
  // 「**我将**按最接近的支持时长生成：15 秒」是话术，上游随后照样按 30 秒出片
  // （#199 实测成片 30.080 秒）。判据是「有没有在问你要回答」，
  // **不是**「有没有提到 4 到 15 秒」—— 这一条翻车的代价是正常任务被判死并退款。
  const statement = '视频生成目前支持 4 到 15 秒。我将按最接近的支持时长生成：15 秒。'
    + '本次使用 Dreamina Seedance 2.5 生成，将消耗 2 个视频生成额度。';
  const r = classifyChainText(statement, { prompt: PROMPT });
  assert.notEqual(r.rule, 'duration_inquiry', `陈述句不该判问询，实际 ${r.rule}`);
});

test('★ duration_inquiry 也必须**两半都命中**：只有区间、或只有提问词，都不算', () => {
  for (const text of [
    '视频生成目前支持 4 到 15 秒。',
    '本模型支持 4 到 15 秒，超出部分会被裁剪。',
    '你想生成多长？可以直接回复我。',
  ]) {
    assert.notEqual(classifyChainText(text, { prompt: PROMPT }).rule, 'duration_inquiry', `「${text}」不该判问询`);
  }
});

test('★ duration_inquiry：英文双语版本也认得出（推断口径，见 DURATION_ASK_HINT 注释）', () => {
  // 上游会**双语回答**（英文样本见 dola-generation-channel-triage 里的 #192）。
  // 中文「**我可以**…你回复 A 或 B」= 提问（实测不出片）；中文「**我将**…15 秒」= 陈述（实测出片）。
  // 按中英对照推出 `I can` 对应提问、`I will` 对应陈述 —— 所以只收 `I can`，故意不收 `I will`。
  const asking = 'Video generation currently supports durations from 4 to 15 seconds. '
    + 'I can generate it at the nearest supported duration of 15 seconds. Reply A or B and I will start.';
  assert.equal(classifyChainText(asking, { prompt: PROMPT }).rule, 'duration_inquiry');

  const telling = 'Video generation currently supports durations from 4 to 15 seconds. '
    + 'I will generate it at the nearest supported duration of 15 seconds.';
  assert.notEqual(classifyChainText(telling, { prompt: PROMPT }).rule, 'duration_inquiry',
    '`I will` 是陈述，必须放行；只收 `I can`');
});

test('★ duration_inquiry：结构化确证优先（is_creation_clarifying / 回执码 710082041）', () => {
  const r = classifyChainText('随便一句完全没有问询含义的话', {
    prompt: PROMPT, clarifying: '上游消息标记 is_creation_clarifying="1"',
  });
  assert.equal(r.rule, 'duration_inquiry');
  assert.equal(r.classifiable, true);
});

test('★ readChainClarifying：两个判据都认得出，且不误伤出片样本', () => {
  assert.match(readChainClarifying(wrapExt({ is_creation_clarifying: '1' })), /is_creation_clarifying/);
  assert.match(readChainClarifying(wrapExt({ ai_creation_res_code: DURATION_INQUIRY_RES_CODE })), /710082041/);
  // 出片样本：ai_creation_res_code="0" + fc 步骤有耗时（#199 实测 1007ms）
  assert.equal(readChainClarifying(wrapExt({ ai_creation_res_code: '0' })), '');
  assert.equal(readChainClarifying(null), '');
  assert.equal(readChainClarifying(wrapExt()), '');
});

test('quota：认得出额度回执（复用项目既有的口径）', () => {
  const a = classifyChainText('今日剩余 3 个视频生成额度', { prompt: PROMPT });
  assert.equal(a.rule, 'quota');
  assert.match(a.evidence, /今日剩余 3/);

  const b = classifyChainText('本条消耗 2 个视频生成额度', { prompt: PROMPT });
  assert.equal(b.rule, 'quota');
  assert.match(b.evidence, /消耗 2/);
});

test('accepted：原文里已出现成片直链（由调用方算好 hasVideo 传进来）', () => {
  const r = classifyChainText(JSON.stringify({ url: 'https://x/video/tos/abc.mp4' }), { prompt: PROMPT, hasVideo: true });
  assert.equal(r.rule, 'accepted');
  // 没传 hasVideo 时不能自己瞎认
  assert.notEqual(classifyChainText('随便一段没有信号的话', { prompt: PROMPT }).rule, 'accepted');
});

test('prompt_echo：链里只有我们提交的提示词，没有任何生产信号', () => {
  const chain = JSON.stringify({ message_list: [{ content: JSON.stringify({ text: PROMPT }) }] });
  const r = classifyChainText(chain, { prompt: PROMPT });
  assert.equal(r.rule, 'prompt_echo');
  assert.equal(r.classifiable, true);
});

test('★ upstream_error：认得出上游的通用错误回执，且必须带出原话', () => {
  // 真实样本，逐字取自生产任务 #144（会话 38417845063359249）的消息链：
  //   {"text_block":{"text":"出了点问题，请稍后重试。"}}
  // 修复前它被判成 prompt_echo —— 于是轮询一路空转到 20 分钟时限，
  // 终态只说「到达时限」，上游的原话被丢掉。
  for (const text of ['出了点问题，请稍后重试。', '出了点问题', '服务器繁忙，请稍后重试', '系统繁忙']) {
    const r = classifyChainText(text, { prompt: PROMPT });
    assert.equal(r.rule, 'upstream_error', `「${text}」应判 upstream_error，实际 ${r.rule}`);
    assert.equal(typeof r.upstreamError, 'string', '必须带出命中的原话，调用方要写进 stage/终态说明');
    assert.ok(text.includes(r.upstreamError));
  }
});

test('★ upstream_error 与 voided 语义不同：前者是抖动、后者是确定性拒绝', () => {
  // 判据是「措辞里带不带"稍后重试"这类可重试含义」。
  // 调用方据此决定要不要判终态 —— 混在一起会把偶发抖动变成任务失败，而积分已经扣了。
  assert.equal(classifyChainText('出了点问题，请稍后重试。', { prompt: PROMPT }).rule, 'upstream_error');
  assert.equal(classifyChainText('视频生成失败', { prompt: PROMPT }).rule, 'voided');
  // 两者同时出现时 voided 优先（更具体、更该判死）
  assert.equal(classifyChainText('视频生成失败。出了点问题，请稍后重试。', { prompt: PROMPT }).rule, 'voided');
});

test('none：什么都没有 → 认不出来（这才是真的漂移信号）', () => {
  const r = classifyChainText('{"data":{"message_list":[]}}', { prompt: PROMPT });
  assert.equal(r.rule, 'none');
  assert.equal(r.classifiable, true);
});

// ─────────────────────── ② 规则顺序（最易写错处） ───────────────────────
test('★ 顺序：提示词 + 失败信号同时出现 → 判 voided，不能被 prompt_echo 吃掉', () => {
  const chain = `${PROMPT} … 视频生成失败`;
  assert.equal(classifyChainText(chain, { prompt: PROMPT }).rule, 'voided');
});

test('★ 顺序：上游错误回执 + 我们自己的提示词同时出现 → 判 upstream_error，不能被 prompt_echo 吃掉', () => {
  // 这是生产上的真实形态：消息链里**必然**有我们提交的那条用户消息，
  // 所以任何排在 prompt_echo 之后的规则都永远轮不到。upstream_error 必须排在它前面。
  const chain = JSON.stringify({
    message_list: [
      { content: JSON.stringify({ text: '出了点问题，请稍后重试。' }) },
      { content: JSON.stringify({ text: PROMPT }) },
    ],
  });
  const r = classifyChainText(chain, { prompt: PROMPT });
  assert.equal(r.rule, 'upstream_error', 'prompt_echo 是兜底，必须垫底');
  assert.equal(r.upstreamError, '出了点问题');
});

test('★ 顺序：额度用尽 + 我们自己的提示词同时出现 → 判 quota_exhausted，不能被 prompt_echo 吃掉', () => {
  // 生产 #145 的真实形态：拒绝文案与我们的提示词在同一条链里。
  const chain = JSON.stringify({
    message_list: [
      { content: JSON.stringify({ text: '今天的生成次数已经达到上限，明天再来免费生成吧' }) },
      { content: JSON.stringify({ text: PROMPT }) },
    ],
  });
  assert.equal(classifyChainText(chain, { prompt: PROMPT }).rule, 'quota_exhausted');
});

test('★ 顺序：提示词 + 成片直链同时出现 → 判 accepted，不能被 prompt_echo 吃掉', () => {
  const chain = `${PROMPT} … https://x/video/tos/abc.mp4`;
  assert.equal(classifyChainText(chain, { prompt: PROMPT, hasVideo: true }).rule, 'accepted');
});

test('★ 顺序：提示词 + 额度回执同时出现 → 判 quota', () => {
  const chain = `${PROMPT} … 今日剩余 4 个视频生成额度`;
  assert.equal(classifyChainText(chain, { prompt: PROMPT }).rule, 'quota');
});

test('★ 顺序：voided 与 quota 同时出现 → voided 优先（失败比额度重要）', () => {
  const chain = '视频生成失败（今日剩余 4 个视频生成额度）';
  assert.equal(classifyChainText(chain, { prompt: PROMPT }).rule, 'voided');
});

test('★ 顺序：内容拒绝 + 我们自己的提示词同时出现 → 判 content_refused，不能被 prompt_echo 吃掉', () => {
  // 这是**生产上的真实形态**：链里必然有我们刚提交的那条用户消息，
  // 所以任何排在 prompt_echo 之后的规则都永远轮不到（#210 的拒绝文案就是这样被吃掉的）。
  const chain = `${CONTENT_REFUSED_SAMPLE}\n生成视频：${PROMPT}`;
  assert.equal(classifyChainText(chain, { prompt: PROMPT }).rule, 'content_refused');
});

test('★ 顺序：时长问询 + 额度回执同时出现 → 判 duration_inquiry，不能被 quota 吃掉', () => {
  // 上游哪天把额度句一并带上（"本次将消耗 2 个…额度"），若 quota 排在前面，
  // 就会把"在等你回答"误当成"已经在生成了"，于是又白等满时限。
  const chain = `${DURATION_INQUIRY_SAMPLE}\n今日剩余 4 个视频生成额度`;
  assert.equal(classifyChainText(chain, { prompt: PROMPT }).rule, 'duration_inquiry');
});

test('★ 顺序：结构化确证（clarifying / refused）压过所有文案正则', () => {
  // 文案可能同时命中多条（甚至命中 quota 这种"非终态"规则），
  // 结构化字段才是唯一truth —— 它不受上游换措辞影响。
  const quotaish = '今日剩余 4 个视频生成额度';
  assert.equal(classifyChainText(quotaish, { prompt: PROMPT, clarifying: 'ai_creation_res_code=710082041' }).rule,
    'duration_inquiry');
  assert.equal(classifyChainText(quotaish, { prompt: PROMPT, refused: 'volcano_refused="1"' }).rule,
    'content_refused');
});

// ─────────────────────── ③ 回显判定的健壮性 ───────────────────────
test('提示词里带引号 → 单层转义认得出（链本体就是一层 JSON）', () => {
  const p = '一个写着"Hello World"的霓虹灯招牌';
  const chain = JSON.stringify({ text: p });
  assert.ok(chain.includes('\\"Hello World\\"'), '前提：链里确实是转义形态');
  assert.equal(classifyChainText(chain, { prompt: p }).rule, 'prompt_echo');
});

test('★ 双重转义（嵌套 JSON，本项目真实抓包里就是这个形状）也要认得出', () => {
  const p = '一只写着"你好"的霓虹灯招牌';
  // 模拟：content 本身是一段 JSON 字符串，外面又被 JSON.stringify 了一层
  const chain = JSON.stringify({ message_list: [{ content: JSON.stringify({ text: p }) }] });
  // 前提：链里既没有原样形态，也没有单层转义形态 —— 必须是两层
  const oneLevel = JSON.stringify(p).slice(1, -1);
  assert.ok(!chain.includes(p), '前提：链里没有未转义形态');
  assert.ok(!chain.includes(oneLevel), '前提：链里也没有单层转义形态');
  assert.ok((chain.match(/\\/g) || []).length >= 4, '前提：链里确实有双重转义的反斜杠');
  assert.equal(classifyChainText(chain, { prompt: p }).rule, 'prompt_echo',
    '只试一层转义的话这里会漏判成 none → 变成假漂移告警');
});

test('提示词两边有空白 → 去掉空白后仍能认出来', () => {
  const chain = JSON.stringify({ text: PROMPT });
  assert.equal(classifyChainText(chain, { prompt: `  ${PROMPT}\n` }).rule, 'prompt_echo');
});

test('★ 假告警防护：没给提示词 → none 但 classifiable=false', () => {
  const r = classifyChainText('{"data":{}}', {});
  assert.equal(r.rule, 'none');
  assert.equal(r.classifiable, false);
  assert.match(r.evidence, /没有提示词/);
});

test('★ 假告警防护：提示词太短（1 个字）→ 不做回显判定，classifiable=false', () => {
  const r = classifyChainText('{"data":{"anything":"猫"}}', { prompt: '猫' });
  assert.equal(r.rule, 'none');
  assert.equal(r.classifiable, false);
  assert.match(r.evidence, /过短/);
});

test('空原文 → none 且 classifiable=true（上游真的回空了，这算漂移）', () => {
  for (const raw of ['', '   ', null, undefined]) {
    const r = classifyChainText(raw, { prompt: PROMPT });
    assert.equal(r.rule, 'none');
    assert.equal(r.classifiable, true, `raw=${JSON.stringify(raw)} 应可判定`);
  }
});

test('非字符串输入不抛异常', () => {
  for (const raw of [123, {}, [], true]) {
    assert.doesNotThrow(() => classifyChainText(raw, { prompt: PROMPT }));
  }
});

// ─────────────────────── ④ 观察者：计数与漂移告警 ───────────────────────
const mk = (opts = {}) => {
  const warning = [];
  const obs = createChainTextObserver({ warn: (m) => warning.push(m), ...opts });
  return { obs, warning };
};

test('计数：每个规则各记各的', () => {
  const { obs } = mk();
  obs.record({ rule: 'quota' });
  obs.record({ rule: 'quota' });
  obs.record({ rule: 'voided' });
  obs.record({ rule: 'accepted' });
  const s = obs.snapshot();
  assert.equal(s.rules.quota, 2);
  assert.equal(s.rules.voided, 1);
  assert.equal(s.rules.accepted, 1);
  assert.equal(s.rules.none, 0);
  assert.equal(s.rules.prompt_echo, 0);
});

test('★ 连续 3 轮认不出来 → protocolDrift=true 并告警一次', () => {
  const { obs, warning } = mk();
  assert.equal(obs.snapshot().protocolDrift, false);
  obs.record({ rule: 'none', evidence: 'x' });
  obs.record({ rule: 'none', evidence: 'x' });
  assert.equal(obs.snapshot().protocolDrift, false, '2 次还不该报');
  obs.record({ rule: 'none', evidence: 'x' });
  const s = obs.snapshot();
  assert.equal(s.protocolDrift, true);
  assert.equal(s.consecutiveProtocolFailures, 3);
  assert.equal(s.threshold, DEFAULT_DRIFT_THRESHOLD);
  assert.equal(warning.length, 1);
  assert.match(warning[0], /协议漂移/);
});

test('★ 告警只响一次，不是每轮都吵', () => {
  const { obs, warning } = mk();
  for (let i = 0; i < 10; i++) obs.record({ rule: 'none' });
  assert.equal(warning.length, 1, `实际响了 ${warning.length} 次`);
  assert.equal(obs.snapshot().consecutiveProtocolFailures, 10);
});

test('中间来了一个认得出来的规则 → 连续计数清零，漂移解除', () => {
  const { obs } = mk();
  obs.record({ rule: 'none' });
  obs.record({ rule: 'none' });
  obs.record({ rule: 'quota' });
  const s = obs.snapshot();
  assert.equal(s.consecutiveProtocolFailures, 0);
  assert.equal(s.protocolDrift, false);
});

test('★ 恢复后再坏 → 要能重新提醒（driftNotified 要复位）', () => {
  const { obs, warning } = mk();
  obs.record({ rule: 'none' }); obs.record({ rule: 'none' }); obs.record({ rule: 'none' });
  assert.equal(warning.length, 1);
  obs.record({ rule: 'quota' });                       // 恢复
  assert.equal(obs.snapshot().protocolDrift, false);
  obs.record({ rule: 'none' }); obs.record({ rule: 'none' }); obs.record({ rule: 'none' });
  assert.equal(warning.length, 2, '第二次漂移必须再响一次');
});

test('★ 假告警防护：classifiable=false 的 none 既不计数也不清零', () => {
  const { obs, warning } = mk();
  obs.record({ rule: 'none', classifiable: true });
  obs.record({ rule: 'none', classifiable: true });
  obs.record({ rule: 'none', classifiable: false });   // 我们没条件判，不算上游的错
  obs.record({ rule: 'none', classifiable: false });
  obs.record({ rule: 'none', classifiable: false });
  const s = obs.snapshot();
  assert.equal(s.consecutiveProtocolFailures, 2, '不能因为不可判定就凑到阈值');
  assert.equal(s.protocolDrift, false);
  assert.equal(warning.length, 0, '不该报警');
  assert.equal(s.unclassifiable, 3);
  assert.equal(s.rules.none, 5, '但仍要如实计入总数');
  obs.record({ rule: 'none', classifiable: true });    // 第 3 个可判定的才该报
  assert.equal(obs.snapshot().protocolDrift, true);
});

test('阈值可配', () => {
  const { obs, warning } = mk({ threshold: 5 });
  for (let i = 0; i < 4; i++) obs.record({ rule: 'none' });
  assert.equal(obs.snapshot().protocolDrift, false);
  obs.record({ rule: 'none' });
  assert.equal(obs.snapshot().protocolDrift, true);
  assert.equal(warning.length, 1);
});

test('history 有界，不会无限涨', () => {
  const { obs } = mk({ historyLimit: 5 });
  for (let i = 0; i < 20; i++) obs.record({ rule: 'quota' });
  assert.equal(obs.snapshot().recent.length, 5);
  assert.equal(obs.snapshot().rules.quota, 20, '总数不受 history 上限影响');
});

test(`snapshot 的 ${CHAIN_TEXT_RULES.length} 条规则永远齐全（前端不用兼容缺字段）`, () => {
  const { obs } = mk();
  // 空观察者时 lastAt 应为 null —— 这个也要如实反映，不能假装有时间戳
  const empty = obs.snapshot();
  assert.equal(empty.lastAt, null);
  assert.equal(empty.lastRule, null);

  obs.record({ rule: 'quota', evidence: 'e' });
  const s = obs.snapshot();
  assert.deepEqual(Object.keys(s.rules).sort(), [...CHAIN_TEXT_RULES].sort());
  for (const k of CHAIN_TEXT_RULES) assert.equal(typeof s.rules[k], 'number');
  assert.equal(typeof s.lastAt, 'string', '记过之后要带时间戳，方便对着日志看');
  assert.equal(s.lastRule, 'quota');
  assert.equal(s.lastEvidence, 'e');
});

test('不认识的规则名不污染计数', () => {
  const { obs } = mk();
  obs.record({ rule: 'wat' });
  const s = obs.snapshot();
  // ⚠️ 别写死数字：它必须等于枚举长度。写死的话，往 CHAIN_TEXT_RULES 里加规则时
  //    只会在这里红一次，而**真正危险的漏加**（新规则没进枚举 → 计数被静默丢弃）
  //    反而不会被这条测试发现。用 length 至少保证两处不会各说各话。
  assert.equal(Object.keys(s.rules).length, CHAIN_TEXT_RULES.length);
  assert.equal(s.rules.wat, undefined);
});

test('★ 新规则必须进枚举，否则计数被静默丢弃（本项目真实踩过的一类坑）', () => {
  // record() 第一行是 `if (!CHAIN_TEXT_RULES.includes(rule)) return snapshot();`
  // —— 漏加枚举时：不报错、不告警，那个规则的计数永远是 0，
  //    同时因为 rule !== 'none' 又把漂移计数清零了。表现是"看着在工作，其实没有"。
  const { obs } = mk();
  const before = obs.snapshot().rules.upstream_error;
  obs.record({ rule: 'upstream_error' });
  assert.equal(obs.snapshot().rules.upstream_error, before + 1, 'upstream_error 必须在 CHAIN_TEXT_RULES 里');
});

test('★ 两个终态新规则（content_refused / duration_inquiry）也必须在枚举里', () => {
  // 这两条是后补的终态规则，#210 / #202 两次事故的直接产物。
  // 它们各自都有一个**只有这里能发现**的失效模式：不在枚举里 → 计数静默丢弃，
  // 而监控上看到的是"一切正常"，下一次事故依然要跑满 40 分钟才发现。
  const { obs } = mk();
  for (const rule of ['content_refused', 'duration_inquiry']) {
    assert.ok(CHAIN_TEXT_RULES.includes(rule), `${rule} 必须出现在 CHAIN_TEXT_RULES 里`);
    const before = obs.snapshot().rules[rule];
    obs.record({ rule });
    assert.equal(obs.snapshot().rules[rule], before + 1, `${rule} 的计数被丢弃了（八成漏加了枚举）`);
  }
});

test('reset 清干净', () => {
  const { obs } = mk();
  obs.record({ rule: 'none' }); obs.record({ rule: 'none' }); obs.record({ rule: 'none' });
  const s = obs.reset();
  assert.equal(s.protocolDrift, false);
  assert.equal(s.consecutiveProtocolFailures, 0);
  assert.equal(s.rules.none, 0);
  assert.equal(s.recent.length, 0);
  assert.equal(s.lastRule, null);
});

// ─────────────────────── ⑤ 便捷入口 ───────────────────────
test('recordChainText：传原文 → 自己分类；传已分类结果 → 不重复算', () => {
  const { obs } = mk();
  // 直接测单例之外的行为：用独立观察者会绕过便捷入口，所以这里只验"不抛 + 返回值形状"
  const a = recordChainText(`${PROMPT} 视频生成失败`);
  assert.equal(a.rule, 'voided');
  const b = recordChainText({ rule: 'accepted', evidence: '预先算好的' });
  assert.deepEqual(b, { rule: 'accepted', evidence: '预先算好的' });
  assert.ok(obs.snapshot(), '占位：确保上面没依赖外部状态');
});
