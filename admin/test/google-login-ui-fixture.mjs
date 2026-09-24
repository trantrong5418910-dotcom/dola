/** Local UI rehearsal only: no database, proxy, real browser login or upstream requests.
 * Run: node test/google-login-ui-fixture.mjs
 * Use synthetic-one@example.test|synthetic-password and a second synthetic account.
 * The fixture's Check action simulates completion; it is never mounted by server/index.js.
 */
import express from 'express';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { GoogleLoginManager } from '../server/dola/google-login-core.js';
import { parseAccountLoginEntries } from '../server/dola/account-login-format.js';

const app = express();
const sessions = new Map();
const ownerId = 1;
const profiles = new Map();
function syntheticEntries(raw, manual) {
  const entries = parseAccountLoginEntries(raw, { manual });
  if (!entries.every(({ email }) => /^synthetic-[^@]+@example\.test$/.test(email))) {
    throw Object.assign(new Error('隔离演练只接受 synthetic- 开头、example.test 结尾的模拟邮箱；请勿输入真实账号'), { status: 400 });
  }
  return entries;
}
const manager = new GoogleLoginManager({
  reserveProfiles: entries => entries.map(({ email }) => {
    if (!profiles.has(email)) profiles.set(email, { email, profileId: profiles.size + 1, accountCode: `A${String(profiles.size + 1).padStart(2, '0')}` });
    return profiles.get(email);
  }),
  lookupAccount: () => null,
  storeAccount: () => ({ id: 9001 }),
  driver: {
    async open({ email, loginMethod }) {
      if (!/^synthetic-[^@]+@example\.test$/.test(email)) throw new Error('Synthetic accounts only');
      const session = {
        completed: false,
        async inspect() {
          return session.completed
            ? (loginMethod === 'manual'
              ? { kind: 'ready', manual: true, identity: null, sessionVerified: true, profile: { ok: true, id: 'synthetic-id' } }
              : { kind: 'ready', identity: { email, email_verified: true, sub: 'synthetic-sub' } })
            : { kind: 'waiting_user', reason: 'captcha' };
        },
        async close() { sessions.delete(email); },
      };
      sessions.set(email, session);
      return session;
    },
  },
});
app.use(express.json({ limit: '40kb' }));
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const endpoint = '/api/dola/google-login/batches';
app.post('/api/dola/google-login/preview', (req, res) => {
  try {
    const entries = syntheticEntries(req.body.raw, req.body.manual === true);
    res.json({ ok: true, items: entries.map(({ email, loginMethod, recoveryEmail, verificationUrl }) => ({
      email, loginMethod, hasRecoveryEmail: Boolean(recoveryEmail), hasVerificationUrl: Boolean(verificationUrl),
    })) });
  } catch (e) { res.status(400).json({ ok: false, message: e.status ? e.message : 'Fixture input rejected' }); }
  finally { delete req.body.raw; }
});
app.get(`${endpoint}/current`, (req, res) => res.json({ ok: true, batch: manager.current(ownerId) }));
app.post(endpoint, (req, res) => {
  try {
    syntheticEntries(req.body.raw, req.body.manual === true);
    const batch = manager.create(req.body.raw, ownerId, { manual: req.body.manual === true });
    delete req.body.raw;
    res.json({ ok: true, batch });
  } catch { res.status(400).json({ ok: false, message: 'Fixture input rejected' }); }
  finally { delete req.body.raw; }
});
app.post(`${endpoint}/:id/action`, async (req, res) => {
  try {
    // Explicit fixture behavior, not a real authentication result.
    if (req.body.action === 'check') {
      const batch = manager.current(ownerId);
      const session = sessions.get(batch?.items[batch.currentIndex]?.email);
      if (session) session.completed = true;
    }
    res.json({ ok: true, batch: await manager.action(req.params.id, ownerId, req.body.action) });
  } catch { res.status(409).json({ ok: false, message: 'Fixture action rejected' }); }
});
app.use('/api', (req, res) => res.status(404).json({ ok: false, message: 'Fixture route only' }));
const vite = await createServer({
  configFile: false, root: fileURLToPath(new URL('../web', import.meta.url)),
  plugins: [vue()], appType: 'custom', server: { middlewareMode: true, hmr: false },
});
app.use(vite.middlewares);
app.get('/', async (req, res) => res.type('html').send(await vite.transformIndexHtml('/', `
<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Google 登录隔离演练</title></head>
<body><h2>隔离演练：仅合成账号，不连接 Google、不写号池</h2><div id="app"></div>
<script type="module">
import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import Login from '/src/components/DolaGoogleLogin.vue';
createApp(Login).use(ElementPlus).mount('#app');
</script></body></html>`)));
const server = app.listen(18991, '127.0.0.1', () => console.log('Isolated UI fixture: http://127.0.0.1:18991/'));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  await manager.close(); await vite.close(); server.close(() => process.exit(0));
});
