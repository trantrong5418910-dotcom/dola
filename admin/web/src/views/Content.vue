<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input v-model="query.keyword" placeholder="搜索标题 / 正文" clearable style="width: 220px" @keyup.enter="reload" @clear="reload" />
      <el-select v-model="query.category" placeholder="全部分类" clearable style="width: 140px" @change="reload">
        <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
      </el-select>
      <el-select v-model="query.status" placeholder="全部状态" clearable style="width: 130px" @change="reload">
        <el-option label="草稿" value="draft" />
        <el-option label="已发布" value="published" />
        <el-option label="已归档" value="archived" />
      </el-select>
      <el-button type="primary" :icon="Search" @click="reload">查询</el-button>
      <div class="spacer" />
      <el-button v-if="can('content:delete')" :disabled="!selected.length" type="danger" plain @click="bulkRemove">
        批量删除{{ selected.length ? `（${selected.length}）` : '' }}
      </el-button>
      <el-button v-if="can('content:create')" type="primary" :icon="Plus" @click="openCreate">新建内容</el-button>
    </div>

    <el-table :data="items" v-loading="loading" border stripe @selection-change="(v) => (selected = v)">
      <el-table-column type="selection" width="46" />
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
      <el-table-column prop="category" label="分类" width="110">
        <template #default="{ row }"><el-tag size="small" effect="plain">{{ row.category }}</el-tag></template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="author" label="作者" width="110" />
      <el-table-column label="更新时间" width="160">
        <template #default="{ row }">{{ fmt(row.updated_at) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="openView(row)">查看</el-button>
          <el-button v-if="can('content:update')" size="small" text type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button v-if="can('content:delete')" size="small" text type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
      <template #empty><el-empty description="暂无内容" :image-size="80" /></template>
    </el-table>

    <el-pagination
      class="pager"
      layout="total, sizes, prev, pager, next"
      :total="total"
      :current-page="query.page"
      :page-size="query.pageSize"
      :page-sizes="[10, 20, 50]"
      @current-change="(p) => { query.page = p; load(); }"
      @size-change="(s) => { query.pageSize = s; query.page = 1; load(); }"
    />
  </el-card>

  <el-dialog v-model="dlg" :title="mode === 'view' ? '查看内容' : (editing ? '编辑内容' : '新建内容')" width="620px">
    <el-form :model="form" label-width="70px">
      <el-form-item label="标题"><el-input v-model="form.title" :disabled="mode === 'view'" /></el-form-item>
      <el-form-item label="分类"><el-input v-model="form.category" :disabled="mode === 'view'" placeholder="如 default / docs" /></el-form-item>
      <el-form-item label="状态">
        <el-radio-group v-model="form.status" :disabled="mode === 'view'">
          <el-radio value="draft">草稿</el-radio>
          <el-radio value="published">已发布</el-radio>
          <el-radio value="archived">已归档</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="正文">
        <el-input v-model="form.body" type="textarea" :rows="9" :disabled="mode === 'view'" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dlg = false">{{ mode === 'view' ? '关闭' : '取消' }}</el-button>
      <el-button v-if="mode !== 'view'" type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Search } from '@element-plus/icons-vue';
import { api, qs } from '../api.js';
import { can } from '../store.js';

const items = ref([]);
const categories = ref([]);
const selected = ref([]);
const total = ref(0);
const loading = ref(false);
const saving = ref(false);
const dlg = ref(false);
const editing = ref(null);
const mode = ref('edit'); // edit | view
const form = reactive({ title: '', category: 'default', status: 'draft', body: '' });
const query = reactive({ page: 1, pageSize: 20, keyword: '', category: '', status: '' });

const STATUS = { draft: '草稿', published: '已发布', archived: '已归档' };
function statusLabel(s) { return STATUS[s] || s; }
function statusType(s) { return { draft: 'info', published: 'success', archived: 'warning' }[s] || 'info'; }
function fmt(iso) { return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—'; }

async function load() {
  loading.value = true;
  try {
    const res = await api.get(`/api/contents${qs(query)}`);
    items.value = res.items;
    total.value = res.total;
  } finally { loading.value = false; }
}
function reload() { query.page = 1; load(); }
async function loadCategories() {
  try { categories.value = (await api.get('/api/contents/categories')).items; } catch { /* ignore */ }
}

function openCreate() { editing.value = null; mode.value = 'edit'; Object.assign(form, { title: '', category: 'default', status: 'draft', body: '' }); dlg.value = true; }
function openEdit(row) { editing.value = row; mode.value = 'edit'; Object.assign(form, { title: row.title, category: row.category, status: row.status, body: row.body }); dlg.value = true; }
function openView(row) { openEdit(row); mode.value = 'view'; }

async function save() {
  if (!form.title.trim()) return ElMessage.warning('标题必填');
  saving.value = true;
  try {
    if (editing.value) await api.put(`/api/contents/${editing.value.id}`, { ...form });
    else await api.post('/api/contents', { ...form });
    ElMessage.success('已保存');
    dlg.value = false;
    load();
    loadCategories();
  } finally { saving.value = false; }
}

async function remove(row) {
  try { await ElMessageBox.confirm(`确定删除「${row.title}」？`, '删除内容', { type: 'warning' }); } catch { return; }
  await api.del(`/api/contents/${row.id}`);
  ElMessage.success('已删除');
  load();
}

async function bulkRemove() {
  const ids = selected.value.map((r) => r.id);
  try { await ElMessageBox.confirm(`确定删除选中的 ${ids.length} 条内容？`, '批量删除', { type: 'warning' }); } catch { return; }
  const res = await api.del('/api/contents', { ids });
  ElMessage.success(`已删除 ${res.deleted} 条`);
  load();
}

onMounted(() => { load(); loadCategories(); });
</script>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.spacer { flex: 1; }
.pager { margin-top: 14px; justify-content: flex-end; }
</style>
