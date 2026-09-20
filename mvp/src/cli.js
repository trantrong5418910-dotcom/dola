#!/usr/bin/env node
/**
 * 命令行入口。
 *
 *   node src/cli.js providers
 *   node src/cli.js balance
 *   node src/cli.js create --prompt "一只橘猫在窗台上晒太阳" --wait --download ./out
 *   node src/cli.js status <task_id>
 *   node src/cli.js list
 *   node src/cli.js download <task_id> --out ./out
 *
 * 全局选项：
 *   --provider <name>      dola-workbench | dola-api | mock（默认取 VIDEO_PROVIDER，再默认 mock）
 *   --base-url <url>
 *   --credential <token>   也可放 .env 的 DOLA_CREDENTIAL / DOLA_API_TOKEN
 *   --timeout <秒>         等待总时长
 *   --interval <秒>        轮询间隔
 *   --json                 机器可读输出
 *   --verbose              打印每个 HTTP 请求
 */
import { loadEnv } from './core/env.js';
import { VideoClient } from './client.js';
import { listProviders } from './providers/index.js';
import { STATUS_LABEL_ZH } from './core/task.js';

loadEnv();

function parseArgv(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out.flags[key] = true;
    else { out.flags[key] = next; i++; }
  }
  return out;
}

const { _: positional, flags } = parseArgv(process.argv.slice(2));
const cmd = positional[0] || 'help';
const JSON_OUT = Boolean(flags.json);
const VERBOSE = Boolean(flags.verbose);

function out(obj) {
  if (JSON_OUT) console.log(JSON.stringify(obj, null, 2));
  else console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

function buildClient() {
  const provider = flags.provider || process.env.VIDEO_PROVIDER || 'mock';
  const opts = {
    ...(flags['base-url'] ? { baseUrl: flags['base-url'] } : {}),
    ...(flags.credential ? { credential: flags.credential } : {}),
    timeout: Number(flags['http-timeout'] || (provider === 'dola-api' ? 300 : 60)) * 1000,
    ...(VERBOSE ? { onTrace: (e) => console.error('  [http]', e.method || '', e.url || '', e.status ?? '', (e.ms != null ? e.ms + 'ms' : '')) } : {}),
  };
  return new VideoClient({ provider, providerOptions: opts });
}

const USAGE = `
视频任务 MVP —— 创建 → 轮询 → 下载

  providers                       列出可用 provider
  balance                         查积分余额
  create  --prompt "..."          创建任务
             --ratio 16:9         16:9 / 9:16 / 1:1 / 3:4 / 4:3 / 21:9（默认 16:9）
             --image ./a.png      参考图，可重复传，最多 9 张 / 20MiB
             --wait               阻塞等到终态
             --download ./out     完成后下载到该目录
  status  <task_id>               查单个任务
  wait    <task_id>               等已存在的任务到终态（可加 --download）
  list    [--limit 20]            列任务
  download <task_id> --out ./out   下载视频
  redeem  <card_xxx>              卡密兑换积分（dola-workbench / dola-api）

全局： --provider  --base-url  --credential  --timeout  --interval  --json  --verbose
`.trim();

async function main() {
  switch (cmd) {
    case 'help':
      console.log(USAGE);
      return;

    case 'providers':
      out({ available: listProviders(), current: flags.provider || process.env.VIDEO_PROVIDER || 'mock' });
      return;

    case 'balance': {
      const c = buildClient();
      await c.login();
      out({ balance: await c.getBalance(), provider: c.providerName });
      return;
    }

    case 'list': {
      const c = buildClient();
      await c.login();
      const { items } = await c.listTasks({ limit: Number(flags.limit || 20) });
      if (JSON_OUT) out(items);
      else {
        console.log(`任务 ${items.length} 条：`);
        for (const t of items) {
          console.log(`  ${t.id.padEnd(24)} ${STATUS_LABEL_ZH[t.status] ?? t.status}  ${t.error || t.notice || ''}`);
        }
      }
      return;
    }

    case 'status': {
      const id = positional[1];
      if (!id) throw new Error('用法：status <task_id>');
      const c = buildClient();
      await c.login();
      const t = await c.getTask(id);
      if (JSON_OUT) out(t);
      else {
        console.log(`任务 ${t.id}`);
        console.log(`  状态   ${STATUS_LABEL_ZH[t.status] ?? t.status} (${t.statusText ?? '-'})`);
        console.log(`  直链   ${t.url ?? '（暂无）'}`);
        console.log(`  扣积分 ${t.charged ?? '-'}`);
        if (t.error) console.log(`  错误   ${t.error}`);
        if (t.notice) console.log(`  提示   ${t.notice}`);
      }
      return;
    }

    case 'wait': {
      // 等一个已存在的任务到终态（比如上一次 create 超时后接着等）
      const id = positional[1];
      if (!id) throw new Error('用法：wait <task_id>');
      const c = buildClient();
      await c.login();
      const started = Date.now();
      const t = await c.waitFor(id, {
        pollIntervalMs: Number(flags.interval || 30) * 1000,
        timeoutMs: Number(flags.timeout || 3600) * 1000,
        onProgress: (cur) => {
          if (JSON_OUT) return;
          console.log(`  [${((Date.now() - started) / 1000).toFixed(0)}s] ${STATUS_LABEL_ZH[cur.status] ?? cur.status}${cur.notice ? ' · ' + cur.notice : ''}`);
        },
      });
      const result = { taskId: t.id, status: t.status, url: t.url, charged: t.charged };
      if (flags.download) result.downloaded = await c.downloadTo(t, flags.download === true ? '.' : flags.download);
      out(result);
      return;
    }

    case 'download': {
      const id = positional[1];
      if (!id) throw new Error('用法：download <task_id> --out ./out');
      const c = buildClient();
      await c.login();
      const r = await c.downloadTo(id, flags.out || '.');
      out({ ok: true, ...r });
      return;
    }

    case 'redeem': {
      const card = positional[1] || flags.card;
      if (!card) throw new Error('用法：redeem card_xxx');
      const c = buildClient();
      await c.login();
      out(await c.p.redeemCard(card));
      return;
    }

    case 'create': {
      const prompt = flags.prompt || positional[1];
      if (!prompt) throw new Error('必须给 --prompt');
      const images = [];
      if (flags.image) {
        if (Array.isArray(flags.image)) images.push(...flags.image);
        else images.push(flags.image);
      }
      const c = buildClient();
      await c.login();

      const payload = {
        prompt,
        ratio: flags.ratio || '16:9',
        seconds: Number(flags.seconds || 30),
        mode: flags.mode || (Number(flags.seconds || 30) === 15 ? 'expert' : 'standard'),
        images,
      };

      if (!flags.wait) {
        const created = await c.createTask(payload);
        const res = { taskId: created.taskId, createdVia: created.via, raw: created.raw };
        if (JSON_OUT) out(res);
        else console.log(`已提交，task_id = ${created.taskId}（来源：${created.via}）\n下一步：node src/cli.js status ${created.taskId}`);
        return;
      }

      const started = Date.now();
      const t = await c.createAndWait(payload, {
        pollIntervalMs: Number(flags.interval || 30) * 1000,
        timeoutMs: Number(flags.timeout || 3600) * 1000,
        onProgress: (cur, info) => {
          if (JSON_OUT) return;
          const s = ((Date.now() - started) / 1000).toFixed(0);
          console.log(`  [${s}s] 第 ${info.round} 次查询：${STATUS_LABEL_ZH[cur.status] ?? cur.status}${cur.notice ? ' · ' + cur.notice : ''}`);
        },
      });

      const result = { taskId: t.id, status: t.status, url: t.url, charged: t.charged, raw: t.raw };
      if (flags.download) {
        const r = await c.downloadTo(t, flags.download === true ? '.' : flags.download);
        result.downloaded = r;
      }
      if (JSON_OUT) out(result);
      else {
        console.log(`\n✓ 完成 ${t.id}（${STATUS_LABEL_ZH[t.status]}，耗时 ${((Date.now() - started) / 1000).toFixed(0)}s）`);
        console.log(`  直链 ${t.url}`);
        if (result.downloaded) console.log(`  已下载 ${result.downloaded.filePath} (${(result.downloaded.bytes / 1048576).toFixed(2)} MiB)`);
      }
      return;
    }

    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`✗ ${e.name || 'Error'}: ${e.message}`);
  if (e.raw && VERBOSE) console.error('  原始响应:', JSON.stringify(e.raw));
  process.exitCode = 1;
});
