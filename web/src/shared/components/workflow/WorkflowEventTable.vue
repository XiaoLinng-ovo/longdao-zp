<script setup lang="ts">
import type { WorkflowEvent } from '../../api/workflow-events'

defineProps<{
  events: WorkflowEvent[]
  loading?: boolean
}>()
</script>

<template>
  <div v-if="loading" class="loading-note">正在读取流程审计...</div>
  <div v-else-if="!events.length" class="hint">暂无流程审计记录</div>
  <div v-else class="table-wrap">
    <table class="audit-table">
      <thead>
        <tr><th>时间</th><th>对象</th><th>动作</th><th>状态流转</th><th>操作人</th><th>原因</th></tr>
      </thead>
      <tbody>
        <tr v-for="event in events" :key="event.id">
          <td>{{ (event.createdAt || '').slice(0, 19).replace('T', ' ') }}</td>
          <td>{{ event.subjectLabel || event.subjectId }}</td>
          <td>{{ event.action }}</td>
          <td>{{ event.fromStatus || '-' }} → {{ event.toStatus || '-' }}</td>
          <td>{{ event.actorId || '系统' }}</td>
          <td>{{ event.reason || '-' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.audit-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.audit-table th,
.audit-table td {
  border: 1px solid #e5e7eb;
  padding: 7px 9px;
  text-align: left;
  vertical-align: top;
}
.audit-table th {
  background: #f9fafb;
}
</style>
