/** 直接查 dola 会话消息链，看那条 2.0 Fast 请求到底出了什么（只读） */
import fs from 'node:fs';
import { parseCookies, dolaFetch } from './provider.js';

const cfIdx = process.argv.indexOf('--cookie-file');
const cf = cfIdx >= 0 ? process.argv[cfIdx + 1] : process.env.DOLA_COOKIE_FILE;
if (!cf) { console.error('用法：node server/dola/read-conv.mjs <conversationId> --cookie-file ./cookies.json'); process.exit(2); }
const ck = parseCookies(fs.readFileSync(cf, 'utf8'));
const CONV = process.argv[2] || '38417915089992209';

const r = await dolaFetch('/im/chain/single', {
  cookies: ck,
  body: {
    cmd: 3100,
    uplink_body: {
      pull_singe_chain_uplink_body: {
        conversation_id: CONV, anchor_index: 0, conversation_type: 3,
        direction: 1, limit: 40, ext: {}, filter: { index_list: [] },
        evaluate_ab_params: '', evaluate_common_params: '',
      },
    },
    sequence_id: 'probe-' + Date.now(), channel: 2, version: '1',
  },
  query: { region: 'JP', sys_region: 'JP' },
});

console.log('HTTP', r.status, 'len', r.text.length);
fs.writeFileSync(process.cwd() + '/dola-chain.json', JSON.stringify(r.json, null, 2));
if (!r.json?.downlink_body) { console.log('无 downlink_body:', r.text.slice(0, 300)); process.exit(0); }

const t = r.text;
// 找视频直链
const vids = [...new Set([...t.matchAll(/https?:\\?\/\\?\/[^"\\ ]{20,200}?\.(?:mp4|mov|webm)[^"\\ ]{0,120}/gi)].map((m) => m[0].replace(/\\\//g, '/')))];
console.log('\n=== 视频直链 ===');
if (!vids.length) console.log('  （无）');
for (const v of vids) console.log('  ', v.slice(0, 240));

console.log('\n=== duration / 时长 相关字段 ===');
const seen = new Set();
for (const m of t.matchAll(/.{0,60}(duration|"video"|video_url|ability_param|时长).{0,120}/gi)) {
  const s = m[0].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const k = s.slice(0, 50);
  if (seen.has(k)) continue; seen.add(k);
  console.log('  …', s.slice(0, 200));
  if (seen.size > 20) break;
}

console.log('\n=== 消息文本（提取中文片段）===');
const texts = [...t.matchAll(/[\u4e00-\u9fa5][\u4e00-\u9fa5，。、：？！0-9a-zA-Z%\.]{6,120}/g)].map((m) => m[0]);
for (const s of [...new Set(texts)].slice(0, 25)) console.log('  ', s);

fs.writeFileSync(process.cwd() + '/dola-chain.json', JSON.stringify(r.json, null, 2));
console.log('\n原始响应已存 ./dola-chain.json');
