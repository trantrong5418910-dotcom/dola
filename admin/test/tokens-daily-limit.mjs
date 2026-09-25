/**
 * 令牌「每日积分上限」的接口测试（`server/routes/tokens.js`）。
 *
 * 这个字段有**三态**，而三态在数据库里是 `NULL` / `0` / `N`：
 *
 *   NULL → 跟随全局设置 `gateway_daily_points_limit`
 *   0    → 该令牌**不限**（覆盖全局）
 *   N>0  → 该令牌每天最多 N 分
 *
 * 三态里最容易写错、也最危险的是 **`0`**：
 *   · 后端若用 `Number(x) || null` 解析，`0` 是 falsy，会被吞成 `null`，
 *     「给某个令牌单独开无限额」这个功能就**永远做不到**；
 *   · 前端若用同样的写法，「不限」这个单选项会表现为**点了没反应**。
 *   而它的方向是**把上限放开**，属于静默且危险的一侧。
 *
 * 所以本文件把三态在**接口这一层**钉死，并覆盖：
 *   · 生成时带上限（三种取值 + 非法值必须 400 而不是静默回落）
 *   · 事后改上限（含"恢复跟随全局"）
 *   · 列表要把该字段回给前端（否则界面显示不出"跟随全局"）
 *   · 写审计（额度变更必须可追溯）
 *
 * 隔离方式与 `maintenance.mjs` 一致：临时库 + 合成 JWT，不碰真实库。
 */
import strictAssert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const ENV_KEYS = ['ADMIN_DB', 'ADMIN_JWT_SECRET', 'ADMIN_INIT_PASSWORD'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let tempDirectory = null;
let db = null;
let auth = null;
let apiServer = null;
let apiBase = null;
let adminToken = null;

async function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function api(endpoint, { token = adminToken, method = 'GET', body } = {}) {
  const response = await fetch(`${apiBase}${endpoint}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
}

/** 直接读库确认落库值（不信任接口回显 —— 回显对了但没落库是最坏的）。 */
const storedLimit = (id) =>
  db.prepare('SELECT daily_points_limit AS v FROM tokens WHERE id = ?').get(id).v;

describe('tokens: 每令牌每日积分上限（三态）', { concurrency: false }, () => {
  before(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'tokens-daily-limit-'));
    process.env.ADMIN_DB = join(tempDirectory, 'isolated.sqlite');
    process.env.ADMIN_JWT_SECRET = randomBytes(32).toString('hex');
    process.env.ADMIN_INIT_PASSWORD = 'synthetic-test-password-only';

    // 环境变量必须在导入后端模块**之前**设好，否则 db.js 会绑定到真实库。
    const database = await import('../server/db.js');
    strictAssert.equal(database.DB_PATH, process.env.ADMIN_DB, '必须绑定到临时库');
    db = await database.initDb();

    auth = await import('../server/auth.js');
    const { default: express } = await import('express');
    const { default: tokensRouter } = await import('../server/routes/tokens.js');

    const app = express();
    app.use(express.json());
    app.use(auth.authMiddleware);
    app.use('/api/tokens', tokensRouter);
    apiServer = createServer(app);
    apiBase = await listen(apiServer);

    const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
    adminToken = auth.signJwt({ uid: adminId });
  });

  after(async () => {
    if (apiServer) await new Promise((r) => apiServer.close(r));
    // ⚠️ initDb() 返回的是包装对象 `{ raw, exec, prepare }`，不是裸的连接 ——
    //    `close()` 挂在 `raw` 上。写成 `db.close()` 会在收尾时报
    //    "db.close is not a function"，而**测试本身是全绿的**，
    //    于是这条报错很容易被当成噪音放过（第一次就踩到了）。
    if (db?.raw?.close) db.raw.close();
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  test('★ 迁移真的加了这一列，且默认是 NULL（NULL=跟随全局，不是 0=不限）', () => {
    const cols = db.prepare('PRAGMA table_info(tokens)').all().map((c) => c.name);
    strictAssert.ok(cols.includes('daily_points_limit'), 'tokens 缺 daily_points_limit 列');
    // 默认值必须是 NULL。若默认成 0，全部存量令牌会一夜之间变成"无限额"，
    // 把全局日上限静默废掉。
    const r = db.prepare("SELECT * FROM tokens WHERE id = (SELECT MIN(id) FROM tokens)").get();
    if (r) strictAssert.equal(r.daily_points_limit, null, '存量令牌默认必须是 NULL');
  });

  test('生成：不传 dailyPointsLimit ⇒ NULL（跟随全局）', async () => {
    const res = await api('/api/tokens/generate', { method: 'POST', body: { count: 1, points: 5 } });
    strictAssert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.items[0].id;
    strictAssert.equal(storedLimit(id), null, '落库必须是 NULL');
  });

  test('★ 生成：传 0 ⇒ 落库 0（不限），不能被吞成 NULL', async () => {
    const res = await api('/api/tokens/generate', { method: 'POST', body: { count: 1, points: 5, dailyPointsLimit: 0 } });
    strictAssert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.items[0].id;
    strictAssert.equal(storedLimit(id), 0, '0 必须原样落库 —— 被吞成 NULL 就等于"不限"永远设不上');
  });

  test('生成：传 30 ⇒ 落库 30', async () => {
    const res = await api('/api/tokens/generate', { method: 'POST', body: { count: 1, points: 5, dailyPointsLimit: 30 } });
    strictAssert.equal(res.status, 201);
    strictAssert.equal(storedLimit(res.body.items[0].id), 30);
  });

  test('★ 生成：非法值必须 400，不能静默回落成 NULL', async () => {
    // 「我输错了」和「我要跟随全局」是两件事。静默回落的表现是
    // 运营改了半天不生效，还查不出原因。
    for (const bad of [-1, 'abc', {}, []]) {
      const res = await api('/api/tokens/generate', {
        method: 'POST', body: { count: 1, points: 5, dailyPointsLimit: bad },
      });
      strictAssert.equal(res.status, 400, `${JSON.stringify(bad)} 应被拒绝，实际 ${res.status}`);
      strictAssert.ok(res.body.message, '要给出人话理由');
    }
  });

  test('生成：批量时每个令牌都带上限', async () => {
    const res = await api('/api/tokens/generate', { method: 'POST', body: { count: 3, points: 1, dailyPointsLimit: 7 } });
    strictAssert.equal(res.status, 201);
    strictAssert.equal(res.body.items.length, 3);
    for (const it of res.body.items) strictAssert.equal(storedLimit(it.id), 7);
  });

  test('列表要回 daily_points_limit（否则界面显示不出"跟随全局"）', async () => {
    const gen = await api('/api/tokens/generate', { method: 'POST', body: { count: 1, points: 1, dailyPointsLimit: 42 } });
    const id = gen.body.items[0].id;
    const res = await api('/api/tokens?pageSize=100');
    strictAssert.equal(res.status, 200);
    const row = res.body.items.find((r) => r.id === id);
    strictAssert.ok(row, '列表里应能找到刚生成的令牌');
    strictAssert.equal(row.daily_points_limit, 42, '列表必须带上这个字段');
  });

  test('★ action=daily_limit：能把 NULL 改成 0（开启"不限"）', async () => {
    const gen = await api('/api/tokens/generate', { method: 'POST', body: { count: 1, points: 1 } });
    const id = gen.body.items[0].id;
    strictAssert.equal(storedLimit(id), null);

    const res = await api(`/api/tokens/${id}/action`, { method: 'POST', body: { action: 'daily_limit', dailyPointsLimit: 0 } });
    strictAssert.equal(res.status, 200, JSON.stringify(res.body));
    strictAssert.equal(storedLimit(id), 0, '落库必须是 0');
    strictAssert.equal(res.body.daily_points_limit, 0, '回显也必须是 0（不是 null）');
  });

  test('★ action=daily_limit：能把 0 改回 NULL（恢复跟随全局）', async () => {
    const gen = await api('/api/tokens/generate', { method: 'POST', body: { count: 1, points: 1, dailyPointsLimit: 0 } });
    const id = gen.body.items[0].id;
    strictAssert.equal(storedLimit(id), 0);

    const res = await api(`/api/tokens/${id}/action`, { method: 'POST', body: { action: 'daily_limit', dailyPointsLimit: null } });
    strictAssert.equal(res.status, 200, JSON.stringify(res.body));
    strictAssert.equal(storedLimit(id), null, '必须能回到 NULL');
  });

  test('action=daily_limit：不传字段等价于恢复跟随全局', async () => {
    const gen = await api('/api/tokens/generate', { method: 'POST', body: { count: 1, points: 1, dailyPointsLimit: 9 } });
    const id = gen.body.items[0].id;
    const res = await api(`/api/tokens/${id}/action`, { method: 'POST', body: { action: 'daily_limit' } });
    strictAssert.equal(res.status, 200);
    strictAssert.equal(storedLimit(id), null);
  });

  test('action=daily_limit：非法值 400 且**不改动**原值', async () => {
    const gen = await api('/api/tokens/generate', { method: 'POST', body: { count: 1, points: 1, dailyPointsLimit: 15 } });
    const id = gen.body.items[0].id;
    for (const bad of [-3, 'abc', []]) {
      const res = await api(`/api/tokens/${id}/action`, { method: 'POST', body: { action: 'daily_limit', dailyPointsLimit: bad } });
      strictAssert.equal(res.status, 400, `${JSON.stringify(bad)} 应 400`);
      strictAssert.equal(storedLimit(id), 15, '被拒绝的请求不能改动原值');
    }
  });

  test('action=daily_limit：令牌不存在 ⇒ 404', async () => {
    const res = await api('/api/tokens/999999/action', { method: 'POST', body: { action: 'daily_limit', dailyPointsLimit: 1 } });
    strictAssert.equal(res.status, 404);
  });

  test('★ 额度变更要留审计（改上限是资金相关操作）', async () => {
    const gen = await api('/api/tokens/generate', { method: 'POST', body: { count: 1, points: 1 } });
    const id = gen.body.items[0].id;
    await api(`/api/tokens/${id}/action`, { method: 'POST', body: { action: 'daily_limit', dailyPointsLimit: 25 } });

    const row = db.prepare("SELECT action, target_id, detail FROM audit_logs WHERE action='token.daily_limit' AND target_id=? ORDER BY id DESC").get(String(id));
    strictAssert.ok(row, '应写入 token.daily_limit 审计');
    strictAssert.match(String(row.detail), /25/, '审计里要能看到改成了多少');
  });

  test('生成时的上限也要进审计', async () => {
    const before = db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action='token.generate'").get().c;
    await api('/api/tokens/generate', { method: 'POST', body: { count: 1, points: 1, dailyPointsLimit: 33 } });
    const row = db.prepare("SELECT detail FROM audit_logs WHERE action='token.generate' ORDER BY id DESC").get();
    strictAssert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action='token.generate'").get().c,
      before + 1,
    );
    strictAssert.match(String(row.detail), /33/, `审计应包含日上限，实际：${row.detail}`);
  });

  test('★ 未登录访问 ⇒ 401（这一层不能被绕过）', async () => {
    const res = await api('/api/tokens', { token: null });
    strictAssert.equal(res.status, 401);
  });
});
