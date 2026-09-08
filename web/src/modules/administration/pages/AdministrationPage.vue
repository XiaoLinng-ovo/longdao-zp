<script setup lang="ts">
import { listAdminChecks } from '../api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import SecurityNotice from '../components/SecurityNotice.vue'

const rows = listAdminChecks()
</script>

<template>
  <PageHeader title="管理后台" description="查看招聘团队、流程与系统服务配置" />
  <div class="table-wrap">
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
