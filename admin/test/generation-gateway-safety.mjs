import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { SUBMISSION_JOURNAL_SCHEMA, findUnsettledPrompt } from '../server/dola/submission-journal.js';
import { settleFailedVideoRefund } from '../server/dola/generation-billing.js';

const source = readFileSync(new URL('../server/routes/gateway.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export default router;?/m, '').replace(/\bexport /g, '');
function fixture(t) {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE dola_videos(id INTEGER PRIMARY KEY,status,owner_token_id,charge_ref,conversation_id,prompt,created_at);
    CREATE TABLE tokens(id INTEGER PRIMARY KEY,points,updated_at);
    CREATE TABLE point_transactions(id INTEGER PRIMARY KEY,token_id,token_prefix,kind,delta,ref,reason,created_at);
    INSERT INTO tokens VALUES(1,4,NULL);
    INSERT INTO dola_videos VALUES(1,'submitting',1,'gen-1',NULL,'synthetic  prompt','2020-01-01');
    INSERT INTO point_transactions(token_id,token_prefix,kind,delta,ref) VALUES(1,'fixture','consume',1,'gen-1');`);
  db.exec(SUBMISSION_JOURNAL_SCHEMA);
  const handlers = new Map();
  const box = { db, Date, findUnsettledPrompt, settleFailedVideoRefund,
    express: { Router: () => ({ use() {}, get() {}, post: (path, fn) => handlers.set(path, fn) }) },
    getSetting: (key, fallback) => key === 'gateway_prompt_cooldown_seconds' ? '0' : fallback,
    // ⚠️ 本测试会剥掉 gateway.js 的所有 import 行，所以那边每加一个 import
    //    都得在这里补一个同名绑定。本用例只调 /refund，这些绑定暂时用不到，
    //    但**必须存在**：一旦将来有人把这几个函数挪到顶层执行，缺绑定就会炸。
    quotaView: () => ({ limit: 0, used: 0, remaining: null, ok: true, reason: 'unlimited', day: '1970-01-01', limitSource: 'none' }),
    usageSnapshot: () => ({ limit: 0, used: 0, remaining: null, ok: true, reason: 'unlimited', day: '1970-01-01', limitSource: 'none' }),
    resolveTaskPoints: () => ({ points: 1, source: 'setting', key: 'gateway_points_per_task', costsReason: 'n/a' }),
    parseModelCosts: () => ({ ok: true, costs: {}, reason: 'empty' }),
    QUOTA_SETTING_KEYS: { defaultPoints: 'gateway_points_per_task', modelCosts: 'gateway_model_costs', dailyLimit: 'gateway_daily_points_limit' },
    switchView: () => ({ key: 'gateway_enabled', enabled: true, scope_enabled: true, effective_enabled: true, scope: 'v1', configuredScope: 'all', reasons: [] }),
    SWITCH_KEYS: { gateway: 'gateway_enabled', promptWrap: 'gateway_prompt_wrap_enabled' },
    readinessSummary: () => ({ grade: 'degraded', reasons: [], at: '1970-01-01T00:00:00.000Z' }),
  };
  vm.createContext(box); vm.runInContext(source, box);
  const invokeRefund = () => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    handlers.get('/refund')({ body: { ref: 'gen-1', note: 'client timeout' } }, res);
    return res;
  };
  return { db, box, invokeRefund };
}

for (const state of ['queued', 'submitting', 'generating', 'resolving', 'ready', 'cancelled']) {
  test(`generic refund endpoint cannot refund ${state} video based on a client timeout`, t => {
    const h = fixture(t); h.db.prepare('UPDATE dola_videos SET status=?').run(state);
    const r = h.invokeRefund();
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'GENERATION_REFUND_UNCONFIRMED');
    assert.equal(h.db.prepare('SELECT points FROM tokens').get().points, 4);
    assert.equal(h.db.prepare('SELECT count(*) n FROM point_transactions').get().n, 1);
  });
}

test('confirmed failure still refunds exactly once, without an additional charge', t => {
  const h = fixture(t); h.db.exec("UPDATE dola_videos SET status='failed'");
  assert.equal(h.invokeRefund().statusCode, 200);
  assert.equal(h.invokeRefund().body.duplicated, true);
  assert.equal(h.db.prepare('SELECT points FROM tokens').get().points, 5);
  assert.equal(h.db.prepare('SELECT count(*) n FROM point_transactions').get().n, 2);
});

test('pending prompt protection survives ordinary cooldown expiry or disabling that setting', t => {
  const h = fixture(t);
  h.db.prepare("INSERT INTO dola_submission_journal(task_id,account_id,state,updated_at) VALUES(1,1,'uncertain',?)")
    .run('2020-01-01');
  const result = h.box.findRecentPromptDuplicate(1, ' synthetic\nprompt ');
  assert.equal(result.id, 1); assert.equal(result.requiresReconciliation, true);
  assert.equal(result.retryAfterSeconds, null);
  assert.equal(h.box.findRecentPromptDuplicate(2, 'synthetic prompt'), null);
  assert.equal(h.box.findRecentPromptDuplicate(1, 'different prompt'), null);
});
