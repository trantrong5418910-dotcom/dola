/**
 * 只读诊断：不走浏览器，直接用每个账号自己的代理打一次 dola 落地页，
 * 看返回的是正常聊天页、还是被地区限制 / 风控页。
 *
 * 用途：区分「代理出口 IP 被封」和「代码探测逻辑有问题」。
 * 不写库、不提交、不登录。
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const IDS = process.argv.slice(2).map(Number).filter(Boolean);

const { proxyUrlOf } = await import('../dola/proxy.js');
const { fetchVia } = await import('../dola/proxy.js');

const db = new DatabaseSync(join(ROOT, 'server', 'data', 'admin.db'));
const rows = IDS.length
  ? IDS.map(id => db.prepare('SELECT id,label,proxy,exit_ip,status,native_15s_state FROM dola_accounts WHERE id=?').get(id))
  : db.prepare('SELECT id,label,proxy,exit_ip,status,native_15s_state FROM dola_accounts WHERE proxy IS NOT NULL AND proxy <> ""').all();

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

for (const acc of rows) {
  if (!acc) { console.log(JSON.stringify({ id: '?', error: 'not found' })); continue; }
  const proxyUrl = proxyUrlOf(acc);
  const rec = {
    id: acc.id,
    label: acc.label,
    status: acc.status,
    native_15s_state: acc.native_15s_state,
    exitIp: acc.exit_ip || null,
    proxyHost: (() => { try { return new URL(proxyUrl).host; } catch { return null; } })(),
  };
  if (!proxyUrl) { console.log(JSON.stringify({ ...rec, error: '无代理' })); continue; }
  const started = Date.now();
  try {
    const res = await fetchVia('https://www.dola.com/chat/', {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    }, proxyUrl);
    const body = await res.text();
    const title = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim().slice(0, 80);
    rec.http = res.status;
    rec.finalUrl = String(res.url || '').slice(0, 120);
    rec.ms = Date.now() - started;
    rec.title = title;
    rec.regionRestricted = /region-restricted|region_restricted/i.test(String(res.url || '')) || /region-restricted/i.test(body);
    rec.riskControl = /访问频繁|risk|blocked|captcha|验证/i.test(body);
    rec.englishFallback = /How can I assist you today|New Chat/i.test(body);
    rec.chineseOk = /有什么我能帮你的吗|视频生成/.test(body);
    rec.bodyLen = body.length;
  } catch (e) {
    rec.error = String(e?.message || e).slice(0, 160);
    rec.ms = Date.now() - started;
  }
  console.log(JSON.stringify(rec));
}
process.exit(0);
