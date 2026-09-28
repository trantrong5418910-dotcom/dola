<!--
  仪表盘 = 只放「关键可视化饼盘」。

  2026-09-27 精简：原先这里是 10 个统计卡 + 生成统计（3 张明细表）+ dola 账号池表格
  + 内容状态横条 + 最近操作时间线 + 近 7 天柱条 —— 一屏塞不下、要滚动才看得全，
  而真正每天要瞄一眼的只有三件事：**任务成不成、号够不够、内容多少**。
  所以只留三个环，其余全删（统计卡/账号表格/时间线/柱条已移除）。

  ⚠️ 唯一从「生成统计」里抢救出来的功能是 **重复失败保护 · 只读复核** ——
     那个按钮全后台只有这一处能点到，删掉就等于丢了「解除能力保护」的入口。
     所以它被压缩成下方的一张小表保留着。
-->
<template>
  <div v-loading="loading">
    <el-row :gutter="14">
      <!-- ① 生成任务结果 —— 业务最关心的一个环 -->
      <el-col v-if="canDolaList" :xs="24" :sm="24" :md="8">
        <el-card shadow="never" v-loading="genLoading" class="ring-card">
          <template #header>
            <div class="card-head">
              <span class="card-title">生成任务结果</span>
              <el-select v-model="hours" size="small" style="width:112px" @change="() => loadGeneration()">
                <el-option :value="24" label="最近 24 小时" />
                <el-option :value="72" label="最近 3 天" />
                <el-option :value="168" label="最近 7 天" />
              </el-select>
            </div>
          </template>
          <el-alert v-if="genError" :title="genError" type="warning" :closable="false" show-icon class="ring-alert" />
          <DonutRing
            :segments="genSegments"
            :center-value="genCenterValue"
            center-label="已结案成功率"
            :aria-label="`生成任务结果：${rangeLabel}`"
          />
          <p class="ring-note">成功率 = 成功 ÷（成功 + 失败）；取消与进行中不计入。</p>
          <p class="ring-note">全部留存：{{ gen.allTime.created }} 创建 · {{ gen.allTime.succeeded }} 成功 · {{ gen.allTime.failed }} 失败 · {{ gen.allTime.cancelled }} 取消 · {{ gen.allTime.pending }} 进行中</p>
        </el-card>
      </el-col>

      <!-- ② dola 账号池健康 —— 号够不够、有多少已经废了 -->
      <el-col v-if="canDolaList" :xs="24" :sm="24" :md="8">
        <el-card shadow="never" v-loading="accountLoading" class="ring-card">
          <template #header>
            <div class="card-head">
              <span class="card-title">dola 账号池</span>
              <el-button size="small" plain :loading="accountLoading" @click="loadAccounts()">刷新</el-button>
            </div>
          </template>
          <el-alert v-if="accountError" :title="accountError" type="warning" :closable="false" show-icon class="ring-alert" />
          <DonutRing
            :segments="accountSegments"
            :center-value="accountTotal"
            center-label="账号总数"
            aria-label="dola 账号池状态分布"
          />
          <p class="ring-note">
            冷却中 {{ accountState.summary.cooling ?? 0 }} 个
            · 有效号未配代理 {{ accountState.summary.validNoProxy ?? 0 }} 个
          </p>
        </el-card>
      </el-col>

      <!-- ③ 内容状态分布 -->
      <el-col :xs="24" :sm="24" :md="canDolaList ? 8 : 24">
        <el-card shadow="never" class="ring-card">
          <template #header>
            <div class="card-head">
              <span class="card-title">内容状态</span>
              <el-button size="small" plain @click="$router.push('/contents')">内容管理</el-button>
            </div>
          </template>
          <DonutRing
            :segments="contentSegments"
            :center-value="contentTotal"
            center-label="内容总数"
            aria-label="内容状态分布"
          />
        </el-card>
      </el-col>
    </el-row>

    <!--
      从「生成统计与复核」里唯一保留的功能块。
      这处按钮是**全后台唯一**能给账号解除「重复失败保护」的入口，不能跟着明细表一起删。
    -->
    <el-card v-if="canDolaList" shadow="never" class="mt">
      <template #header>
        <div class="card-head">
          <div>
            <span class="card-title">重复失败保护</span>
            <span class="muted card-sub">{{ guards.length }} 项待复核</span>
          </div>
          <el-button size="small" plain @click="$router.push('/dola')">完整账号池</el-button>
        </div>
      </template>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        class="guard-alert"
        title="能力失败后暂停该账号该能力的提交。只有通过绑定代理做一次只读控件复核才能解除 —— 不填提示词、不生成视频、不消耗额度；复核通过也不代表有额度或能保证成片。"
      />
      <el-table :data="guards" border stripe size="small" empty-text="暂无待复核保护项">
        <el-table-column prop="account_id" label="账号 ID" width="90" />
        <el-table-column prop="label" label="暂停能力" min-width="130" />
        <el-table-column label="触发任务" width="100">
          <template #default="{ row }">#{{ row.source_task_id }}</template>
        </el-table-column>
        <el-table-column label="触发时间" min-width="175">
          <template #default="{ row }">{{ fmt(row.blocked_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" min-width="170">
          <template #default="{ row }">
            <el-button
              v-if="canDolaCheck"
              size="small"
              :disabled="Boolean(probing)"
              :loading="probing === `${row.account_id}/${row.scope}`"
              @click="probeGuard(row)"
            >只读复核后恢复</el-button>
            <span v-else class="muted">需账号校验权限</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
// keep-alive 靠组件名匹配 include，<script setup> 默认没有 name，
// 少了这一行缓存会**静默失效**（不报错、也不生效）。
defineOptions({ name: 'Dashboard' });
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, qs } from '../api.js';
import { can } from '../store.js';
import DonutRing from '../components/DonutRing.vue';

/**
 * 环图的取色。直接写死 Element Plus 的色板值（而不是 var(--el-color-*)）：
 * SVG 的 stroke 吃 CSS 变量是没问题的，但图例里的圆点是靠 background 上色的，
 * 两处都写成同一个字面量最不容易出现「环上一个色、图例另一个色」。
 */
const PALETTE = {
  ok: '#67c23a', danger: '#f56c6c', warn: '#e6a23c', info: '#909399', brand: '#9b6eff',
};

const loading = ref(true);
const canDolaList = computed(() => can('dola:list'));
const canDolaCheck = computed(() => can('dola:check'));

/* ---------------- ① 生成任务结果 ---------------- */

const EMPTY_COUNTS = { created: 0, succeeded: 0, failed: 0, cancelled: 0, pending: 0, other: 0 };
const hours = ref(24);
const genLoading = ref(false);
const genError = ref('');
const gen = ref({ totals: { ...EMPTY_COUNTS }, allTime: { ...EMPTY_COUNTS }, successRate: null });
const guards = ref([]);
const probing = ref('');

const rangeLabel = computed(() => ({ 24: '最近 24 小时', 72: '最近 3 天', 168: '最近 7 天' }[hours.value] || ''));

const genSegments = computed(() => {
  const t = gen.value.totals || {};
  return [
    { key: 'succeeded', label: '成功', value: t.succeeded || 0, color: PALETTE.ok },
    { key: 'failed', label: '失败', value: t.failed || 0, color: PALETTE.danger },
    { key: 'cancelled', label: '取消', value: t.cancelled || 0, color: PALETTE.info },
    { key: 'pending', label: '进行中', value: t.pending || 0, color: PALETTE.warn },
    // other 只在真有这种状态时才进环，平时不占图例格子
    ...(t.other ? [{ key: 'other', label: '其他状态', value: t.other, color: PALETTE.brand }] : []),
  ];
});

const genCenterValue = computed(() =>
  gen.value.successRate === null || gen.value.successRate === undefined ? '—' : `${gen.value.successRate}%`);

/**
 * 只读复核：解除某账号某能力的「重复失败保护」。
 * 这是重活（要驱动浏览器打开页面控件），所以按 dola 前缀走 300 秒超时档。
 */
async function probeGuard(row) {
  try {
    await ElMessageBox.confirm(
      `通过账号 #${row.account_id} 已绑定代理复核 ${row.label} 控件；不提交视频、不消耗生成额度。复核成功才解除此项保护，是否继续？`,
      '只读能力复核',
      { type: 'info' },
    );
  } catch { return; }
  probing.value = `${row.account_id}/${row.scope}`;
  try {
    const result = await api.post(`/api/dola/accounts/${row.account_id}/generation-guard-probe`, { scope: row.scope });
    ElMessage[result.cleared ? 'success' : 'warning'](result.message);
    await loadGeneration();
  } catch { /* api 层已经弹过错误了 */ } finally { probing.value = ''; }
}

/* ---------------- ② dola 账号池健康 ---------------- */

const accountLoading = ref(false);
const accountError = ref('');
const accountState = ref({ items: [], total: 0, summary: {} });
const accountTotal = computed(() => accountState.value.summary?.total ?? 0);

const accountSegments = computed(() => {
  const s = accountState.value.summary || {};
  return [
    { key: 'valid', label: '有效', value: s.valid || 0, color: PALETTE.ok },
    { key: 'invalid', label: '失效', value: s.invalid || 0, color: PALETTE.danger },
    { key: 'unknown', label: '未校验', value: s.unknown || 0, color: PALETTE.info },
    { key: 'disabled', label: '已停用', value: s.disabled || 0, color: PALETTE.warn },
  ];
});

/* ---------------- ③ 内容状态 ---------------- */

const stats = ref({ counts: {}, contentByStatus: [] });
const contentTotal = computed(() => stats.value.counts?.contents ?? 0);

const CONTENT_STATUS = { draft: '草稿', published: '已发布', archived: '已归档' };
const CONTENT_COLOR = { draft: PALETTE.info, published: PALETTE.ok, archived: PALETTE.warn };
const contentSegments = computed(() =>
  (stats.value.contentByStatus || []).map((s) => ({
    key: s.status,
    label: CONTENT_STATUS[s.status] || s.status,
    value: s.c,
    color: CONTENT_COLOR[s.status] || '#409eff',
  })));

function fmt(iso) { return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—'; }

/* ---------------- 加载 ---------------- */

async function loadStats(silent = false) {
  try {
    const res = await api.get('/api/stats', { silent });
    stats.value = { counts: res.counts || {}, contentByStatus: res.contentByStatus || [] };
  } catch { /* api 层已提示（silent 时静默） */ }
}

async function loadAccounts(silent = false) {
  if (!canDolaList.value) return;
  if (!silent) accountLoading.value = true;
  accountError.value = '';
  try {
    // pageSize 保持 100：环图只用 summary（**全池**统计，不受 keyword/status 过滤影响）。
    const res = await api.get(`/api/dola/accounts${qs({ page: 1, pageSize: 100 })}`, { silent: true });
    accountState.value = { items: res.items || [], total: res.total || 0, summary: res.summary || {} };
  } catch (error) {
    accountError.value = error.message || '账号池加载失败';
  } finally {
    if (!silent) accountLoading.value = false;
  }
}

/**
 * @param silent 轮询/回到页面时的静默刷新：不转圈、不弹错、**不清空旧数字**
 *   （失败时保留上一次的结果并挂个「可能已过期」的提示，比整块变空好判断）。
 */
async function loadGeneration(silent = false) {
  if (!canDolaList.value) return;
  if (!silent) genLoading.value = true;
  try {
    // timezone 只影响小时明细的标签文字；明细表已删，所有展示数字与它无关，故固定传北京。
    const res = await api.get(`/api/dola/generation-analytics${qs({ hours: hours.value, timezone: 'Asia/Shanghai' })}`, { silent: true });
    gen.value = {
      totals: { ...EMPTY_COUNTS, ...(res.totals || {}) },
      allTime: { ...EMPTY_COUNTS, ...(res.allTime || {}) },
      successRate: res.successRate ?? null,
    };
    guards.value = res.guards || [];
    genError.value = '';
  } catch {
    if (!silent) genError.value = '统计读取失败，请刷新；环上数字可能已过期。';
  } finally {
    if (!silent) genLoading.value = false;
  }
}

async function loadAll({ silent = false } = {}) {
  if (!silent) loading.value = true;
  const tasks = [loadStats(silent)];
  if (canDolaList.value) tasks.push(loadAccounts(silent), loadGeneration(silent));
  await Promise.allSettled(tasks);
  if (!silent) loading.value = false;
}

/* ---------------- 轮询（keep-alive 就绪） ---------------- */

/**
 * Dashboard 在 AdminLayout 的 KEEP_ALIVE 名单里 ⇒ 组件被缓存后 **onUnmounted 不再触发**，
 * 老写法（只在 onMounted 挂 setTimeout）会让定时器在后台一直跑，白烧服务端。
 * 所以：onDeactivated 停、onActivated 续，start 幂等（已在排队就不重复挂）。
 */
let timer = null, disposed = false, parked = false;
function startPolling() {
  if (disposed || timer) return;
  timer = setTimeout(async () => {
    timer = null; // ★ 先置空，否则下面 startPolling 会被自己这个残留 id 挡住
    if (!genLoading.value) await loadGeneration(true);
    startPolling();
  }, 30000);
}
function stopPolling() { clearTimeout(timer); timer = null; }

onMounted(() => { loadAll(); startPolling(); });
onActivated(() => {
  // parked 区分「首次挂载」和「从缓存里回来」，避免 onMounted + onActivated 各拉一遍
  if (!parked) return;
  parked = false;
  loadAll({ silent: true });
  startPolling();
});
onDeactivated(() => { parked = true; stopPolling(); });
onUnmounted(() => { disposed = true; stopPolling(); });
</script>

<style scoped>
.mt { margin-top: 14px; }
.muted { color: var(--el-text-color-secondary); }
.card-title { font-weight: 600; font-size: 14px; }
.card-sub { margin-left: 10px; font-size: 12px; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
/* 三张环图卡等高：内容多少不一样，不对齐会显得参差 */
.ring-card { height: 100%; }
.ring-alert { margin-bottom: 12px; }
.ring-note { margin: 10px 0 0; font-size: 12px; line-height: 1.7; color: var(--el-text-color-secondary); }
.guard-alert { margin-bottom: 12px; }
</style>
