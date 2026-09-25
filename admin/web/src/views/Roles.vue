<template>
  <el-card shadow="never">
    <div class="toolbar">
      <span class="muted">角色决定用户能看哪些菜单、能调哪些接口。内置角色不可改权限。</span>
      <div class="spacer" />
      <el-button v-if="can('role:update')" type="primary" :icon="Plus" @click="openCreate">新建角色</el-button>
    </div>

    <el-table :data="items" v-loading="loading" border stripe>
      <el-table-column prop="id" label="ID" width="60" />
      <el-table-column prop="code" label="编码" width="110" />
      <el-table-column prop="name" label="名称" width="130" />
      <el-table-column prop="description" label="说明" min-width="200" show-overflow-tooltip />
      <el-table-column label="权限" min-width="200">
        <template #default="{ row }">
          <el-tag v-if="row.permissions.includes('*') || row.isAll" type="danger" size="small" effect="plain">全部权限</el-tag>
          <template v-else>
            <el-tag v-for="p in row.permissions.slice(0, 4)" :key="p" size="small" effect="plain" class="perm-tag">{{ label(p) }}</el-tag>
            <el-tag v-if="row.permissions.length > 4" size="small" type="info" effect="plain">+{{ row.permissions.length - 4 }}</el-tag>
            <span v-if="!row.permissions.length" class="muted">无</span>
          </template>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="80">
        <template #default="{ row }">
          <el-tag size="small" :type="row.builtin ? 'warning' : 'info'" effect="plain">{{ row.builtin ? '内置' : '自定义' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="190" fixed="right">
        <template #default="{ row }">
          <el-button v-if="can('role:update')" size="small" text type="primary" :disabled="!!row.builtin" @click="openPerm(row)">配置权限</el-button>
          <el-button v-if="can('role:update')" size="small" text type="danger" :disabled="!!row.builtin" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <!-- 配置权限 -->
  <el-dialog v-model="permDlg" :title="`配置权限 · ${current?.name || ''}`" width="620px">
    <div v-for="g in groups" :key="g.group" class="group">
      <div class="group-head">
        <el-checkbox
          :model-value="allChecked(g)"
          :indeterminate="someChecked(g)"
          @change="(v) => toggleGroup(g, v)"
        >{{ g.group }}</el-checkbox>
      </div>
      <div class="group-body">
        <el-checkbox
          v-for="p in g.items"
          :key="p.code"
          :model-value="checked.includes(p.code)"
          @change="(v) => toggleOne(p.code, v)"
        >{{ p.label }} <code>{{ p.code }}</code></el-checkbox>
      </div>
    </div>
    <template #footer>
      <el-button @click="permDlg = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="savePerm">保存</el-button>
    </template>
  </el-dialog>

  <!-- 新建角色 -->
  <el-dialog v-model="createDlg" title="新建角色" width="440px">
    <el-form :model="form" label-width="80px">
      <el-form-item label="编码"><el-input v-model="form.code" placeholder="英文小写，如 operator" /></el-form-item>
      <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
      <el-form-item label="说明"><el-input v-model="form.description" type="textarea" :rows="2" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="createDlg = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="saveCreate">创建</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
// keep-alive 靠组件名匹配 include，<script setup> 默认没有 name，
// 少了这一行缓存会**静默失效**（不报错、也不生效）。
defineOptions({ name: 'Roles' });
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus } from '@element-plus/icons-vue';
import { api } from '../api.js';
import { can } from '../store.js';

const items = ref([]);
const groups = ref([]);
const loading = ref(false);
const saving = ref(false);
const permDlg = ref(false);
const createDlg = ref(false);
const current = ref(null);
const checked = ref([]);
const form = reactive({ code: '', name: '', description: '' });

const permLabelMap = computed(() => {
  const m = {};
  for (const g of groups.value) for (const p of g.items) m[p.code] = p.label;
  return m;
});
function label(code) { return permLabelMap.value[code] || code; }

function allChecked(g) { return g.items.every((p) => checked.value.includes(p.code)); }
function someChecked(g) { const n = g.items.filter((p) => checked.value.includes(p.code)).length; return n > 0 && n < g.items.length; }
function toggleGroup(g, v) {
  const codes = g.items.map((p) => p.code);
  checked.value = v ? [...new Set([...checked.value, ...codes])] : checked.value.filter((c) => !codes.includes(c));
}
function toggleOne(code, v) {
  checked.value = v ? [...checked.value, code] : checked.value.filter((c) => c !== code);
}

async function load() {
  loading.value = true;
  try {
    items.value = (await api.get('/api/roles')).items;
  } finally { loading.value = false; }
}

function openPerm(row) { current.value = row; checked.value = [...row.permissions]; permDlg.value = true; }

async function savePerm() {
  saving.value = true;
  try {
    await api.put(`/api/roles/${current.value.id}/permissions`, { permissions: checked.value });
    ElMessage.success('权限已更新（相关用户下次请求即生效）');
    permDlg.value = false;
    load();
  } finally { saving.value = false; }
}

function openCreate() { Object.assign(form, { code: '', name: '', description: '' }); createDlg.value = true; }
async function saveCreate() {
  saving.value = true;
  try {
    await api.post('/api/roles', { ...form, permissions: [] });
    ElMessage.success('已创建，去配置权限');
    createDlg.value = false;
    load();
  } finally { saving.value = false; }
}

async function remove(row) {
  try { await ElMessageBox.confirm(`确定删除角色「${row.name}」？`, '删除角色', { type: 'warning' }); } catch { return; }
  await api.del(`/api/roles/${row.id}`);
  ElMessage.success('已删除');
  load();
}

onMounted(async () => {
  const p = await api.get('/api/roles/permissions');
  groups.value = p.groups;
  load();
});
</script>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.spacer { flex: 1; }
.muted { color: var(--el-text-color-secondary); font-size: 13px; }
.perm-tag { margin-right: 4px; }
.group { border-bottom: 1px solid var(--el-border-color-lighter); padding: 6px 0 12px; }
.group:last-child { border-bottom: 0; }
.group-head { font-weight: 600; margin-bottom: 6px; }
.group-body { display: flex; flex-wrap: wrap; gap: 4px 18px; padding-left: 22px; }
.group-body code { font-size: 11px; color: var(--el-text-color-placeholder); margin-left: 4px; }
</style>
