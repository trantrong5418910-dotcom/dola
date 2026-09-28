import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import express from 'express';

/**
 * 防护复核端点的口径一致性。
 *
 * ⚠️ 这个测试用 vm **只切出 handler 本体**，所以 handler 用到的每个模块级依赖
 *    都必须注入 —— 包括 `upstreamConcatEnabled` / `allow30sRewrite` 这两个开关读取器。
 *    它们必须被注入、也必须被断言：2026-09-26 之前 handler 只调
 *    `clearGenerationGuard(db, guard, acc, result)`，而解锁判据里硬编码了"精确目标证据"，
 *    于是 30 秒（页面 UI 里根本没有 30 秒档位）的解锁分支**永远返回 false** = 永久锁。
 *    现在两个开关从**同一处**读出来传进去，与生成路径同源；下面的断言把这条钉住，
 *    防止有人再把它们当"多余参数"删掉。
 *
 * `seconds` 由 scope 决定，`uiSeconds: 10 / native: false / rewriteCarrier: true`
 * 是**线上真实形态**（#424 的 native_30s_note：「已确认页面 10 秒载体可用」）。
 */
function guardEndpoint({ scope, rewrite, concat = false, cleared }) {
  let handler;
  const seconds = Number(String(scope).split(':')[1]);
  const account = { id: 1, status: 'valid', proxy: 'http://example.invalid' };
  const guard = { account_id: 1, scope };
  const result = { ok: true, state: 'available', seconds, uiSeconds: 10,
    model: 'seedance_v2.5', native: false, rewriteCarrier: true };
  const guardProbes = new Set();
  const box = {
    router: { post: (_path, _auth, fn) => { handler = fn; } }, requirePerm: () => () => {},
    db: { prepare: sql => ({ get: () => sql.includes('FROM dola_accounts') ? account
      : sql.includes('FROM dola_generation_guards') ? guard : undefined }) },
    guardProbes, now: () => '2026-09-20T21:00:00.000Z',
    proxyOf: () => ({ server: account.proxy }), proxyUrlOf: () => account.proxy,
    accountCookies: () => ({}),
    upstreamConcatEnabled: () => concat,
    allow30sRewrite: () => rewrite,
    probeNativeVideoViaBrowser: async (_cookies, options) => { assert.equal(options.seconds, seconds); return result; },
    clearGenerationGuard: (_db, g, a, observed, at, flags) => {
      assert.equal(g, guard); assert.equal(a, account); assert.equal(observed, result);
      assert.equal(at, undefined, 'at 必须留默认值，由 clearGenerationGuard 自己取当前时间');
      // ⚠️ 这里**不能**用 assert.deepEqual：flags 是在 vm 的另一个 realm 里创建的对象字面量，
      //    而 node:assert/strict 的 deepEqual = deepStrictEqual，会连原型一起比较 ⇒ 必然失败。
      //    逐字段比布尔值即可（realm 之间原始值仍然 ===）。
      assert.equal(flags.allowUpstreamConcat, concat, '解锁判据必须与生成路径读同一对开关');
      assert.equal(flags.allowCarrierRewrite, rewrite, '解锁判据必须与生成路径读同一对开关');
      return cleared;
    }, audit() {},
  };
  return async () => {
    const source = readFileSync(new URL('../server/routes/dola.js', import.meta.url), 'utf8');
    const start = source.indexOf("router.post('/accounts/:id/generation-guard-probe'");
    assert.ok(start >= 0);
    const end = source.indexOf('\n});', start);
    assert.ok(end > start);
    vm.createContext(box); vm.runInContext(source.slice(start, end + 4), box);
    const response = { status(n) { this.statusCode = n; return this; }, json(data) { this.data = data; return this; } };
    await handler({ params: { id: '1' }, body: { scope } }, response);
    // 无论成功失败都必须释放并发闸，否则该账号之后再也复核不了。
    assert.equal(guardProbes.size, 0);
    return response;
  };
}

test('guard endpoint does not label carrier-only evidence available after refusing to unlock', async () => {
  // 20 秒口径本次未改：载体证据仍然不能解锁（历史行为原样保留）。
  const response = await guardEndpoint({ scope: 'duration:20', rewrite: true, cleared: false })();
  assert.equal(response.data.cleared, false);
  assert.equal(response.data.state, 'unknown');
  assert.match(response.data.message, /较短时长.*不能证明目标时长.*保留失败保护/);
});

test('★ 30 秒解锁只在改写开关打开时生效，且与生成路径读同一对开关（防「永久锁」）', async () => {
  // 开关打开：与生成路径同源 ⇒ 载体证据可以解除。这正是 #424 的形态：
  // 09:12 因瞬时失败建了 duration:30 防护，10:32 的只读探针已确认 10 秒载体可用。
  const on = await guardEndpoint({ scope: 'duration:30', rewrite: true, cleared: true })();
  assert.equal(on.data.cleared, true);
  assert.equal(on.data.state, 'available');
  assert.match(on.data.message, /已解除该能力保护/);

  // 开关关闭：退回历史口径，同样拒绝解锁 —— 严格增量，默认行为逐字不变。
  const off = await guardEndpoint({ scope: 'duration:30', rewrite: false, cleared: false })();
  assert.equal(off.data.cleared, false);
  assert.equal(off.data.state, 'unknown');
});

test('admin analytics is permission-checked/read-only, rejects bad ranges; guard probe fails closed without proxy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dola-analytics-api-'));
  process.env.ADMIN_DB = join(dir, 'fixture.db');
  process.env.ADMIN_INIT_PASSWORD = 'fixture-only-password';
  process.env.ADMIN_JWT_SECRET = randomBytes(32).toString('hex');
  const database = await import('../server/db.js');
  const db = await database.initDb();
  const auth = await import('../server/auth.js');
  const { default: routes } = await import('../server/routes/dola.js');
  const user = db.prepare("SELECT id,role_id FROM users WHERE username='admin'").get();
  const token = auth.signJwt({ uid: user.id });
  const app = express(); app.use(express.json()); app.use(auth.authMiddleware); app.use('/api/dola', routes);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/dola`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  try {
    const at = new Date().toISOString();
    const id = Number(db.prepare(`INSERT INTO dola_accounts(label,cookie,cookie_hash,cookie_names,status,proxy,created_at,updated_at)
      VALUES('fixture','SYNTHETIC_COOKIE','synthetic','ttwid','valid','',?,?)`).run(at, at).lastInsertRowid);
    db.prepare(`INSERT INTO dola_videos(account_id,seconds,status,error,created_at,updated_at,finished_at)
      VALUES(?,15,'failed','未确认原生 15 秒 SYNTHETIC_SECRET',?,?,?)`).run(id, at, at, at);
    const before = JSON.stringify(db.prepare('SELECT * FROM dola_accounts').all());
    assert.equal((await fetch(`${base}/generation-analytics`)).status, 401);
    const response = await fetch(`${base}/generation-analytics?hours=24&timezone=Asia%2FShanghai`, { headers });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.totals.failed, 1); assert.equal(result.reasons[0].code, 'capability');
    assert.equal(JSON.stringify(result).includes('SYNTHETIC'), false);
    assert.equal(result.guards.length, 0); // GET does not backfill or mutate.
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM dola_accounts').all()), before);
    assert.equal((await fetch(`${base}/generation-analytics?hours=100000`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/generation-analytics?timezone=invalid`, { headers })).status, 400);
    db.prepare('UPDATE roles SET permissions=? WHERE id=?').run('[]', user.role_id);
    assert.equal((await fetch(`${base}/generation-analytics`, { headers })).status, 403);
    db.prepare('UPDATE roles SET permissions=? WHERE id=?').run('["dola:list"]', user.role_id);
    const probe = () => fetch(`${base}/accounts/${id}/generation-guard-probe`, { method: 'POST', headers, body: '{"scope":"duration:15"}' });
    assert.equal((await probe()).status, 403);
    db.prepare('UPDATE roles SET permissions=? WHERE id=?').run('["*"]', user.role_id);
    db.prepare(`INSERT INTO dola_generation_guards(account_id,scope,reason_code,source_task_id,blocked_at)
      VALUES(?,'duration:15','capability',1,?)`).run(id, at);
    assert.equal((await probe()).status, 409);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM dola_videos').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM point_transactions').get().n, 0);
    assert.equal(db.prepare('SELECT cleared_at FROM dola_generation_guards').get().cleared_at, null);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    db.raw.close(); await rm(dir, { recursive: true, force: true });
  }
});
