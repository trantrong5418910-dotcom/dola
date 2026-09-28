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

        <!-- 全局忙碌进度条：有请求在飞时在 header 下沿滑一条，慢操作时不至于让人以为没点生效 -->
        <div v-show="isBusy" class="busy-bar" :title="busyText"><i /></div>
      </el-header>

      <el-main class="main">
        <!--
          路由切换时的兜底骨架：懒加载的页面 chunk 在弱网/首次访问时会有一段时间没有内容，
          期间必须先给个「正在加载」，否则就是一片无提示的空白（Bug-1 的观感来源之一）。
          延迟 120ms 才显示，避免瞬时完成的导航闪一下骨架。
          注意：这是**覆盖层**，不能写成 v-if/v-else 去替换 router-view —— 那样每次切换都会
          卸载重建 keep-alive，把页面缓存全丢掉。
        -->
        <div v-if="showRouteLoading" class="route-loading" aria-busy="true" aria-live="polite">
          <el-skeleton :rows="6" animated />
          <div class="route-loading-tip">正在加载页面…</div>
        </div>

        <router-view v-slot="{ Component }">
          <!--
            ★ 这里的 <transition> **不能加 mode="out-in"**（2026-09-27 血泪）。
            原因：out-in 要求子节点是「可对比的单个 vnode」，而它的直接子节点是 <keep-alive>，
            两者 type/key 都不变 ⇒ 过渡机制不接管（连 before-leave/before-enter 都不会触发），
            同时 keep-alive 的子树会被渲染成一个空的注释占位节点。
            表现极具误导性：**第一次点菜单正常，从第二次开始内容区永久空白**，且
            console 零报错、无失败请求；F5 之后恢复正常（重新挂载）。
            已验证：加 mode="out-in" → 第 2 次导航起全部空白；去掉 → 14 个页面 × 深浅两色全通过。
            也验证过「给 component 加 :key」和「把 keep-alive 挪到 transition 外层」都救不回来。
            交叉淡入（无 mode）有约 160ms 的重叠，可接受；如需回到 out-in 请连同 keep-alive 一起重构。
            ⚠ 维护提示：本段注释内禁止出现「两个连续短横线」，否则注释会被提前闭合，后半段正文会直接漏到页面上。
          -->
          <transition name="fade">
            <keep-alive :include="KEEP_ALIVE">
              <component :is="Component" />
            </keep-alive>
          </transition>
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';
import { state, toggleTheme, logout, can } from '../store.js';
import { menuItems, routePending } from '../router.js';
import { isBusy, busyText } from '../busy.js';

/**
 * 哪些页面可以被 keep-alive 缓存。
 *
 * ⚠️ 两个前提，缺一个就会出问题：
 *   1. 被缓存的组件必须有 name（<script setup> 默认没有，要在文件里写
 *      `defineOptions({ name: 'Users' })`）。名字对不上就**静默不缓存**，不报错。
 *   2. 页面里如果自己挂了轮询定时器，必须自己处理启停 —— 组件被缓存后
 *      onUnmounted 不再触发，定时器会在后台一直跑，白烧服务端。
 *      （Dashboard.vue 已经按这个要求改好了，可以当样板 —— 30 秒轮询
 *        onDeactivated 停 / onActivated 续、start 幂等。
 *        注：DolaGenerationAnalytics.vue 也满足这个要求，它挂在 /dola 的
 *        「生成与复核」tab 上，仍然在用；2026-09-27 起仪表盘不再复用它。）
 *
 * 下面这 11 个页面都是「只读或慢改、没有自家定时器」，缓存是安全的。
 */
const KEEP_ALIVE = [
  'Dashboard', 'Users', 'Roles', 'Content', 'Tokens',
  'Cards', 'Materials', 'Settings', 'Logs', 'Profile',
  // 代理池：纯手动刷新，没有轮询定时器，缓存安全
  'ProxyPool',
  // 参考图库：只有「读取凭证」这一个会过期的状态，load() 每次都会重发凭证；
  // 没有轮询定时器，缓存安全（缓存它能让来回切菜单时缩略图不重新请求）。
  'ReferenceImages',
  // 成片库：有「扫描凭证倒计时」一个定时器，但已经按 keep-alive 的规矩处理好了
  // —— 倒计时按截止时刻算而非累减，且 onDeactivated 停表、onActivated 重算。
  // 缓存它的实际收益很大：扫描会话是唯一有出站成本的动作，切个菜单就重扫一遍很浪费。
  'MediaLibrary',
];

// 待启用（各自补一行 defineOptions 就能加进来）：
//   'Dola'    — 页面内有 3 处轮询定时器，需先加 onActivated/onDeactivated 启停
//   'Proxies' — 该文件尚未提交，等它的改动落定后再加

const route = useRoute();
const router = useRouter();

/**
 * 路由加载骨架：延迟 120ms 才显示（见模板里的说明）。
 * routePending 由 router.js 在 beforeEach/afterEach 里维护 —— 它覆盖了
 * 「守卫执行 + 懒加载 chunk 拉取」整段时间，正是会出现无提示空白的那段。
 */
const showRouteLoading = ref(false);
let routeLoadingTimer = null;
watch(routePending, (pending) => {
  clearTimeout(routeLoadingTimer);
  if (pending) {
    routeLoadingTimer = setTimeout(() => { showRouteLoading.value = true; }, 120);
  } else {
    showRouteLoading.value = false;
  }
});
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
  position: relative;
}
/* 全局忙碌进度条：贴在 header 下沿，2px 高，不占布局空间 */
.busy-bar {
  position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
  overflow: hidden; background: var(--el-color-primary-light-8);
}
.busy-bar i {
  display: block; width: 34%; height: 100%;
  background: var(--el-color-primary);
  animation: busy-slide 1.1s ease-in-out infinite;
}
@keyframes busy-slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(330%); }
}
@media (prefers-reduced-motion: reduce) {
  .busy-bar i { animation: none; width: 100%; }
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
.main { background: var(--el-bg-color-page); padding: 18px; position: relative; }
/* 路由加载骨架（覆盖层，见模板注释：必须覆盖而非替换 router-view） */
.route-loading {
  position: absolute; inset: 18px; z-index: 1;
  background: var(--el-bg-color-page);
  padding: 18px; box-sizing: border-box;
}
.route-loading-tip {
  margin-top: 14px; text-align: center;
  font-size: 13px; color: var(--el-text-color-secondary);
}
.fade-enter-active, .fade-leave-active { transition: opacity .16s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
@media (max-width: 700px) { .uname { display: none; } }
</style>
