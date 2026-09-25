<template>
  <el-row :gutter="14">
    <el-col :md="10" :xs="24">
      <el-card shadow="never">
        <template #header><span class="title">账号信息</span></template>
        <el-descriptions :column="1" border>
          <el-descriptions-item label="用户名">{{ state.user?.username }}</el-descriptions-item>
          <el-descriptions-item label="昵称">{{ state.user?.nickname || '—' }}</el-descriptions-item>
          <el-descriptions-item label="邮箱">{{ state.user?.email || '—' }}</el-descriptions-item>
          <el-descriptions-item label="角色">
            <el-tag size="small" effect="plain">{{ state.user?.role_name }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="权限数">
            {{ state.user?.permissions?.includes('*') ? '全部（超级管理员）' : (state.user?.permissions?.length || 0) + ' 项' }}
          </el-descriptions-item>
          <el-descriptions-item label="最后登录">{{ fmt(state.user?.last_login_at) }}</el-descriptions-item>
        </el-descriptions>
      </el-card>
    </el-col>

    <el-col :md="14" :xs="24">
      <el-card shadow="never">
        <template #header><span class="title">修改密码</span></template>
        <el-form :model="form" label-width="90px" style="max-width: 420px">
          <el-form-item label="原密码">
            <el-input v-model="form.oldPassword" type="password" show-password />
          </el-form-item>
          <el-form-item label="新密码">
            <el-input v-model="form.newPassword" type="password" show-password placeholder="至少 6 位" />
          </el-form-item>
          <el-form-item label="确认新密码">
            <el-input v-model="form.confirm" type="password" show-password />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never" class="mt">
        <template #header><span class="title">界面</span></template>
        <div class="row">
          <span>深色模式</span>
          <el-switch :model-value="state.dark" @change="toggleTheme" />
        </div>
      </el-card>
    </el-col>
  </el-row>
</template>

<script setup>
// keep-alive 靠组件名匹配 include，<script setup> 默认没有 name，
// 少了这一行缓存会**静默失效**（不报错、也不生效）。
defineOptions({ name: 'Profile' });
import { reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import { state, toggleTheme } from '../store.js';

const form = reactive({ oldPassword: '', newPassword: '', confirm: '' });
const saving = ref(false);

function fmt(iso) { return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—'; }

async function submit() {
  if (!form.oldPassword || !form.newPassword) return ElMessage.warning('请填写原密码和新密码');
  if (form.newPassword.length < 6) return ElMessage.warning('新密码至少 6 位');
  if (form.newPassword !== form.confirm) return ElMessage.warning('两次输入的新密码不一致');
  saving.value = true;
  try {
    await api.post('/api/auth/password', { oldPassword: form.oldPassword, newPassword: form.newPassword });
    ElMessage.success('密码已修改');
    Object.assign(form, { oldPassword: '', newPassword: '', confirm: '' });
  } finally { saving.value = false; }
}
</script>

<style scoped>
.title { font-weight: 600; }
.mt { margin-top: 14px; }
.row { display: flex; align-items: center; justify-content: space-between; max-width: 420px; }
</style>
