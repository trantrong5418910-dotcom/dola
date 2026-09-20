/**
 * 本地 SOCKS5 中转桥的自测。
 *
 *   node scripts/test-socks-bridge.mjs --proxy "socks5://user:pass@gate2.ipweb.cc:7778"
 *
 * 为什么需要这个桥：Chromium/Playwright **不支持带认证的 SOCKS5**
 * （报 `Browser does not support socks5 proxy authentication`），
 * 而 IPWeb 的网关实测只认 SOCKS5。桥的作用是把认证在本地做掉，
 * 给浏览器一个"无认证的本地 HTTP 代理"。
 */
import { startSocksBridge } from '../server/dola/socks-bridge.js';
import { ProxyAgent, fetch as uFetch } from 'undici';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const PROXY = flag('proxy');
if (!PROXY) { console.error('用法：node scripts/test-socks-bridge.mjs --proxy "socks5://user:pass@host:port"'); process.exit(2); }

console.log('上游 SOCKS5：', String(PROXY).replace(/\/\/([^:]+):[^@]+@/, '//$1:***@'));

const bridge = await startSocksBridge(PROXY);
console.log(`本地桥已起：${bridge.url}（无认证）\n`);

// 用 HTTP 代理方式（无认证）经桥访问 —— 等价于浏览器会走的路径
try {
  const r = await uFetch('https://ipinfo.io/json', {
    dispatcher: new ProxyAgent({ uri: bridge.url }),
    signal: AbortSignal.timeout(25000),
  });
  const j = await r.json();
  console.log('✅ 经桥访问成功');
  console.log(`   出口 IP : ${j.ip}`);
  console.log(`   地区    : ${j.country} ${j.region || ''} ${j.city || ''}`);
  console.log(`   运营商  : ${j.org}`);
  console.log(`   隧道数  : ${bridge.stats.tunnels}`);
  if (bridge.stats.errors.length) console.log(`   桥内错误: ${bridge.stats.errors.join(' / ')}`);
} catch (e) {
  console.log('❌ 经桥访问失败：', e.message, e.cause?.message ? `/ ${e.cause.message}` : '');
  if (bridge.stats.errors.length) console.log('   桥内错误：', bridge.stats.errors.join(' / '));
}

await bridge.close();
process.exit(0);
