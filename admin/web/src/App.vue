<template>
  <router-view v-if="state.ready" />
  <div v-else class="boot">
    <el-icon class="is-loading" :size="28"><Loading /></el-icon>
    <p>正在恢复登录状态…</p>
  </div>
</template>

<script setup>
import { state } from './store.js';
</script>

<style>
html, body, #app { height: 100%; margin: 0; }
.boot {
  height: 100%; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 14px;
  color: var(--el-text-color-secondary);
}
</style>
