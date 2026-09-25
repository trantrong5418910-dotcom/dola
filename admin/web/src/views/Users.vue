<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input v-model="query.keyword" placeholder="搜索用户名 / 昵称 / 邮箱" clearable style="width: 260px" @keyup.enter="reload" @clear="reload" />
      <el-select v-model="query.status" placeholder="全部状态" clearable style="width: 130px" @change="reload">
        <el-option label="启用" value="active" />
        <el-option label="停用" value="disabled" />
      </el-select>
      <el-button type="primary" :icon="Search" @click="reload">查询</el-button>
      <div class="spacer" />
      <el-button v-if="can('user:create')" type="primary" :icon="Plus" @click="openCreate">新建用户</el-button>
    </div>

    <el-table :data="items" v-loading="loading" border stripe style="width: 100%">
      <el-table-column prop="id" label="ID" width="60" />
      <el-table-column prop="username" label="用户名" min-width="120" />
      <el-table-column prop="nickname" label="昵称" min-width="110" />
      <el-table-column prop="email" label="邮箱" min-width="180" show-overflow-tooltip />
      <el-table-column label="角色" width="110">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ row.role_name || '—' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
            {{ row.status === 'active' ? '启用' : '停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="最后登录" width="140">
        <template #default="{ row }">{{ fmt(row.last_login_at) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="176" fixed="right" align="right">
        <template #default="{ row }">
          <el-button v-if="can('user:update')" size="small" text type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button v-if="can('user:update')" size="small" text @click="openReset(row)">重置密码</el-button>
          <el-button v-if="can('user:delete')" size="small" text type="danger" :disabled="row.id === state.user?.id" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
      <template #empty><el-empty description="没有用户" :image-size="80" /></template>
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

  <el-dialog v-model="dlg" :title="editing ? '编辑用户' : '新建用户'" width="440px">
    <el-form :model="form" label-width="80px">
      <el-form-item label="用户名" v-if="!editing">
        <el-input v-model="form.username" placeholder="登录名，创建后不可改" />
      </el-form-item>
      <el-form-item label="密码" v-if="!editing">
        <el-input v-model="form.password" type="password" show-password placeholder="至少 6 位" />
      </el-form-item>
      <el-form-item label="昵称"><el-input v-model="form.nickname" /></el-form-item>
      <el-form-item label="邮箱"><el-input v-model="form.email" /></el-form-item>
      <el-form-item label="角色">
        <el-select v-model="form.role_id" placeholder="选择角色" style="width: 100%">
          <el-option v-for="r in roles" :key="r.id" :label="r.name" :value="r.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="状态">
        <el-radio-group v-model="form.status">
          <el-radio value="active">启用</el-radio>
          <el-radio value="disabled">停用</el-radio>
        </el-radio-group>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dlg = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
// keep-alive 靠组件名匹配 include，<script setup> 默认没有 name，
// 少了这一行缓存会**静默失效**（不报错、也不生效）。
defineOptions({ name: 'Users' });
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Search } from '@element-plus/icons-vue';
import { api, qs } from '../api.js';
import { can, state } from '../store.js';

const items = ref([]);
const roles = ref([]);
const total = ref(0);
const loading = ref(false);
const saving = ref(false);
const dlg = ref(false);
const editing = ref(null);
const form = reactive({ username: '', password: '', nickname: '', email: '', role_id: null, status: 'active' });
const query = reactive({ page: 1, pageSize: 20, keyword: '', status: '' });

function fmt(iso) { return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—'; }

async function load() {
  loading.value = true;
  try {
    const res = await api.get(`/api/users${qs(query)}`);
    items.value = res.items;
    total.value = res.total;
  } finally { loading.value = false; }
}
function reload() { query.page = 1; load(); }

async function loadRoles() {
  try { roles.value = (await api.get('/api/roles/options')).items; } catch { /* 没权限就不显示 */ }
}

function reset() {
  Object.assign(form, { username: '', password: '', nickname: '', email: '', role_id: roles.value[0]?.id ?? null, status: 'active' });
}
function openCreate() { editing.value = null; reset(); dlg.value = true; }
function openEdit(row) {
  editing.value = row;
  Object.assign(form, { username: row.username, password: '', nickname: row.nickname, email: row.email, role_id: row.role_id, status: row.status });
  dlg.value = true;
}

async function save() {
  saving.value = true;
  try {
    if (editing.value) {
      await api.put(`/api/users/${editing.value.id}`, {
        nickname: form.nickname, email: form.email, role_id: form.role_id, status: form.status,
      });
      ElMessage.success('已保存');
    } else {
      await api.post('/api/users', { ...form });
      ElMessage.success('已创建');
    }
    dlg.value = false;
    load();
  } finally { saving.value = false; }
}

async function openReset(row) {
  try {
    const { value } = await ElMessageBox.prompt(`给「${row.username}」设置新密码`, '重置密码', {
      inputType: 'password',
      inputPlaceholder: '至少 6 位',
      inputValidator: (v) => (v && v.length >= 6) || '至少 6 位',
    });
    await api.post(`/api/users/${row.id}/reset-password`, { password: value });
    ElMessage.success('密码已重置');
  } catch { /* 取消 */ }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定删除用户「${row.username}」？此操作不可撤销。`, '删除用户', { type: 'warning' });
  } catch { return; }
  await api.del(`/api/users/${row.id}`);
  ElMessage.success('已删除');
  load();
}

onMounted(() => { loadRoles(); load(); });
</script>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.spacer { flex: 1; }
.pager { margin-top: 14px; justify-content: flex-end; }
</style>
