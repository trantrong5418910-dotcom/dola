/**
 * 按模型计费 + 每令牌每日额度（`server/dola/gateway-quota.js`）的单测。
 *
 * 这份测试盯的是**三件会静默烧钱的事**：
 *
 *  ① **价目表 JSON 坏了必须整份作废**，不能"能读几条算几条"。
 *     半份生效的价目表是最坏的：运营以为 30 秒收 3 分，实际因为一个多余逗号
 *     整份解析失败、全部回落成 1 分 —— 用户白用，且**没有任何地方报错**。
 *
 *  ② **模型推导必须与生成链路的 `normalizeVideoDuration().targetModel` 一致**。
 *     不一致的表现是"按 v2.0 收钱、实际跑 v2.5"，账永远对不上。
 *     所以下面直接拿**真函数**交叉核对 10/15/20/30 四档，而不是自己复述一遍规则。
 *
 *  ③ **日额度用净消耗（consume − refund）**。生成失败会退款，
 *     失败的任务不该占用户当天的额度；否则用户会遇到"明明失败了、额度也没了"。
 *
 * 另外钉死一个容易写错的地方：`created_at` 在生产库里有两种格式
 * （应用的 ISO 带 `T`/`Z`、夹具的 SQLite 带空格），**不能在 SQL 里比字符串**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  QUOTA_SETTING_KEYS, COST_DEFAULT_KEY,
  parseModelCosts, modelForTask, costKeyForTask, resolveTaskPoints,
  localDayKey, dailyConsumedPoints, resolveDailyLimit, quotaView, usageSnapshot,
  parseDailyPointsLimit,
} from '../server/dola/gateway-quota.js';
// ★ 交叉核对用的**真**函数：钉住"计费用的模型"与"生成真的跑哪个模型"是同一套规则。
import { normalizeVideoDuration } from '../server/dola/generation-policy.js';

const reader = (map) => (key, fallback = null) => (key in map ? map[key] : fallback);

/** 一个只有两张相关表的内存库。 */
function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, value TEXT, prefix TEXT DEFAULT 'dv_x',
      points INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
      expires_at TEXT, daily_points_limit INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE point_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, token_id INTEGER, token_prefix TEXT NOT NULL DEFAULT '',
      delta INTEGER NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
      ref TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_ptx_ref ON point_transactions(kind, ref) WHERE ref <> '';
  `);
  return db;
}

let seq = 0;
function addTx(db, tokenId, kind, delta, at) {
  seq++;
  db.prepare(`INSERT INTO point_transactions (token_id, token_prefix, delta, kind, reason, ref, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(tokenId, 'dv_x', delta, kind, 'test', `r${seq}`, at instanceof Date ? at.toISOString() : String(at));
}

const addToken = (db, points = 1000, daily = null) => {
  const info = db.prepare(`INSERT INTO tokens (name, value, prefix, points, status, daily_points_limit, created_at, updated_at)
                           VALUES ('t', 'v', 'dv_x', ?, 'active', ?, '2026-01-01', '2026-01-01')`).run(points, daily);
  return Number(info.lastInsertRowid);
};

// ─────────────────────── ① 价目表解析：坏表必须整份作废 ───────────────────────
test('parseModelCosts：空值 = 没配价目表（ok，空表），不是错误', () => {
  for (const raw of ['', '   ', null, undefined]) {
    const r = parseModelCosts(raw);
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'empty');
    assert.deepEqual(r.costs, {});
  }
});

test('★ parseModelCosts：JSON 语法坏了 → 整份作废（不许"能读几条算几条"）', () => {
  for (const raw of ['{', '{"default":1,}', "{'default':1}", 'not json at all']) {
    const r = parseModelCosts(raw);
    assert.equal(r.ok, false, `raw=${JSON.stringify(raw)} 应当判为坏表`);
    assert.equal(r.reason, 'invalid_json');
    assert.deepEqual(r.costs, {}, '坏表必须返回空表，绝不能返回解析到一半的结果');
  }
});

test('parseModelCosts：不是对象（数组/标量/null）也算坏表', () => {
  for (const raw of ['[1,2]', '3', '"default"', 'null', 'true']) {
    const r = parseModelCosts(raw);
    assert.equal(r.ok, false, `raw=${raw} 应当判为坏表`);
    assert.ok(['not_an_object', 'invalid_json'].includes(r.reason));
  }
});

test('★ parseModelCosts：某个档位是 0 / 负数 / 小数 → 整份作废', () => {
  for (const raw of ['{"seedance_v2.5":0}', '{"seedance_v2.5":-1}', '{"seedance_v2.5":1.5}',
    '{"seedance_v2.5":"abc"}', '{"seedance_v2.5":null}']) {
    const r = parseModelCosts(raw);
    assert.equal(r.ok, false, `raw=${raw} 应当整份作废：某个模型静默免费比报错危险得多`);
    assert.match(r.reason, /^bad_value:/);
    assert.deepEqual(r.costs, {});
  }
});

test('parseModelCosts：default 允许 0（免费档），其余档位不接受 0', () => {
  const ok = parseModelCosts('{"default":0,"seedance_v2.5":2}');
  assert.equal(ok.ok, true);
  assert.equal(ok.costs.default, 0);
  assert.equal(ok.costs['seedance_v2.5'], 2);
  // default=0 但其它档位都为 0 时仍然是坏表（那等于整表免费）
  assert.equal(parseModelCosts('{"seedance_v2.0":0}').ok, false);
});

test('parseModelCosts：正常表原样保留（含"模型|秒数"这种带竖线的键）', () => {
  const r = parseModelCosts('{"default":1,"seedance_v2.0":2,"seedance_v2.5":1,"seedance_v2.5|30":3}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.costs, { default: 1, 'seedance_v2.0': 2, 'seedance_v2.5': 1, 'seedance_v2.5|30': 3 });
  assert.ok(Object.hasOwn(r.costs, 'seedance_v2.5|30'));
});

// ─────────────────────── ② 模型推导：与生成链路交叉核对 ───────────────────────
test('★ modelForTask 与 normalizeVideoDuration().targetModel 对 15/30 完全一致', () => {
  for (const seconds of [15, 30]) {
    const truth = normalizeVideoDuration({ seconds }).targetModel;
    // 生成链路对 10 秒返回 null（= 沿用页面默认），而页面默认就是 v2.5。
    const expected = truth === null ? 'seedance_v2.5' : truth;
    assert.equal(modelForTask({ seconds }), expected,
      `${seconds}s：按模型计费说 ${modelForTask({ seconds })}，生成链路说 ${truth} —— 两者必须同源`);
  }
  // 15 秒是 Seedance 2.0 专家路径（唯一一个不是 v2.5 的档）
  assert.equal(modelForTask({ seconds: 15 }), 'seedance_v2.0');
});

test('costKeyForTask：形状是 `模型|秒数`，秒数非法时为空串（由调用方回落到模型档）', () => {
  assert.equal(costKeyForTask({ seconds: 30 }), 'seedance_v2.5|30');
  assert.equal(costKeyForTask({ seconds: 15 }), 'seedance_v2.0|15');
  assert.equal(costKeyForTask({ seconds: undefined }), '');
  assert.equal(costKeyForTask({ seconds: 'abc' }), '');
});

// ─────────────────────── ③ 定价优先级 ───────────────────────
test('★ resolveTaskPoints 命中顺序：模型|秒数 → 模型 → default → 设置', () => {
  const full = reader({
    [QUOTA_SETTING_KEYS.defaultPoints]: '1',
    [QUOTA_SETTING_KEYS.modelCosts]: '{"default":5,"seedance_v2.0":2,"seedance_v2.5":1,"seedance_v2.5|30":3}',
  });
  assert.deepEqual(
    { p: resolveTaskPoints({ seconds: 30, readSetting: full }).points, s: resolveTaskPoints({ seconds: 30, readSetting: full }).source },
    { p: 3, s: 'exact' });
  assert.deepEqual(
    { p: resolveTaskPoints({ seconds: 20, readSetting: full }).points, s: resolveTaskPoints({ seconds: 20, readSetting: full }).source },
    { p: 1, s: 'model' });
  assert.deepEqual(
    { p: resolveTaskPoints({ seconds: 15, readSetting: full }).points, s: resolveTaskPoints({ seconds: 15, readSetting: full }).source },
    { p: 2, s: 'model' });

  // 表里只有 default → 走 default（不是设置项）
  const onlyDefault = reader({
    [QUOTA_SETTING_KEYS.defaultPoints]: '1',
    [QUOTA_SETTING_KEYS.modelCosts]: '{"default":7}',
  });
  const r = resolveTaskPoints({ seconds: 30, readSetting: onlyDefault });
  assert.equal(r.points, 7);
  assert.equal(r.source, 'default_key');
  assert.equal(r.key, COST_DEFAULT_KEY);

  // 没配表 → 回落设置项
  const none = reader({ [QUOTA_SETTING_KEYS.defaultPoints]: '4' });
  const r2 = resolveTaskPoints({ seconds: 30, readSetting: none });
  assert.equal(r2.points, 4);
  assert.equal(r2.source, 'setting');
});

test('★ 价目表坏了 → 整份忽略并回落设置项，但必须回报 invalid_json（可排查）', () => {
  const broken = reader({
    [QUOTA_SETTING_KEYS.defaultPoints]: '2',
    [QUOTA_SETTING_KEYS.modelCosts]: '{"default":1,"seedance_v2.5":3,',
  });
  const r = resolveTaskPoints({ seconds: 30, readSetting: broken });
  assert.equal(r.points, 2, '必须回落成设置里的一口价，而不是用半份表');
  assert.equal(r.source, 'setting');
  assert.equal(r.costsReason, 'invalid_json', '坏表必须留痕，否则"为什么价格不对"无从查起');
});

test('default 档为 0 时**不生效**（0 是"整表免费"，不该被当成有效价）', () => {
  const zero = reader({
    [QUOTA_SETTING_KEYS.defaultPoints]: '3',
    [QUOTA_SETTING_KEYS.modelCosts]: '{"default":0}',
  });
  const r = resolveTaskPoints({ seconds: 20, readSetting: zero });
  assert.equal(r.points, 3, 'default=0 应当被跳过（它不是"这个模型免费"，是"表被写坏了"）');
  assert.equal(r.source, 'setting');
});

test('设置项本身脏（非数字/0/负）时兜底为 1，绝不出现 0 或 NaN 的价', () => {
  for (const raw of ['0', '-5', 'abc', '', null]) {
    const r = resolveTaskPoints({ seconds: 20, readSetting: reader({ [QUOTA_SETTING_KEYS.defaultPoints]: raw }) });
    assert.equal(r.points, 1, `defaultPoints=${JSON.stringify(raw)} 时应当兜底为 1`);
    assert.ok(Number.isInteger(r.points) && r.points > 0);
  }
});

// ─────────────────────── ④ 日界：必须是**本地**日 ───────────────────────
test('★ localDayKey 是本地日，不是 UTC 日（否则"配额莫名在早上多出来"）', () => {
  const d = new Date(2026, 0, 2, 3, 4, 5);            // 本地时间
  assert.equal(localDayKey(d), '2026-01-02');
  const p = (n) => String(n).padStart(2, '0');
  assert.equal(localDayKey(d), `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  // 本地跨年/跨月边界
  assert.equal(localDayKey(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31');
  assert.equal(localDayKey(new Date(2027, 0, 1, 0, 0, 1)), '2027-01-01');
});

// ─────────────────────── ⑤ 净消耗口径 ───────────────────────
test('★ 日用量 = consume − refund（失败退款不该占用户当天额度）', (t) => {
  const db = fixture(); t.after(() => db.close());
  const id = addToken(db);
  const at = new Date(2026, 8, 25, 12, 0, 0);
  addTx(db, id, 'consume', 5, at);
  addTx(db, id, 'consume', 7, at);
  assert.equal(dailyConsumedPoints(db, id, at), 12);
  addTx(db, id, 'refund', 7, at);                      // 其中一个任务失败了、退回来了
  assert.equal(dailyConsumedPoints(db, id, at), 5, '退款必须从当日用量里扣掉');
});

test('★ 净值为负时夹到 0（不能把额度"退成负数"白送）', (t) => {
  const db = fixture(); t.after(() => db.close());
  const id = addToken(db);
  const at = new Date(2026, 8, 25, 12, 0, 0);
  addTx(db, id, 'consume', 3, at);
  addTx(db, id, 'refund', 10, at);                     // 退了一笔昨天的（跨日退款）
  assert.equal(dailyConsumedPoints(db, id, at), 0);
});

test('★ 只算当天：昨天的消耗不计入（精确判定，不靠粗筛）', (t) => {
  const db = fixture(); t.after(() => db.close());
  const id = addToken(db);
  const today = new Date(2026, 8, 25, 12, 0, 0);
  const yesterday = new Date(2026, 8, 24, 12, 0, 0);
  addTx(db, id, 'consume', 9, yesterday);
  assert.equal(dailyConsumedPoints(db, id, today), 0, '昨天的不该算今天');
  addTx(db, id, 'consume', 2, today);
  assert.equal(dailyConsumedPoints(db, id, today), 2);
  assert.equal(dailyConsumedPoints(db, id, yesterday), 9, '反过来看昨天也只算昨天');
});

test('★ 两种 created_at 格式都能正确归类（ISO 带 T/Z 与 SQLite 带空格）', (t) => {
  const db = fixture(); t.after(() => db.close());
  const id = addToken(db);
  const at = new Date(2026, 8, 25, 12, 0, 0);
  // 格式 A：应用写的 ISO（addTx 默认）
  addTx(db, id, 'consume', 4, at);
  // 格式 B：夹具写的 SQLite 风格（本地时间、无时区标记）
  const p = (n) => String(n).padStart(2, '0');
  addTx(db, id, 'consume', 6, `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} 12:00:00`);
  assert.equal(dailyConsumedPoints(db, id, at), 10, '两种格式都必须被算进来');
});

test('created_at 无法解析时不计数（也不抛异常）', (t) => {
  const db = fixture(); t.after(() => db.close());
  const id = addToken(db);
  const at = new Date(2026, 8, 25, 12, 0, 0);
  addTx(db, id, 'consume', 5, 'not-a-date');
  addTx(db, id, 'consume', 4, '');
  assert.doesNotThrow(() => dailyConsumedPoints(db, id, at));
  assert.equal(dailyConsumedPoints(db, id, at), 0);
});

test('只统计本令牌，不吃别人的账；令牌 id 非法时安全返回 0', (t) => {
  const db = fixture(); t.after(() => db.close());
  const a = addToken(db);
  const b = addToken(db);
  const at = new Date(2026, 8, 25, 12, 0, 0);
  addTx(db, a, 'consume', 5, at);
  addTx(db, b, 'consume', 8, at);
  assert.equal(dailyConsumedPoints(db, a, at), 5);
  assert.equal(dailyConsumedPoints(db, b, at), 8);
  for (const bad of [null, undefined, 0, -1, 'abc']) {
    assert.equal(dailyConsumedPoints(db, bad, at), 0, `tokenId=${bad} 应当安全返回 0`);
  }
});

test('只统计 consume/refund，其它 kind（如充值）不算用量', (t) => {
  const db = fixture(); t.after(() => db.close());
  const id = addToken(db);
  const at = new Date(2026, 8, 25, 12, 0, 0);
  addTx(db, id, 'consume', 5, at);
  addTx(db, id, 'recharge', 100, at);
  addTx(db, id, 'grant', 100, at);
  assert.equal(dailyConsumedPoints(db, id, at), 5);
});

// ─────────────────────── ⑥ 每日上限解析 ───────────────────────
test('★ resolveDailyLimit：令牌自带覆盖全局；null=用全局；0=不限', () => {
  const global = reader({ [QUOTA_SETTING_KEYS.dailyLimit]: '50' });
  assert.deepEqual(resolveDailyLimit({ token: { daily_points_limit: 10 }, readSetting: global }),
    { limit: 10, source: 'token' });
  assert.deepEqual(resolveDailyLimit({ token: { daily_points_limit: null }, readSetting: global }),
    { limit: 50, source: 'global' });
  // 字段缺失（老库还没迁移完）也要当"用全局"
  assert.deepEqual(resolveDailyLimit({ token: {}, readSetting: global }), { limit: 50, source: 'global' });
  // ★ 令牌上显式写 0 → 该令牌不限，不被全局的 50 盖住
  assert.deepEqual(resolveDailyLimit({ token: { daily_points_limit: 0 }, readSetting: global }),
    { limit: 0, source: 'token' });
  // 全局也是 0 → 不限
  assert.deepEqual(resolveDailyLimit({ token: {}, readSetting: reader({ [QUOTA_SETTING_KEYS.dailyLimit]: '0' }) }),
    { limit: 0, source: 'global' });
  // 设置项缺失/脏 → 不限（宁可放开也不误封）
  assert.deepEqual(resolveDailyLimit({ token: {}, readSetting: reader({}) }), { limit: 0, source: 'global' });
});

// ─────────────────────── ⑦ 额度视图 ───────────────────────
test('★ quotaView：limit=0 时 remaining 报 null（"无限额"不是"剩 0"）', (t) => {
  const db = fixture(); t.after(() => db.close());
  const id = addToken(db);
  const v = quotaView({ database: db, token: { id, daily_points_limit: null }, readSetting: reader({}), points: 9999 });
  assert.equal(v.limit, 0);
  assert.equal(v.remaining, null);
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'unlimited');
});

test('★ quotaView：刚好用完仍放行，超出一分就拒（边界不许差一）', (t) => {
  const db = fixture(); t.after(() => db.close());
  const id = addToken(db);
  const at = new Date(2026, 8, 25, 12, 0, 0);
  const rs = reader({ [QUOTA_SETTING_KEYS.dailyLimit]: '10' });
  addTx(db, id, 'consume', 7, at);

  const exact = quotaView({ database: db, token: { id }, readSetting: rs, points: 3, at });
  assert.equal(exact.used, 7);
  assert.equal(exact.remaining, 3);
  assert.equal(exact.ok, true, '正好达到上限应当放行（否则"上限 10"实际只能用到 9）');

  const over = quotaView({ database: db, token: { id }, readSetting: rs, points: 4, at });
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'daily_limit_exceeded');
  assert.equal(over.remaining, 3);
});

test('★ 退款会把额度还回来（否则用户会遇到"失败了、额度也没了"）', (t) => {
  const db = fixture(); t.after(() => db.close());
  const id = addToken(db);
  const at = new Date(2026, 8, 25, 12, 0, 0);
  const rs = reader({ [QUOTA_SETTING_KEYS.dailyLimit]: '10' });
  addTx(db, id, 'consume', 10, at);
  assert.equal(quotaView({ database: db, token: { id }, readSetting: rs, points: 1, at }).ok, false);
  addTx(db, id, 'refund', 10, at);
  assert.equal(quotaView({ database: db, token: { id }, readSetting: rs, points: 1, at }).ok, true);
  assert.equal(quotaView({ database: db, token: { id }, readSetting: rs, points: 1, at }).used, 0);
});

test('quotaView 带上 day 与 limitSource，便于把"为什么被拒"讲清楚', (t) => {
  const db = fixture(); t.after(() => db.close());
  const id = addToken(db);
  const at = new Date(2026, 8, 25, 12, 0, 0);
  const v = quotaView({ database: db, token: { id, daily_points_limit: 5 }, readSetting: reader({}), points: 1, at });
  assert.equal(v.day, '2026-09-25');
  assert.equal(v.limitSource, 'token');
});

test('usageSnapshot：不需要 points 也能用（状态接口只报当前状态）', (t) => {
  const db = fixture(); t.after(() => db.close());
  const id = addToken(db);
  const at = new Date(2026, 8, 25, 12, 0, 0);
  addTx(db, id, 'consume', 3, at);
  const u = usageSnapshot({ database: db, token: { id, daily_points_limit: 8 }, readSetting: reader({}), at });
  assert.deepEqual({ limit: u.limit, used: u.used, remaining: u.remaining, ok: u.ok },
    { limit: 8, used: 3, remaining: 5, ok: true });
});

test('设置 key 常量：冻结且与 db.js 注册的字符串一致（改了这里必须同步 seed）', () => {
  assert.ok(Object.isFrozen(QUOTA_SETTING_KEYS));
  assert.equal(QUOTA_SETTING_KEYS.defaultPoints, 'gateway_points_per_task');
  assert.equal(QUOTA_SETTING_KEYS.modelCosts, 'gateway_model_costs');
  assert.equal(QUOTA_SETTING_KEYS.dailyLimit, 'gateway_daily_points_limit');
  assert.equal(COST_DEFAULT_KEY, 'default');
});

// ─────────────────────── 写库侧：入参三态 ───────────────────────
test('★ parseDailyPointsLimit 三态：留空=跟随全局，0=不限，正数=上限', () => {
  // 这三态在库里是 NULL / 0 / N，行为完全不同，绝不能互相吞掉。
  for (const blank of [null, undefined, '']) {
    const r = parseDailyPointsLimit(blank);
    assert.equal(r.ok, true, `${JSON.stringify(blank)} 应合法`);
    assert.equal(r.value, null, `${JSON.stringify(blank)} → null（跟随全局）`);
  }
  assert.equal(parseDailyPointsLimit(0).value, 0, '0 → 0（该令牌不限，覆盖全局）');
  assert.equal(parseDailyPointsLimit('0').value, 0, '字符串 "0" 同样是"不限"');
  assert.equal(parseDailyPointsLimit(30).value, 30);
  assert.equal(parseDailyPointsLimit('30').value, 30);
  assert.equal(parseDailyPointsLimit('30.7').value, 30, '小数向下取整');
});

test('★ parseDailyPointsLimit：0 绝不能被当成"没填"（否则永远开不了无限额）', () => {
  // 反面写法是 `Number(raw) || null` —— 0 是 falsy，会被吞成 null，
  // 于是"给某个令牌单独开无限额"这个需求根本无法实现。
  const zero = parseDailyPointsLimit(0);
  assert.equal(zero.ok, true);
  assert.notEqual(zero.value, null, '0 必须保留成 0，不能回落成 null');
  // 并且读的一侧要真的把它解释成"无限额"
  const db = fixture();
  try {
    const id = addToken(db);
    const view = quotaView({
      database: db, token: { id, daily_points_limit: 0 }, points: 9999,
      readSetting: reader({ gateway_daily_points_limit: '10' }),
    });
    assert.equal(view.reason, 'unlimited', '令牌上写 0 ⇒ 无限额，且要覆盖全局上限');
    assert.equal(view.limit, 0);
    assert.equal(view.remaining, null, '无限额时 remaining 报 null，而不是"剩 0"');
    assert.equal(view.ok, true, '无限额 ⇒ 永远放行，哪怕本次要 9999 分');
  } finally {
    db.close();
  }
});

test('parseDailyPointsLimit：非法输入要报错而不是静默回落', () => {
  // 「我输错了」和「我要跟随全局」是两件事。静默回落成 null 的表现是
  // 运维改了半天不生效还查不出原因。
  for (const bad of ['abc', 'NaN', {}, []]) {
    const r = parseDailyPointsLimit(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应被拒绝`);
    assert.ok(r.message.length > 0, '要给得出人话理由');
  }
  const neg = parseDailyPointsLimit(-5);
  assert.equal(neg.ok, false, '负数应被拒绝');
  assert.match(neg.message, /不能为负/);
});

test('★ 写入的三态能被读的一侧正确解释（写读闭环）', () => {
  const db = fixture();
  try {
    const id = addToken(db);
    const cases = [
      [null, '跟随全局：读到全局上限'],
      [0, '令牌写 0：无限额'],
      [50, '令牌写 50：上限 50'],
    ];
    for (const [input] of cases) {
      db.prepare('UPDATE tokens SET daily_points_limit=? WHERE id=?').run(
        parseDailyPointsLimit(input).value, id);
      const row = db.prepare('SELECT daily_points_limit FROM tokens WHERE id=?').get(id);
      const { limit, source } = resolveDailyLimit({ token: row, readSetting: reader({ gateway_daily_points_limit: '10' }) });
      if (input === null) {
        assert.equal(limit, 10, '留空 ⇒ 用全局的 10');
        assert.equal(source, 'global');
      } else if (input === 0) {
        assert.equal(limit, 0, '写 0 ⇒ 不受全局限制');
        assert.equal(source, 'token');
      } else {
        assert.equal(limit, 50);
        assert.equal(source, 'token');
      }
    }
  } finally {
    db.close();
  }
});

test('★ db.js 真的注册了这三个设置（没注册的话 setSetting 是静默空操作）', async (t) => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
  for (const key of Object.values(QUOTA_SETTING_KEYS)) {
    assert.ok(src.includes(`'${key}'`),
      `db.js 的 seed 列表里没有 ${key} —— 后台改这个设置会"返回成功但值还是 null"`);
  }
  // tokens.daily_points_limit 也必须在迁移列表里，否则老库升上来没有这一列
  assert.ok(/\[\s*'tokens'\s*,\s*'daily_points_limit'/.test(src),
    'db.js 的 ALTERS 里缺 tokens.daily_points_limit');
});
