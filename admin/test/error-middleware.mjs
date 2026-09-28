/**
 * 兜底错误中间件的单测。
 *
 * 背景：2026-09-28 并发压测中，100 个畸形 JSON 请求**全部返回 500**（应为 400），
 * 并把 `error.log` 从 1497 行灌到 3435 行（**+1938 行，19 行/请求**），日志里还带着原始请求体。
 * 根因就是这个兜底中间件把**框架已经分好类**的 4xx 抹成了 500。
 *
 * 这组用例固定三件事：
 *   ① 状态码要**尊重框架**给的分类（entity.parse.failed 带 400）；
 *   ② 客户端错误的日志**只一行**、且**绝不出现请求体**（这是最贵也最看不见的那一条）；
 *   ③ **真正的 5xx 行为一个字没变** —— 修复绝不能顺手改掉它，否则排查线上问题时会瞎。
 *
 * 这里用**真的 HTTP**（`app.listen(0)` 随机端口）而不是直接调函数：
 * 因为要测的正是「body-parser 抛的到底是什么」——那部分只有走真实管道才作数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createErrorHandler, httpStatusOf, PARSER_MESSAGES } from '../server/error-middleware.js';

/** 伪装成请求体里的凭据。任何地方（响应/日志）出现它都算泄漏。 */
const MARKER = 'SECRET_MARKER_9f3a';

/** 起一个一次性 app：body 解析 + 可自定义路由 + **真实的**兜底处理器。 */
async function withServer(defineRoutes = () => {}) {
  const logs = [];
  const app = express();
  app.use(express.json());
  defineRoutes(app);
  app.use(createErrorHandler({ log: (...args) => logs.push(args.map(String).join(' ')) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    logs,
    close: () => new Promise((r) => server.close(r)),
  };
}

const postJson = (base, path, body) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body,
});

/**
 * 用**裸的** app 抓一次 body-parser 的原始报错。
 *
 * 这是后面几条用例的**前提证据**：证明「框架确实把 400 分好类了」以及
 * 「原始报错里确实带着请求体片段」—— 没有这个前提，后面那些断言可能只是"恰好成立"。
 */
async function captureRawParserError(raw) {
  const app = express();
  app.use(express.json());
  app.post('/x', (_req, res) => res.json({ ok: true }));
  let captured = null;
  app.use((err, _req, res, _next) => { captured = err; res.status(500).end(); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    await postJson(`http://127.0.0.1:${server.address().port}`, '/x', raw);
  } finally {
    await new Promise((r) => server.close(r));
  }
  return captured;
}

// ─────────────────────── ① 前提：框架确实分好了类 ───────────────────────
test('前提（证据）：body-parser 的畸形 JSON 报错**自带 400 且带请求体**', async () => {
  // body 以 MARKER 开头：V8 的报错会把**前 ~15 个字符**放进 message，
  // 所以这种形状能把"回显 err.message"这条泄漏通道暴露出来。
  const raw = `${MARKER}{"x":1}`;
  const err = await captureRawParserError(raw);
  assert.ok(err, '应该捕获到 body-parser 的错误');
  assert.equal(err.type, 'entity.parse.failed');
  assert.equal(err.status, 400, '框架已经标好了 400 —— 旧代码把它抹成了 500');
  assert.equal(err.statusCode, 400);
  assert.equal(err.expose, true);
  // ⚠️ 这两条是"为什么必须回固定文案"的实证：
  assert.equal(err.body, raw, 'err.body 是**完整原始请求体** —— 旧代码 console.error 全量，就是把它写进日志');
  // ⚠️ 注意 V8 只截**前 10 个字符**，所以断言用 SECRET_MAR 而不是整个 MARKER。
  //    这也是"为什么必须回固定文案"的实证：解析报错自己就会把请求体开头带出来。
  assert.match(err.message, /SECRET_MAR/, 'err.message 里也**带着请求体片段**，所以不能当客户端文案回显');
});

test('httpStatusOf：只认 400–599，取不到就交给 5xx 分支', () => {
  assert.equal(httpStatusOf({ status: 400 }), 400);
  assert.equal(httpStatusOf({ statusCode: 413 }), 413);
  assert.equal(httpStatusOf({ status: '404' }), 404, '字符串数字也要认（中间件不一定给 number）');
  assert.equal(httpStatusOf({ status: 400, statusCode: 500 }), 400, 'status 优先于 statusCode');
  // 以下都应视为"这不是一个分好类的客户端错误"
  for (const v of [undefined, null, {}, { status: 200 }, { status: 399 }, { status: 600 }, { status: 'abc' }, { status: NaN }]) {
    assert.equal(httpStatusOf(v), 0, `${JSON.stringify(v)} 应返回 0`);
  }
});

// ─────────────────────── ② 状态码：4xx 不许被抹成 500 ───────────────────────
test('★ 畸形 JSON body → 400（本次压测挖到的那个 bug）', async () => {
  const s = await withServer((app) => app.post('/v1/videos', (_req, res) => res.json({ ok: true })));
  try {
    const res = await postJson(s.base, '/v1/videos', `${MARKER}{"x":1}`);
    assert.equal(res.status, 400, `实际 ${res.status}（旧代码是 500）`);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.message, PARSER_MESSAGES['entity.parse.failed']);
    assert.ok(!JSON.stringify(body).includes('SECRET_MARKER'), '响应里绝不能回显请求体片段');
  } finally { await s.close(); }
});

test('★ 超大请求体 → 413（同样别被抹成 500）', async () => {
  const s = await withServer((app) => app.post('/v1/videos', (_req, res) => res.json({ ok: true })));
  try {
    // express.json() 默认上限 100kb，这里给 300kb 的**合法** JSON
    const res = await postJson(s.base, '/v1/videos', JSON.stringify({ prompt: 'x'.repeat(300 * 1024) }));
    assert.equal(res.status, 413, `实际 ${res.status}`);
    assert.equal((await res.json()).message, PARSER_MESSAGES['entity.too.large']);
  } finally { await s.close(); }
});

test('★ 路由抛出的 4xx：状态码照原样返回，但**未标记 expose 的 message 不外发**', async () => {
  const s = await withServer((app) => {
    app.get('/boom', () => {
      // 形如 generator.js / submission-journal.js 里 `Object.assign(new Error(...), { status })`
      // 的写法：带状态码但**没标 expose**，按约定就不该把内部措辞发给客户端。
      throw Object.assign(new Error('内部细节：账号 #446 的 cookie_hash 不匹配'), { status: 409 });
    });
  });
  try {
    const res = await fetch(`${s.base}/boom`);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).message, '请求格式不正确');
    assert.ok(!s.logs.join('\n').includes('cookie_hash'), '日志里也不该出现内部措辞');
  } finally { await s.close(); }
});

test('显式标了 expose:true 的 4xx → 按约定回显它自己的 message', async () => {
  const s = await withServer((app) => {
    app.get('/boom', () => { throw Object.assign(new Error('该任务已是终态，不能启动'), { status: 409, expose: true }); });
  });
  try {
    const res = await fetch(`${s.base}/boom`);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).message, '该任务已是终态，不能启动');
  } finally { await s.close(); }
});

// ─────────────────────── ③ 日志：一行、且无请求体 ───────────────────────
test('★ 客户端错误只记**一行**，且请求体/堆栈都不出现（旧代码 19 行/请求，含原始 body）', async () => {
  const s = await withServer((app) => app.post('/v1/videos', (_req, res) => res.json({ ok: true })));
  try {
    await postJson(s.base, '/v1/videos', `${MARKER}{"x":1}`);
    assert.equal(s.logs.length, 1, `应只记一行，实际 ${s.logs.length} 行`);
    const line = s.logs[0];
    assert.match(line, /400/, '这一行要带上状态码，方便和访问日志对上');
    assert.match(line, /POST \/v1\/videos/, '要带方法+路径，否则等于没记');
    assert.match(line, /entity\.parse\.failed/, '要带错误类型');
    assert.ok(!line.includes('SECRET_MARKER'), '**日志里绝不能出现请求体**');
    assert.ok(!/\n\s+at\s/.test(line), '客户端错误不该打堆栈');
  } finally { await s.close(); }
});

test('★ 回归：**真正的 5xx 行为一个字没变**（全量日志 + 原样 message）', async () => {
  // 故意不动这条路径：排查线上问题时，5xx 的原始信息必须还在。
  const s = await withServer((app) => {
    app.get('/boom', () => { throw new Error('磁盘写满了：ENOSPC'); });
  });
  try {
    const res = await fetch(`${s.base}/boom`);
    assert.equal(res.status, 500);
    assert.equal((await res.json()).message, '磁盘写满了：ENOSPC');
    assert.equal(s.logs.length, 1);
    assert.ok(s.logs[0].includes('磁盘写满了'), '5xx 仍要把原始错误打出来');
  } finally { await s.close(); }
});

// ─────────────────────── ④ 凭据路径的特例不许退化 ───────────────────────
test('★ google-login 特例：状态码照框架给的走，日志仍是固定一句、不含请求体', async () => {
  // 这条路径**在修复前就做对了**，很容易在重构时被顺手改坏 —— 所以要有网。
  const s = await withServer((app) => app.post('/api/dola/google-login/submit', (_req, res) => res.json({ ok: true })));
  try {
    const res = await postJson(s.base, '/api/dola/google-login/submit', `${MARKER}{"x":1}`);
    assert.equal(res.status, 400, '凭据路径也要尊重 400，不能回 500');
    assert.equal((await res.json()).message, '登录请求格式错误或暂不可用，请检查后重试');
    assert.equal(s.logs.length, 1);
    assert.ok(!s.logs.join('\n').includes('SECRET_MARKER'));
    assert.match(s.logs[0], /敏感内容已省略/);
  } finally { await s.close(); }
});

test('google-login 特例：非 4xx 时仍回 500（保持原逻辑，别顺手改语义）', async () => {
  const s = await withServer((app) => {
    app.get('/api/dola/google-login/x', () => { throw new Error('浏览器起不来'); });
  });
  try {
    const res = await fetch(`${s.base}/api/dola/google-login/x`);
    assert.equal(res.status, 500);
    assert.equal((await res.json()).message, '登录请求格式错误或暂不可用，请检查后重试');
  } finally { await s.close(); }
});

// ─────────────────────── ⑤ 响应头已发出时不炸 ───────────────────────
test('headersSent 之后：把错误交回 Express（不二次写响应、不把进程搞挂）', async () => {
  // 这里**不能**断言"能拿到一个漂亮的响应"：我们的处理器 `return next(err)` 之后，
  // Express 的终章处理器发现响应头已经发出去了，会**直接掐断连接**（设计如此）。
  // 而且 `fetch()` 在**响应头到达时就已经 resolve**，所以掐连接不会让它 reject ——
  // 想靠 `assert.rejects(fetch(...))` 验证这件事是测不到的。
  // 真正要钉的是三件事：不二次写响应、照常记一行、服务还活着。
  for (const status of [409, 500]) {
    const s = await withServer((app) => {
      app.get('/half', (_req, res) => {
        res.write('已开始输出');
        throw Object.assign(new Error('写到一半出错'), { status });
      });
      app.get('/alive', (_req, res) => res.json({ ok: true }));
    });
    try {
      await fetch(`${s.base}/half`).then((r) => r.text()).catch(() => '连接被掐断（预期）');
      assert.equal(s.logs.length, 1, '但要照常记一行');
      const alive = await fetch(`${s.base}/alive`);
      assert.equal(alive.status, 200, '一次失败不能把服务带走');
    } finally { await s.close(); }
  }
});
