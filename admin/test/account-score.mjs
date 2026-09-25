/**
 * account-score.js 单测：失败分调度的记账、衰减、节流与排序。
 *
 * 覆盖的正是参考站 /admin-route 那套机制的语义：
 *   失败按类型加权（账号的问题重罚、链路的问题轻罚）、上限 50、随时间衰减、
 *   成功清零；选号按「失败分低 → 额度多 → 最久未用」排序；提交间隔真节流。
 *
 * 用真实 node:sqlite 内存库跑记账函数 —— 这些函数的价值就在 SQL 的窄更新上，
 * 用 stub 测等于没测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  FAILURE_WEIGHTS, FAIL_SCORE_CAP, FAIL_SCORE_DECAY_PER_HOUR,
  recordTaskFailure, recordTaskSuccess, markAccountSubmitted,
  effectiveFailScore, quotaOf, submitThrottle, rankCandidates, routeRow,
} from '../server/dola/account-score.js';
import { FAILURE_REASONS } from '../server/dola/generation-analytics.js';

const HOUR = 3600000;

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE dola_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'valid',
    quota_remaining INTEGER,
    quota_total INTEGER NOT NULL DEFAULT 4,
    last_used_at TEXT,
    fail_score INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_failure_at TEXT,
    success_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    last_submit_at TEXT,
    updated_at TEXT
  )`);
  return db;
}

function seedAccount(db, over = {}) {
  const row = {
    label: '', quota_remaining: null, quota_total: 4, last_used_at: null,
    fail_score: 0, consecutive_failures: 0, last_failure_at: null,
    success_count: 0, fail_count: 0, last_submit_at: null, ...over,
  };
  const info = db.prepare(`INSERT INTO dola_accounts
    (label, quota_remaining, quota_total, last_used_at, fail_score, consecutive_failures,
     last_failure_at, success_count, fail_count, last_submit_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.label, row.quota_remaining, row.quota_total, row.last_used_at, row.fail_score,
      row.consecutive_failures, row.last_failure_at, row.success_count, row.fail_count,
      row.last_submit_at, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

const getAcc = (db, id) => db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(id);

// ---------------------------------------------------------------- 权重表完整性

test('权重表与 classifyFailure 的 14 类一一对应（漏键会被这里拦住）', () => {
  const reasonKeys = Object.keys(FAILURE_REASONS).sort();
  const weightKeys = Object.keys(FAILURE_WEIGHTS).sort();
  assert.deepEqual(weightKeys, reasonKeys);
  // 2026-09-25：新增 login 类（登录未确认 / 创作页没出现输入框）。
  // 它此前被 session 分支的正则（含「登录」）吞掉，而 session 没有作用域 →
  // 不建任何防护 → 该号永远留在待选池里、每轮再烧最多 3 分钟。
  assert.equal(reasonKeys.length, 14);
  for (const [code, w] of Object.entries(FAILURE_WEIGHTS)) {
    assert.ok(Number.isInteger(w) && w >= 1 && w <= 10, `${code} 权重应在 1~10`);
  }
});

test('账号的问题（login/session/capability/proxy/reference）比链路的问题（rate_limit/network/interrupted）罚得重', () => {
  for (const heavy of ['login', 'session', 'capability', 'proxy', 'reference']) {
    for (const light of ['rate_limit', 'network', 'interrupted', 'billing']) {
      assert.ok(FAILURE_WEIGHTS[heavy] > FAILURE_WEIGHTS[light], `${heavy} 应比 ${light} 重`);
    }
  }
});

// ---------------------------------------------------------------- 失败记账

test('失败按类型加权累加，连续失败 +1，失败总数 +1', () => {
  const db = freshDb();
  const id = seedAccount(db);
  const r1 = recordTaskFailure(db, id, '会话失效，账号已停用');
  assert.equal(r1.code, 'session');
  assert.equal(r1.weight, FAILURE_WEIGHTS.session);
  let acc = getAcc(db, id);
  assert.equal(acc.fail_score, FAILURE_WEIGHTS.session);
  assert.equal(acc.consecutive_failures, 1);
  assert.equal(acc.fail_count, 1);

  recordTaskFailure(db, id, '网络超时 timeout');
  acc = getAcc(db, id);
  assert.equal(acc.fail_score, FAILURE_WEIGHTS.session + FAILURE_WEIGHTS.network);
  assert.equal(acc.consecutive_failures, 2);
  assert.equal(acc.fail_count, 2);
});

test('失败分封顶 FAIL_SCORE_CAP，不会无限涨', () => {
  const db = freshDb();
  const id = seedAccount(db, { fail_score: FAIL_SCORE_CAP - 2 });
  recordTaskFailure(db, id, '会话失效');
  assert.equal(getAcc(db, id).fail_score, FAIL_SCORE_CAP);
  recordTaskFailure(db, id, '会话失效');
  assert.equal(getAcc(db, id).fail_score, FAIL_SCORE_CAP);
});

test('失败记账留下 last_failure_at（衰减的起点）', () => {
  const db = freshDb();
  const id = seedAccount(db);
  const at = '2026-09-25T01:00:00.000Z';
  recordTaskFailure(db, id, '网络超时', { at });
  assert.equal(getAcc(db, id).last_failure_at, at);
});

test('recordTaskFailure 对非法 accountId 静默返回 null（不炸主流程）', () => {
  const db = freshDb();
  assert.equal(recordTaskFailure(db, null, 'x'), null);
  assert.equal(recordTaskFailure(db, 'abc', 'x'), null);
});

// ---------------------------------------------------------------- 成功记账

test('成功即清零失败分与连续失败，成功计数 +1', () => {
  const db = freshDb();
  const id = seedAccount(db, { fail_score: 30, consecutive_failures: 4, fail_count: 7 });
  recordTaskSuccess(db, id);
  const acc = getAcc(db, id);
  assert.equal(acc.fail_score, 0);
  assert.equal(acc.consecutive_failures, 0);
  assert.equal(acc.success_count, 1);
  assert.equal(acc.fail_count, 7);   // 历史失败总数不清，只有"分"清
});

// ---------------------------------------------------------------- 衰减

test('有效失败分按每小时 DECAY 衰减，下限 0', () => {
  const t0 = Date.parse('2026-09-25T00:00:00.000Z');
  const acc = { fail_score: 30, last_failure_at: '2026-09-25T00:00:00.000Z' };
  assert.equal(effectiveFailScore(acc, t0), 30);
  assert.equal(effectiveFailScore(acc, t0 + 1 * HOUR), 30 - FAIL_SCORE_DECAY_PER_HOUR);
  assert.equal(effectiveFailScore(acc, t0 + 2 * HOUR), 30 - 2 * FAIL_SCORE_DECAY_PER_HOUR);
  assert.equal(effectiveFailScore(acc, t0 + 99 * HOUR), 0);   // 衰减到 0 为止，不为负
});

test('没有 last_failure_at 时无法衰减，保守取原值', () => {
  assert.equal(effectiveFailScore({ fail_score: 20, last_failure_at: null }), 20);
  assert.equal(effectiveFailScore({ fail_score: 0 }), 0);
  assert.equal(effectiveFailScore({}), 0);
});

// ---------------------------------------------------------------- 额度口径

test('quotaOf：确认过的剩余额度优先，未知退回 quota_total，再退回 4', () => {
  assert.equal(quotaOf({ quota_remaining: 3, quota_total: 4 }), 3);
  assert.equal(quotaOf({ quota_remaining: 0, quota_total: 4 }), 0);   // 0 是有效读数，不退回
  assert.equal(quotaOf({ quota_remaining: null, quota_total: 4 }), 4);
  assert.equal(quotaOf({ quota_remaining: null, quota_total: null }), 4);
});

// ---------------------------------------------------------------- 提交间隔节流

test('间隔内节流并报剩余秒数，间隔外放行', () => {
  const t0 = Date.parse('2026-09-25T00:00:00.000Z');
  const acc = { last_submit_at: '2026-09-25T00:00:00.000Z' };
  assert.deepEqual(submitThrottle(acc, 60, t0 + 30_000), { throttled: true, waitSeconds: 30 });
  assert.deepEqual(submitThrottle(acc, 60, t0 + 60_000), { throttled: false, waitSeconds: 0 });
  assert.deepEqual(submitThrottle(acc, 60, t0 + 90_000), { throttled: false, waitSeconds: 0 });
});

test('从未提交过 / 间隔为 0 → 不节流', () => {
  assert.deepEqual(submitThrottle({ last_submit_at: null }, 60), { throttled: false, waitSeconds: 0 });
  assert.deepEqual(submitThrottle({ last_submit_at: '2026-09-25T00:00:00.000Z' }, 0), { throttled: false, waitSeconds: 0 });
});

test('markAccountSubmitted 只在派发成功时记时间', () => {
  const db = freshDb();
  const id = seedAccount(db);
  const at = '2026-09-25T02:00:00.000Z';
  markAccountSubmitted(db, id, { at });
  assert.equal(getAcc(db, id).last_submit_at, at);
});

// ---------------------------------------------------------------- 排序

test('排序：失败分低者优先，与 last_used_at 无关', () => {
  const nowMs = Date.parse('2026-09-25T06:00:00.000Z');
  const fresh = { id: 1, fail_score: 0, last_failure_at: null, quota_remaining: 4, last_used_at: '2026-09-20T00:00:00.000Z' };
  const flaky = { id: 2, fail_score: 30, last_failure_at: '2026-09-25T05:50:00.000Z', quota_remaining: 4, last_used_at: '2026-09-19T00:00:00.000Z' };
  // flaky 虽然"最久没用"（原来会排第一），但失败分高 → 必须排在 fresh 后面
  const ranked = rankCandidates([flaky, fresh], { nowMs });
  assert.deepEqual(ranked.map((a) => a.id), [1, 2]);
});

test('排序：同分比额度，额度多者优先', () => {
  const nowMs = Date.parse('2026-09-25T06:00:00.000Z');
  const rich = { id: 1, fail_score: 0, quota_remaining: 4, last_used_at: '2026-09-25T01:00:00.000Z' };
  const poor = { id: 2, fail_score: 0, quota_remaining: 1, last_used_at: '2026-09-20T00:00:00.000Z' };
  const ranked = rankCandidates([poor, rich], { nowMs });
  assert.deepEqual(ranked.map((a) => a.id), [1, 2]);
});

test('排序：同分同额度退回 last_used_at 轮转，再退回 id', () => {
  const nowMs = Date.parse('2026-09-25T06:00:00.000Z');
  const older = { id: 5, fail_score: 0, quota_remaining: 4, last_used_at: '2026-09-20T00:00:00.000Z' };
  const newer = { id: 3, fail_score: 0, quota_remaining: 4, last_used_at: '2026-09-25T01:00:00.000Z' };
  const ranked = rankCandidates([newer, older], { nowMs });
  assert.deepEqual(ranked.map((a) => a.id), [5, 3]);
  // 全相等时 id 小者优先（稳定）
  const a = { id: 9, fail_score: 0, quota_remaining: 4, last_used_at: null };
  const b = { id: 4, fail_score: 0, quota_remaining: 4, last_used_at: null };
  assert.deepEqual(rankCandidates([a, b], { nowMs }).map((x) => x.id), [4, 9]);
});

test('排序用衰减后的有效分：很久前失败的号能回到前列', () => {
  const nowMs = Date.parse('2026-09-25T06:00:00.000Z');
  const recovered = { id: 1, fail_score: 10, last_failure_at: '2026-09-24T00:00:00.000Z', quota_remaining: 4, last_used_at: null }; // 30 小时前 → 衰减完
  const freshFail = { id: 2, fail_score: 5, last_failure_at: '2026-09-25T05:30:00.000Z', quota_remaining: 4, last_used_at: null };     // 刚失败
  const ranked = rankCandidates([freshFail, recovered], { nowMs });
  assert.deepEqual(ranked.map((a) => a.id), [1, 2]);
});

test('rankCandidates 不改原数组', () => {
  const input = [{ id: 2, fail_score: 5 }, { id: 1, fail_score: 0 }];
  const snapshot = input.map((a) => a.id);
  rankCandidates(input);
  assert.deepEqual(input.map((a) => a.id), snapshot);
});

// ---------------------------------------------------------------- 路由行白名单

test('routeRow 是字段白名单：绝不带 cookie / proxy / exit_ip / cookie_hash', () => {
  const account = {
    id: 7, label: 'acc7', fail_score: 10, consecutive_failures: 2,
    last_failure_at: '2026-09-25T05:00:00.000Z', quota_remaining: 3,
    last_used_at: null, last_submit_at: null, success_count: 1, fail_count: 2,
    cookie: 'SECRET_COOKIE', proxy: 'http://user:pass@host:7778', exit_ip: '1.2.3.4', cookie_hash: 'HASH',
  };
  const row = routeRow(account, 1, { nowMs: Date.parse('2026-09-25T05:30:00.000Z'), minIntervalSec: 60 });
  assert.equal(row.id, 7);
  assert.equal(row.rank, 1);
  assert.ok(row.failScore > 0 && row.failScore < 10);   // 已衰减
  for (const forbidden of ['cookie', 'proxy', 'exit_ip', 'cookie_hash', 'cookieHash', 'exitIp']) {
    assert.ok(!(forbidden in row), `不应暴露 ${forbidden}`);
  }
  assert.ok(row.reason.includes('失败分'));
  assert.ok(row.reason.includes('剩余额度 3'));
});

test('routeRow 的 reason 如实报告节流与在飞', () => {
  const nowMs = Date.parse('2026-09-25T06:00:00.000Z');
  const account = { id: 1, fail_score: 0, quota_remaining: 4, last_submit_at: '2026-09-25T05:59:30.000Z' };
  const row = routeRow(account, 1, { nowMs, minIntervalSec: 60, inflight: true });
  assert.equal(row.throttled, true);
  assert.equal(row.waitSeconds, 30);
  assert.equal(row.inflight, true);
  assert.ok(row.reason.includes('提交间隔未到'));
  assert.ok(row.reason.includes('有任务在飞'));
});
