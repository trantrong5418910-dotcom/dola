import express from 'express';
import { db } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { audit } from '../audit.js';
import { GoogleLoginManager } from '../dola/google-login-core.js';
import { createGoogleBrowserDriver } from '../dola/google-login-browser.js';
import { createGoogleAccountStore } from '../dola/google-login-store.js';
import { createLoginProxyResolver } from '../dola/google-login-proxy.js';
import { parseAccountLoginEntries } from '../dola/account-login-format.js';
import { createLoginProfileRegistry } from '../dola/account-login-registry.js';

let manager;
const service = () => {
  if (!manager) {
    const registry = createLoginProfileRegistry(db);
    // 浏览器启动方式：默认 'cdp' = spawn + connectOverCDP。
    // Playwright 的 launch() 会注入 --enable-automation，页面里 navigator.webdriver === true，
    // Google 据此在「输入账号密码」这一步直接判「此浏览器或应用可能不安全」（2026-09-29 实测）。
    // 需要临时回退旧行为：设 DOLA_LOGIN_LAUNCH_MODE=launch 并重启 dola-admin。
    const launchMode = /^(?:launch|persistent)$/i.test(process.env.DOLA_LOGIN_LAUNCH_MODE || '') ? 'launch' : 'cdp';
    manager = new GoogleLoginManager({ driver: createGoogleBrowserDriver({ launchMode }), ...createGoogleAccountStore(db, { registry }),
      // 直连兜底默认开启（2026-09-29 飞哥确认：优先现有的 IPWeb 代理，腾讯直连 IP 备用）。
      // 需要临时关掉时设 DOLA_LOGIN_ALLOW_DIRECT=0 并重启 dola-admin。
      ...createLoginProxyResolver(db, { allowDirect: !/^(?:0|false|off|no)$/i.test(process.env.DOLA_LOGIN_ALLOW_DIRECT || '') }),
      reserveProfiles: entries => registry.reserve(entries) });
  }
  return manager;
};
export const stopGoogleLogins = () => manager?.close();
export function createGoogleLoginRouter(getManager = service) {
  const router = express.Router();
  router.use(requireAuth, requirePerm('dola:import'));
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Credentials must not cross an unencrypted remote connection. Headed browser is local.
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      return res.status(403).json({ ok: false, message: 'Google 登录入池仅支持在后台所在电脑本机操作' });
    }
    next();
  });
  router.get('/batches/current', (req, res) => res.json({ ok: true, batch: getManager().current(req.user.id) }));
  router.post('/preview', (req, res) => {
    try {
      if (req.body?.manual !== undefined && typeof req.body.manual !== 'boolean') throw Object.assign(new Error('登录方式无效'), { status: 400 });
      const entries = parseAccountLoginEntries(req.body?.raw, { manual: req.body?.manual === true });
      res.json({ ok: true, items: entries.map(({ email, loginMethod, recoveryEmail, verificationUrl }) => ({
        email, loginMethod, hasRecoveryEmail: Boolean(recoveryEmail), hasVerificationUrl: Boolean(verificationUrl),
      })) });
    } catch (e) { res.status(e.status || 400).json({ ok: false, message: e.status ? e.message : '账号格式校验失败' }); }
    finally { if (req.body) delete req.body.raw; }
  });
  router.get('/batches/:id/preview', async (req, res) => {
    try {
      const image = await getManager().preview(req.params.id, req.user.id);
      res.json({ ok: true, image: `data:image/png;base64,${image.toString('base64')}` });
    } catch (e) { res.status(e.status || 500).json({ ok: false, message: e.status ? e.message : '登录窗口预览暂不可用' }); }
  });
  // 可交互画面：后台跑在服务器上时，运营看不到那个有界窗口，
  // 所以把画面 + viewport 尺寸回传，由前端渲染成能点的画布。
  router.get('/batches/:id/surface', async (req, res) => {
    try {
      const surface = await getManager().surface(req.params.id, req.user.id);
      res.json({ ok: true, image: `data:image/png;base64,${surface.image.toString('base64')}`, viewport: surface.viewport });
    } catch (e) { res.status(e.status || 500).json({ ok: false, message: e.status ? e.message : '登录窗口画面暂不可用' }); }
  });
  // 点击 / 滚动 / 按键 / 文本 → 真实窗口。
  // ⚠️ 走同一套鉴权（requireAuth + dola:import + 本机限制），
  // 且**绝不落审计详情、绝不回显事件内容**（可能含账号密码）。
  router.post('/batches/:id/interact', async (req, res) => {
    try {
      const event = req.body?.event;
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw Object.assign(new Error('输入事件无效'), { status: 400 });
      await getManager().interact(req.params.id, req.user.id, event);
      res.json({ ok: true });
    } catch (e) {
      res.status(e.status || 500).json({ ok: false, message: e.status ? e.message : '窗口操作暂不可用' });
    } finally { if (req.body) delete req.body.event; }
  });
  router.post('/batches', (req, res) => {
    try {
      if (req.body?.manual !== undefined && typeof req.body.manual !== 'boolean') throw Object.assign(new Error('登录方式无效'), { status: 400 });
      const batch = getManager().create(req.body?.raw, req.user.id, { manual: req.body?.manual === true });
      if (req.body) delete req.body.raw;
      audit(req, 'dola.google_login_start', 'google_login', batch.id, `独立会话登录 ${batch.items.length} 个账号，不保存密码`);
      res.status(201).json({ ok: true, batch });
    } catch (e) {
      if (req.body) delete req.body.raw;
      res.status(e.status || 500).json({ ok: false, message: e.status ? e.message : '无法创建登录批次' });
    }
  });
  router.post('/batches/:id/action', async (req, res) => {
    try {
      const batch = await getManager().action(req.params.id, req.user.id, req.body?.action);
      audit(req, 'dola.google_login_action', 'google_login', batch.id, req.body.action);
      res.json({ ok: true, batch });
    } catch (e) { res.status(e.status || 500).json({ ok: false, message: e.status ? e.message : '登录操作暂不可用' }); }
  });
  return router;
}
export default createGoogleLoginRouter();
