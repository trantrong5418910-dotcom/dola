/** node --test mvp/test/admin-dola-isolated.mjs
 * Only ephemeral loopback stubs and synthetic data; never starts admin or a browser.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startFixture, USER_A, USER_B, FIXTURE_KEY } from './fixtures/admin-dola-server.mjs';
import { SYNTHETIC_VIDEO } from './fixtures/synthetic-video.mjs';
import { CREATE_TIMEOUT_MS, createGateway } from '../src/core/gateway.js';
import { isGatewayArchiveUrl } from '../src/core/media-url.js';
import { publicTask } from '../src/core/public-task.js';
import { AdminDolaProvider } from '../src/providers/admin-dola.js';

const nativeFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('NETWORK_BLOCKED: use the isolated fixture'); };
after(() => { globalThis.fetch = nativeFetch; });

async function fixture(t, options = {}) {
  const value = await startFixture({ nativeFetch, gate: true, ...options });
  t.after(() => value.close());
  return value;
}
function headers(token = USER_A) { return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }; }
async function request(f, route, options = {}) {
  const response = await f.request(route, { headers: headers(), ...options });
  return { status: response.status, body: await response.json() };
}
async function create(f, payload = {}) {
  return request(f, '/api/tasks', { method: 'POST', headers: headers(), body: JSON.stringify({ prompt: 'synthetic-only', seconds: 30, ...payload }) });
}
async function ready(f, id) {
  let result;
  for (let i = 0; i < 3; i++) result = await request(f, `/api/tasks/${id}`);
  assert.equal(result.body.status, 'succeeded');
  return result.body;
}
function privateFieldsAbsent(value) {
  const text = JSON.stringify(value);
  for (const secret of [FIXTURE_KEY, USER_A, USER_B, '?token=']) assert.ok(!text.includes(secret), 'no synthetic secret leaked');
  for (const key of ['url', 'raw', 'account', 'cookie', 'cookies', 'local_path', 'watermarkedUrl', 'unwatermarkedUrl']) assert.equal(Object.hasOwn(value, key), false, key);
}

async function ownerSnapshot(f, id) {
  return {
    ledger: await fs.readFile(f.ledgerFile, 'utf8'),
    task: JSON.stringify(f.state.tasks.get(id)),
    points: [...f.state.points.values()],
    creates: f.state.creates,
    refunds: f.state.refunds,
  };
}

async function assertOwnerUnchanged(f, id, before) {
  const ledgerText = await fs.readFile(f.ledgerFile, 'utf8');
  // Compare privately: assertion diagnostics must never print stored credentials.
  assert.ok(ledgerText === before.ledger, 'Rejected delete must not rewrite the ownership/hidden ledger');
  assert.ok(JSON.stringify(f.state.tasks.get(id)) === before.task, 'Rejected delete must not mutate the gateway task');
  assert.deepEqual([...f.state.points.values()], before.points);
  assert.equal(f.state.creates, before.creates);
  assert.equal(f.state.refunds, before.refunds);
  const ledger = JSON.parse(ledgerText);
  assert.equal(ledger.tasks[id]?.tokenId, 1);
  assert.equal(Object.hasOwn(ledger.hidden, id), false);
  const status = await request(f, `/api/tasks/${id}`);
  assert.equal(status.status, 200);
  assert.equal(status.body.status, 'succeeded');
  const listing = await request(f, '/api/tasks');
  assert.equal(listing.status, 200);
  assert.ok(listing.body.items.some(task => String(task.id) === String(id)), 'Owner must still see the task');
}

test('gate stays closed: no create, no billing; health declares unsupported images', async (t) => {
  const f = await fixture(t, { gate: false });
  const health = await request(f, '/api/health');
  assert.equal(health.body.fixedSeconds, 30);
  assert.equal(health.body.fixedSecondsReady, false);
  assert.equal(health.body.expertSecondsReady, false);
  assert.equal(health.body.referenceImagesSupported, false);
  assert.deepEqual(health.body.generation, {
    running: 1,
    queued: 2,
    concurrency: 3,
    available: 2,
    reservedAccounts: 0,
    byStatus: { queued: 2, submitting: 0, generating: 1, resolving: 0 },
  });
  const result = await create(f);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'FIXED_DURATION_UNAVAILABLE');
  assert.equal(f.state.creates, 0);
  assert.equal(f.state.points.get(USER_A), 100);
});

test('10s and 20s stay open, while expert mode adds native 15s', async (t) => {
  const f = await fixture(t, { gate: false });
  for (const seconds of [10, 20]) {
    const result = await create(f, { seconds });
    assert.equal(result.status, 202);
    assert.equal(f.state.lastCreate.seconds, seconds);
    assert.equal(f.state.lastCreate.forceSeconds, seconds);
  }
  const standard15 = await create(f, { seconds: 15, mode: 'standard' });
  assert.equal(standard15.status, 400);
  assert.equal(standard15.body.code, 'EXPERT_MODE_REQUIRED');
  const health = await request(f, '/api/health');
  assert.deepEqual(health.body.supportedSeconds, [10, 15, 20, 30]);
  assert.deepEqual(health.body.expertSeconds, [15]);
  assert.equal(health.body.expertSecondsReady, false);
  const blocked15 = await create(f, { seconds: 15, mode: 'expert' });
  assert.equal(blocked15.status, 409);
  assert.equal(blocked15.body.code, 'EXPERT_DURATION_UNAVAILABLE');
  assert.equal(f.state.creates, 2);

  const open = await fixture(t, { gate: true });
  const expert15 = await create(open, { seconds: 15, mode: 'expert' });
  assert.equal(expert15.status, 202);
  assert.equal(open.state.lastCreate.seconds, 15);
  assert.equal(open.state.lastCreate.mode, 'expert');
  assert.equal((await request(open, '/api/health')).body.expertSecondsReady, true);
});

test('unsupported references are rejected before gateway create', async (t) => {
  const f = await fixture(t); // duration gate open, imagesGate still closed
  assert.equal((await request(f, '/api/health')).body.referenceImagesSupported, false);
  const rejected = await create(f, { images: [{ name: 'synthetic.png', dataBase64: 'c3ludGhldGlj' }] });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, 'REFERENCE_IMAGES_UNSUPPORTED');
  assert.equal((await create(f, { images: {} })).status, 400);
  assert.equal(f.state.creates, 0);
  const provider = new AdminDolaProvider({ gateway: f.gateway });
  await provider.login(USER_A);
  await assert.rejects(provider.createTask({ prompt: 'synthetic', seconds: 15 }), /专家模式/);
  await provider.createTask({ prompt: 'synthetic', seconds: 15, mode: 'expert' });
  await assert.rejects(provider.createTask({ prompt: 'synthetic', images: ['synthetic'] }), { code: 'REFERENCE_IMAGES_UNSUPPORTED' });
  assert.equal(f.state.creates, 1);
});

test('when referenceImagesReady, images are forwarded and charged only after gateway accepts', async (t) => {
  const f = await fixture(t, { imagesGate: true });
  assert.equal((await request(f, '/api/health')).body.referenceImagesSupported, true);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const created = await create(f, {
    images: [{ name: 'synthetic.png', dataBase64: png.toString('base64') }],
  });
  assert.equal(created.status, 202);
  assert.equal(f.state.creates, 1);
  assert.equal(f.state.lastCreate.images?.length, 1);
  assert.equal(f.state.lastCreate.images[0].name, 'synthetic.png');
  assert.ok(f.state.lastCreate.images[0].dataBase64);

  const provider = new AdminDolaProvider({ gateway: f.gateway });
  provider.referenceImagesReady = true;
  await provider.login(USER_A);
  await provider.createTask({
    prompt: 'synthetic with image',
    seconds: 10,
    images: [{ name: 'via-provider.png', data: png }],
  });
  assert.equal(f.state.creates, 2);
  assert.equal(f.state.lastCreate.images?.[0]?.name, 'via-provider.png');
});

test('HTTP success: create -> poll -> public list/status -> archive media/download', async (t) => {
  const f = await fixture(t);
  const created = await create(f);
  assert.equal(created.status, 202);
  privateFieldsAbsent(created.body);
  const id = created.body.taskId;
  assert.equal(f.state.lastCreate.seconds, 30);
  assert.equal(f.state.lastCreate.forceSeconds, 30);
  assert.equal(f.state.lastCreate.token, USER_A);
  assert.equal((await request(f, `/api/tasks/${id}`)).body.status, 'queued');
  assert.equal((await request(f, `/api/tasks/${id}`)).body.status, 'processing');
  const completed = await request(f, `/api/tasks/${id}`);
  assert.equal(completed.body.status, 'succeeded');
  assert.equal(completed.body.durationSec, 30);
  assert.equal(completed.body.mediaReady, true);
  assert.equal(completed.body.archived, true);
  privateFieldsAbsent(completed.body);
  const list = await request(f, '/api/tasks');
  assert.equal(list.body.items[0].archived, true);
  assert.equal(list.body.items[0].durationSec, 30);
  privateFieldsAbsent(list.body.items[0]);
  for (const mode of ['media', 'download']) {
    const response = await f.request(`/api/tasks/${id}/${mode}`, { headers: headers() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), SYNTHETIC_VIDEO);
    if (mode === 'download') assert.match(response.headers.get('content-disposition'), /attachment; filename="1-nowatermark.mp4"/);
    assert.equal(response.headers.get('x-gateway-key'), null);
  }
  assert.equal((await request(f, '/api/balance')).body.balance, 99);
  const ledger = JSON.parse(await fs.readFile(f.ledgerFile, 'utf8'));
  assert.equal(ledger.tasks[id].tokenId, 1);
  assert.equal(f.state.calls.filter((call) => call.path.endsWith('/file')).every((call) => call.hasKey), true);
});

test('auth and owner isolation cover list, status, media, download and cancel', async (t) => {
  const f = await fixture(t);
  assert.equal((await request(f, '/api/tasks', { headers: {} })).status, 401);
  assert.equal((await request(f, '/api/tasks', { headers: headers('fixture-disabled') })).status, 403);
  assert.equal((await request(f, '/api/session', { method: 'POST', body: JSON.stringify({ credential: 'invalid-synthetic' }) })).status, 401);
  const { body: created } = await create(f);
  await ready(f, created.taskId);
  assert.deepEqual((await request(f, '/api/tasks', { headers: headers(USER_B) })).body.items, []);
  for (const suffix of ['', '/media', '/download']) {
    assert.equal((await request(f, `/api/tasks/${created.taskId}${suffix}`, { headers: headers(USER_B) })).status, 404);
  }
  const before = await ownerSnapshot(f, created.taskId);
  assert.equal((await request(f, `/api/tasks/${created.taskId}`, { method: 'DELETE', headers: headers(USER_B) })).status, 404);
  await assertOwnerUnchanged(f, created.taskId, before);
});

test('admin-dola cancel auth, gateway and timeout errors never forget or hide owner state', async (t) => {
  for (const [name, status, code] of [
    ['unauthorized', 401], ['forbidden', 403], ['gateway-unavailable', 503],
    ['timeout', 504, 'GATEWAY_TIMEOUT'], ['transport-error', undefined],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      const { body: created } = await create(f);
      await ready(f, created.taskId);
      const before = await ownerSnapshot(f, created.taskId);
      const cancel = t.mock.method(f.gateway.generation, 'cancel', async ({ token, taskId }) => {
        assert.ok(token === USER_A, 'Cancellation must use the requesting owner identity');
        assert.equal(taskId, created.taskId);
        throw Object.assign(new Error('Synthetic cancel failure'), { status, code });
      });
      const result = await request(f, `/api/tasks/${created.taskId}`, { method: 'DELETE' });
      assert.equal(result.status, status ?? 500);
      assert.equal(result.body.ok, false);
      assert.equal(cancel.mock.callCount(), 1, 'Do not retry ambiguous cancellation');
      await assertOwnerUnchanged(f, created.taskId, before);
    });
  }
});

test('successful owner cancellation still hides only the requested task', async (t) => {
  const f = await fixture(t);
  const { body: created } = await create(f);
  const { body: other } = await create(f);
  await ready(f, created.taskId);
  const result = await request(f, `/api/tasks/${created.taskId}`, { method: 'DELETE' });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(f.state.tasks.get(created.taskId).status, 'cancelled');
  const ledger = JSON.parse(await fs.readFile(f.ledgerFile, 'utf8'));
  assert.equal(Object.hasOwn(ledger.tasks, created.taskId), false);
  assert.equal(Object.hasOwn(ledger.hidden, created.taskId), true);
  assert.equal(ledger.tasks[other.taskId]?.tokenId, 1);
  assert.equal(Object.hasOwn(ledger.hidden, other.taskId), false);
  assert.equal((await request(f, `/api/tasks/${created.taskId}`)).status, 404);
  const listing = await request(f, '/api/tasks');
  assert.deepEqual(listing.body.items.map(task => String(task.id)), [other.taskId]);
});

test('legacy provider delete errors preserve the existing local-hide behavior', async (t) => {
  const f = await fixture(t, { provider: 'mock', createClient: () => ({
    login: async () => {}, getBalance: async () => 100,
    createTask: async () => ({ taskId: 'synthetic-legacy-delete' }),
    deleteTask: async () => { throw new Error('Synthetic legacy delete unavailable'); },
  }) });
  const { body: created } = await create(f);
  const result = await request(f, `/api/tasks/${created.taskId}`, { method: 'DELETE' });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  const ledger = JSON.parse(await fs.readFile(f.ledgerFile, 'utf8'));
  assert.equal(Object.hasOwn(ledger.tasks, created.taskId), false);
  assert.equal(Object.hasOwn(ledger.hidden, created.taskId), true);
});

test('confirmed failed wait is explicit; admin remains billing authority', async (t) => {
  const f = await fixture(t);
  const result = await create(f, { prompt: 'fixture:fail', wait: true, intervalMs: 1, timeoutMs: 1000 });
  assert.equal(result.status, 200);
  assert.equal(result.body.failed, true);
  assert.equal(result.body.task.status, 'failed');
  assert.equal(result.body.refunded, true);
  privateFieldsAbsent(result.body.task);
  assert.equal(result.body.balance, 100);
  assert.equal(f.state.refunds, 0);
  assert.equal((await request(f, `/api/tasks/${result.body.taskId}/media`)).status, 409);
});

test('local wait timeout is pending, never failure/refund/re-submission', async (t) => {
  const f = await fixture(t);
  const result = await create(f, { prompt: 'fixture:pending', wait: true, intervalMs: 1, timeoutMs: 5 });
  assert.equal(result.body.waiting, true);
  assert.equal(result.body.waitTimedOut, true);
  assert.notEqual(result.body.failed, true);
  assert.equal(f.state.creates, 1);
  assert.equal(f.state.refunds, 0);
  assert.equal(f.state.points.get(USER_A), 99);
});

test('ready without archive, HTML media, and redirects fail closed', async (t) => {
  const f = await fixture(t);
  for (const [prompt, expected] of [['fixture:no-media', 409], ['fixture:html', 502], ['fixture:redirect', 502]]) {
    const { body: created } = await create(f, { prompt });
    const task = await ready(f, created.taskId);
    if (prompt === 'fixture:no-media') assert.equal(task.mediaReady, false);
    const result = await request(f, `/api/tasks/${created.taskId}/media`);
    assert.equal(result.status, expected);
    privateFieldsAbsent(result.body);
  }
  assert.equal(f.state.external.length, 0, 'redirect target was never contacted');
  f.state.redirectVerify = true;
  await assert.rejects(f.gateway.verify(USER_A));
  assert.equal(f.state.external.length, 0, 'authenticated API redirects are also blocked');
});

test('precise archive origin/path, no public key, external media has no secret', async (t) => {
  const f = await fixture(t);
  assert.equal(Object.hasOwn(f.gateway, 'key'), false);
  const good = f.gatewayUrl + '/api/gateway/gen/1/file?token=synthetic';
  assert.equal(isGatewayArchiveUrl(good, f.gatewayUrl), true);
  for (const url of [f.gatewayUrl + '/other', f.gatewayUrl + '/api/gateway/gen/1/file/extra', f.gatewayUrl + '/api/gateway/gen/a%2Fb/file', f.gatewayUrl + '@evil.invalid/api/gateway/gen/1/file', 'https://gateway.invalid.evil.invalid/api/gateway/gen/1/file']) {
    assert.equal(isGatewayArchiveUrl(url, f.gatewayUrl), false);
  }
  const before = f.state.calls.length;
  await assert.rejects(f.gateway.fetchMedia(f.gatewayUrl + '/other'));
  await assert.rejects(f.gateway.fetchMedia(f.gatewayUrl + '@evil.invalid/media'));
  assert.equal(f.state.calls.length, before);
  const media = await f.gateway.fetchMedia(f.externalUrl + '/clip.mp4', { range: 'bytes=0-15' });
  assert.equal(media.status, 206);
  assert.equal((await media.arrayBuffer()).byteLength, 16);
  assert.equal(f.state.external[0].headers['x-gateway-key'], undefined);
  assert.equal(f.state.external[0].headers.authorization, undefined);
  assert.equal(f.state.external[0].headers.cookie, undefined);
});

test('archive byte ranges and provider download use the enclosed secret', async (t) => {
  const f = await fixture(t);
  const { body: created } = await create(f);
  await ready(f, created.taskId);
  const range = await f.request(`/api/tasks/${created.taskId}/media`, { headers: { ...headers(), Range: 'bytes=0-31' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-31/${SYNTHETIC_VIDEO.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), SYNTHETIC_VIDEO.subarray(0, 32));
  const p = new AdminDolaProvider({ gateway: f.gateway });
  await p.login(USER_A);
  const result = await p.download(created.taskId, path.join(f.directory, 'synthetic.mp4'));
  assert.equal(result.bytes, SYNTHETIC_VIDEO.length);
});

test('create uses its own longer deadline; timeout is ambiguous and is never retried', async (t) => {
  const f = await fixture(t);
  assert.ok(CREATE_TIMEOUT_MS > 3 * 15_000);
  const guardedFetch = (url, options) => {
    assert.equal(new URL(url).origin, f.gatewayUrl);
    assert.equal(options.redirect, 'error');
    return nativeFetch(url, options);
  };
  f.state.createDelayMs = 40;
  const long = createGateway({ url: f.gatewayUrl, key: FIXTURE_KEY, timeout: 5, createTimeout: 1000, fetchImpl: guardedFetch });
  await long.generation.create({ token: USER_A, prompt: 'synthetic', seconds: 30, forceSeconds: 30 });
  assert.equal(f.state.creates, 1);
  const short = createGateway({ url: f.gatewayUrl, key: FIXTURE_KEY, createTimeout: 10, fetchImpl: guardedFetch });
  await assert.rejects(short.generation.create({ token: USER_A, prompt: 'synthetic', seconds: 30, forceSeconds: 30 }), { code: 'GATEWAY_CREATE_TIMEOUT', status: 504 });
  assert.equal(f.state.creates, 2);
});

test('frontend create timeout outlasts the gateway creation budget', async () => {
  const source = await fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  // Read the exact create call without executing the page or making a request.
  const calls = [...source.matchAll(/\bapi\(\s*(['"])\/api\/tasks\1\s*,\s*\{([^{}]*)/g)];
  const createCalls = calls.filter(([, , options]) => /\bmethod\s*:\s*(['"])POST\1/.test(options));
  // 前端有**两处** POST /api/tasks：单条创建（创作页）与批量创建（批量弹窗）。
  // 早先这里断言 `length === 1`，于是被误判成「重复提交」——其实两条路径都要各自
  // 满足同一个约束，所以改成「每一处都必须带一个比网关预算更长的显式 deadline」。
  assert.ok(createCalls.length >= 1, 'Locate the frontend POST /api/tasks requests');
  for (const [, , options] of createCalls) {
    const match = /\btimeoutMs\s*:\s*([\d_]+)\b/.exec(options);
    assert.ok(match, `Frontend create must set an explicit numeric deadline: ${options.trim()}`);
    const frontendTimeout = Number(match[1].replaceAll('_', ''));
    assert.ok(frontendTimeout > CREATE_TIMEOUT_MS,
      `Frontend create budget (${frontendTimeout}ms) must exceed gateway budget (${CREATE_TIMEOUT_MS}ms)`);
  }
});

test('legacy wait only refunds a confirmed terminal failure, not local errors', async (t) => {
  for (const mode of ['failed', 'timeout', 'query-error']) {
    await t.test(mode, async (t) => {
      const f = await fixture(t, { provider: 'mock', createClient: () => ({ login: async () => {}, getBalance: async () => 100,
        createTask: async () => ({ taskId: 'synthetic-legacy' }),
        waitFor: async () => {
          if (mode === 'failed') return { id: 'synthetic-legacy', status: 'failed', error: 'synthetic failure' };
          throw Object.assign(new Error('synthetic local error'), { name: mode === 'timeout' ? 'TimeoutError' : 'Error' });
        },
      }) });
      const result = await create(f, { wait: true });
      assert.equal(f.state.refunds, mode === 'failed' ? 1 : 0);
      assert.equal(Boolean(result.body.failed), mode === 'failed');
      assert.equal(Boolean(result.body.waiting), mode !== 'failed');
    });
  }
});

test('public task uses an allowlist, even when upstream adds credential fields', () => {
  const result = publicTask({ id: 'synthetic', status: 'succeeded', url: '/file?token=synthetic', raw: { cookie: 'synthetic' }, account: 'synthetic', local_path: '/synthetic', cookies: [], durationSec: 30, archived: true, stage: { token: 'synthetic' } });
  privateFieldsAbsent(result);
  assert.equal(result.mediaReady, true);
  assert.equal(result.durationSec, 30);
  assert.equal(Object.hasOwn(result, 'stage'), false);
});
