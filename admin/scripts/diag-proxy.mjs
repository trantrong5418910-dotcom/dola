/**
 * 代理连不通的分变量排查。
 *
 *   node scripts/diag-proxy.mjs
 *
 * 现状：TCP 能连上 gate2 的 7778，但发 CONNECT 后**被静默关闭、没有任何回应**。
 * 已知沙箱允许非标端口出站（portquiz.net:7778 通）。所以要换变量找原因。
 */
import net from 'node:net';
import https from 'node:https';
import { ProxyAgent, fetch as uFetch } from 'undici';

const USER_BASE = 'B_102773';
const PASS = 'g3Ro267Rbx';
const SID = 'xaqBg1pe';

/** 用 DoH 拿真实 IP（沙箱 DNS 是 fake-IP，会解析到 198.18.x.x） */
function resolveReal(host) {
  return new Promise((resolve) => {
    https.get({
      host: 'cloudflare-dns.com',
      path: `/dns-query?name=${host}&type=A`,
      headers: { accept: 'application/dns-json' },
    }, (r) => {
      let d = ''; r.on('data', (c) => (d += c));
      r.on('end', () => {
        try { resolve(JSON.parse(d).Answer.filter((a) => a.type === 1).map((a) => a.data)); }
        catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

/** 手工发一次 CONNECT，返回服务端是否给了回应 */
function rawConnect(host, port, target = 'ipinfo.io:443') {
  return new Promise((resolve) => {
    const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');
    const s = net.connect(port, host);
    let buf = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { s.destroy(); } catch { /* ignore */ } resolve(v); } };
    s.setTimeout(12000);
    s.on('connect', () => {
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });
    s.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\r\n')) done(buf.split('\r\n')[0]); });
    s.on('timeout', () => done('(超时无回应)'));
    s.on('error', (e) => done(`(连接错误 ${e.code})`));
    s.on('close', () => done(buf ? buf.split('\r\n')[0] : '(被静默关闭)'));
  });
}

let USER;

const lines = [];
const say = (s) => { console.log(s); lines.push(s); };

say('══ 1. 解析网关真实 IP ══');
const realIps = {};
for (const h of ['gate1.ipweb.cc', 'gate2.ipweb.cc', 'gate3.ipweb.cc']) {
  realIps[h] = await resolveReal(h);
  say(`  ${h} → ${realIps[h].join(', ') || '(解析失败)'}`);
}

say('\n══ 2. 手工 CONNECT（看服务端到底回不回）══');
const combos = [
  { name: 'KR + 指定州/城市', user: `${USER_BASE}_KR_2167_13904_30_${SID}` },
  { name: 'KR 不限州/城市  ', user: `${USER_BASE}_KR___30_${SID}` },
  { name: 'US（对照国家）  ', user: `${USER_BASE}_US___30_${SID}` },
  { name: '000 全球随机    ', user: `${USER_BASE}_000___30_${SID}` },
];
for (const c of combos) {
  USER = c.user;
  for (const h of ['gate1.ipweb.cc', 'gate2.ipweb.cc']) {
    const ip = realIps[h]?.[0];
    if (!ip) continue;
    const r = await rawConnect(ip, 7778);
    say(`  ${c.name} | ${h.split('.')[0]} (${ip}) → ${r}`);
  }
}

say('\n══ 3. 经 undici ProxyAgent 真发一次请求（用真实 IP）══');
USER = `${USER_BASE}_KR___30_${SID}`;
for (const h of ['gate1.ipweb.cc', 'gate2.ipweb.cc']) {
  const ip = realIps[h]?.[0];
  if (!ip) continue;
  const agent = new ProxyAgent({ uri: `http://${USER}:${PASS}@${ip}:7778` });
  try {
    const r = await uFetch('https://ipinfo.io/json', { dispatcher: agent, signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    say(`  ✅ ${h} → 出口 ${j.ip} (${j.country} ${j.city || ''})`);
  } catch (e) {
    say(`  ❌ ${h} → ${e.message}${e.cause?.message ? ' / ' + e.cause.message : ''}`);
  }
}

say('\n══ 4. 同一个 CONNECT 打到 portquiz.net:7778（对照：证明"发 CONNECT 能收到回应"）══');
USER = `${USER_BASE}_KR___30_${SID}`;
const pq = (await resolveReal('portquiz.net'))[0];
if (pq) say(`  portquiz.net (${pq}:7778) → ${await rawConnect(pq, 7778, 'example.com:80')}`);
