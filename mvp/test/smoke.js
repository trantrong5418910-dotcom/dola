/** 冒烟测试：mock provider 全链路 + 归一化 + 错误分支。跑法：npm run smoke（零依赖） */
import { VideoClient } from '../src/client.js';
import { Status } from '../src/core/task.js';
import { MockProvider } from '../src/providers/mock.js';
import { DolaApiProvider } from '../src/providers/dola-api.js';
import { createProvider, listProviders } from '../src/providers/index.js';

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

console.log('— provider 注册 —');
ok(listProviders().includes('dola-workbench'), '注册表包含 dola-workbench');
ok(listProviders().includes('dola-api'), '注册表包含 dola-api');
ok(createProvider('mock') instanceof MockProvider, 'createProvider("mock") 类型正确');
ok(createProvider('dola-api', { credential: 'local-test-token' }) instanceof DolaApiProvider, 'createProvider("dola-api") 类型正确');

console.log('— mock 全链路 —');
{
  const c = new VideoClient({ provider: 'mock', providerOptions: { queueDelayMs: 100, processDelayMs: 400 } });
  await c.login();
  const bal0 = await c.getBalance();
  const t = await c.createAndWait(
    { prompt: '测试任务', ratio: '16:9' },
    { pollIntervalMs: 200, onProgress: null },
  );
  ok(t.status === Status.SUCCEEDED, `终态为 succeeded（实际 ${t.status}）`);
  ok(Boolean(t.id), `拿到 task_id：${t.id}`);
  ok(Boolean(t.url), '成功后有视频 url');
  ok((await c.getBalance()) === bal0 - 10, '余额扣减 10');

  // 空参数应报错而不是创建
  let threw = false;
  try { await c.createTask({ prompt: '  ' }); } catch { threw = true; }
  ok(threw, '空 prompt 被拒绝');

  // 失败分支
  const c2 = new VideoClient({ provider: 'mock', providerOptions: { queueDelayMs: 50, processDelayMs: 100, failRate: 1 } });
  await c2.login();
  let failed = false;
  try { await c2.createAndWait({ prompt: '必失败' }, { pollIntervalMs: 150 }); } catch (e) { failed = e.name === 'TaskFailedError'; }
  ok(failed, '失败任务抛 TaskFailedError');

  // 未知 provider
  let cfgErr = false;
  try { createProvider('nope'); } catch (e) { cfgErr = e.name === 'ConfigError'; }
  ok(cfgErr, '未知 provider 抛 ConfigError');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
