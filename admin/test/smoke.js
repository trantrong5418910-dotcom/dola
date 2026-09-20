/**
 * 端到端冒烟测试：登录 → 权限隔离 → CRUD → 角色 → 设置 → 日志。
 *
 *   1) 先起服务： npm start
 *   2) 再跑测试： npm run smoke
 *
 * 设计原则：**只动自己造的数据**。所有临时角色/用户都带 smoke 前缀，
 * 跑完自己删干净；不修改、不删除任何已有的角色与用户，避免污染你的数据。
 * （这条是被真实教训逼出来的：早先的版本误删过内置 seed 的 editor 角色。）
 */
const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 8788}`;
const ADMIN = { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD || 'admin123' };

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
};

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch { /* 空响应 */ }
  return { status: res.status, data };
}

const suffix = Date.now().toString(36);
const created = { roleId: null, userId: null, contentId: null, tokenIds: [], cardIds: [] };

console.log(`目标：${BASE}\n`);

console.log('— 健康检查与登录 —');
const adminToken = await (async () => {
  const h = await call('GET', '/api/health');
  ok(h.data.ok === true, '服务存活');

  const bad = await call('POST', '/api/auth/login', { body: { username: ADMIN.username, password: 'definitely-wrong' } });
  ok(bad.status === 401, '错误密码被拒绝', `得到 ${bad.status}`);

  const noAuth = await call('GET', '/api/users');
  ok(noAuth.status === 401, '未登录访问被拦截', `得到 ${noAuth.status}`);

  const login = await call('POST', '/api/auth/login', { body: ADMIN });
  ok(login.status === 200 && Boolean(login.data.token), '管理员登录成功');
  ok(login.data.user?.permissions?.includes('*'), '管理员拥有全部权限');
  return login.data.token;
})();

console.log('\n— 仪表盘 —');
{
  const s = await call('GET', '/api/stats', { token: adminToken });
  ok(s.status === 200 && typeof s.data.counts?.users === 'number', '统计接口返回数据');
}

console.log('\n— 内容 CRUD —');
{
  const c = await call('POST', '/api/contents', { token: adminToken, body: { title: `冒烟测试内容 ${suffix}`, category: 'smoke', status: 'draft', body: 'hello' } });
  ok(c.status === 201 && Boolean(c.data.id), '新建内容');
  created.contentId = c.data.id;

  const bad = await call('POST', '/api/contents', { token: adminToken, body: { title: '  ' } });
  ok(bad.status === 400, '空标题被拒绝');

  const u = await call('PUT', `/api/contents/${created.contentId}`, { token: adminToken, body: { title: `冒烟测试内容 ${suffix}`, status: 'published' } });
  ok(u.status === 200, '修改内容');

  const r = await call('GET', `/api/contents/${created.contentId}`, { token: adminToken });
  ok(r.data.item?.status === 'published', '修改已生效', JSON.stringify(r.data.item?.status));

  const l = await call('GET', `/api/contents?keyword=${suffix}`, { token: adminToken });
  ok(l.data.items?.length === 1, '关键字搜索命中');
}

console.log('\n— 临时角色 + 临时用户 —');
// 自建角色，别用 seed 里的 viewer/editor（用了就可能改到/删到它们）
{
  const role = await call('POST', '/api/roles', {
    token: adminToken,
    body: { code: `smoke_${suffix}`, name: '冒烟只读角色', description: '测试用，跑完自动删除' },
  });
  ok(role.status === 201 && Boolean(role.data.id), '新建临时角色');
  created.roleId = role.data.id;

  const perm = await call('PUT', `/api/roles/${created.roleId}/permissions`, {
    token: adminToken,
    body: { permissions: ['dashboard:view', 'content:list', '一个不存在的权限点'] },
  });
  ok(perm.status === 200, '配置临时角色权限');
  ok(perm.data.permissions.length === 2, '脏权限点被过滤掉', JSON.stringify(perm.data.permissions));

  const u = await call('POST', '/api/users', {
    token: adminToken,
    body: { username: `_smoke_${suffix}`, password: 'test123456', nickname: '冒烟只读', role_id: created.roleId },
  });
  ok(u.status === 201, '新建临时用户');
  created.userId = u.data.id;

  const dup = await call('POST', '/api/users', { token: adminToken, body: { username: `_smoke_${suffix}`, password: 'test123456' } });
  ok(dup.status === 409, '重名用户被拒绝', `得到 ${dup.status}`);

  const short = await call('POST', '/api/users', { token: adminToken, body: { username: `_smoke2_${suffix}`, password: '123' } });
  ok(short.status === 400, '弱密码被拒绝');

  // 现在角色有用户在用了 —— 这次才是真正的「在用不可删」场景
  const inUse = await call('DELETE', `/api/roles/${created.roleId}`, { token: adminToken });
  ok(inUse.status === 400, '有用户在用的角色不可删除（400）', `得到 ${inUse.status}`);
}

console.log('\n— 权限隔离（核心） —');
{
  const vLogin = await call('POST', '/api/auth/login', { body: { username: `_smoke_${suffix}`, password: 'test123456' } });
  ok(vLogin.status === 200, '只读用户能登录');
  const viewerToken = vLogin.data.token;
  ok(vLogin.data.user?.permissions?.length === 2, '只读用户只拿到 2 个权限点');

  const canRead = await call('GET', '/api/contents', { token: viewerToken });
  ok(canRead.status === 200, '只读用户能看内容');

  const cannotWrite = await call('POST', '/api/contents', { token: viewerToken, body: { title: '越权尝试' } });
  ok(cannotWrite.status === 403, '只读用户不能新建内容（403）', `得到 ${cannotWrite.status}`);

  const cannotUsers = await call('GET', '/api/users', { token: viewerToken });
  ok(cannotUsers.status === 403, '只读用户不能看用户列表（403）', `得到 ${cannotUsers.status}`);

  const cannotSetting = await call('PUT', '/api/settings', { token: viewerToken, body: { site_name: 'hacked' } });
  ok(cannotSetting.status === 403, '只读用户不能改设置（403）', `得到 ${cannotSetting.status}`);

  // 只读用户在菜单里也看不到这些项（前端 menuItems 按同一份权限过滤）
  const roles = await call('GET', '/api/roles/options', { token: viewerToken });
  ok(roles.status === 200, '只读用户能拿到角色下拉选项（不要求 role:list）');
}

console.log('\n— 内置角色保护 —');
{
  const roles = await call('GET', '/api/roles', { token: adminToken });
  const adminRole = roles.data.items.find((r) => r.code === 'admin');
  ok(Boolean(adminRole), '读得到内置 admin 角色');

  const blocked = await call('PUT', `/api/roles/${adminRole.id}/permissions`, { token: adminToken, body: { permissions: [] } });
  ok(blocked.status === 400, '内置角色不可改权限（400）', `得到 ${blocked.status}`);

  const delBlocked = await call('DELETE', `/api/roles/${adminRole.id}`, { token: adminToken });
  ok(delBlocked.status === 400, '内置角色不可删除（400）', `得到 ${delBlocked.status}`);

  // 确认 seed 的 editor / viewer 仍在（防止测试误删 seed 数据的回归）
  ok(roles.data.items.some((r) => r.code === 'editor'), 'seed 角色 editor 健在');
  ok(roles.data.items.some((r) => r.code === 'viewer'), 'seed 角色 viewer 健在');
}

console.log('\n— 令牌生成与生命周期 —');
{
  const gen = await call('POST', '/api/tokens/generate', {
    token: adminToken,
    body: { count: 2, points: 77, name: `冒烟令牌 ${suffix}`, note: 'smoke', expiresInDays: 30 },
  });
  ok(gen.status === 201 && gen.data.items.length === 2, '生成 2 个令牌');
  ok(gen.data.items[0].value.startsWith('dv_'), '令牌前缀是 dv_', gen.data.items[0].value.slice(0, 6));
  ok(gen.data.items[0].value.length === 35, '令牌长度 35（dv_ + 32）', gen.data.items[0].value.length);
  ok(gen.data.items.every((i) => i.points === 77), '初始积分写入正确');
  created.tokenIds = gen.data.items.map((i) => i.id);
  const fullValue = gen.data.items[0].value;
  const tokenId = gen.data.items[0].id;

  const list = await call('GET', `/api/tokens?keyword=${suffix}`, { token: adminToken });
  ok(list.status === 200, '按名称搜到令牌');
  ok(list.data.items.length === 2, '搜到 2 个');
  ok(!list.data.items.some((i) => i.value === fullValue), '列表里不泄露完整令牌（已打码）');
  ok(list.data.items[0].value.includes('*'), '列表值是掩码形态');

  const rev = await call('GET', `/api/tokens/${tokenId}/reveal`, { token: adminToken });
  ok(rev.data.value === fullValue, 'reveal 能取回完整值');

  const pts = await call('POST', `/api/tokens/${tokenId}/action`, { token: adminToken, body: { action: 'points', delta: -7 } });
  ok(pts.status === 200 && pts.data.points === 70, '调整积分 77-7=70', JSON.stringify(pts.data));

  const neg = await call('POST', `/api/tokens/${tokenId}/action`, { token: adminToken, body: { action: 'points', delta: -9999 } });
  ok(neg.status === 400, '扣成负数被拒绝', `得到 ${neg.status}`);

  const dis = await call('POST', `/api/tokens/${tokenId}/action`, { token: adminToken, body: { action: 'disable' } });
  ok(dis.data.status === 'disabled', '停用令牌');
  const en = await call('POST', `/api/tokens/${tokenId}/action`, { token: adminToken, body: { action: 'enable' } });
  ok(en.data.status === 'active', '重新启用令牌');
  const rv = await call('POST', `/api/tokens/${tokenId}/action`, { token: adminToken, body: { action: 'revoke' } });
  ok(rv.data.status === 'revoked', '撤销令牌');
  const re = await call('POST', `/api/tokens/${tokenId}/action`, { token: adminToken, body: { action: 'enable' } });
  ok(re.status === 400, '已撤销的令牌不可再启用', `得到 ${re.status}`);

  const exp = await call('GET', '/api/tokens/export', { token: adminToken });
  ok(exp.status === 200, '令牌导出 CSV 可用');

  // 待会儿兑换测试要用这个令牌，先恢复成 active
  await call('POST', `/api/tokens/${tokenId}/action`, { token: adminToken, body: { action: 'enable' } });
  // 撤销过的令牌不允许启用 —— 换个新令牌来做兑换
  created.redeemTokenId = (await call('POST', '/api/tokens/generate', { token: adminToken, body: { count: 1, points: 0, name: `冒烟兑换令牌 ${suffix}` } })).data.items[0].id;
  created.tokenIds.push(created.redeemTokenId);
  ok(Boolean(created.redeemTokenId), '准备一个用于兑换的令牌');
}

console.log('\n— 卡密生成与兑换闭环 —');
{
  const gen = await call('POST', '/api/cards/generate', {
    token: adminToken,
    body: { count: 3, points: 50, note: `冒烟卡密 ${suffix}` },
  });
  ok(gen.status === 201 && gen.data.items.length === 3, '生成 3 张卡密');
  ok(gen.data.items[0].value.startsWith('card_'), '卡密前缀是 card_', gen.data.items[0].value.slice(0, 6));
  ok(gen.data.items[0].value.length === 25, '卡密长度 25（card_ + 20）', gen.data.items[0].value.length);
  ok(gen.data.batchNo.startsWith('B'), '自动生成批次号', gen.data.batchNo);
  ok(!/[0O1lI]/.test(gen.data.items[0].value.slice(5)), '卡密不含易混字符 0O1lI');
  created.cardIds = gen.data.items.map((i) => i.id);
  const batchNo = gen.data.batchNo;
  const fullCode = gen.data.items[0].value;

  const list = await call('GET', `/api/cards?keyword=${suffix}`, { token: adminToken });
  ok(!list.data.items.some((i) => i.code === fullCode), '列表里不泄露完整卡密');

  const batches = await call('GET', '/api/cards/batches', { token: adminToken });
  ok(batches.data.items.some((b) => b.batch_no === batchNo), '批次列表里有这个批次');

  // 兑换闭环
  const rd = await call('POST', '/api/cards/redeem', {
    token: adminToken,
    body: { code: fullCode, tokenId: created.redeemTokenId },
  });
  ok(rd.status === 200 && rd.data.points === 50, '兑换成功 +50 积分', JSON.stringify(rd.data));
  ok(rd.data.tokenPoints === 50, '令牌积分 0 → 50', JSON.stringify(rd.data));

  const dup = await call('POST', '/api/cards/redeem', {
    token: adminToken,
    body: { code: fullCode, tokenId: created.redeemTokenId },
  });
  ok(dup.status === 409, '同一张卡重复兑换被拒（409）', `得到 ${dup.status}`);

  const afterToken = await call('GET', `/api/tokens?keyword=冒烟兑换令牌`, { token: adminToken });
  ok(afterToken.data.items[0].points === 50, '积分只加了一次（没被重复兑换刷爆）');

  const delRedeemed = await call('DELETE', `/api/cards/${created.cardIds[0]}`, { token: adminToken });
  ok(delRedeemed.status === 400, '已兑换的卡密默认不可删（400）', `得到 ${delRedeemed.status}`);

  const rev = await call('POST', `/api/cards/${created.cardIds[1]}/action`, { token: adminToken, body: { action: 'revoke' } });
  ok(rev.data.status === 'revoked', '撤销未使用的卡密');
  const rs = await call('POST', `/api/cards/${created.cardIds[1]}/action`, { token: adminToken, body: { action: 'restore' } });
  ok(rs.data.status === 'unused', '恢复已撤销的卡密');

  const exp = await call('GET', '/api/cards/export', { token: adminToken });
  ok(exp.status === 200, '卡密导出 CSV 可用');

  const bad = await call('POST', '/api/cards/generate', { token: adminToken, body: { count: 1, points: 0 } });
  ok(bad.status === 400, '面额为 0 被拒绝', `得到 ${bad.status}`);

  const big = await call('POST', '/api/cards/generate', { token: adminToken, body: { count: 99999, points: 1 } });
  ok(big.status === 201 && big.data.count === 1000, '单次生成上限被裁到 1000', `得到 ${big.data?.count}`);
  // 这一批当场批量删掉，不放进 created（否则收尾时会重复删、误报失败）
  const bulkIds = big.data.items.map((i) => i.id);
  const bulkDel = await call('DELETE', '/api/cards', { token: adminToken, body: { ids: bulkIds } });
  ok(bulkDel.data.deleted === 1000, '批量删除这 1000 张', JSON.stringify(bulkDel.data));
}

console.log('\n— 令牌/卡密的权限隔离 —');
{
  const vLogin = await call('POST', '/api/auth/login', { body: { username: `_smoke_${suffix}`, password: 'test123456' } });
  const vToken = vLogin.data.token;

  const noGenToken = await call('POST', '/api/tokens/generate', { token: vToken, body: { count: 1, points: 1 } });
  ok(noGenToken.status === 403, '只读用户不能生成令牌（403）', `得到 ${noGenToken.status}`);

  const noListToken = await call('GET', '/api/tokens', { token: vToken });
  ok(noListToken.status === 403, '只读用户不能看令牌列表（403）', `得到 ${noListToken.status}`);

  const noGenCard = await call('POST', '/api/cards/generate', { token: vToken, body: { count: 1, points: 1 } });
  ok(noGenCard.status === 403, '只读用户不能生成卡密（403）', `得到 ${noGenCard.status}`);

  const noReveal = await call('GET', `/api/tokens/${created.tokenIds[0]}/reveal`, { token: vToken });
  ok(noReveal.status === 403, '只读用户不能查看令牌完整值（403）', `得到 ${noReveal.status}`);

  const noOptions = await call('GET', '/api/tokens/options', { token: vToken });
  ok(noOptions.status === 200, '令牌下拉选项只要求登录（方便兑换对话框）');
}

console.log('\n— dola 账号池 —');
const dola = { ids: [], tokenId: null };
{
  // 导入：2 条正常 + 1 条重复 + 1 行垃圾
  const c1 = `ttwid=1%7Csmoke_${suffix}_a%7C1789%7Caaa; odin_tt=smokeodinAAAA; s_v_web_id=verify_${suffix}a`;
  const c2 = `ttwid=1%7Csmoke_${suffix}_b%7C1789%7Cbbb; odin_tt=smokeodinBBBB; s_v_web_id=verify_${suffix}b`;
  const imp = await call('POST', '/api/dola/accounts/import', {
    token: adminToken,
    body: { raw: [c1, '', c2, c1, '这不是 cookie'].join('\n'), labelPrefix: `冒烟${suffix}`, note: 'smoke' },
  });
  ok(imp.status === 201 && imp.data.inserted === 2, '导入 2 个账号', JSON.stringify(imp.data));
  ok(imp.data.skipped === 1, '重复 cookie 被跳过');
  ok(imp.data.invalid === 1, '垃圾行被识别为无效');
  dola.ids = imp.data.ids;

  const list = await call('GET', `/api/dola/accounts?keyword=冒烟${suffix}`, { token: adminToken });
  ok(list.data.items.length === 2, '按备注名搜到 2 个账号');
  ok(list.data.items.every((a) => !a.cookie.includes('odin_tt=')), '列表不泄露完整 cookie');
  ok(list.data.items[0].cookie_names.includes('ttwid'), '记录了 cookie 字段名');
  ok(typeof list.data.summary.total === 'number', 'summary 有统计');

  // 缺关键 cookie 的行应被标 invalid
  const bad = await call('POST', '/api/dola/accounts/import', {
    token: adminToken, body: { raw: `s_v_web_id=only_this_${suffix}`, labelPrefix: `坏${suffix}` },
  });
  ok(bad.data.inserted === 1, '只有 s_v_web_id 也能入库');
  dola.ids.push(...bad.data.ids);

  // 探测（假 cookie 必然是 session_expired）
  const pr = await call('POST', `/api/dola/accounts/${dola.ids[0]}/probe`, { token: adminToken });
  ok(pr.status === 200 && pr.data.session.valid === false, '假 cookie 探测判定为未登录');
  ok(pr.data.probes.some((p) => p.kind === 'session_expired'), '探测到 session_expired（710012001）');
  ok(pr.data.probes.length >= 5, '候选接口列表已扩充（含 self_brief / brief_list）');
  ok(pr.data.probes.some((p) => p.flagged), '标出历史上误判为需签名的接口（供排查）');

  // 手动录入额度
  const sc = await call('POST', `/api/dola/accounts/${dola.ids[0]}/action`, { token: adminToken, body: { action: 'set_credits', credits: 105 } });
  ok(sc.status === 200 && sc.data.credits === 105, '手动录入额度');
  const scBad = await call('POST', `/api/dola/accounts/${dola.ids[0]}/action`, { token: adminToken, body: { action: 'set_credits', credits: -5 } });
  ok(scBad.status === 400, '负数额度被拒绝', `得到 ${scBad.status}`);

  // 换算：非 valid 状态必须被挡住（安全行为）
  const blocked = await call('POST', '/api/dola/convert', { token: adminToken, body: { ids: [dola.ids[0]], basis: 'credits', ratio: 10 } });
  ok(blocked.data.pointsGained === 0 && /状态/.test(blocked.data.details[0].message), '非 valid 账号不参与换算');

  const badBasis = await call('POST', '/api/dola/convert', { token: adminToken, body: { all: true, basis: 'nope' } });
  ok(badBasis.status === 400, '未知计价方式被拒绝', `得到 ${badBasis.status}`);

  // 一个都不选（既没 ids 也没 all）必须拒绝，别静默把全库算进去
  const noTarget = await call('POST', '/api/dola/convert', { token: adminToken, body: { basis: 'account' } });
  ok(noTarget.status === 400, '既没给 ids 也没给 all 时被拒绝', `得到 ${noTarget.status}`);
  // 给 ids 但账号状态不合格时，不是报错而是逐条说明跳过原因
  const skipped = await call('POST', '/api/dola/convert', { token: adminToken, body: { ids: [dola.ids[0]], basis: 'account' } });
  ok(skipped.status === 200 && skipped.data.pointsGained === 0 && skipped.data.details.length === 1, '状态不合格的账号逐条说明跳过原因');

  // —— 测试夹具：把账号置为 valid，才能验证换算的算术 ——
  // 正常情况这是「校验通过」写进去的，这里没有真实 cookie，只能直接改库。
  // ⚠️ 必须用命名空间对象访问 db（m.db），不能解构取 ——
  // db.js 导出的是 `export let db`，会在 initDb() 里被赋值；
  // 解构 { db } 会把它拍成赋 null 那一刻的快照，拿到 null。
  const dbMod = await import('../server/db.js');
  await dbMod.initDb();
  dbMod.db.prepare(`UPDATE dola_accounts SET status='valid' WHERE id IN (${dola.ids.map(() => '?').join(',')})`).run(...dola.ids);

  // ---- 按账号数计价（免费号场景，主用法）----
  const accDry = await call('POST', '/api/dola/convert', { token: adminToken, body: { ids: [dola.ids[1]], basis: 'account', pointsPerAccount: 30, dryRun: true } });
  ok(accDry.data.pointsGained === 30 && accDry.data.basis === 'account', '按账号数试算：1 个账号 = 30 积分', JSON.stringify({ p: accDry.data.pointsGained }));
  ok(accDry.data.ratioDesc.includes('30'), '试算回显了计价说明', accDry.data.ratioDesc);

  const accReal = await call('POST', '/api/dola/convert', { token: adminToken, body: { ids: [dola.ids[1]], basis: 'account', pointsPerAccount: 30 } });
  ok(accReal.data.pointsGained === 30, '按账号数真实计价');

  const accAgain = await call('POST', '/api/dola/convert', { token: adminToken, body: { ids: [dola.ids[1]], basis: 'account', pointsPerAccount: 30 } });
  ok(accAgain.data.pointsGained === 0 && /计过价/.test(accAgain.data.details[0].message), '同一个账号不会被重复计价');

  const resetOk = await call('POST', `/api/dola/accounts/${dola.ids[1]}/action`, { token: adminToken, body: { action: 'reset_counted' } });
  ok(resetOk.status === 200, '可撤销计价标记');
  const accAfterReset = await call('POST', '/api/dola/convert', { token: adminToken, body: { ids: [dola.ids[1]], basis: 'account', pointsPerAccount: 30, dryRun: true } });
  ok(accAfterReset.data.pointsGained === 30, '撤销后又能重新计价');
  const resetTwice = await call('POST', `/api/dola/accounts/${dola.ids[2]}/action`, { token: adminToken, body: { action: 'reset_counted' } });
  ok(resetTwice.status === 400, '没计过价的账号撤销会被拒（400）', `得到 ${resetTwice.status}`);

  // ---- 按额度计价（付费号场景）----
  const dry = await call('POST', '/api/dola/convert', { token: adminToken, body: { ids: [dola.ids[0]], basis: 'credits', ratio: 10, dryRun: true } });
  ok(dry.data.pointsGained === 10, '试算 105 额度 / 10 = 10 积分（余 5 保留）', JSON.stringify({ p: dry.data.pointsGained }));
  ok(dry.data.creditsUsed === 100, '试算只算用掉 100 额度');

  const t = await call('POST', '/api/tokens/generate', { token: adminToken, body: { count: 1, points: 0, name: `冒烟dola令牌${suffix}` } });
  dola.tokenId = t.data.items[0].id;

  const real = await call('POST', '/api/dola/convert', { token: adminToken, body: { ids: [dola.ids[0]], basis: 'credits', ratio: 10, tokenId: dola.tokenId } });
  ok(real.data.pointsGained === 10, '真实换算产出 10 积分');
  ok(real.data.tokenId === dola.tokenId, '指定了目标令牌');

  const afterToken = await call('GET', `/api/tokens?keyword=冒烟dola令牌${suffix}`, { token: adminToken });
  ok(afterToken.data.items[0].points === 10, '积分确实充到了令牌上', `得到 ${afterToken.data.items[0].points}`);

  // 再换一次：余 5 额度不够 1 积分，不能再发
  const again = await call('POST', '/api/dola/convert', { token: adminToken, body: { ids: [dola.ids[0]], basis: 'credits', ratio: 10, tokenId: dola.tokenId } });
  ok(again.data.pointsGained === 0, '重复换算不会重复发积分');
  const tokenAgain = await call('GET', `/api/tokens?keyword=冒烟dola令牌${suffix}`, { token: adminToken });
  ok(tokenAgain.data.items[0].points === 10, '令牌积分未被二次累加');

  // 换算流水
  const conv = await call('GET', '/api/dola/conversions', { token: adminToken });
  ok((conv.data.items || []).some((c) => c.account_label?.includes(`冒烟${suffix}`)), '换算流水记录了本次操作');
  ok(conv.data.summary.points > 0, '流水汇总有数据');

  // 有换算记录的账号默认不可删
  const delBlocked = await call('DELETE', `/api/dola/accounts/${dola.ids[0]}`, { token: adminToken });
  ok(delBlocked.status === 400, '有换算记录的账号默认不可删（400）', `得到 ${delBlocked.status}`);

  // 批量任务
  const job = await call('POST', '/api/dola/jobs', { token: adminToken, body: { type: 'dola_check', ids: dola.ids, concurrency: 2 } });
  ok(job.status === 201 && job.data.job.total === dola.ids.length, '创建批量校验任务');
  const jid = job.data.job.id;

  let finalJob = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const j = await call('GET', `/api/dola/jobs/${jid}`, { token: adminToken });
    finalJob = j.data.job;
    if (!['queued', 'running'].includes(finalJob.status)) break;
  }
  ok(finalJob.status === 'done', '任务正常跑完（状态是 done，不是 failed）', JSON.stringify({ s: finalJob.status }));
  ok(finalJob.done === dola.ids.length, '所有项都处理了', JSON.stringify({ d: finalJob.done, t: finalJob.total }));
  ok((finalJob.result?.details || []).length > 0, '任务明细有记录');
  ok((finalJob.payload?.idCount ?? 0) === dola.ids.length, '任务的 payload 只回报数量不回传全量 ids');

  const badType = await call('POST', '/api/dola/jobs', { token: adminToken, body: { type: 'nope', all: true } });
  ok(badType.status === 400, '未知任务类型被拒绝', `得到 ${badType.status}`);

  const provider = await call('GET', '/api/dola/provider', { token: adminToken });
  ok(provider.status === 200 && Array.isArray(provider.data.loginOptions), 'provider 状态接口可用');
  ok(provider.data.loginOptions.length >= 5, '列出了 dola 的登录方式（供 UI 提示「无密码登录」）');
  ok(Number.isInteger(provider.data.generation?.concurrency) && provider.data.generation.concurrency >= 1, 'provider 返回生成并发状态');
  ok(provider.data.settings?.generationConcurrency === provider.data.generation?.concurrency, '生成并发设置与实时状态一致');
  ok(Number.isInteger(provider.data.generation?.queueLimit) && provider.data.generation.queueLimit >= 1 && provider.data.generation.queueLimit <= 6000,
    'provider 返回生成队列容量', JSON.stringify(provider.data.generation));
  ok(provider.data.settings?.generationQueueLimit === provider.data.generation?.queueLimit, '生成队列容量设置与实时状态一致');
  ok(Number.isInteger(provider.data.generation?.activeTasks) && Number.isInteger(provider.data.generation?.queueAvailable),
    'provider 返回队列占用与剩余容量', JSON.stringify(provider.data.generation));

  const generationTasks = await call('GET', '/api/dola/generation-tasks?limit=5', { token: adminToken });
  ok(generationTasks.status === 200 && Array.isArray(generationTasks.data.items), '生成任务只读列表可用');
  ok(!JSON.stringify(generationTasks.data).match(/owner_token_id|charge_ref|local_path|watermarked_url|unwatermarked_url/), '生成任务列表不暴露令牌或媒体内部字段');
}

console.log('\n— dola 权限隔离 —');
{
  const vLogin = await call('POST', '/api/auth/login', { body: { username: `_smoke_${suffix}`, password: 'test123456' } });
  const vToken = vLogin.data.token;
  for (const [path, body, name] of [
    ['/api/dola/accounts/import', { raw: 'x=1' }, '导入账号'],
    ['/api/dola/jobs', { type: 'dola_check', all: true }, '提交批量任务'],
    ['/api/dola/convert', { all: true, basis: 'account' }, '计价换算'],
  ]) {
    const r = await call('POST', path, { token: vToken, body });
    ok(r.status === 403, `只读用户不能${name}（403）`, `得到 ${r.status}`);
  }
  const l = await call('GET', '/api/dola/accounts', { token: vToken });
  ok(l.status === 403, '只读用户不能看账号池（403）', `得到 ${l.status}`);
}

console.log('\n— 用户端网关 —');
{
  const mod = await import('../server/db.js');
  await mod.initDb();
  const guard = await import('../server/routes/gateway.js');
  const gkey = mod.db.prepare("SELECT value FROM settings WHERE key='gateway_key'").get()?.value;
  ok(Boolean(gkey), '网关密钥已生成');

  const gw = (path, body, key) => fetch(`${BASE}/api/gateway${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key === null ? {} : { 'X-Gateway-Key': key ?? gkey }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

  const noKey = await gw('/health', undefined, null);
  ok(noKey.status === 401, '不带网关密钥被拒（401）', `得到 ${noKey.status}`);
  const badKey = await gw('/health', undefined, 'wrong-key');
  ok(badKey.status === 401, '错误网关密钥被拒（401）');
  const good = await gw('/health');
  ok(good.status === 200 && typeof good.data.pointsPerTask === 'number', '正确密钥可用');

  // 造一个临时令牌来测扣费，别动 seed 的演示令牌
  const tg = await call('POST', '/api/tokens/generate', { token: adminToken, body: { count: 1, points: 10, name: `网关冒烟${suffix}` } });
  const gTok = tg.data.items[0];
  const gValue = gTok.value;
  created.tokenIds.push(gTok.id);

  // 重复提示词保护只测守门逻辑，不创建真实任务、不体检账号、不消耗积分。
  const guardPrompt = `重复提示词 ${suffix}`;
  const guardCreatedAt = new Date(Date.now() - 10_000).toISOString();
  const guardRow = mod.db.prepare(`INSERT INTO dola_videos
    (prompt, status, stage, owner_token_id, owner_prefix, created_at, updated_at)
    VALUES (?, 'failed', '冒烟占位', ?, ?, ?, ?)`)
    .run(guardPrompt, gTok.id, gTok.prefix, guardCreatedAt, guardCreatedAt);
  const duplicate = guard.findRecentPromptDuplicate(gTok.id, `  ${guardPrompt}\n`);
  ok(duplicate?.id === Number(guardRow.lastInsertRowid), '相同提示词在冷却期内会被识别');
  ok(duplicate?.retryAfterSeconds > 0, '重复提示词返回剩余等待时间');
  mod.db.prepare('DELETE FROM dola_videos WHERE id=?').run(Number(guardRow.lastInsertRowid));

  const v1 = await gw('/verify', { token: gValue });
  ok(v1.status === 200 && v1.data.points === 10, '网关校验令牌并返回余额', JSON.stringify(v1.data));
  const vBad = await gw('/verify', { token: 'dv_not_a_real_token' });
  ok(vBad.status === 401, '网关拒绝无效令牌（401）');

  const ref = `smoke-${suffix}`;
  const c1 = await gw('/consume', { token: gValue, ref, points: 4 });
  ok(c1.status === 200 && c1.data.charged === 4 && c1.data.balance === 6, '网关扣积分', JSON.stringify(c1.data));
  const c2 = await gw('/consume', { token: gValue, ref, points: 4 });
  ok(c2.data.duplicated === true && c2.data.balance === 6, '同 ref 重复扣费被幂等挡下（余额不变）');

  const over = await gw('/consume', { token: gValue, ref: `over-${suffix}`, points: 9999 });
  ok(over.status === 402, '积分不足返回 402', `得到 ${over.status}`);

  const r1 = await gw('/refund', { ref, note: '冒烟退款' });
  ok(r1.status === 200 && r1.data.refunded === 4 && r1.data.balance === 10, '网关退款', JSON.stringify(r1.data));
  const r2 = await gw('/refund', { ref });
  ok(r2.data.duplicated === true && r2.data.balance === 10, '重复退款幂等（余额不变）');
  const rBad = await gw('/refund', { ref: `never-${suffix}` });
  ok(rBad.status === 404, '没有消费记录的 ref 拒绝退款（404）', `得到 ${rBad.status}`);

  // 令牌完整值绝不出现在流水里
  const tx = await gw('/transactions?limit=20');
  ok(tx.status === 200 && Array.isArray(tx.data.items), '网关流水可读');
  ok(!JSON.stringify(tx.data).includes(gValue), '流水里不包含令牌完整值');
}

console.log('\n— 前台入口 —');
// ⚠️ 先在开头备份用户真实的前台配置，收尾时**原样还原**。
// 早期版本直接在收尾清空 frontend_url，跑一次测试就把用户配好的地址抹掉了。
const feBackup = (await call('GET', '/api/frontend/config', { token: adminToken })).data;
{
  // 先清空，验证「没配置」的提示
  await call('PUT', '/api/settings', { token: adminToken, body: { frontend_url: '', frontend_open_mode: 'tab' } });

  const cfg0 = await call('GET', '/api/frontend/config', { token: adminToken });
  ok(cfg0.status === 200 && cfg0.data.configured === false, '未配置时 configured=false');

  const open0 = await call('POST', '/api/frontend/open', { token: adminToken, body: {} });
  ok(open0.status === 400, '未配置地址时点开被拒（400）', `得到 ${open0.status}`);

  // 非法协议必须被温和拒绝，而且**不能把服务搞崩**（曾经的 bug）
  await call('PUT', '/api/settings', { token: adminToken, body: { frontend_url: 'file:///etc/passwd' } });
  const bad = await call('POST', '/api/frontend/open', { token: adminToken, body: {} });
  ok(bad.status === 400 && /协议/.test(bad.data.message), '非 http/https 协议被拒（400）', JSON.stringify(bad.data));
  const alive = await call('GET', '/api/health');
  ok(alive.status === 200, '拒绝非法协议后服务仍然存活（防 async 未捕获导致进程退出）');

  // 合法地址 + tab 模式：服务端只回 URL，不启动任何进程
  await call('PUT', '/api/settings', { token: adminToken, body: { frontend_url: 'https://example.com', frontend_open_mode: 'tab', frontend_name: '冒烟前台' } });
  const cfg = await call('GET', '/api/frontend/config', { token: adminToken });
  ok(cfg.data.configured === true && cfg.data.name === '冒烟前台', '配置读取正确', JSON.stringify(cfg.data));
  const openTab = await call('POST', '/api/frontend/open', { token: adminToken, body: {} });
  ok(openTab.status === 200 && openTab.data.mode === 'tab' && openTab.data.url.startsWith('https://example.com'), 'tab 模式只返回 URL', JSON.stringify(openTab.data));

  // 接口不该接受请求体里的 url（防 SSRF）
  const injected = await call('POST', '/api/frontend/open', { token: adminToken, body: { url: 'http://169.254.169.254/latest/meta-data/' } });
  ok(injected.data.url.startsWith('https://example.com'), '忽略请求体传入的 url（防 SSRF）', JSON.stringify(injected.data));

  const st = await call('GET', '/api/frontend/status', { token: adminToken });
  ok(st.status === 200 && st.data.browserOpen === false, 'tab 模式下没有浏览器进程');
}

console.log('\n— 前台入口权限隔离 —');
{
  const vLogin = await call('POST', '/api/auth/login', { body: { username: `_smoke_${suffix}`, password: 'test123456' } });
  const vToken = vLogin.data.token;
  const denied = await call('POST', '/api/frontend/open', { token: vToken, body: {} });
  ok(denied.status === 403, '只读用户不能打开前台（403）', `得到 ${denied.status}`);
  const cfgDenied = await call('GET', '/api/frontend/config', { token: vToken });
  ok(cfgDenied.status === 200, '只读用户能读配置（前端靠它决定按钮显不显示）');
}

console.log('\n— 设置与日志 —');
{
  const before = await call('GET', '/api/settings/public');
  ok(before.status === 200, '公共设置接口免登录可读（登录页要用）');

  const s = await call('PUT', '/api/settings', { token: adminToken, body: { site_name: `冒烟后台 ${suffix}` } });
  ok(s.status === 200 && s.data.changed.includes('site_name'), '修改设置');

  const after = await call('GET', '/api/settings/public');
  ok(after.data.siteName.includes(suffix), '设置修改后立即可读');

  const logs = await call('GET', '/api/logs?pageSize=200', { token: adminToken });
  const actions = (logs.data.items || []).map((l) => l.action);
  const loginLogs = (logs.data.items || []).filter((l) => l.action === 'login' || l.action === 'login_failed');
  ok(actions.includes('login'), '日志记录了登录');
  ok(actions.includes('login_failed'), '日志记录了登录失败');
  ok(actions.includes('content.create'), '日志记录了新建内容');
  ok(actions.includes('role.create'), '日志记录了新建角色');
  ok(actions.includes('token.generate'), '日志记录了生成令牌');
  ok(actions.includes('card.generate'), '日志记录了生成卡密');
  ok(actions.includes('frontend.open'), '日志记录了打开前台');

  // 这两条是回归断言：曾经因为 {...req} 展开丢了 headers，登录日志静默写不进去
  ok(loginLogs.length >= 2, '登录/失败登录都落了库', `只有 ${loginLogs.length} 条`);
  ok(loginLogs.every((l) => l.ip), '登录日志带上了真实 IP（不是空串）', JSON.stringify(loginLogs.map((l) => l.ip)));
  ok((logs.data.items || []).some((l) => l.username === ADMIN.username), '登录日志带上了真实用户名（不是 anonymous）');
  ok((logs.data.items || []).every((l) => l.ip !== undefined), '日志表有 IP 字段');
}

console.log('\n— 收尾清理（只删自己造的） —');
{
  if (created.contentId) {
    const d = await call('DELETE', `/api/contents/${created.contentId}`, { token: adminToken });
    ok(d.status === 200, '清理测试内容');
  }
  if (created.userId) {
    const d = await call('DELETE', `/api/users/${created.userId}`, { token: adminToken });
    ok(d.status === 200, '清理测试用户');
  }
  if (created.roleId) {
    const d = await call('DELETE', `/api/roles/${created.roleId}`, { token: adminToken });
    ok(d.status === 200, '清理临时角色（用户已删，角色可删了）');
  }

  // 卡密：已兑换的默认删不掉，用 force=1 清理测试数据（会留 force_delete 审计）
  let cardOk = 0;
  for (const id of created.cardIds) {
    const r = await call('DELETE', `/api/cards/${id}?force=1`, { token: adminToken });
    if (r.status === 200) cardOk++;
  }
  ok(cardOk === created.cardIds.length, `清理测试卡密 ${cardOk}/${created.cardIds.length}`);

  // 令牌：有兑换记录的也要 force
  let tokenOk = 0;
  for (const id of created.tokenIds) {
    const r = await call('DELETE', `/api/tokens/${id}?force=1`, { token: adminToken });
    if (r.status === 200) tokenOk++;
  }
  ok(tokenOk === created.tokenIds.length, `清理测试令牌 ${tokenOk}/${created.tokenIds.length}`);

  // dola 账号（有换算记录的 + 刚建的令牌）
  if (dola.ids.length) {
    const r = await call('DELETE', '/api/dola/accounts', { token: adminToken, body: { ids: dola.ids, force: true } });
    ok(r.data.deleted === dola.ids.length, `清理测试 dola 账号 ${r.data.deleted}/${dola.ids.length}`);
  }
  if (dola.tokenId) {
    const r = await call('DELETE', `/api/tokens/${dola.tokenId}?force=1`, { token: adminToken });
    ok(r.status === 200, '清理 dola 测试用的令牌');
  }
  // 换算流水也清掉，避免反复跑测试越积越多
  {
    const dbMod2 = await import('../server/db.js');
    await dbMod2.initDb();
    const n = dbMod2.db.prepare("DELETE FROM credit_conversions WHERE account_label LIKE ?").run(`%${suffix}%`).changes;
    ok(n >= 0, `清理换算流水 ${n} 条`);
  }

  await call('PUT', '/api/settings', { token: adminToken, body: { site_name: '管理后台' } });
  // 把前台配置**原样还原**（不是清空）
  const restored = await call('PUT', '/api/settings', {
    token: adminToken,
    body: { frontend_name: feBackup.name, frontend_url: feBackup.url, frontend_open_mode: feBackup.mode },
  });
  ok(restored.status === 200, '前台配置已还原为测试前的值');
  const after = await call('GET', '/api/frontend/config', { token: adminToken });
  ok(after.data.url === feBackup.url && after.data.name === feBackup.name,
    '还原校验：前台配置与测试前一致', JSON.stringify({ before: feBackup.url, after: after.data.url }));

  const roles = await call('GET', '/api/roles', { token: adminToken });
  const codes = roles.data.items.map((r) => r.code);
  ok(codes.includes('editor') && codes.includes('viewer'), '清理后 seed 角色仍然完好');
  ok(!codes.some((c) => c.startsWith('smoke_')), '临时角色已清空');

  // 确认没有把 seed 的示例令牌/卡密误删
  const t = await call('GET', '/api/tokens', { token: adminToken });
  const c = await call('GET', '/api/cards', { token: adminToken });
  ok(t.data.items.some((i) => i.name?.includes('演示令牌')), 'seed 示例令牌健在');
  ok(c.data.items.some((i) => i.note === '示例数据，可直接删除'), 'seed 示例卡密健在');
  ok(!t.data.items.some((i) => i.name?.includes('冒烟')), '测试令牌已清空');
  ok(!c.data.items.some((i) => i.note?.includes('冒烟')), '测试卡密已清空');
}

// ================================================================ 无水印提取
//
// 这部分测的是**纯函数**（不发真实请求），所以可以在冒烟里稳定跑。
// 它是整个"去水印"能力的地基 —— 逻辑一错，线上就是静默拿不到无水印版本，
// 而且看起来"任务成功"，非常难查。所以这里逐个函数钉死。

console.log('\n— 无水印提取（纯函数）—');
{
  const uw = await import('../server/dola/unwatermark.js');

  // ① 转义还原：dola 的响应里 URL 经常被 \\/ 转义，甚至多层 JSON 字符串套娃
  ok(uw.decodeJsonEscapedFragment('https:\\/\\/a.com\\/b?x=1&y=2') === 'https://a.com/b?x=1&y=2',
    'decodeJsonEscapedFragment 还原 \\/ 转义');
  ok(uw.decodeJsonEscapedFragment('https:\\u0026amp') === 'https:&amp',
    'decodeJsonEscapedFragment 还原 \\u0026');

  // ② 域名白名单：必须是 https 且命中根域（防响应里塞外站 URL 造成 SSRF）
  ok(uw.isAllowedFallbackApiUrl('https://vod-urls-mya.byteintlapi.com/video/x') === true,
    '白名单放行 byteintlapi.com');
  ok(uw.isAllowedFallbackApiUrl('https://www.dola.com/x') === true, '白名单放行 dola.com');
  ok(uw.isAllowedFallbackApiUrl('https://evil.com/x') === false, '白名单拦下未知域名');
  ok(uw.isAllowedFallbackApiUrl('http://vod-urls-mya.byteintlapi.com/x') === false,
    '白名单拦下非 https');
  ok(uw.isAllowedFallbackApiUrl('https://byteintlapi.com.evil.com/x') === false,
    '白名单拦下"根域当子域"的伪装（byteintlapi.com.evil.com）');

  // ③ 从消息链里挖 fallback_api（结构化 + 正则兜底两条路都要通）
  const fakeChain = {
    downlink_body: [{
      message: {
        content: JSON.stringify({
          video_info: { data: { video_list: { '1': { main_url: 'qAABxxxx', bitrate: 100 } }, key_seed: 'seed123' } },
          fallback_api: 'https://vod-urls-mya.byteintlapi.com/video/fplay/1/abc',
        }),
      },
    }],
  };
  const apis = uw.findFallbackApis(fakeChain, JSON.stringify(fakeChain));
  ok(apis.length === 1 && apis[0].includes('byteintlapi.com'), 'findFallbackApis 从嵌套 JSON 里挖出 fallback_api',
    JSON.stringify(apis));
  ok(uw.findFallbackApis({}, 'x "fallback_api":"https://evil.com/a" y').length === 0,
    'findFallbackApis 不采纳白名单外的 URL');
  ok(uw.findFallbackApis({}, 'fallback_api\\":\\"https:\\/\\/vod-urls-mya.byteintlapi.com\\/v\\/1\\"').length === 1,
    'findFallbackApis 能从转义原文里挖出来（正则兜底路径）');

  // ④ 参数改写：这三个参数就是"去水印"的全部秘密
  const rewritten = uw.withUnwatermarkedParams('https://vod-urls-mya.byteintlapi.com/video/fplay/1/abc?codec_type=3');
  ok(/logo_type=unwatermarked/.test(rewritten) && /channel=no/.test(rewritten) && /codec_type=8/.test(rewritten),
    'withUnwatermarkedParams 注入 channel=no / codec_type=8 / logo_type=unwatermarked');
  ok(/codec_type=8/.test(rewritten) && !/codec_type=3/.test(rewritten), '同参数被覆盖而非追加');

  // ⑤ 挑最高清的那一档
  const token = uw.pickMainUrlToken({
    video_list: { a: { main_url: 'low', bitrate: 100 }, b: { main_url: 'high', bitrate: 9000 } },
  });
  ok(token === 'high', 'pickMainUrlToken 挑比特率最高的一档', token);

  // ⑥ 直链 / base64 两种形态
  ok(uw.decodeMainUrl('https://x.com/a.mp4') === 'https://x.com/a.mp4', 'decodeMainUrl 直链原样返回');
  const b64 = Buffer.from('https://cdn.example.com/v.mp4').toString('base64');
  ok(uw.decodeMainUrl(b64) === 'https://cdn.example.com/v.mp4', 'decodeMainUrl 解 base64 形态');

  // ⑦ qAAB 密文：**加解密往返**（最能钉死 key/iv 派生逻辑写没写对）
  //    用同一套派生规则把 URL 加密回去，看解码能不能还原。
  //
  //    ⚠️ 关键细节：token **整体**是一个 base64 串，解码出来的前 4 字节就是魔数
  //    `a8 00 01 00`。它之所以长成 `qAAB` 开头，正是因为
  //    base64(a8 00 01 00 ...) 的前 4 个字符恰好是 "qAAB"。
  //    所以构造时不能写成 `'qAAB' + base64(...)`（那是双重编码）——
  //    这个坑我第一版测试就踩了，payload 前面多出 3 个字节，解密全废。
  {
    const crypto = await import('node:crypto');
    const keySeedRaw = crypto.randomBytes(32);
    const keySeed = keySeedRaw.toString('base64url');
    const digest1 = crypto.createHash('sha512').update(keySeedRaw.subarray(0, 32)).digest();
    const salt = Buffer.from(uw.QAAB_SALT_HEX, 'hex');
    const digest2 = crypto.createHash('sha512').update(Buffer.concat([digest1, salt])).digest();
    const key = digest2.subarray(0, 16);
    const iv = digest2.subarray(16, 32);
    const plain = Buffer.from('https://cdn.example.com/no-watermark.mp4');
    const pad = 16 - (plain.length % 16);
    const padded = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    cipher.setAutoPadding(false);
    const enc = Buffer.concat([cipher.update(padded), cipher.final()]);
    const qaab = Buffer.concat([Buffer.from([0xa8, 0x00, 0x01, 0x00]), enc]).toString('base64');
    ok(qaab.startsWith('qAAB'), '构造出的 token 自然以 qAAB 开头（印证魔数即前缀）', qaab.slice(0, 8));
    const decoded = uw.decodeQaabToken(qaab, keySeed);
    ok(decoded === 'https://cdn.example.com/no-watermark.mp4',
      'decodeQaabToken 往返解密成功（key/iv/salt 派生正确）', decoded || '(空)');
    ok(uw.decodeQaabToken(qaab, '') === '', 'decodeQaabToken 缺 key_seed 时返回空（不瞎猜）');
  }

  // ⑧ 原图直链
  const imgs = uw.findImageOriRawUrls({ a: { image_ori_raw: { url: 'https://p.example.com/1.png' } } });
  ok(imgs.length === 1 && imgs[0].endsWith('1.png'), 'findImageOriRawUrls 取出 image_ori_raw.url');
}

// ================================================================ 网关：视频生成
//
// 只测**校验与拒绝路径** —— 真正提交生成要开浏览器、消耗账号额度，
// 那属于手工验收（见 README 的"端到端验收"），不该塞进冒烟里反复烧额度。

console.log('\n— 网关：视频生成接口 —');
{
  const settings = await call('GET', '/api/settings', { token: adminToken });
  const gk = settings.data.items.find((i) => i.key === 'gateway_key')?.value || '';
  ok(Boolean(gk), '能读到网关密钥');

  const gw = async (method, path, { body, key = gk, token } = {}) => {
    const headers = {};
    if (key) headers['X-Gateway-Key'] = key;
    if (token) headers['X-User-Token'] = token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = {};
    try { data = await res.json(); } catch { /* 空 */ }
    return { status: res.status, data };
  };

  const noKey = await gw('GET', '/api/gateway/health', { key: '' });
  ok(noKey.status === 401, '网关缺密钥 → 401', `实际 ${noKey.status}`);

  const health = await gw('GET', '/api/gateway/health');
  ok(health.data.ok === true && health.data.generation && typeof health.data.generation.running === 'number',
    'health 报告生成队列状态', JSON.stringify(health.data.generation));
  ok(Number.isInteger(health.data.generation?.queueLimit) && Number.isInteger(health.data.generation?.activeTasks),
    '网关 health 转发队列容量状态', JSON.stringify(health.data.generation));

  // 建任务：各种缺参数的拒绝路径
  ok((await gw('POST', '/api/gateway/gen', { body: {} })).status === 400, 'POST /gen 缺 token → 400');
  ok((await gw('POST', '/api/gateway/gen', { body: { token: 'dv_nope' } })).status === 400,
    'POST /gen 缺 prompt → 400');
  const badTok = await gw('POST', '/api/gateway/gen', { body: { token: 'dv_definitely_not_real', prompt: 'x' } });
  ok(badTok.status === 401, 'POST /gen 假令牌 → 401', `实际 ${badTok.status}`);
  const badPts = await gw('POST', '/api/gateway/gen', { body: { token: 'dv_nope', prompt: 'x', points: -1 } });
  ok(badPts.status === 401 || badPts.status === 400, 'POST /gen 非法 points 被拒', `实际 ${badPts.status}`);

  // 查询 / 下载：先验证缺令牌，再验证带无效令牌查询不存在任务。
  ok((await gw('GET', '/api/gateway/gen/99999999')).status === 401, 'GET /gen/:id 缺令牌 → 401');
  ok((await gw('GET', '/api/gateway/gen/99999999', { token: 'dv_unknown' })).status === 404, 'GET /gen/:id 不存在 → 404');
  const noFile = await gw('GET', '/api/gateway/gen/99999999/file', { token: 'dv_unknown' });
  ok(noFile.status === 404, 'GET /gen/:id/file 不存在 → 404');

  // 列表要令牌
  ok((await gw('GET', '/api/gateway/gen')).status === 400, 'GET /gen 缺 token → 400');
}

// ================================================================ 代理
//
// 这组测试是**回归防线**：曾经因为 `String(acc?.proxy || acc || '')` 的写法，
// 在"没配代理"时把整个账号对象 stringify 成 "[object Object]" 当代理地址用，
// 导致所有账号在生成前体检时集体失败、且错误信息完全指不到这里。
// 这类 bug 不写测试根本防不住。

console.log('\n— 出口代理 —');
{
  const px = await import('../server/dola/proxy.js');

  // ① 没配代理时**必须**返回空（不能回落到账号对象）
  const noProxyAcc = { id: 1, label: 'x', proxy: '' };
  ok(px.proxyUrlOf(noProxyAcc) === null, 'proxy 为空 → proxyUrlOf 返回 null', String(px.proxyUrlOf(noProxyAcc)));
  ok(px.proxyOf(noProxyAcc) === undefined, 'proxy 为空 → proxyOf 返回 undefined');
  ok(px.proxyUrlOf({ id: 2, label: 'y' }) === null, 'proxy 字段缺失 → 返回 null');
  ok(!String(px.proxyUrlOf(noProxyAcc)).includes('object'), '**不能**把账号对象 stringify 成 [object Object]');

  // ② 脏值当"无代理"处理（而不是拿去建 ProxyAgent）
  ok(px.proxyUrlOf({ id: 3, proxy: '[object Object]' }) === null, '脏值 "[object Object]" → 按无代理处理');

  // ③ 正常值原样带出
  const good = 'http://B_1_KR___30_Ab000001:pw@gate2.ipweb.cc:7778';
  ok(px.proxyUrlOf({ id: 4, proxy: good }) === good, '正常代理原样返回');
  const po = px.proxyOf({ id: 4, proxy: good });
  ok(po?.server === 'http://gate2.ipweb.cc:7778' && po.username === 'B_1_KR___30_Ab000001' && po.password === 'pw',
    'proxyOf 拆出 server/username/password', JSON.stringify(po));
  // 也支持直接传字符串
  ok(px.proxyUrlOf(good) === good, '直接传代理字符串也支持');

  // ④ 自编代理的生成 / 解析往返
  // 注意两点（都改过）：
  //   ① 协议必须是 **socks5** —— IPWeb 的 HTTP 代理模式不接受我们的认证（见 proxy.js）
  //   ② minutes 会被**夹到 1~30**（IPWeb 粘性会话上限就是 30 分钟），传 60 出来是 30
  const built = px.buildIpwebProxy({ account: 'B_36307', password: 'p@ss word', country: 'KR', minutes: 60, sid: 'D0000110' });
  ok(built.startsWith('socks5://B_36307_KR___30_D0000110:'), 'buildIpwebProxy 拼出正确用户名（socks5 + 夹到 30 分钟）', built.slice(0, 50));
  const back = px.parseIpwebExport(built);
  ok(back.account === 'B_36307' && back.country === 'KR' && back.minutes === 30 && back.sid === 'D0000110',
    '往返：解析回原参数', JSON.stringify(back));
  ok(back.password === 'p@ss word', '往返：含特殊字符的密码正确');

  // 回归：**端口不能被当成密码**（曾经因此让所有代理认证失败）
  const portCase = px.parseIpwebExport('gate2.ipweb.cc:7778:B_102773_KR_2167_13904_30_xaqBg1pe:g3Ro267Rbx');
  ok(portCase.password === 'g3Ro267Rbx', '**不能把端口 7778 当成密码**', portCase.password);
  ok(portCase.gateway === 'gate2.ipweb.cc', '网关解析正确');
  const order2 = px.parseIpwebExport('B_36424_HK___10_Ab000001:123456:gate1.ipweb.cc:7778');
  ok(order2.password === '123456' && order2.gateway === 'gate1.ipweb.cc', '第二种段序（账号在前）也正确', JSON.stringify(order2));

  // ⑤ 解析 IPWeb 后台导出的两种段序（官方文档里两种都列了）
  const a1 = px.parseIpwebExport('gate1.ipweb.cc:7778:B_36307_US_1474_10748_5_Ab000001:123456');
  ok(a1.account === 'B_36307' && a1.country === 'US' && a1.state === '1474' && a1.minutes === 5 && a1.gateway === 'gate1.ipweb.cc',
    '解析「服务器在前」的导出行', JSON.stringify(a1));
  const a2 = px.parseIpwebExport('B_36424_HK___10_Ab000001:123456:gate1.ipweb.cc:7778');
  ok(a2.account === 'B_36424' && a2.country === 'HK' && a2.state === '' && a2.gateway === 'gate1.ipweb.cc',
    '解析「账号在前」的导出行（州/城市留空）', JSON.stringify(a2));

  // ⑥ SID 稳定：同一个 id 必须永远派生出同一个 SID，否则重启后换 IP 代理就白配了
  ok(px.sidForAccount(110) === px.sidForAccount(110), 'sidForAccount 对同一 id 稳定');
  ok(px.sidForAccount(110) !== px.sidForAccount(111), '不同 id 派生出不同 SID');
  ok(/^[A-Za-z0-9]{8}$/.test(px.sidForAccount(12345)), 'SID 是 8 位字母数字', px.sidForAccount(12345));

  // ⑦ 打码
  // ⚠️ 断言用的密码要挑一个不会出现在主机名里的字符串 ——
  //    最初用 'pw' 当密码，结果 `ipweb.cc` 里正好含 "pw"，测试假失败了一次。
  const secret = 'Zq7-secret';
  const withSecret = `http://B_1_KR___30_Ab000001:${secret}@gate2.ipweb.cc:7778`;
  ok(!px.maskProxy(withSecret).includes(secret), 'maskProxy 不泄漏密码', px.maskProxy(withSecret));
  ok(px.maskProxy(withSecret).includes('***'), 'maskProxy 用 *** 占位');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
