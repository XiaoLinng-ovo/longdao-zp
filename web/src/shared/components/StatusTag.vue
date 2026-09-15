<script setup lang="ts">
import type { Status } from '../types/recruiting'

defineProps<{ status: Status | string }>()

const labels: Record<string, string> = {
  active: '进行中', pending: '待处理', approved: '已通过', rejected: '已拒绝', draft: '草稿',
  scheduled: '已安排', completed: '已完成', sent: '已发送', accepted: '已接受', declined: '已拒绝',
  published: '已发布', paused: '已暂停', configured: '已配置', disabled: '未配置', pending_approval: '待审批',
  withdrawn: '已撤回', closed: '已关闭', cancelled: '已取消', ready: '待发布', converted: '已转岗位',
}
</script>

<template>
  <span class="status-tag" :class="`status-${status}`">
    <span class="status-bullet" aria-hidden="true"></span>
    {{ labels[status] ?? status }}
  </span>
</template>
