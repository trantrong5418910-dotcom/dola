<template>
  <div class="login-page">
    <div class="card">
      <div class="head">
        <div class="logo">A</div>
        <h1>{{ siteName }}</h1>
        <p class="muted">请使用管理员账号登录</p>
      </div>

      <el-form :model="form" @submit.prevent="submit" size="large">
        <el-form-item>
          <el-input v-model="form.username" placeholder="用户名" :prefix-icon="User" clearable @keyup.enter="submit" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="form.password" type="password" placeholder="密码" :prefix-icon="Lock" show-password @keyup.enter="submit" />
        </el-form-item>
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="err" />
        <el-button type="primary" class="full" :loading="loading" @click="submit">登 录</el-button>
      </el-form>

      <p class="hint">
        默认账号 <code>admin</code> / <code>admin123</code>，首次登录后请到「个人设置」改密码。
      </p>
    </div>

    <el-icon class="theme-toggle" @click="toggleTheme">
      <component :is="state.dark ? 'Sunny' : 'Moon'" />
    </el-icon>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { User, Lock } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { state, login, toggleTheme } from '../store.js';
import { api } from '../api.js';

const router = useRouter();
const route = useRoute();
const form = reactive({ username: '', password: '' });
const loading = ref(false);
const error = ref('');
const siteName = ref('管理后台');

onMounted(async () => {
  try {
    const { siteName: n } = await api.get('/api/settings/public', { silent: true });
    if (n) siteName.value = n;
  } catch { /* 用默认标题 */ }
});

async function submit() {
  error.value = '';
  if (!form.username || !form.password) { error.value = '请输入用户名和密码'; return; }
  loading.value = true;
  try {
    const user = await login(form.username, form.password);
    ElMessage.success(`欢迎回来，${user.nickname || user.username}`);
    router.replace(route.query.redirect || '/dashboard');
  } catch (e) {
    error.value = e.message || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100%; display: grid; place-items: center; padding: 24px;
  background: var(--el-bg-color-page); position: relative;
}
.card {
  width: 100%; max-width: 380px; padding: 32px 28px;
  background: var(--el-bg-color); border: 1px solid var(--el-border-color-light);
  border-radius: 14px; box-shadow: var(--el-box-shadow-light);
}
.head { text-align: center; margin-bottom: 22px; }
.logo {
  width: 46px; height: 46px; margin: 0 auto 12px; border-radius: 12px;
  background: var(--el-color-primary); color: #fff;
  display: grid; place-items: center; font-size: 22px; font-weight: 700;
}
h1 { font-size: 18px; margin: 0 0 6px; }
.muted { color: var(--el-text-color-secondary); font-size: 13px; margin: 0; }
.full { width: 100%; }
.err { margin-bottom: 12px; }
.hint { margin: 18px 0 0; font-size: 12px; color: var(--el-text-color-secondary); text-align: center; line-height: 1.8; }
.hint code { background: var(--el-fill-color); padding: 1px 5px; border-radius: 4px; }
.theme-toggle { position: absolute; top: 22px; right: 26px; font-size: 19px; cursor: pointer; color: var(--el-text-color-secondary); }
.theme-toggle:hover { color: var(--el-color-primary); }
</style>
