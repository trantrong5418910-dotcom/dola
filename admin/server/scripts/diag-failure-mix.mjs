/** 只读：统计最近任务的失败类型分布，确认除了 cookie bug 还有没有别的拦路虎。 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const db = new DatabaseSync(join(ROOT, 'server', 'data', 'admin.db'));

const statusCounts = db.prepare("SELECT status, COUNT(*) n FROM dola_videos GROUP BY status ORDER BY n DESC").all();

const rows = db.prepare(`SELECT id, status, created_at, error, seconds, account_id, account_label
                         FROM dola_videos ORDER BY id DESC LIMIT 60`).all();

const bucket = (e) => {
  const s = String(e || '');
  if (!s) return '(空)';
  if (/Invalid cookie fields/.test(s)) return 'A. cookie 前缀注入失败（Bug 1，已修）';
  if (/710022002|访问频繁|限流/.test(s)) return 'B. 上游限流 710022002（运营/频率问题）';
  if (/未确认已登录的创作页面|VIDEO_PAGE_NOT_READY/.test(s)) return 'C. 创作页未就绪（页面/代理问题）';
  if (/GENERATION_PREFLIGHT|体检/.test(s)) return 'D. 账号体检未过';
  if (/region-restricted|地区限制/.test(s)) return 'E. 地区限制';
  if (/额度|积分不足|402/.test(s)) return 'F. 额度/积分不足';
  return 'G. 其它：' + s.slice(0, 70);
};

const mix = {};
for (const r of rows) {
  if (r.status === 'ready') continue;
  const k = bucket(r.error);
  mix[k] = (mix[k] || 0) + 1;
}

console.log(JSON.stringify({
  statusCounts,
  failedMixLast60: mix,
  latestFailed: rows.filter(r => r.status !== 'ready').slice(0, 5)
    .map(r => ({ id: r.id, at: r.created_at, account: r.account_id, seconds: r.seconds, bucket: bucket(r.error) })),
  lastTaskAt: rows[0]?.created_at,
}, null, 2));
process.exit(0);
