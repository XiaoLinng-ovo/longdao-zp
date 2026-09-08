<script setup lang="ts">
import type { Candidate } from '../../../shared/types/recruiting'
import StatusTag from '../../../shared/components/StatusTag.vue'
defineProps<{ rows: readonly Candidate[] }>()
</script>

<template>
  <div class="table-wrap"><table><thead><tr><th>候选人</th><th>应聘岗位</th><th>综合评分</th><th>AI 分析</th><th>申请状态</th><th>更新时间</th></tr></thead>
    <tbody><tr v-for="row in rows" :key="row.id"><td><strong>{{ row.name }}</strong><small class="muted">{{ row.id }}</small></td><td>{{ row.job }}</td><td><strong>{{ row.score }}</strong>/100</td><td><StatusTag :status="row.aiStatus" /></td><td><StatusTag :status="row.applicationStatus" /></td><td>{{ row.updatedAt }}</td></tr><tr v-if="!rows.length"><td colspan="6" class="table-empty">暂无数据</td></tr></tbody>
  </table></div>
</template>
