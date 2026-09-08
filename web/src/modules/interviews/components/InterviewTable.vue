<script setup lang="ts">
import type { Interview } from '../../../shared/types/recruiting'
import StatusTag from '../../../shared/components/StatusTag.vue'
defineProps<{ rows: readonly Interview[] }>()
</script>

<template>
  <div class="table-wrap"><table><thead><tr><th>候选人</th><th>岗位</th><th>轮次</th><th>时间</th><th>面试官</th><th>反馈</th></tr></thead>
    <tbody><tr v-for="row in rows" :key="row.id"><td><strong>{{ row.candidate }}</strong></td><td>{{ row.job }}</td><td>{{ row.round }}</td><td>{{ row.scheduledAt }}</td><td>{{ row.interviewers.join('、') }}</td><td><StatusTag :status="row.feedbackStatus" /></td></tr><tr v-if="!rows.length"><td colspan="6" class="table-empty">暂无数据</td></tr></tbody>
  </table></div>
</template>
