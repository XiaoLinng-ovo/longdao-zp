<script setup lang="ts">
import type { Job } from '../../../shared/types/recruiting'
import StatusTag from '../../../shared/components/StatusTag.vue'
defineProps<{ rows: readonly Job[] }>()
</script>

<template>
  <div class="table-wrap"><table><thead><tr><th>岗位编号</th><th>职位</th><th>部门</th><th>状态</th><th>发布渠道</th><th>更新时间</th></tr></thead>
    <tbody><tr v-for="row in rows" :key="row.id"><td>{{ row.id }}</td><td><strong>{{ row.title }}</strong></td><td>{{ row.department }}</td><td><StatusTag :status="row.status" /></td><td>{{ row.channels.join('、') || '未发布' }}</td><td>{{ row.updatedAt }}</td></tr><tr v-if="!rows.length"><td colspan="6" class="table-empty">暂无数据</td></tr></tbody>
  </table></div>
</template>
