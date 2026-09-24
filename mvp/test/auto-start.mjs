/**
 * 守护 `shouldAutoStart()` —— 防止「PM2 下静默不 listen」这个线上事故复发。
 *
 * 背景：PM2 fork 模式会把 `process.argv[1]` 换成它自己的容器脚本
 * （`.../pm2/lib/ProcessContainerFork.js`），导致只看 argv[1] 的
 * "我是不是主模块"判断永远为假 —— 启动块被跳过，进程 online 却永不 listen。
 *
 * 跑：node --test test/auto-start.mjs   （或 npm run test:auto-start）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldAutoStart } from '../src/server.js';

const MODULE_URL = 'file:///www/wwwroot/dola.fei85.cn/mvp/src/server.js';
const SELF = '/www/wwwroot/dola.fei85.cn/mvp/src/server.js';
const PM2_CONTAINER = '/usr/local/node22/lib/node_modules/pm2/lib/ProcessContainerFork.js';

test('★ PM2 下 argv[1] 指向 PM2 容器时，仍然必须启动（回归本次线上故障）', () => {
  assert.equal(
    shouldAutoStart({ argv1: PM2_CONTAINER, moduleUrl: MODULE_URL, env: { pm_id: '0' } }),
    true,
  );
});

test('PM2 的 cluster 模式（pm_id 非 0）同样要启动', () => {
  assert.equal(
    shouldAutoStart({ argv1: PM2_CONTAINER, moduleUrl: MODULE_URL, env: { pm_id: '3' } }),
    true,
  );
});

test('直接 node src/server.js 要启动', () => {
  assert.equal(shouldAutoStart({ argv1: SELF, moduleUrl: MODULE_URL, env: {} }), true);
});

test('被测试 import 时绝不启动（argv[1] 是测试文件）', () => {
  assert.equal(
    shouldAutoStart({ argv1: '/x/mvp/test/auto-start.mjs', moduleUrl: MODULE_URL, env: {} }),
    false,
  );
});

test('没有 argv[1] 且不在 PM2 下，不启动', () => {
  assert.equal(shouldAutoStart({ argv1: undefined, moduleUrl: MODULE_URL, env: {} }), false);
});

test('pm_id 为空字符串不算 PM2（别把空值当"在 PM2 下"）', () => {
  assert.equal(
    shouldAutoStart({ argv1: '/x/other.js', moduleUrl: MODULE_URL, env: { pm_id: '' } }),
    false,
  );
});
