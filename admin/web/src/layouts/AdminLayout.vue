<template>
  <el-container class="shell">
    <el-aside :width="collapsed ? '64px' : '210px'" class="aside">
      <div class="brand">
        <div class="logo">A</div>
        <transition name="fade"><span v-show="!collapsed" class="brand-text">管理后台</span></transition>
      </div>
      <el-menu
        :default-active="$route.path"
        :collapse="collapsed"
        :collapse-transition="false"
        router
        class="menu"
      >
        <el-menu-item v-for="m in menus" :key="m.path" :index="m.path">
          <el-icon><component :is="m.icon" /></el-icon>
          <template #title>{{ m.title }}</template>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="header">
        <el-icon class="collapse-btn" @click="collapsed = !collapsed">
          <component :is="collapsed ? 'Expand' : 'Fold'" />
        </el-icon>
        <el-breadcrumb separator="/">
          <el-breadcrumb-item>{{ currentTitle }}</el-breadcrumb-item>
        </el-breadcrumb>

        <div class="spacer" />

        <!-- 前台入口：配置了地址且有权限才显示 -->
        <el-tooltip v-if="can('frontend:open')" :content="frontendTip">
          <el-button size="small" class="fe-btn" :type="fe.configured ? 'default' : 'primary'" plain @click="openFrontend">
            <el-icon><Monitor /></el-icon>
            <span class="fe-name">{{ fe.configured ? fe.name : '前台' }}</span>
          </el-button>
        </el-tooltip>
        <el-tooltip v-if="fe.browserOpen" content="关闭服务器上的前台浏览器">
          <el-icon class="icon-btn" @click="closeFrontend"><CircleClose /></el-icon>
        </el-tooltip>

        <el-tooltip :content="state.dark ? '切换到浅色' : '切换到深色'">
          <el-icon class="icon-btn" @click="toggleTheme">
            <component :is="state.dark ? 'Sunny' : 'Moon'" />
          </el-icon>
        </el-tooltip>

        <el-dropdown @command="onCommand">
          <span class="user">
            <el-avatar :size="28" class="avatar">{{ avatarText }}</el-avatar>
            <span class="uname">{{ state.user?.nickname || state.user?.username }}</span>
            <!--
              昵称和角色名相同时（默认超管的昵称就是「超级管理员」）不再重复打一遍标签 ——
              并排显示两个一模一样的词看着像 bug。
            -->
            <el-tag
              v-if="state.user?.role_name && state.user.role_name !== (state.user.nickname || state.user.username)"
              size="small" type="info" effect="plain" class="role-tag"
            >
              {{ state.user.role_name }}
            </el-tag>
            <el-icon class="caret"><ArrowDown /></el-icon>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="profile">个人设置</el-dropdown-item>
              <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </el-header>

      <el-main class="main">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';
import { state, toggleTheme, logout, can } from '../store.js';
import { menuItems } from '../router.js';

const route = useRoute();
const router = useRouter();
const collapsed = ref(false);
const menus = computed(() => menuItems());
const currentTitle = computed(() => route.meta?.title || '');
const avatarText = computed(() => (state.user?.nickname || state.user?.username || '?').slice(0, 1).toUpperCase());

// ---------------- 前台入口 ----------------
const fe = ref({ name: '前台', url: '', mode: 'tab', configured: false, browserOpen: false, playwright: false });

const frontendTip = computed(() => {
  if (!fe.value.configured) return '还没配置前台地址 —— 点这里去系统设置里填';
  if (fe.value.mode === 'browser') return `在后台所在机器上打开「${fe.value.name}」\n${fe.value.url}`;
  return `新标签页打开「${fe.value.name}」\n${fe.value.url}`;
});

async function loadFrontend() {
  try { fe.value = { ...fe.value, ...(await api.get('/api/frontend/config', { silent: true })) }; } catch { /* 无权限 */ }
}

async function openFrontend() {
  // 没配地址就直接把人带到设置页，别给个死按钮
  if (!fe.value.configured) {
    try {
      await ElMessageBox.confirm(
        '还没配置前台地址。去「系统设置 → 前台入口」填上地址后，这个按钮就能一键打开前台了。',
        '先配置前台地址', { confirmButtonText: '去配置', cancelButtonText: '取消', type: 'info' },
      );
    } catch { return; }
    router.push('/settings');
    return;
  }
  try {
    const r = await api.post('/api/frontend/open', {});
    if (r.mode === 'tab') {
      window.open(r.url, '_blank', 'noopener');
    } else {
      ElMessage.success(r.message || '已打开');
      fe.value = { ...fe.value, browserOpen: true };
    }
  } catch { /* api 已提示 */ }
}

async function closeFrontend() {
  const r = await api.post('/api/frontend/close', {});
  ElMessage.success(r.closed ? '已关闭前台浏览器' : '本来就没开着');
  fe.value = { ...fe.value, browserOpen: false };
}

onMounted(loadFrontend);

async function onCommand(cmd) {
  if (cmd === 'profile') return router.push('/profile');
  if (cmd === 'logout') {
    try {
      await ElMessageBox.confirm('确定要退出登录吗？', '退出', { type: 'warning' });
    } catch { return; }
    await logout();
    ElMessage.success('已退出');
    router.push('/login');
  }
}
</script>

<style scoped>
.shell { height: 100%; }
.aside {
  background: var(--el-bg-color-page);
  border-right: 1px solid var(--el-border-color-light);
  transition: width .2s;
  overflow: hidden;
}
.brand { display: flex; align-items: center; gap: 10px; padding: 16px 18px; height: 60px; box-sizing: border-box; }
.logo {
  width: 30px; height: 30px; flex: 0 0 30px; border-radius: 9px;
  background: linear-gradient(135deg, var(--el-color-primary), #7c6bff);
  color: #fff; font-size: 15px;
  display: grid; place-items: center; font-weight: 700;
  box-shadow: 0 2px 8px rgba(64, 158, 255, .28);
}
.brand-text { font-weight: 600; white-space: nowrap; letter-spacing: .3px; }
.menu { border-right: 0; background: transparent; }
/* 菜单项圆角 + 左右留白，默认是通栏直角，和整体的圆角语言不搭 */
.menu :deep(.el-menu-item) {
  margin: 3px 10px;
  border-radius: var(--adm-radius-sm);
  height: 42px;
  line-height: 42px;
}
.menu :deep(.el-menu-item.is-active) { font-weight: 600; }
.header {
  display: flex; align-items: center; gap: 14px;
  border-bottom: 1px solid var(--el-border-color-light);
  background: var(--el-bg-color);
}
.collapse-btn, .icon-btn { cursor: pointer; font-size: 18px; color: var(--el-text-color-regular); display: inline-flex; }
.fe-btn { display: inline-flex; align-items: center; gap: 5px; }
@media (max-width: 900px) { .fe-name { display: none; } }
.collapse-btn:hover, .icon-btn:hover { color: var(--el-color-primary); }
.spacer { flex: 1; }
.user { display: flex; align-items: center; gap: 8px; cursor: pointer; outline: none; }
.avatar { background: linear-gradient(135deg, var(--el-color-primary), #7c6bff); font-size: 13px; }
.uname { font-size: 13px; }
.role-tag { transform: scale(.92); }
.caret { font-size: 12px; color: var(--el-text-color-secondary); }
.main { background: var(--el-bg-color-page); padding: 18px; }
.fade-enter-active, .fade-leave-active { transition: opacity .16s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
@media (max-width: 700px) { .uname { display: none; } }
</style>
