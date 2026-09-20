/**
 * Provider 注册表 —— 换服务只改配置里的 `provider` 名字，上层代码一行不动。
 *
 * 加一个新 provider：实现下面 5 个方法，再在这里注册即可。
 *   login() / createTask() / getTask() / listTasks() / download()
 *
 * 四个内置 provider：
 *   mock           —— 本地假数据，不联网（默认，跑测试用）
 *   dola-workbench —— 老视频工作台（43.254.166.145）
 *   dola-api       —— 新 Bearer Token API（43.254.166.196，文档契约）
 *   admin-dola     —— 走管理后台网关：后台自己挑 dola 账号开浏览器生成，
 *                     完成时返回**无水印直链**。生产建议用这个。
 */
import { DolaWorkbenchProvider } from './dola-workbench.js';
import { DolaApiProvider } from './dola-api.js';
import { AdminDolaProvider } from './admin-dola.js';
import { MockProvider } from './mock.js';
import { ConfigError } from '../core/errors.js';

/** @type {Record<string, (opts:object)=>object>} */
const REGISTRY = {
  'dola-workbench': (o) => new DolaWorkbenchProvider(o),
  dola: (o) => new DolaWorkbenchProvider(o),
  'dola-api': (o) => new DolaApiProvider(o),
  'admin-dola': (o) => new AdminDolaProvider(o),
  mock: (o) => new MockProvider(o),
};

export function listProviders() {
  return Object.keys(REGISTRY);
}

/**
 * @param {string} name provider 名
 * @param {object} [opts] 透传给 provider 构造函数的配置
 */
export function createProvider(name = process.env.VIDEO_PROVIDER || 'mock', opts = {}) {
  const key = String(name).toLowerCase();
  const factory = REGISTRY[key];
  if (!factory) {
    throw new ConfigError(`未知 provider：${name}。可用：${listProviders().join(', ')}`);
  }
  return factory(opts);
}

export { DolaWorkbenchProvider, DolaApiProvider, AdminDolaProvider, MockProvider };
