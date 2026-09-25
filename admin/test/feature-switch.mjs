/**
 * 三层开关（`server/dola/feature-switch.js`）的单测。
 *
 * 这个模块存在的唯一理由，是让「**开关开了、但实际没生效**」这种状态**可以被表达**。
 * 所以这份测试的重点是把三层真值表钉死，尤其是两条最容易写错的性质：
 *
 *  ① **`effective_enabled` 必须严格弱于前两层**。任何让 `effective_enabled=true`
 *     而 `enabled=false` 的写法，都会把"关了"报成"生效中"，比不报还危险。
 *  ② **认不出的 scope 值必须回落到 `all`**。写错一个词（比如 `v2`、`ALL ` 大小写）
 *     如果导致"哪都不生效"，现象是"开关点了没反应"；回落到 all 最多是多生效，
 *     但会在 `reasons` 里留痕 —— 后者好查得多。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SWITCH_KEYS, SWITCH_SCOPES, isOn, scopeKeyOf, switchView, switchEffective,
} from '../server/dola/feature-switch.js';

/** 假设置读取：未提到的 key 走 fallback。 */
const reader = (map) => (key, fallback = null) => (key in map ? map[key] : fallback);
const K = 'synthetic_switch';

// ─────────────────────── ① 布尔语义 ───────────────────────
test('★ isOn 严格等于 "true"（设置存的是字符串，Boolean("false") === true 是经典坑）', () => {
  for (const v of ['true', 'TRUE', 'True', ' true ', '  TRUE  ']) assert.equal(isOn(v), true, `${JSON.stringify(v)} 应为开`);
  for (const v of ['false', 'FALSE', 'false ', '0', '', 'no', 'off', null, undefined, 'yes', '1']) {
    assert.equal(isOn(v), false, `${JSON.stringify(v)} 应为关`);
  }
});

test('scopeKeyOf：范围设置的 key 是 `<开关key>_scope`', () => {
  assert.equal(scopeKeyOf('gateway_enabled'), 'gateway_enabled_scope');
  assert.equal(scopeKeyOf(K), `${K}_scope`);
});

// ─────────────────────── ② 三层真值表 ───────────────────────
test('★ 三层真值表：只有 总开关 ∧ 范围 ∧ 前提 全过才 effective', () => {
  const cases = [
    { enabled: 'false', scope: 'all', scopeCfg: 'all', prereq: [], exp: false, why: '总开关关' },
    { enabled: 'true', scope: 'all', scopeCfg: 'all', prereq: [], exp: true, why: '全过' },
    { enabled: 'true', scope: 'v1', scopeCfg: 'admin', prereq: [], exp: false, why: '范围不含当前入口' },
    { enabled: 'true', scope: 'admin', scopeCfg: 'admin', prereq: [], exp: true, why: '范围正好匹配' },
    { enabled: 'true', scope: 'v1', scopeCfg: 'all', prereq: [], exp: true, why: '范围是全量' },
    { enabled: 'false', scope: 'v1', scopeCfg: 'all', prereq: [{ ok: false, reason: 'x' }], exp: false, why: '总开关关+前提不满足' },
    // ★ 这一行是本模块存在的意义：开关开着、范围也对、但前提不满足 → 实际没生效
    { enabled: 'true', scope: 'v1', scopeCfg: 'all', prereq: [{ ok: false, reason: '号池空' }], exp: false, why: '开了但前提不满足' },
    { enabled: 'true', scope: 'v1', scopeCfg: 'all', prereq: [{ ok: true, reason: '' }], exp: true, why: '前提满足不产生噪音' },
  ];
  for (const c of cases) {
    const readSetting = reader({ [K]: c.enabled, [`${K}_scope`]: c.scopeCfg });
    const v = switchView({ key: K, scope: c.scope, prerequisites: c.prereq, readSetting });
    assert.equal(v.effective_enabled, c.exp, `${c.why}：期望 effective=${c.exp}`);
    // ① 强制性质：effective 必须弱于前两层
    if (v.effective_enabled) {
      assert.equal(v.enabled, true, `${c.why}：effective=true 时 enabled 必须为 true`);
      assert.equal(v.scope_enabled, true, `${c.why}：effective=true 时 scope_enabled 必须为 true`);
    }
  }
});

test('★ effective_enabled 永远不会"无中生有"：单个前提 ok=false 就能压掉它', () => {
  const readSetting = reader({ [K]: 'true', [`${K}_scope`]: 'all' });
  const one = switchView({ key: K, scope: 'all', prerequisites: [{ ok: false, reason: 'A' }], readSetting });
  assert.equal(one.effective_enabled, false);
  const mixed = switchView({
    key: K, scope: 'all', readSetting,
    prerequisites: [{ ok: true, reason: 'B' }, { ok: false, reason: 'A' }, { ok: true, reason: 'C' }],
  });
  assert.equal(mixed.effective_enabled, false, '只要有一个前提不满足就不算生效');
});

// ─────────────────────── ③ reasons：只收"坏消息" ───────────────────────
test('★ reasons 只收 ok=false 的前提（ok=true 的不产生噪音）', () => {
  const readSetting = reader({ [K]: 'true', [`${K}_scope`]: 'all' });
  const clean = switchView({
    key: K, scope: 'all', readSetting,
    prerequisites: [{ ok: true, reason: '前提A没问题' }, { ok: true, reason: '前提B也没问题' }],
  });
  assert.deepEqual(clean.reasons, [], '一切正常时不该有任何理由条目');

  const dirty = switchView({ key: K, scope: 'all', readSetting, prerequisites: [{ ok: false, reason: '号池没有可用账号' }] });
  assert.deepEqual(dirty.reasons, ['号池没有可用账号']);
});

test('★ 总开关关时要说"总开关未开启"，范围挡住时要说清是哪个范围', () => {
  const off = switchView({ key: K, scope: 'v1', readSetting: reader({ [K]: 'false' }) });
  assert.ok(off.reasons.some((r) => r.includes('总开关')), `实际=${off.reasons}`);

  const scoped = switchView({
    key: K, scope: 'admin',
    readSetting: reader({ [K]: 'true', [`${K}_scope`]: 'v1' }),
  });
  assert.equal(scoped.effective_enabled, false);
  assert.ok(scoped.reasons.some((r) => r.includes('v1') && r.includes('admin')),
    `理由里要同时说明限制范围与实际入口，实际=${scoped.reasons}`);
});

// ─────────────────────── ④ 范围回落 ───────────────────────
test('★ 认不出的 scope 回落到 all（不能让写错一个词把功能静默全关）', () => {
  // ⚠️ `'admin '`（带空白）**不算坏值** —— 实现先 trim+小写再判定，它规范化成合法的 admin。
  //    这里只放真正认不出来的取值。
  for (const bad of ['v2', 'ALL_x', 'both', '前端', 'all|v1']) {
    const readSetting = reader({ [K]: 'true', [`${K}_scope`]: bad });
    const v = switchView({ key: K, scope: 'admin', readSetting });
    assert.equal(v.configuredScope, 'all', `scope=${JSON.stringify(bad)} 应回落到 all`);
    assert.equal(v.effective_enabled, true, `scope=${JSON.stringify(bad)} 时应当仍然生效`);
    // reasons 里记的是**规范化后**的值（trim+小写），所以比对时不区分大小写
    assert.ok(v.reasons.some((r) => r.toLowerCase().includes(bad.toLowerCase())),
      `必须留痕说明收到过坏值，实际=${v.reasons}`);
  }
});

test('范围值大小写/空白宽容（后台手填 "V1" 不该变成"哪都不生效"）', () => {
  for (const v of ['v1', 'V1', ' v1 ', 'V1 '.trim()]) {
    const view = switchView({ key: K, scope: 'v1', readSetting: reader({ [K]: 'true', [`${K}_scope`]: v }) });
    assert.equal(view.effective_enabled, true, `scope=${JSON.stringify(v)} 应当匹配 v1`);
    assert.equal(view.configuredScope, 'v1');
  }
});

test('scope 缺省/为空 → 当 all（默认行为必须与"只有一层开关"完全一致）', () => {
  for (const cfg of [undefined, '', '   ']) {
    const readSetting = reader(cfg === undefined ? { [K]: 'true' } : { [K]: 'true', [`${K}_scope`]: cfg });
    for (const scope of ['all', 'v1', 'admin']) {
      assert.equal(switchView({ key: K, scope, readSetting }).effective_enabled, true,
        `_scope=${JSON.stringify(cfg)}、入口=${scope} 时应当生效`);
    }
  }
});

// ─────────────────────── ⑤ fallback：兼容性保险 ───────────────────────
test('★ fallback 决定"设置行丢失"时算开还是算关（迁移时不能改掉既有默认）', () => {
  const missing = reader({});
  // gateway_enabled 的既有默认是 true（缺行 = 开）。硬编 false 会把对外网关静默关掉。
  assert.equal(switchView({ key: K, fallback: 'true', readSetting: missing }).enabled, true);
  assert.equal(switchView({ key: K, readSetting: missing }).enabled, false, '默认仍是 false');
  // 但 fallback 只能影响"缺行"，不能盖过显式写入的值
  assert.equal(switchView({ key: K, fallback: 'true', readSetting: reader({ [K]: 'false' }) }).enabled, false);
  assert.equal(switchView({ key: K, fallback: 'false', readSetting: reader({ [K]: 'true' }) }).enabled, true);
});

// ─────────────────────── ⑥ 形状与常量 ───────────────────────
test('switchView 的返回形状稳定（字段名被 /v1/status 与前端依赖）', () => {
  const v = switchView({ key: K, scope: 'v1', readSetting: reader({ [K]: 'true' }) });
  assert.deepEqual(Object.keys(v).sort(),
    ['configuredScope', 'effective_enabled', 'enabled', 'key', 'reasons', 'scope', 'scope_enabled'].sort());
  assert.equal(v.key, K);
  assert.equal(v.scope, 'v1', 'scope 回报的是调用方传入的入口，不是配置值');
  assert.ok(Array.isArray(v.reasons));
});

test('switchEffective 就是 switchView().effective_enabled 的简写（不许有两套判定）', () => {
  for (const enabled of ['true', 'false']) {
    for (const scope of ['all', 'v1', 'admin']) {
      for (const cfg of ['all', 'v1', 'admin']) {
        const readSetting = reader({ [K]: enabled, [`${K}_scope`]: cfg });
        const opts = { key: K, scope, readSetting };
        assert.equal(switchEffective(opts), switchView(opts).effective_enabled);
      }
    }
  }
});

test('SWITCH_KEYS / SWITCH_SCOPES：冻结、取值与 db.js 注册的一致', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
  assert.ok(Object.isFrozen(SWITCH_KEYS));
  assert.ok(Object.isFrozen(SWITCH_SCOPES));
  assert.deepEqual([...SWITCH_SCOPES], ['all', 'v1', 'admin']);
  assert.equal(SWITCH_KEYS.gateway, 'gateway_enabled');
  assert.equal(SWITCH_KEYS.promptWrap, 'gateway_prompt_wrap_enabled');
  for (const key of Object.values(SWITCH_KEYS)) {
    assert.ok(src.includes(`'${key}'`), `db.js 的 seed 里缺 ${key}`);
    assert.ok(src.includes(`'${scopeKeyOf(key)}'`),
      `db.js 的 seed 里缺 ${scopeKeyOf(key)} —— 范围设置写不进去，三层开关等于只有两层`);
  }
});

test('deploy 兼容性：scope 设置的默认值必须是 all（升级不能改变既有行为）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
  for (const key of Object.values(SWITCH_KEYS)) {
    const re = new RegExp(`\\['${scopeKeyOf(key)}',\\s*'all'`);
    assert.ok(re.test(src), `${scopeKeyOf(key)} 的 seed 默认值必须是 'all'`);
  }
});
