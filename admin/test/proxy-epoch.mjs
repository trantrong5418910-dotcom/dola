/**
 * 代理出口轮换 epoch（`server/dola/proxy-epoch.js`）的单测。
 *
 * 这个模块最重要的性质不是"算得准"，而是**不撒谎**。我们观测不到 IPWeb 的窗口边界
 * （它锚在自己的时钟上），只能算出**上界**。所以这份测试盯三条诚实边界：
 *
 *  ① `estimate` 恒为 true。只要它变成 false，就等于宣称我们知道精确到期时间。
 *  ② `remaining <= 0` 只能说 `stale`（"该重新核验了"），
 *     **绝不能**说成"已轮换" —— 硬说就是编，而且会引发无谓的换号重试。
 *  ③ 没有锚点时 `remainingSeconds` 必须是 `null`，**不许**编一个数字出来。
 *     凭空的 remaining 会让调度做错决定。
 *
 * 另外钉住 epoch 的记账规则：**只有 IP 真的变了才 +1**，
 * 同一个 IP 反复探测不会把 epoch 刷上去（否则"这条线路不稳"的信号就废了）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  UNKNOWN_WINDOW_SECONDS, DEFAULT_ROTATION_RISK_SECONDS, EPOCH_SETTING_KEYS, ROTATION_RISKS,
  parseStickyWindow, rotationView, accountRotationView, recordObservedExit, rotationSummary,
} from '../server/dola/proxy-epoch.js';

const reader = (map) => (key, fallback = null) => (key in map ? map[key] : fallback);

/** 造一条 IPWeb 形状的代理 URL：`账号_国家_州_城市_分钟_SID`。 */
const ipweb = (minutes = 5, sid = 'Ab000001', account = 'B_36307') =>
  `http://${account}_KR__${minutes}_${sid}:secret@gate2.ipweb.cc:7778`;

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dola_proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL DEFAULT '', url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'unknown',
    exit_ip TEXT, exit_ip_at TEXT, rotation_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT, updated_at TEXT);`);
  return db;
}
const addProxy = (db, url, exitIp = null, exitIpAt = null, rotations = 0) => {
  const info = db.prepare(`INSERT INTO dola_proxies (label, url, enabled, state, exit_ip, exit_ip_at, rotation_count, created_at, updated_at)
                           VALUES ('p', ?, 1, 'alive', ?, ?, ?, '2026-01-01', '2026-01-01')`).run(url, exitIp, exitIpAt, rotations);
  return Number(info.lastInsertRowid);
};

// ─────────────────────── ① 粘性窗口解析 ───────────────────────
test('★ parseStickyWindow：从 URL 里读出分钟数（窗口时长本来就在 URL 里）', () => {
  assert.deepEqual(
    { ok: parseStickyWindow(ipweb(5)).ok, minutes: parseStickyWindow(ipweb(5)).minutes, w: parseStickyWindow(ipweb(5)).windowSeconds, sid: parseStickyWindow(ipweb(5)).sid },
    { ok: true, minutes: 5, w: 300, sid: 'Ab000001' });
  assert.equal(parseStickyWindow(ipweb(30)).windowSeconds, 1800);
  assert.equal(parseStickyWindow(ipweb(1)).windowSeconds, 60);
});

test('parseStickyWindow：密码里的特殊字符不影响解析（只看 username 的第 5 段）', () => {
  const url = `socks5://B_36307_US__5_Zz999:p%40ss%3Aword@gate2.ipweb.cc:7778`;
  const r = parseStickyWindow(url);
  assert.equal(r.ok, true);
  assert.equal(r.minutes, 5);
  assert.equal(r.sid, 'Zz999');
});

test('parseStickyWindow：非 IPWeb 形状/坏 URL/空值 → ok=false 且给出原因（不猜）', () => {
  const cases = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['not a url', 'unparseable_url'],
    ['http://user:pass@host:8080', 'not_ipweb_shape'],       // 段数不够
    [`http://a_b_c_d_5@host:8080`, 'not_ipweb_shape'],        // 只有 5 段
    [`http://a_b_c_d_0_sid@host:8080`, 'bad_minutes'],        // 分钟为 0
    [`http://a_b_c_d_abc_sid@host:8080`, 'bad_minutes'],
    [`http://a_b_c_d_-5_sid@host:8080`, 'bad_minutes'],
  ];
  for (const [url, reason] of cases) {
    const r = parseStickyWindow(url);
    assert.equal(r.ok, false, `url=${JSON.stringify(url)} 应当判为读不出窗口`);
    assert.equal(r.reason, reason, `url=${JSON.stringify(url)} 的原因应为 ${reason}`);
    assert.equal(r.windowSeconds, UNKNOWN_WINDOW_SECONDS);
  }
  assert.equal(UNKNOWN_WINDOW_SECONDS, 0, '0 = 不知道，不算');
});

// ─────────────────────── ② 轮换视图：诚实边界 ───────────────────────
test('★ estimate 恒为 true —— 我们算的永远是上界（IPWeb 窗口锚在它自己的时钟上）', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const views = [
    rotationView({ proxyUrl: ipweb(5), exitIp: '1.1.1.1', exitIpAt: '2026-09-25T11:59:00Z', now }),
    rotationView({ proxyUrl: ipweb(5), exitIp: '1.1.1.1', exitIpAt: '2026-09-25T11:00:00Z', now }),
    rotationView({ proxyUrl: ipweb(5), exitIp: '', now }),
    rotationView({ proxyUrl: 'not ipweb', now }),
    rotationView({ proxyUrl: ipweb(5), now }),
  ];
  for (const v of views) assert.equal(v.estimate, true, 'estimate 一旦为 false 就等于宣称我们精确知道到期时刻');
});

test('★ 没有锚点（从没核验过出口）时 remainingSeconds 必须是 null，不许编数字', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const v = rotationView({ proxyUrl: ipweb(5), exitIp: '', exitIpAt: null, now });
  assert.equal(v.ok, true, '窗口读出来了');
  assert.equal(v.anchorAt, null);
  assert.equal(v.expiresAt, null);
  assert.equal(v.remainingSeconds, null, '没有锚点就只能说不知道');
  assert.equal(v.risk, 'unknown');
  assert.equal(v.reason, 'no_anchor');
  assert.equal(v.stale, false, '没有锚点也不该说"过期"');
});

test('★ remaining <= 0 只说 stale，绝不说"已轮换"', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const v = rotationView({ proxyUrl: ipweb(5), exitIp: '1.1.1.1', exitIpAt: '2026-09-25T11:00:00Z', now });
  assert.ok(v.remainingSeconds <= 0);
  assert.equal(v.stale, true);
  assert.equal(v.risk, 'stale');
  assert.ok(!Object.hasOwn(v, 'rotated'), '视图里不该出现"已轮换"这种断言字段');
  assert.ok(!JSON.stringify(v).includes('已轮换'), '序列化结果里也不能出现"已轮换"');
});

test('★ risk 分档：剩余 > 阈值 = low，<= 阈值 = high，<= 0 = stale', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const at = (secondsAgo) => new Date(now - secondsAgo * 1000).toISOString();
  // 窗口 300 秒，阈值 120 秒
  assert.equal(rotationView({ proxyUrl: ipweb(5), exitIp: 'x', exitIpAt: at(60), riskSeconds: 120, now }).risk, 'low');
  assert.equal(rotationView({ proxyUrl: ipweb(5), exitIp: 'x', exitIpAt: at(200), riskSeconds: 120, now }).risk, 'high');
  assert.equal(rotationView({ proxyUrl: ipweb(5), exitIp: 'x', exitIpAt: at(300), riskSeconds: 120, now }).risk, 'stale');
  assert.equal(rotationView({ proxyUrl: ipweb(5), exitIp: 'x', exitIpAt: at(301), riskSeconds: 120, now }).risk, 'stale');
  // 阈值边界：正好等于阈值算 high
  assert.equal(rotationView({ proxyUrl: ipweb(5), exitIp: 'x', exitIpAt: at(180), riskSeconds: 120, now }).risk, 'high');
  // 阈值 0 = 不判定（永远 low，除非 stale）
  assert.equal(rotationView({ proxyUrl: ipweb(5), exitIp: 'x', exitIpAt: at(299), riskSeconds: 0, now }).risk, 'low');
});

test('剩余秒数是"距到期还有多久"，且随观测点前移而减少', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const a = rotationView({ proxyUrl: ipweb(5), exitIp: 'x', exitIpAt: new Date(now).toISOString(), now });
  assert.equal(a.remainingSeconds, 300, '刚观测到一个出口 → 还剩整个窗口（上界）');
  const b = rotationView({ proxyUrl: ipweb(5), exitIp: 'x', exitIpAt: new Date(now).toISOString(), now: now + 60_000 });
  assert.equal(b.remainingSeconds, 240);
  // expiresAt = anchor + window，且 anchor 一定早于（或等于）真实窗口起点
  assert.equal(Date.parse(a.expiresAt) - Date.parse(a.anchorAt), 300_000);
});

test('读不出窗口时整块信息都是"不知道"（不半猜）', () => {
  const v = rotationView({ proxyUrl: '', exitIp: '1.1.1.1', exitIpAt: '2026-09-25T11:00:00Z' });
  assert.equal(v.ok, false);
  assert.equal(v.windowSeconds, UNKNOWN_WINDOW_SECONDS);
  assert.equal(v.windowSource, 'unknown');
  assert.equal(v.remainingSeconds, null);
  assert.equal(v.risk, 'unknown');
  assert.equal(v.reason, 'empty');
  assert.equal(v.stale, false);
});

test('assumedMinutes：URL 读不出窗口时的兜底，来源要标成 assumed（不许冒充 url）', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const v = rotationView({
    proxyUrl: 'socks5://user:pass@self-hosted.example:1080',
    exitIp: '1.1.1.1', exitIpAt: new Date(now).toISOString(), assumedMinutes: 10, now,
  });
  assert.equal(v.ok, true);
  assert.equal(v.windowSeconds, 600);
  assert.equal(v.windowSource, 'assumed', '兜底窗口必须标明是猜的，不能冒充 URL 里读出来的');
  assert.equal(v.remainingSeconds, 600);
  // assumedMinutes = 0 → 不算，回落成 unknown
  const zero = rotationView({
    proxyUrl: 'socks5://user:pass@self-hosted.example:1080',
    exitIp: '1.1.1.1', exitIpAt: new Date(now).toISOString(), assumedMinutes: 0, now,
  });
  assert.equal(zero.ok, false);
  assert.equal(zero.remainingSeconds, null);
});

// ─────────────────────── ③ epoch 语义 ───────────────────────
test('★ epoch = rotation_count + 1，且至少为 1（第几代出口）', () => {
  for (const [rotations, epoch] of [[0, 1], [1, 2], [7, 8], [null, 1], [undefined, 1], [-3, 1]]) {
    const v = rotationView({ proxyUrl: ipweb(5), exitIp: 'x', exitIpAt: '2026-09-25T11:59:00Z', rotations });
    assert.equal(v.epoch, epoch, `rotation_count=${rotations} 时 epoch 应为 ${epoch}`);
  }
});

// ─────────────────────── ④ 记账：只有 IP 变了才 +1 ───────────────────────
test('★ recordObservedExit：同一个 IP 反复探测不会把 epoch 刷上去', (t) => {
  const db = fixture(); t.after(() => db.close());
  addProxy(db, ipweb(5));
  const first = recordObservedExit(db, { url: ipweb(5), exitIp: '1.1.1.1', at: '2026-09-25T12:00:00Z' });
  assert.equal(first.changed, false, '首次观测没有"旧值"，不算换了');
  assert.equal(first.epoch, 1);
  for (let i = 0; i < 5; i++) {
    const again = recordObservedExit(db, { url: ipweb(5), exitIp: '1.1.1.1', at: `2026-09-25T12:0${i}:30Z` });
    assert.equal(again.changed, false, '同一个 IP 不该被算成轮换');
  }
  const row = db.prepare('SELECT rotation_count, exit_ip, exit_ip_at FROM dola_proxies').get();
  assert.equal(row.rotation_count, 0, 'IP 没变 → rotation_count 必须是 0');
  assert.equal(row.exit_ip, '1.1.1.1');
  assert.equal(row.exit_ip_at, '2026-09-25T12:00:00Z', '同一 IP 不许重置锚点（否则 remaining 会被无限续命）');
});

test('★ recordObservedExit：IP 真的变了 → rotation_count+1 且锚点重置为本次时刻', (t) => {
  const db = fixture(); t.after(() => db.close());
  addProxy(db, ipweb(5));
  recordObservedExit(db, { url: ipweb(5), exitIp: '1.1.1.1', at: '2026-09-25T12:00:00Z' });
  const second = recordObservedExit(db, { url: ipweb(5), exitIp: '2.2.2.2', at: '2026-09-25T12:06:00Z' });
  assert.equal(second.changed, true);
  assert.equal(second.from, '1.1.1.1');
  assert.equal(second.to, '2.2.2.2');
  assert.equal(second.epoch, 2);

  const after = db.prepare('SELECT rotation_count, exit_ip, exit_ip_at FROM dola_proxies').get();
  assert.equal(after.rotation_count, 1);
  assert.equal(after.exit_ip, '2.2.2.2');
  assert.equal(after.exit_ip_at, '2026-09-25T12:06:00Z', '锚点必须跟到新 IP 的首次观测时刻');

  // epoch 单调递增
  recordObservedExit(db, { url: ipweb(5), exitIp: '3.3.3.3', at: '2026-09-25T12:12:00Z' });
  const third = db.prepare('SELECT rotation_count FROM dola_proxies').get();
  assert.equal(third.rotation_count, 2);
  assert.equal(rotationView({
    proxyUrl: ipweb(5), exitIp: '3.3.3.3', exitIpAt: '2026-09-25T12:12:00Z',
    rotations: third.rotation_count, now: Date.parse('2026-09-25T12:12:00Z'),
  }).epoch, 3);
});

test('recordObservedExit：URL 不存在或 IP 为空 → 什么都不改（安全返回）', (t) => {
  const db = fixture(); t.after(() => db.close());
  addProxy(db, ipweb(5));
  for (const args of [
    { url: 'http://unknown@host:1', exitIp: '9.9.9.9' },
    { url: ipweb(5), exitIp: '' },
    { url: ipweb(5), exitIp: '   ' },
    { url: '', exitIp: '9.9.9.9' },
  ]) {
    const r = recordObservedExit(db, args);
    assert.deepEqual(r, { changed: false, epoch: null }, `args=${JSON.stringify(args)} 应当无操作`);
  }
  const row = db.prepare('SELECT exit_ip, rotation_count FROM dola_proxies').get();
  assert.equal(row.exit_ip, null);
  assert.equal(row.rotation_count, 0);
});

test('recordObservedExit：先有空值再观测到真 IP → 不算"换过"（旧值为空不是换）', (t) => {
  const db = fixture(); t.after(() => db.close());
  addProxy(db, ipweb(5), '', null, 0);
  const r = recordObservedExit(db, { url: ipweb(5), exitIp: '1.1.1.1', at: '2026-09-25T12:00:00Z' });
  assert.equal(r.changed, false, '空 → 有值 只是"第一次观测"，不是轮换');
  assert.equal(db.prepare('SELECT rotation_count FROM dola_proxies').get().rotation_count, 0);
});

// ─────────────────────── ⑤ accountRotationView ───────────────────────
test('★ accountRotationView：账号没代理 → 直接说 no_proxy（不查库）', (t) => {
  const db = fixture(); t.after(() => db.close());
  const v = accountRotationView({ proxy: '' }, { database: db, readSetting: reader({}) });
  assert.equal(v.reason, 'no_proxy');
  assert.equal(v.remainingSeconds, null);
  assert.equal(v.estimate, true);
});

test('★ accountRotationView：库里的锚点与 epoch 被正确读出（这是页面显示的数据源）', (t) => {
  const db = fixture(); t.after(() => db.close());
  const now = Date.parse('2026-09-25T12:00:00Z');
  addProxy(db, ipweb(5), '1.1.1.1', new Date(now).toISOString(), 3);
  const v = accountRotationView({ proxy: ipweb(5), exit_ip: 'ignored' }, { database: db, readSetting: reader({}), now });
  assert.equal(v.epoch, 4, 'epoch = rotation_count(3) + 1');
  assert.equal(v.remainingSeconds, 300);
  assert.equal(v.windowSeconds, 300);
  assert.equal(v.windowSource, 'url');
});

test('★ accountRotationView：池里没这条代理 → unknown，但也不抛（表可能还没懒建出来）', (t) => {
  const db = fixture(); t.after(() => db.close());
  const rs = reader({});
  const v = accountRotationView({ proxy: ipweb(5), exit_ip: '7.7.7.7' }, { database: db, readSetting: rs });
  assert.equal(v.reason, 'no_anchor', '有窗口、但没有池记录 → 没有锚点');
  assert.equal(v.remainingSeconds, null);

  const empty = new Database(':memory:'); t.after(() => empty.close());
  assert.doesNotThrow(() => accountRotationView({ proxy: ipweb(5) }, { database: empty, readSetting: rs }));
  assert.equal(accountRotationView({ proxy: ipweb(5) }, { database: empty, readSetting: rs }).remainingSeconds, null);
});

test('accountRotationView 吃设置里的兜底窗口与风险阈值', (t) => {
  const db = fixture(); t.after(() => db.close());
  const now = Date.parse('2026-09-25T12:00:00Z');
  const url = 'socks5://user:pass@self-hosted.example:1080';
  addProxy(db, url, '1.1.1.1', new Date(now - 60_000).toISOString(), 0);
  // 兜底窗口 10 分钟 → 剩余 540 秒；风险阈值设成 600 秒 → 判 high
  const rs = reader({
    [EPOCH_SETTING_KEYS.assumedMinutes]: '10',
    [EPOCH_SETTING_KEYS.riskSeconds]: '600',
  });
  const v = accountRotationView({ proxy: url }, { database: db, readSetting: rs, now });
  assert.equal(v.remainingSeconds, 540);
  assert.equal(v.risk, 'high', '阈值 600 > 剩余 540 → 应当判 high');
  assert.equal(v.windowSource, 'assumed');
  assert.equal(Number(rs(EPOCH_SETTING_KEYS.assumedMinutes, '0')), 10);
});

// ─────────────────────── ⑥ rotationSummary ───────────────────────
test('★ rotationSummary：五个桶全输出（枚举桶降到 0 时消失会让 Grafana 曲线"断掉"）', (t) => {
  const db = fixture(); t.after(() => db.close());
  const s = rotationSummary({ database: db, readSetting: reader({}) });
  for (const risk of ROTATION_RISKS) {
    assert.equal(typeof s[risk], 'number', `桶 ${risk} 必须存在（哪怕是 0）`);
  }
  assert.deepEqual([...ROTATION_RISKS], ['low', 'high', 'stale', 'unknown', 'no_anchor']);
  assert.deepEqual(Object.keys(s).sort(), ['high', 'low', 'no_anchor', 'probed', 'rotated', 'stale', 'unknown'].sort());
});

test('★ rotationSummary：unknown（读不出窗口）与 no_anchor（没核验过）必须分开计', (t) => {
  const db = fixture(); t.after(() => db.close());
  const now = Date.parse('2026-09-25T12:00:00Z');
  addProxy(db, 'socks5://u:p@self-hosted.example:1080', '1.1.1.1', new Date(now).toISOString(), 0);   // 读不出窗口 → unknown
  addProxy(db, ipweb(5, 'S1'), '2.2.2.2', null, 0);                                                  // 有窗口无锚点 → no_anchor
  addProxy(db, ipweb(5, 'S2'), '3.3.3.3', new Date(now).toISOString(), 0);                           // low
  const s = rotationSummary({ database: db, readSetting: reader({}), now });
  assert.equal(s.unknown, 1, '读不出窗口的算 unknown');
  assert.equal(s.no_anchor, 1, '有窗口但没锚点的算 no_anchor（混进 unknown 会掩盖"锚点没写进去"）');
  assert.equal(s.low, 1);
  assert.equal(s.probed, 3);
});

test('rotationSummary：只统计启用的代理；rotated 数的是"换过 IP"的条数', (t) => {
  const db = fixture(); t.after(() => db.close());
  const now = Date.parse('2026-09-25T12:00:00Z');
  addProxy(db, ipweb(5, 'A'), '1.1.1.1', new Date(now).toISOString(), 0);
  addProxy(db, ipweb(5, 'B'), '2.2.2.2', new Date(now).toISOString(), 2);
  db.prepare('UPDATE dola_proxies SET enabled=0 WHERE id=2').run();
  const s = rotationSummary({ database: db, readSetting: reader({}), now });
  assert.equal(s.probed, 1, '停用的代理不参与统计');
  assert.equal(s.rotated, 0);

  db.prepare('UPDATE dola_proxies SET enabled=1').run();
  const s2 = rotationSummary({ database: db, readSetting: reader({}), now });
  assert.equal(s2.probed, 2);
  assert.equal(s2.rotated, 1, '只有 rotation_count>0 的那条算"观测到过轮换"');
});

test('rotationSummary：表还没建时全 0 且不抛异常（可观测性不能把主流程搞挂）', (t) => {
  const empty = new Database(':memory:'); t.after(() => empty.close());
  let s;
  assert.doesNotThrow(() => { s = rotationSummary({ database: empty, readSetting: reader({}) }); });
  assert.equal(s.probed, 0);
  assert.equal(s.unknown, 0);
  assert.equal(s.low, 0);
});

test('★ 默认风险阈值是 120 秒，且设置 key 在 db.js 里注册过', async () => {
  assert.equal(DEFAULT_ROTATION_RISK_SECONDS, 120);
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
  for (const key of Object.values(EPOCH_SETTING_KEYS)) {
    assert.ok(src.includes(`'${key}'`), `db.js 的 seed 里缺 ${key}`);
  }
  // dola_proxies 的两列：新建库走 PROXY_POOL_SCHEMA，老库走 ALTER（两边都要有）
  const pool = readFileSync(new URL('../server/proxy-pool.js', import.meta.url), 'utf8');
  for (const col of ['exit_ip_at', 'rotation_count']) {
    assert.ok(src.includes(`'${col}'`), `db.js 的 ALTERS 里缺 dola_proxies.${col}（老库升不上来）`);
    assert.ok(pool.includes(col), `proxy-pool.js 的 PROXY_POOL_SCHEMA 里缺 ${col}（新库建不出来）`);
  }
});

test('★ 顺序陷阱：记账必须在写 exit_ip 之前（写在后面就永远读到新值）', async () => {
  const { readFileSync } = await import('node:fs');
  const pool = readFileSync(new URL('../server/proxy-pool.js', import.meta.url), 'utf8');
  // 每个"探测成功"的分支里，noteObservedExit 都要出现在写 exit_ip 的那条 UPDATE 之前
  const idx = [];
  let from = 0;
  for (;;) {
    const i = pool.indexOf('noteObservedExit(', from);
    if (i < 0) break;
    idx.push(i);
    from = i + 1;
  }
  assert.ok(idx.length >= 3, `至少要接在 3 个探测成功分支上，实际 ${idx.length} 处`);
  for (const i of idx) {
    const after = pool.slice(i, i + 900);
    const updateAt = after.search(/UPDATE dola_proxies SET[^`]*exit_ip=\?/);
    const callAt = after.indexOf('noteObservedExit(');
    assert.ok(updateAt < 0 || callAt < updateAt,
      'noteObservedExit 必须写在 `UPDATE ... exit_ip=?` 之前，否则 rotation_count 永远是 0');
  }
});
