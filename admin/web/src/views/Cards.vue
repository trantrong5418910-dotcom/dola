<template>
  <div>
    <el-row :gutter="14" class="stats">
      <el-col v-for="s in statCards" :key="s.label" :xs="12" :sm="8" :md="4">
        <div class="stat">
          <div class="num" :style="{ color: s.color }">{{ s.value }}</div>
          <div class="label">{{ s.label }}</div>
        </div>
      </el-col>
    </el-row>

    <el-card shadow="never">
      <div class="toolbar">
        <div class="filters">
          <el-input v-model="query.keyword" placeholder="搜索卡密 / 前缀 / 批次 / 备注" clearable style="width: 220px" @keyup.enter="reload" @clear="reload" />
          <el-select v-model="query.batch" placeholder="全部批次" clearable filterable style="width: 170px" @change="reload">
            <el-option v-for="b in batches" :key="b.batch_no" :label="`${b.batch_no}（未用 ${b.unused}/${b.total}）`" :value="b.batch_no" />
          </el-select>
          <el-select v-model="query.status" placeholder="全部状态" clearable style="width: 116px" @change="reload">
            <el-option label="未使用" value="unused" />
            <el-option label="已兑换" value="redeemed" />
            <el-option label="已撤销" value="revoked" />
          </el-select>
          <el-button type="primary" :icon="Search" @click="reload">查询</el-button>
        </div>
        <div class="spacer" />
        <div class="actions">
          <el-button v-if="can('card:delete')" :disabled="!selected.length" type="danger" plain @click="bulkRemove">
            批量删除{{ selected.length ? `（${selected.length}）` : '' }}
          </el-button>
          <el-button :icon="Download" @click="exportCsv">导出 CSV</el-button>
          <el-button v-if="can('card:redeem')" :icon="Tickets" @click="openRedeem">手动兑换</el-button>
          <el-button v-if="can('card:generate')" type="primary" :icon="Plus" @click="openGenerate">生成卡密</el-button>
        </div>
      </div>

      <el-table :data="items" v-loading="loading" border stripe @selection-change="(v) => (selected = v)">
        <el-table-column type="selection" width="46" :selectable="(row) => row.status !== 'redeemed'" />
        <el-table-column prop="id" label="ID" width="64" />
        <el-table-column label="卡密" min-width="235">
          <template #default="{ row }">
            <span class="mono">{{ row.code }}</span>
            <el-button v-if="can('card:list')" size="small" text type="primary" @click="reveal(row)">查看</el-button>
          </template>
        </el-table-column>
        <el-table-column label="面额" width="84">
          <template #default="{ row }"><span class="points">{{ row.points }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="92">
          <template #default="{ row }">
            <el-tag size="small" :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="batch_no" label="批次" width="120" show-overflow-tooltip />
        <el-table-column label="兑换去向" width="110">
          <template #default="{ row }">
            <span v-if="row.token_prefix" class="mono">{{ row.token_prefix }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="兑换时间" width="140">
          <template #default="{ row }">{{ row.redeemed_at ? fmt(row.redeemed_at) : '—' }}</template>
        </el-table-column>
        <el-table-column prop="note" label="备注" width="100" show-overflow-tooltip />
        <!-- 操作列收窄 + 「删除」进「更多」，让整表不再超出容器（原来超 89px） -->
        <el-table-column label="操作" width="156" fixed="right" align="right">
          <template #default="{ row }">
            <el-button v-if="can('card:update') && row.status === 'unused'" size="small" text type="warning" @click="action(row, 'revoke')">撤销</el-button>
            <el-button v-if="can('card:update') && row.status === 'revoked'" size="small" text type="primary" @click="action(row, 'restore')">恢复</el-button>
            <el-dropdown v-if="can('card:delete')" trigger="click" @command="(c) => rowMenu(row, c)">
              <el-button size="small" text>更多<el-icon><ArrowDown /></el-icon></el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="delete" :disabled="row.status === 'redeemed'">删除</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <span v-if="row.status === 'redeemed'" class="muted tiny">已兑换不可改</span>
          </template>
        </el-table-column>
        <template #empty><el-empty description="还没有卡密，点右上角生成" :image-size="80" /></template>
      </el-table>

      <el-pagination
        class="pager"
        layout="total, sizes, prev, pager, next"
        :total="total"
        :current-page="query.page"
        :page-size="query.pageSize"
        :page-sizes="[10, 20, 50, 100]"
        @current-change="(p) => { query.page = p; load(); }"
        @size-change="(s) => { query.pageSize = s; query.page = 1; load(); }"
      />
    </el-card>

    <!-- 生成 -->
    <el-dialog v-model="genDlg" title="生成充值卡" width="520px">
      <el-alert type="warning" :closable="false" show-icon class="tip"
        title="完整卡密只在生成后显示这一次，请立即复制或下载 CSV 留存。" />
      <el-form :model="genForm" label-width="120px" class="mt">
        <el-form-item label="数量">
          <el-input-number v-model="genForm.count" :min="1" :max="1000" />
          <span class="hint">最多 1000 张</span>
        </el-form-item>
        <el-form-item label="每张面额">
          <el-input-number v-model="genForm.points" :min="1" :max="1000000" :step="50" />
          <span class="hint">合计 {{ genForm.count * genForm.points }} 积分</span>
        </el-form-item>
        <el-form-item label="批次号">
          <el-input v-model="genForm.batchNo" placeholder="留空自动生成，如 B20260919-XXXX" />
        </el-form-item>
        <el-form-item label="有效期（天）">
          <el-input-number v-model="genForm.expiresInDays" :min="0" :max="3650" />
          <span class="hint">0 = 永不过期</span>
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="genForm.note" placeholder="可选，如：淘宝渠道" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="genDlg = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doGenerate">确认生成</el-button>
      </template>
    </el-dialog>

    <!-- 生成结果 -->
    <el-dialog v-model="resultDlg" title="生成成功" width="620px" :close-on-click-modal="false">
      <el-alert type="success" :closable="false" show-icon
        :title="`批次 ${resultBatch}：${resultItems.length} 张 × ${resultPoints} 积分，请立即复制保存`" />
      <el-input v-model="resultText" type="textarea" :rows="10" readonly class="mt mono-box" />
      <template #footer>
        <el-button :icon="Download" @click="downloadResult">下载 CSV</el-button>
        <el-button type="primary" :icon="CopyDocument" @click="copy(resultText)">复制全部</el-button>
        <el-button @click="resultDlg = false">我已保存，关闭</el-button>
      </template>
    </el-dialog>

    <!-- 查看完整卡密 -->
    <el-dialog v-model="revealDlg" title="卡密完整值" width="520px">
      <el-input v-model="revealValue" readonly />
      <template #footer>
        <el-button type="primary" :icon="CopyDocument" @click="copy(revealValue)">复制</el-button>
        <el-button @click="revealDlg = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 手动兑换 -->
    <el-dialog v-model="redeemDlg" title="手动兑换卡密" width="520px">
      <el-alert type="info" :closable="false" show-icon
        title="把卡密面额充到指定令牌的积分上。客服补单、自测都走这里。" />
      <el-form label-width="90px" class="mt">
        <el-form-item label="卡密">
          <el-input v-model="redeemForm.code" placeholder="card_xxxxxxxx" class="mono-box" />
        </el-form-item>
        <el-form-item label="充值到">
          <el-select v-model="redeemForm.tokenId" placeholder="选择令牌" style="width: 100%" filterable>
            <el-option v-for="t in tokenOptions" :key="t.id" :label="`${t.name || '未命名'} (${t.prefix}) · ${t.points} 积分`" :value="t.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert v-if="redeemResult" type="success" :closable="false" class="mt"
        :title="`兑换成功：+${redeemResult.points} 积分，令牌 ${redeemResult.tokenPrefix} 现为 ${redeemResult.tokenPoints} 积分`" />
      <template #footer>
        <el-button @click="redeemDlg = false">关闭</el-button>
        <el-button type="primary" :loading="saving" @click="doRedeem">确认兑换</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowDown, CopyDocument, Download, Plus, Search, Tickets } from '@element-plus/icons-vue';
import { api, qs } from '../api.js';
import { can } from '../store.js';

const items = ref([]);
const batches = ref([]);
const tokenOptions = ref([]);
const summary = ref({});
const selected = ref([]);
const total = ref(0);
const loading = ref(false);
const saving = ref(false);
const query = reactive({ page: 1, pageSize: 20, keyword: '', status: '', batch: '' });

const genDlg = ref(false);
const genForm = reactive({ count: 10, points: 100, batchNo: '', note: '', expiresInDays: 0 });
const resultDlg = ref(false);
const resultItems = ref([]);
const resultBatch = ref('');
const resultPoints = ref(0);
const revealDlg = ref(false);
const revealValue = ref('');
const redeemDlg = ref(false);
const redeemForm = reactive({ code: '', tokenId: null });
const redeemResult = ref(null);

const STATUS = { unused: '未使用', redeemed: '已兑换', revoked: '已撤销' };
const statusLabel = (s) => STATUS[s] || s;
const statusType = (s) => ({ unused: 'success', redeemed: 'info', revoked: 'danger' }[s] || 'info');
function fmt(iso) { return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—'; }

const statCards = computed(() => [
  { label: '卡密总数', value: summary.value.total ?? 0, color: 'var(--el-color-primary)' },
  { label: '未使用', value: summary.value.unused ?? 0, color: '#67c23a' },
  { label: '已兑换', value: summary.value.redeemed ?? 0, color: '#909399' },
  { label: '已撤销', value: summary.value.revoked ?? 0, color: '#f56c6c' },
  { label: '待兑积分', value: summary.value.unused_points ?? 0, color: '#e6a23c' },
]);

const resultText = computed(() => resultItems.value.map((i) => i.value).join('\n'));

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('已复制到剪贴板');
  } catch {
    ElMessage.warning('浏览器拒绝了剪贴板权限，请手动选中复制');
  }
}

function downloadResult() {
  const csv = '\uFEFF' + ['卡密,面额,批次', ...resultItems.value.map((i) => `${i.value},${i.points},${resultBatch.value}`)].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `cards-${resultBatch.value || Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  ElMessage.success('已下载');
}

async function load() {
  loading.value = true;
  try {
    const res = await api.get(`/api/cards${qs(query)}`);
    items.value = res.items;
    total.value = res.total;
    summary.value = res.summary || {};
  } finally { loading.value = false; }
}
function reload() { query.page = 1; load(); }

async function loadSide() {
  try { batches.value = (await api.get('/api/cards/batches')).items; } catch { /* 无权限 */ }
  try { tokenOptions.value = (await api.get('/api/tokens/options')).items; } catch { /* 无权限 */ }
}

function openGenerate() {
  Object.assign(genForm, { count: 10, points: 100, batchNo: '', note: '', expiresInDays: 0 });
  genDlg.value = true;
}

async function doGenerate() {
  saving.value = true;
  try {
    const res = await api.post('/api/cards/generate', { ...genForm });
    resultItems.value = res.items;
    resultBatch.value = res.batchNo;
    resultPoints.value = res.points;
    genDlg.value = false;
    resultDlg.value = true;
    load();
    loadSide();
  } finally { saving.value = false; }
}

async function reveal(row) {
  const res = await api.get(`/api/cards/${row.id}/reveal`);
  revealValue.value = res.code;
  revealDlg.value = true;
}

function openRedeem() {
  redeemForm.code = '';
  redeemForm.tokenId = tokenOptions.value[0]?.id ?? null;
  redeemResult.value = null;
  redeemDlg.value = true;
  loadSide();
}

async function doRedeem() {
  if (!redeemForm.code.trim()) return ElMessage.warning('请输入卡密');
  if (!redeemForm.tokenId) return ElMessage.warning('请选择要充值的令牌');
  saving.value = true;
  try {
    const res = await api.post('/api/cards/redeem', { code: redeemForm.code.trim(), tokenId: redeemForm.tokenId });
    redeemResult.value = res;
    redeemForm.code = '';
    ElMessage.success('兑换成功');
    load();
    loadSide();
  } finally { saving.value = false; }
}

async function action(row, act) {
  const label = act === 'revoke' ? '撤销' : '恢复';
  try { await ElMessageBox.confirm(`确定${label}卡密「${row.prefix}」？`, label, { type: 'warning' }); } catch { return; }
  await api.post(`/api/cards/${row.id}/action`, { action: act });
  ElMessage.success(`已${label}`);
  load();
}

async function remove(row) {
  try { await ElMessageBox.confirm(`确定删除卡密「${row.prefix}」？`, '删除卡密', { type: 'warning' }); } catch { return; }
  await api.del(`/api/cards/${row.id}`);
  ElMessage.success('已删除');
  load();
}

/** 「更多」下拉的路由 */
function rowMenu(row, cmd) {
  if (cmd === 'delete') return remove(row);
}

async function bulkRemove() {
  const ids = selected.value.map((r) => r.id);
  try { await ElMessageBox.confirm(`确定删除选中的 ${ids.length} 张卡密？（已兑换的会自动跳过）`, '批量删除', { type: 'warning' }); } catch { return; }
  const res = await api.del('/api/cards', { ids });
  ElMessage.success(`已删除 ${res.deleted} 张${res.skipped ? `，跳过 ${res.skipped} 张（已兑换）` : ''}`);
  load();
}

function exportCsv() {
  const token = localStorage.getItem('admin_token');
  fetch(`/api/cards/export${qs({ status: query.status, batch: query.batch })}`, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => r.blob())
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cards-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      ElMessage.success('已导出');
    });
}

onMounted(() => { load(); loadSide(); });
</script>

<style scoped>
.stats { margin-bottom: 14px; }
.stat {
  background: var(--el-bg-color); border: 1px solid var(--el-border-color-light);
  border-radius: 10px; padding: 14px 16px; margin-bottom: 10px;
}
.num { font-size: 20px; font-weight: 700; line-height: 1.3; }
.label { font-size: 12px; color: var(--el-text-color-secondary); }
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.spacer { flex: 1; min-width: 0; }
.pager { margin-top: 14px; justify-content: flex-end; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.mono-box :deep(textarea), .mono-box :deep(input) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.points { font-weight: 600; color: #e6a23c; }
.muted { color: var(--el-text-color-secondary); }
.tiny { font-size: 12px; }
.hint { margin-left: 10px; font-size: 12px; color: var(--el-text-color-secondary); }
.tip { margin-bottom: 16px; }
.mt { margin-top: 8px; }
</style>
