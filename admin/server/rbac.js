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
  { code: 'dola:import', label: '导入账号', group: 'dola 账号池' },
  { code: 'dola:check', label: '批量校验账号', group: 'dola 账号池' },
  { code: 'dola:update', label: '修改账号', group: 'dola 账号池' },
  { code: 'dola:delete', label: '删除账号', group: 'dola 账号池' },
  { code: 'dola:convert', label: '额度转积分', group: 'dola 账号池' },
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
