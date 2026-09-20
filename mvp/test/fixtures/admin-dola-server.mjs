/** Isolated UI/API fixture. Never imports admin, dotenv, DB, accounts, or browsers.
 * node mvp/test/fixtures/admin-dola-server.mjs [--synthetic-ready] [--port 8799]
 * Synthetic prompts: normal text, fixture:fail, fixture:pending, fixture:poll-error,
 * fixture:no-media, fixture:redirect, fixture:html. Default gate is CLOSED.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkbenchServer } from '../../src/server.js';
import { createGateway } from '../../src/core/gateway.js';
import { SYNTHETIC_VIDEO } from './synthetic-video.mjs';

export const USER_A = 'fixture-user-a';
export const USER_B = 'fixture-user-b';
export const FIXTURE_KEY = 'fixture-server-only-key';

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
async function listen(server, port = 0) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
}
function video(req, res) {
  const length = SYNTHETIC_VIDEO.length;
  const range = req.headers.range;
  let start = 0; let end = length - 1;
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    start = match ? Number(match[1]) : length;
    end = match?.[2] ? Number(match[2]) : end;
    if (start >= length || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${length}` }); res.end(); return; }
    end = Math.min(end, length - 1);
  }
  res.writeHead(range ? 206 : 200, {
    'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${length}` } : {}),
  });
  res.end(SYNTHETIC_VIDEO.subarray(start, end + 1));
}

export async function startFixture({ gate = false, imagesGate = false, port = 0, nativeFetch = globalThis.fetch, createClient, provider = 'admin-dola' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mvp-isolated-'));
  const state = { tasks: new Map(), points: new Map([[USER_A, 100], [USER_B, 100]]), calls: [], creates: 0, refunds: 0, external: [] };
  let app; let gatewayServer; let externalServer;
  const shutdown = async () => { await close(app); await close(gatewayServer); await close(externalServer); await fs.rm(directory, { recursive: true, force: true }); };
  try {
    externalServer = http.createServer((req, res) => { state.external.push({ url: req.url, headers: req.headers }); video(req, res); });
    const externalUrl = await listen(externalServer);
    gatewayServer = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://fixture.invalid');
        state.calls.push({ method: req.method, path: url.pathname, hasKey: req.headers['x-gateway-key'] === FIXTURE_KEY });
        if (req.headers['x-gateway-key'] !== FIXTURE_KEY) { json(res, 403, { message: 'fixture gateway denied' }); return; }
        const input = req.method === 'POST' ? await body(req) : {};
        if (url.pathname === '/api/gateway/verify' && state.redirectVerify) { res.writeHead(302, { Location: externalUrl + '/auth-redirect' }); res.end(); return; }
        if (url.pathname === '/api/gateway/health') {
          json(res, 200, {
            pointsPerTask: 1,
            supportedSeconds: [10, 15, 20, 30],
            expertSeconds: [15],
            expertSecondsReady: gate,
            fixedSeconds: 30,
            fixedSecondsReady: gate,
            native15: { ready: gate, eligible: gate ? 1 : 0, available: gate ? 1 : 0, unknown: gate ? 0 : 1, unavailable: 0 },
            native30: { ready: gate, eligible: gate ? 1 : 0, available: gate ? 1 : 0, unknown: gate ? 0 : 1, unavailable: 0 },
            referenceImagesReady: imagesGate,
            referenceImages: { ready: imagesGate, eligible: imagesGate ? 1 : 0, available: imagesGate ? 1 : 0, unknown: imagesGate ? 0 : 1, unavailable: 0 },
            generation: { running: 1, queued: 2, concurrency: 3, available: 2, reservedAccounts: 0, byStatus: { queued: 2, submitting: 0, generating: 1, resolving: 0 } },
          });
          return;
        }
        const token = input.token || url.searchParams.get('token');
        if (url.pathname === '/api/gateway/refund') { state.refunds++; json(res, 200, { refunded: true }); return; }
        if (!state.points.has(token)) { json(res, token === 'fixture-disabled' ? 403 : 401, { message: 'fixture token denied' }); return; }
        if (url.pathname === '/api/gateway/verify') { json(res, 200, { tokenId: token === USER_A ? 1 : 2, prefix: token, points: state.points.get(token), name: 'Synthetic user' }); return; }
        if (url.pathname === '/api/gateway/consume') { json(res, 200, { charged: 1, balance: 99 }); return; }
        if (url.pathname === '/api/gateway/gen' && req.method === 'POST') {
          state.creates++;
          state.lastCreate = input;
          if (state.createDelayMs) await new Promise((resolve) => setTimeout(resolve, state.createDelayMs));
          if (![10, 15, 20, 30].includes(input.seconds) || input.forceSeconds !== input.seconds
              || !['standard', 'expert'].includes(input.mode || 'standard')
              || (input.seconds === 15 && input.mode !== 'expert')) { json(res, 400, { message: 'fixture requires a supported native duration and mode' }); return; }
          const id = String(state.creates);
          state.tasks.set(id, { id, token, prompt: input.prompt, ratio: input.ratio, seconds: input.seconds, status: 'queued', polls: 0, created_at: new Date().toISOString(), archived: false });
          state.points.set(token, state.points.get(token) - 1);
          json(res, 202, { taskId: id, balance: state.points.get(token), chargedPoints: 1 }); return;
        }
        const archiveUrl = (task) => task.status === 'ready' && task.archived ? `/api/gateway/gen/${task.id}/file?token=${encodeURIComponent(task.token)}` : null;
        if (url.pathname === '/api/gateway/gen') {
          json(res, 200, { items: [...state.tasks.values()].filter((task) => task.token === token).reverse().map((task) => ({ id: task.id, status: task.status, stage: 'synthetic', prompt: task.prompt, ratio: task.ratio, seconds: task.seconds, duration_sec: task.status === 'ready' ? task.seconds : null, archived: task.archived, url: archiveUrl(task), created_at: task.created_at, is_unwatermarked: true, local_bytes: task.archived ? SYNTHETIC_VIDEO.length : null })) }); return;
        }
        const match = /^\/api\/gateway\/gen\/(\d+)(?:\/(file|cancel))?$/.exec(url.pathname);
        const task = match && state.tasks.get(match[1]);
        if (!task || task.token !== token) { json(res, 404, { message: 'fixture task not found' }); return; }
        if (match[2] === 'file') {
          if (task.status !== 'ready' || !task.archived) { json(res, 409, { message: 'fixture file not ready' }); return; }
          if (task.prompt === 'fixture:redirect') { res.writeHead(302, { Location: externalUrl + '/redirect-target' }); res.end(); return; }
          if (task.prompt === 'fixture:html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<p>not a video</p>'); return; }
          video(req, res); return;
        }
        if (match[2] === 'cancel') { task.status = 'cancelled'; json(res, 200, { refunded: false, message: 'fixture cancelled' }); return; }
        if (task.prompt === 'fixture:poll-error') { json(res, 503, { message: 'fixture polling unavailable' }); return; }
        task.polls++;
        if (!['ready', 'failed', 'cancelled'].includes(task.status)) {
          task.status = task.prompt === 'fixture:pending' ? 'generating' : task.polls < 2 ? 'queued' : task.polls < 3 ? 'generating' : task.prompt === 'fixture:fail' ? 'failed' : 'ready';
          if (task.status === 'failed') { state.points.set(token, state.points.get(token) + 1); task.refunded = true; }
          task.archived = task.status === 'ready' && task.prompt !== 'fixture:no-media';
        }
        json(res, 200, { taskId: task.id, status: task.status, seconds: task.seconds, durationSec: task.status === 'ready' ? task.seconds : null, archived: task.archived, url: archiveUrl(task), createdAt: task.created_at, error: task.status === 'failed' ? 'synthetic generation failure' : null, refunded: Boolean(task.refunded), balance: state.points.get(token), isUnwatermarked: true, done: ['ready', 'failed', 'cancelled'].includes(task.status) });
      } catch { json(res, 500, { message: 'fixture internal failure' }); }
    });
    const gatewayUrl = await listen(gatewayServer);
    const allowed = new Set([gatewayUrl, externalUrl]);
    const isolatedFetch = (input, options) => {
      if (!allowed.has(new URL(input).origin)) throw new Error('FIXTURE_EXTERNAL_NETWORK_BLOCKED');
      if (options?.redirect !== 'error') throw new Error('FIXTURE_REDIRECTS_MUST_BE_BLOCKED');
      return nativeFetch(input, options);
    };
    const gateway = createGateway({ url: gatewayUrl, key: FIXTURE_KEY, fetchImpl: isolatedFetch });
    const ledgerFile = path.join(directory, 'ledger.json');
    app = await createWorkbenchServer({ env: { VIDEO_PROVIDER: provider, ADMIN_DOLA_FIXED_SECONDS_VERIFIED: gate ? 'true' : 'false' }, gateway, ledgerFile, createClient, logger: { log() {}, error() {} } });
    const url = await listen(app, port);
    return { url, gatewayUrl, externalUrl, directory, ledgerFile, state, gateway, close: shutdown,
      request: (route, options = {}) => {
        const target = new URL(route, url);
        if (target.origin !== url) throw new Error('FIXTURE_EXTERNAL_NETWORK_BLOCKED');
        return nativeFetch(target, { ...options, redirect: 'error' });
      },
    };
  } catch (error) { await shutdown(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const portIndex = process.argv.indexOf('--port');
  const fixture = await startFixture({ gate: process.argv.includes('--synthetic-ready'), port: portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 0 });
  console.log(JSON.stringify({ isolatedFixture: true, url: fixture.url, syntheticToken: USER_A, otherSyntheticToken: USER_B, gate: process.argv.includes('--synthetic-ready') ? 'synthetic-only' : 'closed', notice: 'Only synthetic data. This does not verify or enable real native 30s generation.', prompts: ['normal text', 'fixture:fail', 'fixture:pending', 'fixture:poll-error', 'fixture:no-media', 'fixture:redirect', 'fixture:html'] }, null, 2));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await fixture.close(); process.exit(0); });
}
