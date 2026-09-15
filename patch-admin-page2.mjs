import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const fs = require('fs');
const p = 'web/src/modules/administration/pages/AdministrationPage.vue';
const content = `<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { listAdminChecks, type AdminCheckRow } from '../api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import SecurityNotice from '../components/SecurityNotice.vue'

const rows = ref<AdminCheckRow[]>([])
const loading = ref(true)
const error = ref('')
async function refresh() {
  loading.value = true
  error.value = ''
  try {
    rows.value = await listAdminChecks()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取系统配置失败'
  } finally {
    loading.value = false
  }
}
onMounted(refresh)
</script>

<template>
  <PageHeader title="管理后台" description="查看招聘团队、流程与系统服务配置">
    <button class="btn btn-ghost" type="button" :disabled="loading" @click="refresh">刷新</button>
  </PageHeader>
  <div v-if="loading" class="loading-note">正在读取系统配置...</div>
  <div v-else-if="error" class="error-note" role="alert">{{ error }} <button class="btn btn-ghost" type="button" @click="refresh">重试</button></div>
  <div v-else class="table-wrap">
    <table>
      <thead><tr><th>配置类别</th><th>负责人</th><th>状态</th><th>当前配置</th></tr></thead>
      <tbody>
        <tr v-for="row in rows" :key="row.category">
          <td><strong>{{ row.category }}</strong></td><td>{{ row.owner }}</td>
          <td><StatusTag :status="row.status" /></td><td>{{ row.detail }}</td>
        </tr>
        <tr v-if="!rows.length"><td colspan="4" class="table-empty">暂无配置</td></tr>
      </tbody>
    </table>
  </div>
  <SecurityNotice />
</template>
`;
fs.writeFileSync(p, content, 'utf8');
console.log('written');
