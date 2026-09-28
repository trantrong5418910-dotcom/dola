/**
 * 权限点清单。前端菜单和后端校验都用它，避免两边各写一份。
 *
 * 加新模块：往 PERMISSIONS 里加一行，然后
 *   1) 路由上挂 requirePerm('xxx:list')
 *   2) 前端 router.js 的 meta.perm 写上同样的 code
 */

/** @type {{code:string,label:string,group:string}[]} */
export const PERMISSIONS = [
  { code: 'dashboard:view', label: '查看仪表盘', group: '仪表盘' },
  { code: 'user:list', label: '查看用户', group: '用户' },
  { code: 'user:create', label: '新建用户', group: '用户' },
  { code: 'user:update', label: '修改用户', group: '用户' },
  { code: 'user:delete', label: '删除用户', group: '用户' },
  { code: 'role:list', label: '查看角色', group: '角色' },
  { code: 'role:update', label: '配置权限', group: '角色' },
  { code: 'content:list', label: '查看内容', group: '内容' },
  { code: 'content:create', label: '新建内容', group: '内容' },
  { code: 'content:update', label: '修改内容', group: '内容' },
  { code: 'content:delete', label: '删除内容', group: '内容' },
  { code: 'token:list', label: '查看令牌', group: '令牌' },
  { code: 'token:generate', label: '生成令牌', group: '令牌' },
  { code: 'token:update', label: '修改令牌（启停/积分）', group: '令牌' },
  { code: 'token:delete', label: '删除令牌', group: '令牌' },
  { code: 'token:reveal', label: '查看令牌完整值', group: '令牌' },
  { code: 'card:list', label: '查看卡密', group: '充值卡' },
  { code: 'card:generate', label: '生成卡密', group: '充值卡' },
  { code: 'card:update', label: '修改卡密（撤销）', group: '充值卡' },
  { code: 'card:delete', label: '删除卡密', group: '充值卡' },
  { code: 'card:redeem', label: '手动兑换卡密', group: '充值卡' },
  { code: 'dola:list', label: '查看 dola 账号', group: 'dola 账号池' },
  { code: 'dola:reveal', label: '查看账号完整 cookie', group: 'dola 账号池' },
  { code: 'dola:resolve', label: '处理未结算提交（退款/放行账号）', group: 'dola 账号池' },
  { code: 'dola:import', label: '导入账号', group: 'dola 账号池' },
  { code: 'dola:check', label: '批量校验账号', group: 'dola 账号池' },
  { code: 'dola:update', label: '修改账号', group: 'dola 账号池' },
  { code: 'dola:delete', label: '删除账号', group: 'dola 账号池' },
  { code: 'dola:convert', label: '额度转积分', group: 'dola 账号池' },
  { code: 'dola:create', label: '创建生成任务', group: 'dola 账号池' },
  // ★ 删任务与删账号是两件事，不复用 dola:delete（后者语义是「删除 dola 账号」）。
  // 2026-09-27 成片库删除功能新增；超级管理员 permissions=['*'] 自动放行。
  { code: 'dola:task:delete', label: '删除生成任务（成片库）', group: 'dola 账号池' },
  { code: 'script:list', label: '查看脚本工作台', group: '脚本工作台' },
  { code: 'script:generate', label: '生成脚本', group: '脚本工作台' },
  { code: 'script:update', label: '编辑脚本', group: '脚本工作台' },
  { code: 'script:delete', label: '删除脚本', group: '脚本工作台' },
  { code: 'material:list', label: '查看素材', group: '素材库' },
  { code: 'material:create', label: '新建素材', group: '素材库' },
  { code: 'material:update', label: '修改素材', group: '素材库' },
  { code: 'material:delete', label: '删除素材', group: '素材库' },
  // ★ 参考图库是**独立模块**，不复用 material:* ——
  // 素材是「提示词 + 可选参考图」的模板，参考图库是「可复用的图片资产」，
  // 两者权限面不同（参考图库要被分镜页读取，素材库不需要）。
  // ⚠️ 新增权限点不会自动授予已有角色：超级管理员（permissions=['*']）自动放行，
  //    其它角色需要到「角色」页手动勾选，否则图库页面与分镜页的「从图库选」会 403。
  { code: 'refimage:list', label: '查看参考图库', group: '参考图库' },
  { code: 'refimage:create', label: '收图进图库（上传/直链/分镜图）', group: '参考图库' },
  { code: 'refimage:update', label: '修改参考图（改名/标签）', group: '参考图库' },
  { code: 'refimage:delete', label: '删除参考图', group: '参考图库' },
  { code: 'setting:view', label: '查看设置', group: '系统' },
  { code: 'setting:update', label: '修改设置', group: '系统' },
  { code: 'log:list', label: '查看操作日志', group: '系统' },
  { code: 'frontend:open', label: '打开前台', group: '前台' },
  { code: 'frontend:manage', label: '配置前台地址', group: '前台' },
  { code: 'gateway:manage', label: '管理用户端网关', group: '用户端网关' },
];

export const ALL_PERMISSIONS = PERMISSIONS.map((p) => p.code);

export function groupedPermissions() {
  const map = new Map();
  for (const p of PERMISSIONS) {
    if (!map.has(p.group)) map.set(p.group, []);
    map.get(p.group).push(p);
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }));
}
