<script setup lang="ts">
import type { Offer } from '../../../shared/types/recruiting'
import StatusTag from '../../../shared/components/StatusTag.vue'
defineProps<{ rows: readonly Offer[] }>()
</script>

<template>
  <div class="table-wrap"><table><thead><tr><th>候选人</th><th>岗位</th><th>审批</th><th>发送</th><th>响应</th><th>更新时间</th></tr></thead>
    <tbody><tr v-for="row in rows" :key="row.id"><td><strong>{{ row.candidate }}</strong></td><td>{{ row.job }}</td><td><StatusTag :status="row.approvalStatus" /></td><td><StatusTag :status="row.deliveryStatus" /></td><td><StatusTag :status="row.response" /></td><td>{{ row.updatedAt }}</td></tr><tr v-if="!rows.length"><td colspan="6" class="table-empty">暂无数据</td></tr></tbody>
  </table></div>
</template>
