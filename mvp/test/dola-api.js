/**
 * 新 Dola Bearer API 的本地契约测试。
 * 不连接公网、不需要令牌、不创建真实视频；用一个本地 HTTP 服务模拟文档中的响应。
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DolaApiProvider } from '../src/providers/dola-api.js';
import { Status } from '../src/core/task.js';

let pass = 0;
let fail = 0;

function ok(condition, name) {
  if (condition) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.error(`  ✗ ${name}`); }
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

const state = {
  createCalls: 0,
  createKeys: [],
  createContentTypes: [],
  queryCalls: 0,
  authFailures: 0,
};

const server = http.createServer(async (req, res) => {
  if (req.url === '/video.mp4') {
    const body = Buffer.from('LOCAL-MOCK-MP4');
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length });
    res.end(body);
    return;
  }

  if (req.headers.authorization !== 'Bearer test-token') {
    state.authFailures += 1;
    json(res, 401, { code: '0', message: '令牌无效或已禁用' });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/v1/videos') {
    json(res, 200, {
      code: '1',
      balance: 100,
      tasks: [{ task_id: 'task-0', status: 'succeeded', created_at: '2026-09-19T00:00:00Z', url: 'http://example.invalid/task-0.mp4' }],
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/v1/videos') {
    for await (const _chunk of req) { /* consume multipart body */ }
    state.createCalls += 1;
    state.createKeys.push(req.headers['idempotency-key']);
    state.createContentTypes.push(req.headers['content-type'] || '');
    if (state.createCalls === 1) {
      json(res, 502, { code: '0', message: 'temporary upstream failure' });
      return;
    }
    json(res, 200, {
      code: '1',
      task_id: 'task-1',
      status: 'queued',
      charged_points: 1,
      balance: 99,
      idempotent_replay: false,
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/v1/videos/task-1') {
    state.queryCalls += 1;
    if (state.queryCalls === 1) {
      json(res, 200, {
        code: '0',
        message: '排队中',
        task: { task_id: 'task-1', status: 'processing', estimated_wait: '还需 5 秒' },
      });
      return;
    }
    json(res, 200, {
      code: '1',
      task: { task_id: 'task-1', status: 'succeeded', url: `http://${req.headers.host}/video.mp4`, billing_state: 'charged' },
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/v1/cards/redeem') {
    for await (const _chunk of req) { /* consume JSON body */ }
    json(res, 200, { code: '1', points: 10, balance: 109 });
    return;
  }

  if (req.method === 'DELETE' && req.url === '/api/v1/videos/task-1') {
    json(res, 200, { code: '1', message: 'deleted' });
    return;
  }

  json(res, 404, { code: '0', message: 'not found' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dola-api-test-'));

try {
  const provider = new DolaApiProvider({
    baseUrl,
    credential: 'test-token',
    timeout: 2_000,
    minPollIntervalMs: 0,
  });

  console.log('— 新 Dola API 本地契约 —');
  const session = await provider.login();
  ok(session.role === 'user', 'Bearer Token 登录通过');
  ok(session.balance === 100, '登录不虚构余额，能读取响应里的 balance');

  const created = await provider.createTask({
    prompt: '本地契约测试',
    ratio: '16:9',
    seconds: 30,
    idempotencyKey: 'test-key-001',
  });
  ok(created.taskId === 'task-1', '创建响应直接拿到 task_id');
  ok(state.createCalls === 2, '502 后按文档自动重试一次');
  ok(state.createKeys[0] === state.createKeys[1], '重试复用同一个 Idempotency-Key');
  ok(state.createContentTypes.every((v) => v.includes('multipart/form-data;')), '创建使用 multipart/form-data 且让 fetch 自动生成 boundary');
  ok(provider.balance === 99, '创建响应余额同步为 99');

  const processing = await provider.getTask('task-1');
  ok(processing.status === Status.PROCESSING, '查询 code:"0" 仍能识别处理中状态');
  ok(processing.error == null && processing.notice === '还需 5 秒', '处理中提示进入 notice，不误报成 error');

  const succeeded = await provider.getTask('task-1');
  ok(succeeded.status === Status.SUCCEEDED && succeeded.url.endsWith('/video.mp4'), '成功查询拿到直链');

  const listed = await provider.listTasks({ limit: 10 });
  ok(listed.items.length === 1 && listed.items[0].id === 'task-0', '列表响应归一化为统一任务结构');

  const redeemed = await provider.redeemCard('card-local-test');
  ok(redeemed.points === 10 && provider.balance === 109, '卡密兑换同步积分余额');

  const downloaded = await provider.download(succeeded, path.join(tempDir, 'task-1.mp4'));
  ok(downloaded.bytes === Buffer.byteLength('LOCAL-MOCK-MP4'), '成功任务可下载直链文件');

  const deleted = await provider.deleteTask('task-1');
  ok(deleted.ok === true, '删除接口成功');

  let rejectedSeconds = false;
  try { await provider.createTask({ prompt: '错误时长', seconds: 10 }); } catch { rejectedSeconds = true; }
  ok(rejectedSeconds, '非 30 秒在本地被拒绝');

  let rejectedPrompt = false;
  try { await provider.createTask({ prompt: 'a'.repeat(3001) }); } catch { rejectedPrompt = true; }
  ok(rejectedPrompt, '超过 3000 Unicode 字符的 prompt 在本地被拒绝');

  let rejectedImage = false;
  try { await provider.createTask({ prompt: '坏图片', images: [Buffer.from('not-an-image')] }); } catch { rejectedImage = true; }
  ok(rejectedImage, '无效参考图在本地被拒绝');
  ok(state.authFailures === 0, '所有 API 请求都带 Bearer Token');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

