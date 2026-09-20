<script setup lang="ts">
import type { Status } from '../types/recruiting'

defineProps<{ status: Status | string }>()

const labels: Record<string, string> = {
  active: '进行中', pending: '待处理', approved: '已通过', rejected: '已拒绝', draft: '草稿',
  scheduled: '已安排', completed: '已完成', sent: '已发送', accepted: '已接受', declined: '已拒绝',
  published: '已发布', paused: '已暂停', configured: '已配置', disabled: '未配置', pending_approval: '待审批',
  withdrawn: '已撤回', closed: '已关闭', cancelled: '已取消', ready: '待发布', converted: '已转岗位',
  pending_analysis: '待分析', analysis_queued: '分析排队中', human_review: '人工复核', interviewing: '面试中',
  offer_approval: 'Offer 审批中', offer_sent: 'Offer 已发送', offer_accepted: 'Offer 已接受', onboarding_archived: '已入职归档',
  offer_declined: 'Offer 已拒绝', offer_cancelled: 'Offer 已取消', offer_expired: 'Offer 已过期', interview: '面试中',
  not_required: '无需复核', in_progress: '复核中', needs_correction: '需修正',
}
</script>

<template>
  <span class="status-tag" :class="`status-${status}`">
    <span class="status-bullet" aria-hidden="true"></span>
    {{ labels[status] ?? status }}
  </span>
</template>
