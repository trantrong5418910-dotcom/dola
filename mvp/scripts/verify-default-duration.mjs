/**
 * 零成本验证：拿线上 /api/health 的真实数据 + 线上 index.html 里的**原样**判定函数，
 * 算一遍各个时长下「创建视频任务」按钮是不是可点。
 * 不发任务、不扣积分、不登录。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, '..', 'web', 'index.html'), 'utf8');

// 抽出 supportedSeconds / expertSeconds / availableSeconds / secondsFromPlan /
// activeSeconds / durationReady 六个函数的**源码原文**，避免手抄走样。
const start = html.indexOf('function supportedSeconds()');
const endMark = 'function generationQueueNotice()';
const end = html.indexOf(endMark);
if (start < 0 || end < 0 || end < start) throw new Error('没定位到判定函数区块');
const block = html.slice(start, end);

const health = await (await fetch('https://api.fei85.cn/api/health')).json();

const DEFAULT_SECONDS = Number(/const DEFAULT_SECONDS = (\d+)/.exec(html)?.[1] ?? NaN);
const FALLBACK_SECONDS = [30];
const FALLBACK_EXPERT_SECONDS = [];
const durationPlanInit = /durationPlan: '([^']+)'/.exec(html)?.[1];
const state = { health, seconds: DEFAULT_SECONDS, durationPlan: durationPlanInit };

const fn = new Function('state', 'DEFAULT_SECONDS', 'FALLBACK_SECONDS', 'FALLBACK_EXPERT_SECONDS',
  block + '\n return { supportedSeconds, availableSeconds, activeSeconds, durationReady, secondsFromPlan };');
const api = fn(state, DEFAULT_SECONDS, FALLBACK_SECONDS, FALLBACK_EXPERT_SECONDS);

const rows = ['10', '15', '20', '30', '15x2'].map((plan) => {
  state.durationPlan = plan;
  state.seconds = api.secondsFromPlan(plan);
  return { plan, seconds: api.activeSeconds(), 按钮可点: api.durationReady() };
});

// 页面刚打开时的初始状态
state.durationPlan = durationPlanInit;
state.seconds = DEFAULT_SECONDS;

console.log(JSON.stringify({
  served: { DEFAULT_SECONDS, durationPlanInit },
  health: {
    supportedSeconds: health.supportedSeconds,
    expertSecondsReady: health.expertSecondsReady,
    fixedSecondsReady: health.fixedSecondsReady,
  },
  打开页面时默认: { durationPlan: durationPlanInit, seconds: api.activeSeconds(), 按钮可点: api.durationReady() },
  各时长: rows,
}, null, 2));
