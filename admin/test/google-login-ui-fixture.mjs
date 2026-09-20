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

const app = express();
const sessions = new Map();
const ownerId = 1;
const manager = new GoogleLoginManager({
  lookupAccount: () => null,
  storeAccount: () => ({ id: 9001 }),
  driver: {
    async open({ email }) {
      if (!/^synthetic-[^@]+@example\.test$/.test(email)) throw new Error('Synthetic accounts only');
      const session = {
        completed: false,
        async inspect() {
          return session.completed
            ? { kind: 'ready', identity: { email, email_verified: true, sub: 'synthetic-sub' } }
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
app.get(`${endpoint}/current`, (req, res) => res.json({ ok: true, batch: manager.current(ownerId) }));
app.post(endpoint, (req, res) => {
  try {
    const batch = manager.create(req.body.raw, ownerId);
    delete req.body.raw;
    res.json({ ok: true, batch });
  } catch { res.status(400).json({ ok: false, message: 'Fixture input rejected' }); }
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
