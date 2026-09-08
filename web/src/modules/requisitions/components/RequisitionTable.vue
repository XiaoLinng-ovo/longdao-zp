<script setup lang="ts">
import type { Requisition } from '../../../shared/types/recruiting'
import StatusTag from '../../../shared/components/StatusTag.vue'
defineProps<{ rows: readonly Requisition[] }>()
</script>

<template>
  <div class="table-wrap"><table><thead><tr><th>需求编号</th><th>岗位</th><th>部门</th><th>人数</th><th>预算</th><th>审批人</th><th>状态</th><th>更新日期</th></tr></thead>
    <tbody><tr v-for="row in rows" :key="row.id"><td>{{ row.id }}</td><td><strong>{{ row.title }}</strong></td><td>{{ row.department }}</td><td>{{ row.headcount }}</td><td>{{ row.budget }}</td><td>{{ row.approver }}</td><td><StatusTag :status="row.status" /></td><td>{{ row.updatedAt }}</td></tr><tr v-if="!rows.length"><td colspan="8" class="table-empty">暂无数据</td></tr></tbody>
  </table></div>
</template>
