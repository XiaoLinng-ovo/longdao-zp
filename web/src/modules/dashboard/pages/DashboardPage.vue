<script setup lang="ts">
import { getDashboardMetrics, getDashboardPending } from '../api'
import MetricCard from '../../../shared/components/MetricCard.vue'
import PageHeader from '../../../shared/components/PageHeader.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import FunnelSummary from '../components/FunnelSummary.vue'
const metrics = getDashboardMetrics()
const pending = getDashboardPending()
const funnel = [{ label: '收到简历', value: 246 }, { label: '通过筛选', value: 86 }, { label: '进入面试', value: 32 }, { label: '发出 Offer', value: 11 }]
</script>
<template><PageHeader title="招聘概览" description="掌握团队招聘进展与待办事项" /><div class="metric-grid"><MetricCard v-for="metric in metrics" :key="metric.label" :metric="metric" /></div><section class="section"><h3 class="section-title">招聘漏斗</h3><FunnelSummary :steps="funnel" /></section><section class="section"><h3 class="section-title">待处理需求</h3><div class="table-wrap"><table><thead><tr><th>需求</th><th>部门</th><th>审批人</th><th>状态</th></tr></thead><tbody><tr v-for="row in pending" :key="row.id"><td>{{ row.title }}</td><td>{{ row.department }}</td><td>{{ row.approver }}</td><td><StatusTag :status="row.status" /></td></tr><tr v-if="!pending.length"><td colspan="4" class="table-empty">暂无待处理需求</td></tr></tbody></table></div></section></template>
