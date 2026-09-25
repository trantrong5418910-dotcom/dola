<template>
  <div class="page">
    <el-card shadow="never">
      <div class="toolbar">
        <div class="stats-inline">
          <span>已配置 <b>{{ summary.withProxy ?? 0 }}</b></span>
          <el-divider direction="vertical" />
          <span>已核验出口 <b class="points">{{ summary.withExitIp ?? 0 }}</b></span>
          <el-divider direction="vertical" />
          <span>共享出口 <b class="danger-text">{{ summary.sharedExitIpRows ?? 0 }}</b></span>
        </div>
        <div class="spacer" />
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
      <el-alert type="info" :closable="false" show-icon class="mb"
        title="只保留 8788 的真实代理绑定；验证会真实访问出口检测服务。生成前仍会拦截未核验或共享出口的账号。" />
      <el-table :data="rows" v-loading="loading" border stripe row-key="id">
        <el-table-column prop="id" label="ID" width="62" />
        <el-table-column label="账号" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">{{ primaryName(row) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }"><el-tag size="small" :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="代理" width="120">
          <template #default="{ row }"><el-tag size="small" :type="row.proxy ? 'success' : 'danger'">{{ row.proxy ? proxyRegion(row.proxy) : '未配置' }}</el-tag></template>
        </el-table-column>
        <el-table-column label="出口隔离" width="125">
          <template #default="{ row }">
            <el-tag size="small" :type="row.exitIpShared ? 'danger' : (row.exitIpKnown ? 'success' : 'warning')">
              {{ row.exitIpShared ? '共享出口' : (row.exitIpKnown ? '已核验' : '待核验') }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="能力" width="150">
          <template #default="{ row }">30 秒 {{ row.native_30s_state === 'available' ? '✓' : '—' }} · 参考图 {{ row.reference_image_state === 'available' ? '✓' : '—' }}</template>
        </el-table-column>
        <el-table-column label="冷却" width="170">
          <template #default="{ row }">{{ row.cooldown_until && new Date(row.cooldown_until) > new Date() ? fmt(row.cooldown_until) : '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="190" fixed="right" align="right">
          <template #default="{ row }">
            <el-button v-if="can('dola:update')" size="small" text type="primary" @click="openSetProxy(row)">设置代理</el-button>
            <el-button v-if="can('dola:update') && row.proxy" size="small" text type="primary" :loading="verifyBusy === row.id" @click="verifyExit(row)">核验出口</el-button>
          </template>
        </el-table-column>
        <template #empty><el-empty description="暂无账号" :image-size="70" /></template>
      </el-table>
    </el-card>

    <!-- 设置代理 -->
    <el-dialog v-model="dlg" :title="`设置代理 —— ${form.label}`" width="560px" :close-on-click-modal="false">
      <el-alert type="info" :closable="false" show-icon class="mb"
        title="上游按出口 IP 限流，一个 IP 操作多个账号必然撞墙。换代理后会清掉旧出口核验，需重新核验。" />
      <el-form label-width="80px">
        <el-form-item label="代理">
          <el-input v-model="form.proxy" placeholder="http://user:pass@host:port 或 socks5://user:pass@host:port（留空 = 清除）" class="mono" />
        </el-form-item>
        <el-alert v-if="verifyResult" :type="verifyResult.ok ? 'success' : 'error'" :closable="false" class="mb">
          <template #title>{{ verifyResult.ok ? `出口 ${verifyResult.ip || '未知'}（${[verifyResult.country, verifyResult.region, verifyResult.city].filter(Boolean).join(' · ') || '未知地区'}）` : `核验失败：${verifyResult.error || verifyResult.status}` }}</template>
        </el-alert>
      </el-form>
      <template #footer>
        <el-button @click="dlg = false">取消</el-button>
        <el-button :loading="verifyBusy === 'dlg'" @click="verifyDlgProxy">先核验</el-button>
        <el-button type="primary" :loading="saveBusy" @click="saveProxy">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import { can } from '../store.js';

const loading = ref(false);
const summary = ref({});
const rows = ref([]);
const dlg = ref(false);
const saveBusy = ref(false);
const verifyBusy = ref(null);
const verifyResult = ref(null);
const form = reactive({ id: null, label: '', proxy: '' });

function fmt(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false });
}
function primaryName(row) {
  return String(row.loginEmail || row.label || '').trim()
    || String(row.account_hint || '').trim().split(/\s+/)[0] || `#${row.id}`;
}
const STATUS_LABEL = { valid: '有效', invalid: '失效', unknown: '未校验', disabled: '已停用' };
function statusLabel(s) { return STATUS_LABEL[s] || s || '未知'; }
function statusType(s) { return { valid: 'success', invalid: 'danger', disabled: 'info' }[s] || 'warning'; }
function proxyRegion(proxy) {
  try {
    const user = decodeURIComponent(new URL(proxy).username);
    return user.split('_')[1] || '代理';
  } catch { return '代理'; }
}

async function load() {
  loading.value = true;
  try {
    const [s, list] = await Promise.all([
      api.get('/api/dola/accounts/proxy/summary', { silent: true }),
      api.get('/api/dola/accounts?page=1&pageSize=500', { silent: true }),
    ]);
    summary.value = s || {};
    rows.value = list.items || [];
  } finally { loading.value = false; }
}

function openSetProxy(row) {
  form.id = row.id;
  form.label = primaryName(row);
  form.proxy = '';
  verifyResult.value = null;
  dlg.value = true;
}
async function verifyDlgProxy() {
  if (!form.proxy.trim()) return ElMessage.warning('先填写代理地址');
  verifyBusy.value = 'dlg';
  try {
    const r = await api.post('/api/dola/accounts/proxy/verify', { proxy: form.proxy.trim() });
    verifyResult.value = r;
    if (r.ok) ElMessage.success(`出口可用：${r.ip || ''}`);
  } catch (e) {
    verifyResult.value = { ok: false, error: e.message };
  } finally { verifyBusy.value = null; }
}
async function saveProxy() {
  saveBusy.value = true;
  try {
    await api.post(`/api/dola/accounts/${form.id}/proxy`, { proxy: form.proxy.trim() });
    ElMessage.success(form.proxy.trim() ? '代理已更新，旧出口核验已清空' : '代理已清除');
    dlg.value = false;
    load();
  } finally { saveBusy.value = false; }
}
async function verifyExit(row) {
  if (!row.proxy) return;
  verifyBusy.value = row.id;
  try {
    const r = await api.post(`/api/dola/accounts/${row.id}/proxy/verify-persist`);
    if (r.ok) ElMessage.success(`出口可用：${r.ip || ''}，已写回`);
    else ElMessage.warning(`出口核验失败：${r.error || r.message || r.status}`);
    load();
  } catch (e) {
    ElMessage.error(e.message || '核验失败');
  } finally { verifyBusy.value = null; }
}

onMounted(load);
</script>

<style scoped>
.page { padding: 0; }
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.stats-inline { display: inline-flex; align-items: center; gap: 10px; font-size: 13px; color: var(--el-text-color-secondary); }
.stats-inline b { color: var(--el-text-color-primary); }
.points { color: var(--el-color-success); font-weight: 600; }
.danger-text { color: var(--el-color-danger); font-weight: 600; }
.spacer { flex: 1; }
.mb { margin-bottom: 12px; }
.mono { font-family: ui-monospace, monospace; }
</style>
