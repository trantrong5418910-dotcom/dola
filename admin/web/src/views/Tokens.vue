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
          <el-input v-model="query.keyword" placeholder="搜索名称 / 前缀 / 备注" clearable style="width: 220px" @keyup.enter="reload" @clear="reload" />
          <el-select v-model="query.status" placeholder="全部状态" clearable style="width: 126px" @change="reload">
            <el-option label="启用" value="active" />
            <el-option label="停用" value="disabled" />
            <el-option label="已撤销" value="revoked" />
          </el-select>
          <el-button type="primary" :icon="Search" @click="reload">查询</el-button>
        </div>
        <div class="spacer" />
        <div class="actions">
          <el-button v-if="can('token:list')" :icon="Download" @click="exportCsv">导出 CSV</el-button>
          <el-button v-if="can('token:generate')" type="primary" :icon="Plus" @click="openGenerate">生成令牌</el-button>
        </div>
      </div>

      <el-table :data="items" v-loading="loading" border stripe>
        <el-table-column prop="id" label="ID" width="58" />
        <el-table-column prop="name" label="名称" width="104" show-overflow-tooltip />
        <el-table-column label="令牌" min-width="180">
          <template #default="{ row }">
            <span class="mono">{{ row.value }}</span>
          </template>
        </el-table-column>
        <el-table-column label="积分" width="80" sortable :sort-method="(a, b) => a.points - b.points">
          <template #default="{ row }"><span class="points">{{ row.points }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="86">
          <template #default="{ row }">
            <el-tag size="small" :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="过期" width="120">
          <template #default="{ row }">
            <span :class="{ expired: isExpired(row) }">{{ row.expires_at ? fmt(row.expires_at) : '永久' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="created_by_name" label="创建人" width="80" />
        <el-table-column label="创建时间" width="120">
          <template #default="{ row }">{{ fmt(row.created_at) }}</template>
        </el-table-column>
        <!--
          操作列从 310px 收到 176px：原来 5 个文字按钮并排（查看/改积分/停用/撤销/删除），
          加上 EP 默认内边距后整表超宽 198px，右侧固定列会盖住「创建时间」。
          现在只留高频两个，其余进「更多」下拉。
        -->
        <el-table-column label="操作" width="164" fixed="right" align="right">
          <template #default="{ row }">
            <el-button v-if="can('token:reveal')" size="small" text type="primary" @click="reveal(row)">查看</el-button>
            <el-button v-if="can('token:update')" size="small" text @click="openPoints(row)">改积分</el-button>
            <el-dropdown trigger="click" @command="(c) => rowMenu(row, c)">
              <el-button size="small" text>更多<el-icon><ArrowDown /></el-icon></el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item
                    v-if="can('token:update') && row.status !== 'revoked'"
                    :command="row.status === 'active' ? 'disable' : 'enable'"
                  >{{ row.status === 'active' ? '停用' : '启用' }}</el-dropdown-item>
                  <el-dropdown-item v-if="can('token:update') && row.status !== 'revoked'" command="revoke" divided>撤销</el-dropdown-item>
                  <el-dropdown-item v-if="can('token:delete')" command="delete" divided>删除</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>
        <template #empty><el-empty description="还没有令牌，点右上角生成" :image-size="80" /></template>
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
    <el-dialog v-model="genDlg" title="生成访问令牌" width="520px">
      <el-alert type="warning" :closable="false" show-icon class="tip"
        title="完整令牌只在生成后显示这一次。关掉窗口就查不到了（列表里只留掩码，需要时用「查看」单独取）。" />
      <el-form :model="genForm" label-width="110px" class="mt">
        <el-form-item label="数量">
          <el-input-number v-model="genForm.count" :min="1" :max="1000" />
          <span class="hint">最多 1000 个</span>
        </el-form-item>
        <el-form-item label="初始积分">
          <el-input-number v-model="genForm.points" :min="0" :max="1000000" :step="10" />
        </el-form-item>
        <el-form-item label="名称"><el-input v-model="genForm.name" placeholder="如：客户A / 生产环境" /></el-form-item>
        <el-form-item label="有效期（天）">
          <el-input-number v-model="genForm.expiresInDays" :min="0" :max="3650" />
          <span class="hint">0 = 永不过期</span>
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="genForm.note" placeholder="可选" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="genDlg = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doGenerate">确认生成</el-button>
      </template>
    </el-dialog>

    <!-- 生成结果（一次性展示） -->
    <el-dialog v-model="resultDlg" title="生成成功" width="620px" :close-on-click-modal="false">
      <el-alert type="success" :closable="false" show-icon :title="`已生成 ${resultItems.length} 个令牌，请立即复制保存`" />
      <el-input v-model="resultText" type="textarea" :rows="10" readonly class="mt mono-box" />
      <template #footer>
        <el-button :icon="Download" @click="downloadResult">下载 CSV</el-button>
        <el-button type="primary" :icon="CopyDocument" @click="copy(resultText)">复制全部</el-button>
        <el-button @click="resultDlg = false">我已保存，关闭</el-button>
      </template>
    </el-dialog>

    <!-- 查看完整值 -->
    <el-dialog v-model="revealDlg" title="令牌完整值" width="560px">
      <el-alert type="info" :closable="false" show-icon title="这次查看已写入操作日志（谁、什么时候、看了哪一个）。" />
      <el-input v-model="revealValue" readonly class="mt" />
      <template #footer>
        <el-button type="primary" :icon="CopyDocument" @click="copy(revealValue)">复制</el-button>
        <el-button @click="revealDlg = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 改积分 -->
    <el-dialog v-model="pointsDlg" title="调整积分" width="420px">
      <p class="muted">当前余额 <b>{{ current?.points }}</b>（可填负数扣减）</p>
      <el-input-number v-model="pointsDelta" :min="-1000000" :max="1000000" :step="10" style="width: 100%" />
      <template #footer>
        <el-button @click="pointsDlg = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="savePoints">确认</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowDown, CopyDocument, Download, Plus, Search } from '@element-plus/icons-vue';
import { api, qs } from '../api.js';
import { can } from '../store.js';

const items = ref([]);
const summary = ref({});
const total = ref(0);
const loading = ref(false);
const saving = ref(false);
const query = reactive({ page: 1, pageSize: 20, keyword: '', status: '' });

const genDlg = ref(false);
const genForm = reactive({ count: 1, points: 100, name: '', note: '', expiresInDays: 0 });
const resultDlg = ref(false);
const resultItems = ref([]);
const revealDlg = ref(false);
const revealValue = ref('');
const pointsDlg = ref(false);
const current = ref(null);
const pointsDelta = ref(0);

const STATUS = { active: '启用', disabled: '停用', revoked: '已撤销' };
const statusLabel = (s) => STATUS[s] || s;
const statusType = (s) => ({ active: 'success', disabled: 'info', revoked: 'danger' }[s] || 'info');
function fmt(iso) { return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function isExpired(row) { return row.expires_at && new Date(row.expires_at) < new Date(); }

const statCards = computed(() => [
  { label: '令牌总数', value: summary.value.total ?? 0, color: 'var(--el-color-primary)' },
  { label: '启用中', value: summary.value.active ?? 0, color: '#67c23a' },
  { label: '已停用', value: summary.value.disabled ?? 0, color: '#909399' },
  { label: '已撤销', value: summary.value.revoked ?? 0, color: '#f56c6c' },
  { label: '积分总量', value: summary.value.points ?? 0, color: '#e6a23c' },
]);

const resultText = computed(() =>
  resultItems.value.map((i) => `${i.value}\t${i.points} 积分`).join('\n'),
);

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('已复制到剪贴板');
  } catch {
    ElMessage.warning('浏览器拒绝了剪贴板权限，请手动选中复制');
  }
}

function downloadResult() {
  const csv = '\uFEFF' + ['令牌,积分,前缀', ...resultItems.value.map((i) => `${i.value},${i.points},${i.prefix}`)].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `tokens-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  ElMessage.success('已下载');
}

async function load() {
  loading.value = true;
  try {
    const res = await api.get(`/api/tokens${qs(query)}`);
    items.value = res.items;
    total.value = res.total;
    summary.value = res.summary || {};
  } finally { loading.value = false; }
}
function reload() { query.page = 1; load(); }

function openGenerate() {
  Object.assign(genForm, { count: 1, points: 100, name: '', note: '', expiresInDays: 0 });
  genDlg.value = true;
}

async function doGenerate() {
  saving.value = true;
  try {
    const res = await api.post('/api/tokens/generate', { ...genForm });
    resultItems.value = res.items;
    genDlg.value = false;
    resultDlg.value = true;
    load();
  } finally { saving.value = false; }
}

async function reveal(row) {
  const res = await api.get(`/api/tokens/${row.id}/reveal`);
  revealValue.value = res.value;
  revealDlg.value = true;
  load(); // 日志变了，列表里的审计不影响，但保持数据新鲜
}

function openPoints(row) { current.value = row; pointsDelta.value = 0; pointsDlg.value = true; }

async function savePoints() {
  if (!pointsDelta.value) return ElMessage.warning('请输入非零的增减值');
  saving.value = true;
  try {
    const res = await api.post(`/api/tokens/${current.value.id}/action`, { action: 'points', delta: pointsDelta.value });
    ElMessage.success(`已调整，当前 ${res.points} 积分`);
    pointsDlg.value = false;
    load();
  } finally { saving.value = false; }
}

async function action(row, act) {
  const label = { disable: '停用', enable: '启用', revoke: '撤销' }[act];
  const tip = act === 'revoke'
    ? `撤销后该令牌立即失效且不可恢复，确定撤销「${row.name || row.prefix}」？`
    : `确定${label}「${row.name || row.prefix}」？`;
  try { await ElMessageBox.confirm(tip, label, { type: 'warning' }); } catch { return; }
  await api.post(`/api/tokens/${row.id}/action`, { action: act });
  ElMessage.success(`已${label}`);
  load();
}

async function remove(row) {
  try { await ElMessageBox.confirm(`确定删除「${row.name || row.prefix}」？此操作不可撤销。`, '删除令牌', { type: 'warning' }); } catch { return; }
  await api.del(`/api/tokens/${row.id}`);
  ElMessage.success('已删除');
  load();
}

/** 「更多」下拉的路由：停用/启用 → action，删除 → remove */
function rowMenu(row, cmd) {
  if (cmd === 'delete') return remove(row);
  return action(row, cmd);
}

function exportCsv() {
  const token = localStorage.getItem('admin_token');
  // 导出接口要带 Authorization，用 fetch 拿 blob 再存盘
  fetch(`/api/tokens/export${qs({ status: query.status })}`, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => r.blob())
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tokens-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      ElMessage.success('已导出');
    });
}

onMounted(load);
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
.mono-box :deep(textarea) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.points { font-weight: 600; color: #e6a23c; }
.expired { color: var(--el-color-danger); }
.muted { color: var(--el-text-color-secondary); font-size: 13px; }
.hint { margin-left: 10px; font-size: 12px; color: var(--el-text-color-secondary); }
.tip { margin-bottom: 16px; }
.mt { margin-top: 8px; }
</style>
