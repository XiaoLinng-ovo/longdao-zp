<script setup lang="ts">
import { loadDashboard } from '../api'
import MetricCard from '../../../shared/components/MetricCard.vue'
import PageHeader from '../../../shared/components/PageHeader.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import FunnelSummary from '../components/FunnelSummary.vue'
import { useRouter } from 'vue-router'
import { processAnalysisTask } from '../../candidates/api'
import { onMounted, ref } from 'vue'

type DashboardPayload = Awaited<ReturnType<typeof loadDashboard>>

const metrics = ref<DashboardPayload['metrics']>([])
const pending = ref<DashboardPayload['pending']>([])
const funnel = ref<DashboardPayload['funnel']>([])
const pendingFeedback = ref<DashboardPayload['pendingFeedback']>([])
const failedTasks = ref<DashboardPayload['failedTasks']>([])
const retryingTaskId = ref('')
const router = useRouter()
const loading = ref(true)
const error = ref('')

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    const data = await loadDashboard()
    metrics.value = data.metrics
    pending.value = data.pending
    funnel.value = data.funnel
    pendingFeedback.value = data.pendingFeedback
    failedTasks.value = data.failedTasks
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取招聘概览失败'
  } finally {
    loading.value = false
  }
}

function openRequirementForm() {
  router.push({ path: '/requisitions', query: { create: '1' } })
}

function openJobForm() {
  router.push({ path: '/jobs', query: { create: '1' } })
}

function openRequisition(row: DashboardPayload['pending'][number]) {
  router.push({ name: 'requisition-detail', params: { id: row.entityId || row.id } })
}

function openInterview(row: DashboardPayload['pendingFeedback'][number]) {
  router.push({ name: 'interview-detail', params: { id: row.id } })
}

async function retryTask(row: DashboardPayload['failedTasks'][number]) {
  if (retryingTaskId.value) return
  retryingTaskId.value = row.id
  try {
    await processAnalysisTask(row.id)
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '分析任务重试失败'
  } finally {
    retryingTaskId.value = ''
  }
}

onMounted(refresh)
</script>
<template>
  <PageHeader title="招聘概览" description="掌握团队招聘进展与待办事项">
    <div class="inline-actions">
      <button class="btn btn-primary" type="button" @click="openRequirementForm">新建需求</button>
      <button class="btn btn-primary" type="button" @click="openJobForm">新建岗位</button>
      <button class="btn btn-ghost" type="button" :disabled="loading" @click="refresh">刷新</button>
    </div>
  </PageHeader>
  <div v-if="loading" class="loading-note">正在读取招聘概览...</div>
  <div v-else-if="error" class="error-note">{{ error }} <button class="btn btn-ghost" type="button" @click="refresh">重试</button></div>
  <template v-else>
    <div class="metric-grid"><MetricCard v-for="metric in metrics" :key="metric.label" :metric="metric" /></div>
    <section class="section"><h3 class="section-title">招聘漏斗</h3><FunnelSummary :steps="funnel" /></section>
    <section class="section"><h3 class="section-title">待审批需求</h3><div class="table-wrap"><table><thead><tr><th>需求</th><th>部门</th><th>审批人</th><th>状态</th></tr></thead><tbody><tr v-for="row in pending" :key="row.id" class="row-clickable" role="link" tabindex="0" @click="openRequisition(row)" @keydown.enter="openRequisition(row)"><td><span class="row-link" @click.stop="openRequisition(row)">{{ row.title }}</span></td><td>{{ row.department }}</td><td>{{ row.approver }}</td><td><StatusTag :status="row.status" /></td></tr><tr v-if="!pending.length"><td colspan="4" class="table-empty">暂无待审批需求</td></tr></tbody></table></div></section>
    <section class="section"><h3 class="section-title">待反馈面试</h3><div class="table-wrap"><table><thead><tr><th>候选人</th><th>岗位</th><th>轮次</th><th>反馈状态</th></tr></thead><tbody><tr v-for="row in pendingFeedback" :key="row.id" class="row-clickable" role="link" tabindex="0" @click="openInterview(row)" @keydown.enter="openInterview(row)"><td><span class="row-link" @click.stop="openInterview(row)">{{ row.candidateName }}</span></td><td>{{ row.jobTitle }}</td><td>第 {{ row.round }} 轮</td><td><StatusTag :status="row.feedbackStatus" /></td></tr><tr v-if="!pendingFeedback.length"><td colspan="4" class="table-empty">暂无待反馈面试</td></tr></tbody></table></div></section>
    <section class="section"><h3 class="section-title">失败分析任务</h3><div class="table-wrap"><table><thead><tr><th>状态</th><th>尝试次数</th><th>失败原因</th><th>操作</th></tr></thead><tbody><tr v-for="row in failedTasks" :key="row.id"><td><StatusTag :status="row.status" /></td><td>{{ row.attempts }}</td><td>{{ row.lastError || '未记录失败原因' }}</td><td><button class="btn btn-primary" type="button" :disabled="retryingTaskId === row.id" @click="retryTask(row)">{{ retryingTaskId === row.id ? '重试中...' : '重新处理' }}</button></td></tr><tr v-if="!failedTasks.length"><td colspan="4" class="table-empty">暂无失败分析任务</td></tr></tbody></table></div></section>
  </template>
</template>


<style scoped>
.row-clickable { cursor: pointer; }
.row-clickable:hover td { background: #f8fafc; }
.row-link { color: var(--primary); font-weight: 500; }
.row-link:hover { text-decoration: underline; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
</style>
