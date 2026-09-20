import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import * as Icons from '@element-plus/icons-vue';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import './styles.css';   // 全局视觉统一：卡片/表格/深色三层明度、滚动条等

import App from './App.vue';
import { router } from './router.js';
import { ensureBootstrap, applyTheme } from './store.js';
import { setUnauthorizedHandler } from './api.js';

const app = createApp(App);

// 全量注册图标，模板里可直接 <el-icon><Odometer /></el-icon>
for (const [name, comp] of Object.entries(Icons)) app.component(name, comp);

app.use(ElementPlus, { locale: zhCn });
app.use(router);

applyTheme();

// 401 统一踢回登录页
setUnauthorizedHandler(() => {
  if (router.currentRoute.value.path !== '/login') router.push({ path: '/login' });
});

// 先用本地 token 恢复登录态再挂载，避免刷新时闪一下登录页
// （路由守卫内部也会 await 同一个 promise，两处都安全）
ensureBootstrap().finally(() => app.mount('#app'));
