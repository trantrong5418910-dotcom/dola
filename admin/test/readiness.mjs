/**
 * 就绪度合成分级（`server/dola/readiness.js`）的单测。
 *
 * 这个模块的全部价值在于**把"能不能用"变成一个别人不用再拼一遍的结论**。
 * 所以测试盯的是三件事：
 *
 *  ① 三级之间的边界不许含糊：`down` 必须是"提交也白提交"，
 *     而不是"有点小毛病"。把降级当宕机（天天误报）和把宕机当降级（真出事不告警）
 *     是同一枚硬币的两面。
 *  ② `degraded` **必须**是可达且常见的中间态。如果规则写成"全好才 ok、
 *     否则 down"，这个分级就退化成了布尔，等于白做。
 *  ③ `reasons` 必须能回答"动哪里"，而 `publicReadiness` **绝不能**带理由出去 ——
 *     那是内部资源情报，会进到无鉴权/半公开的接口里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  READINESS_GRADES, worstOf, readinessSummary, publicReadiness, isDegraded, isAlertable,
} from '../server/dola/readiness.js';
import { SUPPORTED_VIDEO_SECONDS } from '../server/dola/generation-policy.js';

/** 全好的一组输入。 */
const healthy = {
  counts: { valid: 9, cooling: 0 },
  pools: { expertSecondsReady: true, fixedSecondsReady: true, referenceImagesReady: true },
  generation: { activeTasks: 1, queueLimit: 6000, queueAvailable: 5998 },
  readSetting: (key, fallback) => fallback,
};

const grade = (overrides = {}) => readinessSummary({ ...healthy, ...overrides }).grade;

// ─────────────────────── ① 三级定义 ───────────────────────
test('★ down：一个可用账号都没有 / 全部冷却 / 网关未生效', () => {
  assert.equal(grade({ counts: { valid: 0, cooling: 0 } }), 'down');
  assert.equal(grade({ counts: { valid: 3, cooling: 3 } }), 'down', '全部在冷却 = 派不出号');
  assert.equal(grade({ gatewayEnabled: false }), 'down');
  // 只要还剩一个可用账号就不是 down
  assert.notEqual(grade({ counts: { valid: 3, cooling: 2 } }), 'down');
});

test('★ down 的理由必须说清是"没有号"还是"全在冷却"（两种处理方式完全不同）', () => {
  const empty = readinessSummary({ ...healthy, counts: { valid: 0, cooling: 0 } });
  assert.match(empty.reasons.join('；'), /没有有效账号/);
  const allCooling = readinessSummary({ ...healthy, counts: { valid: 4, cooling: 4 } });
  assert.match(allCooling.reasons.join('；'), /4 个有效账号全部在冷却/);
});

test('★ ok：没有已知缺口，且可用账号不低于补号阈值', () => {
  assert.equal(grade(), 'ok');
  assert.equal(readinessSummary({ ...healthy, reasons: undefined }).reasons.length, 0, 'ok 时不该有理由');
});

test('★ degraded 是可达的中间态（不是"全好才 ok、否则 down"的布尔退化）', () => {
  const cases = [
    ['原生 30 秒不可用', { pools: { expertSecondsReady: true, fixedSecondsReady: false } }],
    ['原生 15 秒不可用', { pools: { expertSecondsReady: false, fixedSecondsReady: true } }],
    ['有账号在冷却', { counts: { valid: 9, cooling: 1 } }],
    ['号池低于补号阈值', { counts: { valid: 2, cooling: 0 }, readSetting: (k, d) => (k === 'dola_replenish_min_accounts' ? '5' : d) }],
    ['队列已满', { generation: { activeTasks: 6000, queueLimit: 6000, queueAvailable: 0 } }],
  ];
  for (const [why, over] of cases) {
    assert.equal(grade(over), 'degraded', `${why} 应当判 degraded（能用但有缺口），实际=${grade(over)}`);
  }
});

test('★ 队列"满"的判据是 queueAvailable<=0；limit=0（未配置）时不当成满', () => {
  assert.equal(grade({ generation: { queueLimit: 0, queueAvailable: 0 } }), 'ok',
    'queueLimit=0 表示"没配/不限制"，不能判成队列满');
  assert.equal(grade({ generation: { queueLimit: 10, queueAvailable: 0 } }), 'degraded');
  assert.equal(grade({ generation: { queueLimit: 10, queueAvailable: 1 } }), 'ok');
});

test('★ 补号阈值可关掉（replenish_min_accounts=0 → 不再因为号少而降级）', () => {
  const rs = (k, d) => (k === 'dola_replenish_min_accounts' ? '0' : d);
  assert.equal(grade({ counts: { valid: 1, cooling: 0 }, readSetting: rs }), 'ok',
    '阈值设 0 = 关闭这个判据，不该仍然降级');
  assert.equal(grade({ counts: { valid: 1, cooling: 0 } }), 'degraded', '默认阈值 5 → 1 个号要降级');
});

// ─────────────────────── ② seconds：哪些档位真的能选 ───────────────────────
test('★ seconds.ready：10/20 只需有可用账号，15/30 还需要原生能力已确认', () => {
  const both = readinessSummary(healthy).seconds;
  assert.deepEqual([...both.supported], [...SUPPORTED_VIDEO_SECONDS]);
  assert.deepEqual(both.ready, [10, 15, 20, 30]);

  const onlyPage = readinessSummary({ ...healthy, pools: {} }).seconds;
  assert.deepEqual(onlyPage.ready, [10, 20], '没有原生能力确认时只剩页面默认档位');
  assert.deepEqual([...onlyPage.supported], [...SUPPORTED_VIDEO_SECONDS], 'supported 是能力清单，不随就绪变化');
});

test('★ 一个可用账号都没有时，**任何**档位都不可选（ready 为空）', () => {
  const v = readinessSummary({ ...healthy, counts: { valid: 0, cooling: 0 } });
  assert.deepEqual(v.seconds.ready, [], '没号却报"10 秒可用"就是骗调用方');
  assert.equal(v.grade, 'down');
});

test('★ 冷却中的账号不算可用（否则"有号"是假象）', () => {
  const v = readinessSummary({ ...healthy, counts: { valid: 3, cooling: 3 } });
  assert.equal(v.accounts.available, 0);
  assert.deepEqual(v.seconds.ready, []);
});

test('原生能力字段的别名兼容（expertSecondsReady / native15Ready 都能认）', () => {
  assert.equal(readinessSummary({ ...healthy, pools: { native15Ready: true, native30Ready: true } }).grade, 'ok');
  assert.equal(readinessSummary({ ...healthy, pools: { native15Ready: true } }).grade, 'degraded');
});

// ─────────────────────── ③ 对外投影 ───────────────────────
test('★ publicReadiness 只回分级：内部资源情报一个字都不能带出去', () => {
  const full = readinessSummary({ ...healthy, counts: { valid: 0, cooling: 0 } });
  assert.ok(full.reasons.length > 0, '内部视图应当有理由');
  const pub = publicReadiness(full);
  assert.deepEqual(Object.keys(pub), ['grade'], '对外投影只能有 grade 一个键');
  assert.equal(pub.grade, 'down');
  const text = JSON.stringify(pub);
  for (const leak of ['号池', '账号', '冷却', '原生', 'reason', '秒']) {
    assert.ok(!text.includes(leak), `对外投影里泄露了「${leak}」：${text}`);
  }
});

test('publicReadiness 对空/异常输入安全回落成 down（不抛异常）', () => {
  for (const bad of [null, undefined, {}, { grade: '' }]) {
    const p = publicReadiness(bad);
    assert.equal(p.grade, 'down', `输入 ${JSON.stringify(bad)} 应当回落成 down`);
    assert.deepEqual(Object.keys(p), ['grade']);
  }
});

test('isDegraded：只有 ok 算"好"（缺数据也算坏）', () => {
  assert.equal(isDegraded({ grade: 'ok' }), false);
  assert.equal(isDegraded({ grade: 'degraded' }), true);
  assert.equal(isDegraded({ grade: 'down' }), true);
  assert.equal(isDegraded(null), true, '没有结论时按"坏"处理，不能按"好"');
});

// ─────────────────── ⑥ ★ acute：常态缺口 vs 异常缺口 ───────────────────
// 这一节是本次修复的核心：`grade` 与"该不该告警"必须解耦。
test('★ reasons 是全部缺口（诚实），acute 只装异常缺口（可处理）', () => {
  const chronicOnly = readinessSummary({ ...healthy, pools: {} });
  assert.equal(chronicOnly.grade, 'degraded');
  assert.equal(chronicOnly.reasons.length, 2, '常态缺口也必须出现在 reasons 里，不能对仪表盘撒谎');
  assert.match(chronicOnly.reasons.join('；'), /原生 15 秒/);
  assert.match(chronicOnly.reasons.join('；'), /原生 30 秒/);
  assert.deepEqual(chronicOnly.acute, [], '原生能力未确认是能力基线，不是异常 → acute 必须为空');

  const withCooling = readinessSummary({ ...healthy, counts: { valid: 9, cooling: 2 } });
  assert.ok(withCooling.reasons.some((r) => /2 个账号在限流冷却中/.test(r)));
  assert.deepEqual(withCooling.acute, ['2 个账号在限流冷却中'], '冷却才是异常缺口');

  // 两种都要能同时出现，且 acute 是 reasons 的子集
  const both = readinessSummary({ ...healthy, pools: {}, counts: { valid: 9, cooling: 1 } });
  assert.equal(both.reasons.length, 3);
  assert.deepEqual(both.acute, ['1 个账号在限流冷却中']);
  for (const a of both.acute) assert.ok(both.reasons.includes(a), 'acute 必须是 reasons 的子集');
});

test('★ 分类只认"常态性"：补号阈值 / 队列满 / down 的三条都算异常', () => {
  const cases = [
    ['低于补号阈值', { counts: { valid: 2, cooling: 0 }, readSetting: (k, d) => (k === 'dola_replenish_min_accounts' ? '5' : d) }, /低于补号阈值/],
    ['队列已满', { generation: { activeTasks: 6000, queueLimit: 6000, queueAvailable: 0 } }, /生成队列已满/],
    ['号池空', { counts: { valid: 0, cooling: 0 } }, /没有有效账号/],
    ['全在冷却', { counts: { valid: 3, cooling: 3 } }, /全部在冷却/],
    ['网关未生效', { gatewayEnabled: false }, /网关当前未实际生效/],
  ];
  for (const [why, over, re] of cases) {
    const v = readinessSummary({ ...healthy, ...over });
    assert.ok(v.reasons.some((r) => re.test(r)), `${why}：reasons 里应含 ${re}`);
    assert.ok(v.acute.length > 0, `${why}：应当是可告警的异常缺口，实际 acute=${JSON.stringify(v.acute)}`);
  }
});

test('★ isAlertable：常态 degraded **不告警**（生产实测场景的回归钉）', () => {
  // 复刻生产实测：7 个有效账号、0 冷却、原生 15/30 全是 unknown、补号阈值 5。
  // 修复前 `grade !== 'ok'` ⇒ 永久告警；修复后必须安静。
  const prod = readinessSummary({
    counts: { valid: 7, cooling: 0 },
    pools: { expertSecondsReady: false, fixedSecondsReady: false },
    generation: { activeTasks: 0, queueLimit: 6000, queueAvailable: 6000 },
    readSetting: (k, d) => (k === 'dola_replenish_min_accounts' ? '5' : d),
  });
  assert.equal(prod.grade, 'degraded', 'grade 仍要诚实地说"有缺口"');
  assert.equal(prod.acute.length, 0);
  assert.equal(isAlertable(prod), false, '★ 只有常态缺口的 degraded 绝不能刷告警（这就是告警疲劳）');
  assert.equal(isDegraded(prod), true, 'isDegraded 是"有没有缺口"——这里仍然是 true（两个判断本就不同）');
});

test('★ isAlertable：down 一定告警，ok 不告警，degraded+acute 要告警', () => {
  assert.equal(isAlertable(readinessSummary(healthy)), false, 'ok → 不告警');
  assert.equal(isAlertable(readinessSummary({ ...healthy, counts: { valid: 0, cooling: 0 } })), true,
    'down → 一定告警（提交也白提交是真事故）');
  assert.equal(isAlertable(readinessSummary({ ...healthy, counts: { valid: 9, cooling: 1 } })), true,
    'degraded 且有异常缺口 → 告警');
});

test('★ isAlertable 对未知形状保守：宁可误报，不许把"不知道"静默当健康', () => {
  assert.equal(isAlertable(null), true);
  assert.equal(isAlertable(undefined), true);
  assert.equal(isAlertable({}), true, '没有 grade ⇒ 按 down');
  assert.equal(isAlertable({ grade: 'degraded' }), true, '缺 acute 字段 ⇒ 保守告警');
  assert.equal(isAlertable({ grade: 'degraded', acute: ['x'] }), true);
  assert.equal(isAlertable({ grade: 'degraded', acute: [] }), false);
});

// ─────────────────────── ④ worstOf ───────────────────────
test('★ worstOf 取最差的那一级（合并多个分级的唯一正确方式）', () => {
  assert.equal(worstOf('ok', 'ok'), 'ok');
  assert.equal(worstOf('ok', 'degraded'), 'degraded');
  assert.equal(worstOf('degraded', 'ok'), 'degraded', '顺序无关');
  assert.equal(worstOf('ok', 'degraded', 'down'), 'down');
  assert.equal(worstOf('down', 'ok'), 'down');
  assert.equal(worstOf('ok'), 'ok');
});

test('worstOf 对未知取值安全回落成 down（认不出来时不能报"好"）', () => {
  assert.equal(worstOf('ok', 'something-else'), 'down');
  assert.equal(worstOf('bogus'), 'down');
  assert.equal(worstOf(), 'down');
});

// ─────────────────────── ⑤ 形状与常量 ───────────────────────
test('READINESS_GRADES 从好到坏排列且被冻结（worstOf 依赖这个顺序）', () => {
  assert.ok(Object.isFrozen(READINESS_GRADES));
  assert.deepEqual([...READINESS_GRADES], ['ok', 'degraded', 'down']);
});

test('readinessSummary 的返回形状稳定（指标与接口都依赖字段名）', () => {
  const v = readinessSummary(healthy);
  assert.deepEqual(Object.keys(v).sort(),
    ['accounts', 'acute', 'at', 'grade', 'queue', 'reasons', 'seconds'].sort());
  assert.deepEqual(Object.keys(v.accounts).sort(), ['available', 'cooling', 'valid']);
  assert.deepEqual(Object.keys(v.queue).sort(), ['activeTasks', 'queueAvailable', 'queueLimit']);
  assert.ok(Number.isFinite(Date.parse(v.at)), 'at 必须是可解析的时间戳');
  assert.ok(READINESS_GRADES.includes(v.grade));
});

test('★ 号池表不存在时按 0 处理并判 down（查询失败不能让健康检查崩）', () => {
  const broken = { prepare: () => { throw new Error('no such table: dola_accounts'); } };
  let v;
  assert.doesNotThrow(() => { v = readinessSummary({ ...healthy, counts: null, database: broken }); });
  assert.equal(v.grade, 'down');
  assert.equal(v.accounts.valid, 0);
});
