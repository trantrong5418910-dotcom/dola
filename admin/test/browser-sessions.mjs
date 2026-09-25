/**
 * 常驻浏览器会话池的隔离测试（不起真浏览器）。
 *
 * 重点验证三个「不这么做就会出错」的约束：
 *   ① proxy/profile 变了必须重建（persistent context 的 proxy 是启动参数）
 *   ② 复用前必须 unrouteAll + 关掉残留页面（route 是叠加的，不清会累积）
 *   ③ 回收时必须真 close（那是 HTTP 缓存 flush 到磁盘的唯一时机）
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireSession,
  releaseSession,
  invalidateSession,
  sessionStats,
  closeAllSessions,
} from '../server/dola/browser-sessions.js';

/** 不起真浏览器：一个够用的假 ctx */
function makePage() {
  return { closed: false, close: async function () { this.closed = true; } };
}

function mockCtx({ connected = true, pages = [makePage()] } = {}) {
  return {
    _connected: connected,
    _pages: pages,
    _closed: false,
    unrouteCalls: 0,
    browser() {
      return { isConnected: () => this._connected };
    },
    pages() {
      return this._pages;
    },
    async unrouteAll() {
      this.unrouteCalls += 1;
    },
    async close() {
      this._closed = true;
      this._closedAt = Date.now();
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.afterEach(async () => {
  await closeAllSessions();
});

test('首次 acquire 才调用 launch', async () => {
  let launches = 0;
  const ctx = mockCtx();
  const got = await acquireSession('a1', { launch: async () => { launches += 1; return ctx; }, launchKey: 'p1' });
  assert.equal(got, ctx);
  assert.equal(launches, 1);
});

test('★ 同 key 复用：不再 launch，且清理上一轮痕迹（unrouteAll + 关残留页）', async () => {
  let launches = 0;
  const ctx = mockCtx({ pages: [makePage(), makePage()] });
  const mk = () => { launches += 1; return ctx; };

  await acquireSession('a2', { launch: mk, launchKey: 'p1' });
  releaseSession('a2');
  await acquireSession('a2', { launch: mk, launchKey: 'p1' });

  assert.equal(launches, 1, '复用时不应再启动浏览器');
  assert.equal(ctx.unrouteCalls, 1, '复用前必须 unrouteAll，否则 route 会叠加');
  assert.ok(ctx._pages.every((p) => p.closed), '残留页面必须关掉');
});

test('★ launchKey 变化（换代理/profile）必须重建，旧实例真关', async () => {
  const first = mockCtx();
  const second = mockCtx();
  let launches = 0;
  await acquireSession('a3', { launch: async () => { launches += 1; return first; }, launchKey: 'p1' });
  releaseSession('a3');
  await acquireSession('a3', { launch: async () => { launches += 1; return second; }, launchKey: 'p2' });

  assert.equal(launches, 2);
  assert.ok(first._closed, '配置变了必须销毁旧实例，否则会拿旧出口去请求');
});

test('★ 实例已崩溃（browser 断连）时重建，不把死会话交给调用方', async () => {
  const dead = mockCtx({ connected: false });
  const fresh = mockCtx();
  let launches = 0;
  await acquireSession('a4', { launch: async () => { launches += 1; return dead; }, launchKey: 'p1' });
  releaseSession('a4');
  const got = await acquireSession('a4', { launch: async () => { launches += 1; return fresh; }, launchKey: 'p1' });

  assert.equal(got, fresh);
  assert.equal(launches, 2);
});

test('同一账号并发 acquire 必须报错，不能两份共用', async () => {
  await acquireSession('a5', { launch: async () => mockCtx(), launchKey: 'p1' });
  await assert.rejects(
    () => acquireSession('a5', { launch: async () => mockCtx(), launchKey: 'p1' }),
    /busy/,
  );
});

test('invalidate 立即销毁，下次重新 launch', async () => {
  const first = mockCtx();
  let launches = 0;
  await acquireSession('a6', { launch: async () => { launches += 1; return first; }, launchKey: 'p1' });
  await invalidateSession('a6');
  assert.ok(first._closed, 'invalidate 后必须真关（flush 缓存）');
  await acquireSession('a6', { launch: async () => { launches += 1; return mockCtx(); }, launchKey: 'p1' });
  assert.equal(launches, 2);
});

test('★ 空闲超时后自动回收并真关（缓存 flush）', async () => {
  process.env.DOLA_SESSION_IDLE_MS = '60';
  try {
    const ctx = mockCtx();
    await acquireSession('a7', { launch: async () => ctx, launchKey: 'p1' });
    releaseSession('a7');
    assert.equal(ctx._closed, false, '刚归还时不应立刻关');
    await sleep(200);
    assert.ok(ctx._closed, '空闲超时后必须真关，否则缓存永远不落盘');
    assert.equal(sessionStats().length, 0);
  } finally {
    delete process.env.DOLA_SESSION_IDLE_MS;
  }
});

test('池满时回收最久未用的空闲会话，不碰在跑的', async () => {
  process.env.DOLA_SESSION_MAX = '2';
  try {
    const c1 = mockCtx();
    const c2 = mockCtx();
    const c3 = mockCtx();
    await acquireSession('b1', { launch: async () => c1, launchKey: 'p' });
    releaseSession('b1');
    await sleep(10);
    await acquireSession('b2', { launch: async () => c2, launchKey: 'p' });
    releaseSession('b2');
    // 第三个：应回收最久未用的 b1
    await acquireSession('b3', { launch: async () => c3, launchKey: 'p' });

    assert.ok(c1._closed, 'b1 最久未用，应被回收');
    assert.equal(c2._closed, false, 'b2 较新，仍应保留');
  } finally {
    delete process.env.DOLA_SESSION_MAX;
  }
});

test('sessionStats 供诊断可见', async () => {
  await acquireSession('c1', { launch: async () => mockCtx(), launchKey: 'px' });
  const stats = sessionStats();
  assert.equal(stats.length, 1);
  assert.equal(stats[0].account, 'c1');
  assert.equal(stats[0].busy, true);
  assert.equal(stats[0].launchKey, 'px');
});
