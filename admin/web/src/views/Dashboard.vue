<template>
  <div v-loading="loading">
    <el-row :gutter="14">
      <el-col v-for="c in cards" :key="c.key" :xs="12" :sm="12" :md="6">
        <div class="stat">
          <div class="stat-icon" :style="{ background: c.bg, color: c.color }">
            <el-icon :size="20"><component :is="c.icon" /></el-icon>
          </div>
          <div>
            <div class="stat-num">{{ c.value }}</div>
            <div class="stat-label">{{ c.label }}</div>
          </div>
        </div>
      </el-col>
    </el-row>

    <DolaGenerationAnalytics v-if="canDolaList" class="mt" />

    <el-card v-if="canDolaList" shadow="never" class="mt account-card">
      <template #header>
        <div class="card-head account-head">
          <div>
            <span class="card-title">dola 账号池</span>
            <span class="muted account-head-sub">已并入 8788 仪表盘 · {{ dolaSummary.total ?? 0 }} 个账号</span>
          </div>
          <div class="account-actions">
            <el-button v-if="canDolaCheck" size="small" plain :loading="dolaLoading" @click="loadDolaAccounts">刷新</el-button>
            <el-button v-if="canDolaCheck" size="small" plain :loading="maintenanceLoading" @click="runDolaMaintenance">立即维护</el-button>
            <el-button size="small" type="primary" plain @click="$router.push('/dola')">完整账号池</el-button>
          </div>
        </div>
      </template>

      <div class="account-summary">
        <div class="account-summary-item"><span>有效</span><b class="ok">{{ dolaSummary.valid ?? 0 }}</b></div>
        <div class="account-summary-item"><span>失效</span><b class="danger">{{ dolaSummary.invalid ?? 0 }}</b></div>
        <div class="account-summary-item"><span>未校验</span><b>{{ dolaSummary.unknown ?? 0 }}</b></div>
        <div class="account-summary-item"><span>已确认剩余额度</span><b>{{ dolaSummary.quotaKnown ? (dolaSummary.quotaRemaining ?? '未知') : '未知' }}</b></div>
        <div class="account-summary-item"><span>原生 30 秒</span><b :class="dolaSummary.native30Ready ? 'ok' : 'warning'">{{ dolaSummary.native30Ready ? `${dolaSummary.native30Available} 个可用` : '暂无可用' }}</b></div>
      </div>

      <el-alert
        v-if="dolaError"
        type="warning"
        :title="dolaError"
        :closable="false"
        show-icon
        class="account-alert"
      />

      <div class="account-toolbar">
        <el-input v-model="dolaQuery.keyword" clearable placeholder="搜索备注 / 账号标识" style="width:240px" @keyup.enter="loadDolaAccounts" />
        <el-select v-model="dolaQuery.status" clearable placeholder="全部状态" style="width:130px" @change="loadDolaAccounts">
          <el-option label="有效" value="valid" />
          <el-option label="失效" value="invalid" />
          <el-option label="未校验" value="unknown" />
          <el-option label="已停用" value="disabled" />
        </el-select>
        <el-button plain @click="loadDolaAccounts">查询</el-button>
        <span class="spacer" />
        <el-button v-if="canDolaImport" size="small" @click="dolaImportDlg = true">导入 Cookie</el-button>
      </div>

      <el-table :data="dolaAccounts" v-loading="dolaLoading" stripe border size="small" empty-text="暂无账号">
        <el-table-column prop="id" label="ID" width="64" />
        <el-table-column label="账号" min-width="210" show-overflow-tooltip>
          <template #default="{ row }">
            <div class="cell-stack">
              <span class="main">{{ dolaName(row) }}</span>
              <span class="sub">{{ row.account_hint || '未识别账号' }} · {{ row.proxy ? '已配代理' : '直连风险' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="125">
          <template #default="{ row }">
            <div class="cell-stack">
              <span><el-tag :type="dolaStatusType(row.status)" size="small">{{ dolaStatusLabel(row.status) }}</el-tag></span>
              <span class="sub">{{ dolaStateText(row) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="额度" width="130">
          <template #default="{ row }">
            <span :class="quotaClass(row)">{{ quotaText(row) }}</span>
            <div class="sub">{{ row.quota_source ? `来源：${row.quota_source}` : '未确认' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="30 秒" width="105">
          <template #default="{ row }">
            <el-tag size="small" :type="native30Type(row.native_30s_state)">{{ native30Label(row.native_30s_state) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近校验" width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ fmt(row.last_check_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button v-if="canDolaCheck" link type="primary" size="small" :loading="dolaBusyId === row.id" @click="probeDolaAccount(row)">探测</el-button>
            <el-button v-if="canDolaUpdate" link size="small" @click="toggleDolaAccount(row)">{{ row.status === 'disabled' ? '启用' : '停用' }}</el-button>
            <el-button link type="primary" size="small" @click="$router.push('/dola')">详情</el-button>
            <el-button v-if="canDolaDelete" link type="danger" size="small" @click="removeDolaAccount(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="account-foot muted">当前显示 {{ dolaAccounts.length }} / {{ dolaTotal }} 条。完整探测、代理修复、原生能力探测和批量操作仍可从“完整账号池”进入。</div>
    </el-card>

    <el-row :gutter="14" class="mt">
      <el-col :md="12" :sm="24">
        <el-card shadow="never">
          <template #header><span class="card-title">内容状态分布</span></template>
          <div v-if="byStatus.length" class="bars">
            <div v-for="s in byStatus" :key="s.status" class="bar-row">
              <span class="bar-label">{{ statusLabel(s.status) }}</span>
              <div class="bar-track">
                <div class="bar-fill" :style="{ width: pct(s.c) + '%', background: statusColor(s.status) }" />
              </div>
              <span class="bar-num">{{ s.c }}</span>
            </div>
          </div>
          <el-empty v-else description="暂无内容" :image-size="70" />
        </el-card>
      </el-col>

      <el-col :md="12" :sm="24">
        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <span class="card-title">最近操作</span>
              <el-link type="primary" :underline="false" @click="$router.push('/logs')">全部</el-link>
            </div>
          </template>
          <el-timeline v-if="recentLogs.length" class="tl">
            <el-timeline-item
              v-for="l in recentLogs"
              :key="l.id"
              :timestamp="fmt(l.created_at)"
              size="small"
              :type="l.action.includes('delete') || l.action.includes('failed') ? 'danger' : 'primary'"
            >
              <b>{{ l.username }}</b>
              <span class="muted"> · {{ actionLabel(l.action) }}</span>
              <el-tag v-if="l.target_type" size="small" effect="plain" class="ml">{{ l.target_type }}</el-tag>
            </el-timeline-item>
          </el-timeline>
          <el-empty v-else description="暂无记录" :image-size="70" />
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="mt">
      <template #header><span class="card-title">近 7 天新增内容</span></template>
      <div v-if="trend.length" class="trend">
        <div v-for="d in trend" :key="d.d" class="trend-col">
          <div class="trend-bar" :style="{ height: trendHeight(d.c) }" :title="`${d.d}：${d.c} 条`" />
          <span class="trend-label">{{ d.d.slice(5) }}</span>
        </div>
      </div>
      <el-empty v-else description="近 7 天没有新增" :image-size="70" />
    </el-card>

    <el-dialog v-model="dolaImportDlg" title="导入 dola Cookie" width="620px" destroy-on-close>
      <el-alert type="warning" :closable="false" show-icon title="Cookie 只在当前请求中传输，不要把密码或完整凭据粘贴到操作日志、截图或聊天中。" class="import-alert" />
      <el-form label-width="90px" class="import-form">
        <el-form-item label="Cookie">
          <el-input v-model="dolaImportForm.raw" type="textarea" :rows="7" placeholder="每行一份已登录 Cookie；也支持 JSON Cookie 对象" />
        </el-form-item>
        <el-form-item label="备注前缀">
          <el-input v-model="dolaImportForm.labelPrefix" placeholder="可选，例如 batch-" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="dolaImportForm.note" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dolaImportDlg = false">取消</el-button>
        <el-button type="primary" :loading="dolaImporting" @click="importDolaAccounts">导入并刷新</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';
import { can } from '../store.js';
import DolaGenerationAnalytics from '../components/DolaGenerationAnalytics.vue';

const loading = ref(true);
const data = ref({ counts: {}, contentByStatus: [], recentLogs: [], contentTrend: [] });

const canDolaList = computed(() => can('dola:list'));
const canDolaCheck = computed(() => can('dola:check'));
const canDolaUpdate = computed(() => can('dola:update'));
const canDolaImport = computed(() => can('dola:import'));
const canDolaDelete = computed(() => can('dola:delete'));
const dolaLoading = ref(false);
const dolaError = ref('');
const dolaAccounts = ref([]);
const dolaTotal = ref(0);
const dolaSummary = ref({});
const dolaBusyId = ref(null);
const maintenanceLoading = ref(false);
const dolaImportDlg = ref(false);
const dolaImporting = ref(false);
const dolaQuery = reactive({ keyword: '', status: '', page: 1, pageSize: 100 });
const dolaImportForm = reactive({ raw: '', labelPrefix: '', note: '' });

const cards = computed(() => [
  { key: 'users', label: '用户数', value: data.value.counts.users ?? 0, icon: 'User', bg: 'rgba(64,158,255,.15)', color: '#409eff' },
  { key: 'tokens', label: `访问令牌（启用 ${data.value.counts.tokensActive ?? 0}）`, value: data.value.counts.tokens ?? 0, icon: 'Postcard', bg: 'rgba(155,110,255,.15)', color: '#9b6eff' },
  { key: 'cards', label: `充值卡（未用 ${data.value.counts.cardsUnused ?? 0}）`, value: data.value.counts.cards ?? 0, icon: 'Tickets', bg: 'rgba(230,162,60,.15)', color: '#e6a23c' },
  { key: 'cardPoints', label: '待兑积分（未用卡面额）', value: data.value.counts.cardsUnusedPoints ?? 0, icon: 'Coin', bg: 'rgba(103,194,58,.15)', color: '#67c23a' },
  { key: 'tokenPoints', label: '令牌积分总量', value: data.value.counts.tokenPoints ?? 0, icon: 'Wallet', bg: 'rgba(64,158,255,.12)', color: '#409eff' },
  { key: 'dola', label: `dola 账号（有效 ${data.value.counts.dolaValid ?? 0}）`, value: data.value.counts.dolaAccounts ?? 0, icon: 'Cloudy', bg: 'rgba(155,110,255,.12)', color: '#9b6eff' },
  { key: 'dolaCredits', label: 'dola 额度合计', value: data.value.counts.dolaCredits ?? 0, icon: 'Money', bg: 'rgba(230,162,60,.12)', color: '#e6a23c' },
  { key: 'contents', label: '内容数', value: data.value.counts.contents ?? 0, icon: 'Document', bg: 'rgba(144,147,153,.18)', color: '#909399' },
  { key: 'roles', label: '角色数', value: data.value.counts.roles ?? 0, icon: 'Key', bg: 'rgba(103,194,58,.12)', color: '#67c23a' },
  { key: 'logs', label: '日志条数', value: data.value.counts.logs ?? 0, icon: 'List', bg: 'rgba(144,147,153,.14)', color: '#909399' },
]);

const byStatus = computed(() => data.value.contentByStatus || []);
const recentLogs = computed(() => data.value.recentLogs || []);
const trend = computed(() => data.value.contentTrend || []);
const maxTrend = computed(() => Math.max(1, ...trend.value.map((t) => t.c)));

const STATUS = {
  draft: '草稿', published: '已发布', archived: '已归档',
  active: '启用', disabled: '停用',
};
const ACTION = {
  login: '登录', logout: '退出', login_failed: '登录失败',
  'user.create': '新建用户', 'user.update': '修改用户', 'user.delete': '删除用户',
  'user.reset_password': '重置密码', change_password: '修改密码',
  'content.create': '新建内容', 'content.update': '修改内容', 'content.delete': '删除内容',
  'content.bulk_delete': '批量删除内容',
  'role.create': '新建角色', 'role.delete': '删除角色', 'role.update_permissions': '配置权限',
  'setting.update': '修改设置',
  'token.generate': '生成令牌', 'token.reveal': '查看令牌', 'token.points': '调整令牌积分',
  'token.disable': '停用令牌', 'token.enable': '启用令牌', 'token.revoke': '撤销令牌',
  'token.delete': '删除令牌', 'token.expire': '设置令牌过期', 'token.export': '导出令牌',
  'card.generate': '生成卡密', 'card.redeem': '兑换卡密', 'card.revoke': '撤销卡密',
  'card.restore': '恢复卡密', 'card.delete': '删除卡密', 'card.bulk_delete': '批量删除卡密',
  'card.reveal': '查看卡密', 'card.export': '导出卡密',
  'dola.import': '导入 dola 账号', 'dola.reveal': '查看账号 cookie', 'dola.probe': '探测额度接口',
  'dola.check': '校验账号', 'dola.disable': '停用账号', 'dola.enable': '启用账号',
  'dola.set_credits': '手动录入额度', 'dola.convert': '额度转积分',
  'dola.delete': '删除账号', 'dola.force_delete': '强制删除账号', 'dola.bulk_delete': '批量删除账号',
  'dola.job_create': '提交批量任务', 'dola.job_cancel': '取消批量任务',
};

function statusLabel(s) { return STATUS[s] || s; }
function statusColor(s) {
  return { draft: '#909399', published: '#67c23a', archived: '#e6a23c' }[s] || '#409eff';
}
function actionLabel(a) { return ACTION[a] || a; }
function pct(n) {
  const total = byStatus.value.reduce((s, x) => s + x.c, 0) || 1;
  return Math.round((n / total) * 100);
}
function trendHeight(n) { return Math.max(6, Math.round((n / maxTrend.value) * 100)) + '%'; }
function fmt(iso) { return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—'; }

const DOLA_STATUS = { valid: '有效', invalid: '失效', unknown: '未校验', disabled: '已停用' };
function dolaStatusLabel(status) { return DOLA_STATUS[status] || status || '未知'; }
function dolaStatusType(status) { return ({ valid: 'success', invalid: 'danger', unknown: 'info', disabled: 'warning' })[status] || 'info'; }
function dolaName(row) { return String(row.label || row.account_hint || '').trim() || `账号 #${row.id}`; }
function dolaStateText(row) {
  if (row.cooldown_until && Date.parse(row.cooldown_until) > Date.now()) return `冷却至 ${fmt(row.cooldown_until)}`;
  if (row.fail_streak) return `连续失败 ${row.fail_streak} 次`;
  return row.last_error ? String(row.last_error).slice(0, 28) : '—';
}
function quotaText(row) {
  if (row.quotaKnown && Number.isFinite(Number(row.quotaAvailable))) return `剩 ${row.quotaAvailable}`;
  if (row.quotaState === 'stale') return '待确认';
  return '未知';
}
function quotaClass(row) {
  if (row.quotaKnown && Number(row.quotaAvailable) === 0) return 'danger';
  if (row.quotaKnown) return 'ok';
  return row.quotaState === 'stale' ? 'warning' : 'muted';
}
function native30Label(state) { return ({ available: '可用', unavailable: '不可用', unknown: '未判定' })[state] || '未判定'; }
function native30Type(state) { return ({ available: 'success', unavailable: 'warning', unknown: 'info' })[state] || 'info'; }

async function loadDolaAccounts() {
  if (!canDolaList.value) return;
  dolaLoading.value = true;
  dolaError.value = '';
  try {
    const res = await api.get(`/api/dola/accounts?page=${dolaQuery.page}&pageSize=${dolaQuery.pageSize}&keyword=${encodeURIComponent(dolaQuery.keyword)}&status=${encodeURIComponent(dolaQuery.status)}`, { silent: true });
    dolaAccounts.value = res.items || [];
    dolaTotal.value = res.total || 0;
    dolaSummary.value = {
      ...(res.summary || {}),
      native30Available: (res.items || []).filter((row) => row.status === 'valid' && row.native_30s_state === 'available').length,
      native30Ready: (res.items || []).some((row) => row.status === 'valid' && row.native_30s_state === 'available'),
    };
  } catch (error) {
    dolaError.value = error.message || '账号池加载失败';
  } finally {
    dolaLoading.value = false;
  }
}

async function probeDolaAccount(row) {
  dolaBusyId.value = row.id;
  try {
    const res = await api.post(`/api/dola/accounts/${row.id}/probe`, {}, { silent: true });
    ElMessage.success(res.message || '探测完成');
    await loadDolaAccounts();
  } catch (error) {
    ElMessage.error(error.message || '探测失败');
  } finally {
    dolaBusyId.value = null;
  }
}

async function toggleDolaAccount(row) {
  const action = row.status === 'disabled' ? 'enable' : 'disable';
  try {
    await api.post(`/api/dola/accounts/${row.id}/action`, { action });
    ElMessage.success(action === 'enable' ? '账号已启用' : '账号已停用');
    await loadDolaAccounts();
  } catch (error) {
    ElMessage.error(error.message || '更新账号状态失败');
  }
}

async function removeDolaAccount(row) {
  try {
    await ElMessageBox.confirm(`确定删除账号「${dolaName(row)}」？删除会从 8788 号池移除 Cookie 记录，无法通过本页撤回。`, '删除确认', {
      type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消',
    });
  } catch { return; }
  try {
    await api.del(`/api/dola/accounts/${row.id}`);
    ElMessage.success('账号已删除');
    await loadDolaAccounts();
  } catch (error) {
    ElMessage.error(error.message || '删除失败；如有换算记录，请到完整账号池处理');
  }
}

async function runDolaMaintenance() {
  if (!canDolaCheck.value) return;
  maintenanceLoading.value = true;
  try {
    const res = await api.post('/api/dola/maintenance/run', {}, { silent: true });
    ElMessage.success(res.created ? '账号维护已提交' : '已有维护任务运行中');
    await loadDolaAccounts();
  } catch (error) {
    ElMessage.error(error.message || '提交维护失败');
  } finally {
    maintenanceLoading.value = false;
  }
}

async function importDolaAccounts() {
  if (!dolaImportForm.raw.trim()) {
    ElMessage.warning('请先粘贴 Cookie');
    return;
  }
  dolaImporting.value = true;
  try {
    const res = await api.post('/api/dola/accounts/import', { ...dolaImportForm }, { silent: true });
    ElMessage.success(`新增 ${res.inserted || 0} 个，刷新 ${res.refreshed || 0} 个`);
    dolaImportForm.raw = '';
    dolaImportDlg.value = false;
    await loadDolaAccounts();
  } catch (error) {
    ElMessage.error(error.message || '导入失败');
  } finally {
    dolaImporting.value = false;
  }
}

onMounted(async () => {
  const results = await Promise.allSettled([
    api.get('/api/stats'),
    canDolaList.value ? loadDolaAccounts() : Promise.resolve(),
  ]);
  if (results[0].status === 'fulfilled') data.value = results[0].value;
  loading.value = false;
});
</script>

<style scoped>
.mt { margin-top: 14px; }
.account-card { overflow: hidden; }
.account-head { gap: 14px; }
.account-head-sub { margin-left: 10px; font-size: 12px; }
.account-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.account-summary { display: flex; flex-wrap: wrap; gap: 8px 28px; margin-bottom: 14px; padding: 10px 12px; border: 1px solid var(--el-border-color-light); border-radius: 8px; background: var(--el-fill-color-blank); }
.account-summary-item { display: flex; align-items: baseline; gap: 7px; font-size: 12px; color: var(--el-text-color-secondary); }
.account-summary-item b { font-size: 16px; color: var(--el-text-color-primary); }
.account-alert { margin-bottom: 12px; }
.account-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.account-foot { margin-top: 10px; font-size: 12px; }
.account-card .cell-stack { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.account-card .cell-stack .main { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-card .cell-stack .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.warning { color: var(--el-color-warning) !important; }
.danger { color: var(--el-color-danger) !important; }
.ok { color: var(--el-color-success) !important; }
.import-alert { margin-bottom: 14px; }
.import-form { padding-top: 4px; }
.stat {
  display: flex; align-items: center; gap: 14px; padding: 16px;
  background: var(--el-bg-color); border: 1px solid var(--el-border-color-light);
  border-radius: 10px; margin-bottom: 14px;
}
.stat-icon { width: 42px; height: 42px; border-radius: 10px; display: grid; place-items: center; }
.stat-num { font-size: 22px; font-weight: 700; line-height: 1.2; }
.stat-label { font-size: 12px; color: var(--el-text-color-secondary); }
.card-title { font-weight: 600; font-size: 14px; }
.card-head { display: flex; align-items: center; justify-content: space-between; }
.bars { display: flex; flex-direction: column; gap: 14px; padding: 6px 0; }
.bar-row { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.bar-label { width: 60px; color: var(--el-text-color-secondary); }
.bar-track { flex: 1; height: 8px; background: var(--el-fill-color); border-radius: 4px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 4px; transition: width .3s; }
.bar-num { width: 32px; text-align: right; }
.tl { padding-left: 2px; max-height: 290px; overflow: auto; }
.muted { color: var(--el-text-color-secondary); }
.ml { margin-left: 6px; }
.trend { display: flex; align-items: flex-end; gap: 12px; height: 130px; padding: 8px 4px 0; }
.trend-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; gap: 6px; }
.trend-bar { width: 100%; max-width: 46px; background: var(--el-color-primary); border-radius: 4px 4px 0 0; transition: height .3s; }
.trend-label { font-size: 11px; color: var(--el-text-color-secondary); }
</style>
