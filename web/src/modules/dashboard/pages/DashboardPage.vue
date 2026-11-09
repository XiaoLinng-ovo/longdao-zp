<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { CalendarDays, Search, RotateCcw } from '@lucide/vue'
import type { DashboardPeriod } from '../api'
import { externalJobPublishingEnabled, recruitmentRequestsEnabled } from '../../../shared/config/features'
import { runtimeFeatures } from '../../../shared/config/runtime-features'
import { availableDashboardTodos } from '../utils/todo-availability'
import { useRouter } from 'vue-router'
import { loadDashboard } from '../api'
import MetricCard from '../../../shared/components/MetricCard.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'
import CalendarDatePicker from '../../../shared/components/CalendarDatePicker.vue'
import FunnelSummary from '../components/FunnelSummary.vue'
import { processAnalysisTask } from '../../candidates/api'
import { formatAnalysisError } from '../../../shared/utils/analysis-error'

type DashboardPayload = Awaited<ReturnType<typeof loadDashboard>>

const metrics = ref<DashboardPayload['metrics']>([])
const pending = ref<DashboardPayload['pending']>([])
const funnel = ref<DashboardPayload['funnel']>([])
const pendingInterviews = ref<DashboardPayload['pendingInterviews']>([])
const failedTasks = ref<DashboardPayload['failedTasks']>([])
const todos = ref<DashboardPayload['todos']>([])
const todoDialog = ref<HTMLDialogElement>()
const todoSearch = ref('')
const todoCategory = ref('')
const syncError = ref('')
const activity = ref<DashboardPayload['activity']>()
const initialEnd = new Date()
const initialStart = new Date(initialEnd)
initialStart.setDate(initialStart.getDate() - 29)
const rangeFrom = ref(localInput(initialStart)), rangeTo = ref(localInput(initialEnd)), rangeError = ref('')
const appliedPeriod = ref<DashboardPeriod>()
const shortcut = ref('30')
let requestVersion = 0
function localInput(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}
async function applyPeriod() {
  const from = new Date(rangeFrom.value + 'T00:00:00'), to = new Date(rangeTo.value + 'T00:00:00')
  if (!rangeFrom.value || !rangeTo.value || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) { rangeError.value = '请选择完整的开始和结束日期'; return }
  if (from > to) { rangeError.value = '结束日期不能早于开始日期'; return }
  // The API uses an exclusive end, so next midnight includes the entire end date.
  to.setDate(to.getDate() + 1)
  if (to.getTime() - from.getTime() > 3660 * 86400000) { rangeError.value = '时间跨度不能超过十年'; return }
  rangeError.value = ''
  appliedPeriod.value = { from: from.toISOString(), to: to.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' }
  await refresh(false, true)
}
async function selectPeriod(value: string) {
  shortcut.value = value; rangeError.value = ''
  if (value === 'all') { rangeFrom.value = ''; rangeTo.value = ''; appliedPeriod.value = undefined; await refresh(false, true); return }
  const end = new Date(); end.setHours(0, 0, 0, 0)
  const start = new Date(end)
  if (value !== 'today') start.setDate(start.getDate() - (value === '7' ? 6 : 29))
  rangeFrom.value = localInput(start); rangeTo.value = localInput(end)
  await applyPeriod()
}
let refreshing = false
let refreshTimer: ReturnType<typeof setInterval> | undefined
let disposed = false
const categoryLabels = { requisition: '招聘需求', job: '岗位', resume: '简历', interview: '面试', offer: '录用', onboarding: '入职' }
const visibleTodos = computed(() => availableDashboardTodos(todos.value, { externalJobPublishingEnabled, recruitmentRequestsEnabled }))
const todoCounts = computed(() => visibleTodos.value.reduce<Record<string, number>>((counts, row) => {
  counts[row.category] = (counts[row.category] ?? 0) + 1
  return counts
}, {}))
const todoCategories = computed(() => Object.entries(categoryLabels).filter(([key]) => Boolean(todoCounts.value[key])))
const filteredTodos = computed(() => {
  const keyword = todoSearch.value.trim().toLocaleLowerCase()
  return visibleTodos.value.filter(row => (!todoCategory.value || row.category === todoCategory.value)
    && (!keyword || `${row.title} ${row.description} ${categoryLabels[row.category]}`.toLocaleLowerCase().includes(keyword)))
})
const retryingTaskId = ref('')
const router = useRouter()
const loading = ref(true)
const error = ref('')

const flowSteps = computed(() => {
  const currentIndex = funnel.value.reduce((lastActive, step, index) => Number(step.value) > 0 ? index : lastActive, -1)
  return funnel.value.map((step, index) => ({
    label: step.label,
    count: Number(step.value) || 0,
    state: index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'upcoming',
  }))
})
const todoTotal = computed(() => visibleTodos.value.length)
const quickFlowSteps = computed(() => {
  const steps = [
    recruitmentRequestsEnabled
      ? { label: '一键导入需求', action: openRequirementForm }
      : { label: '新建岗位', action: openJobForm },
    { label: 'AI岗位说明书', action: openJobForm },
    { label: '一键生成JD', action: openJobForm },
  ]
  if (externalJobPublishingEnabled) steps.push({ label: '一键发布渠道', action: () => router.push('/jobs') })
  steps.push(
    { label: 'AI筛选简历', action: () => router.push('/candidates') },
    { label: '一键面试表', action: () => router.push('/interviews') },
  )
  if (runtimeFeatures.recruitmentReportsEnabled) steps.push({ label: '自动统计排序', action: () => router.push('/reports') })
  steps.push({ label: '一键发Offer', action: () => router.push('/offers') })
  return steps
})
const quickFlowTitle = computed(() => `${quickFlowSteps.value.length}步一站式主线`)
const conversionRate = computed(() => {
  const first = Number(funnel.value[0]?.value ?? 0)
  const last = Number(funnel.value[funnel.value.length - 1]?.value ?? 0)
  return first > 0 ? Math.round(last / first * 100) : 0
})

async function refresh(background = false, force = false) {
  if (refreshing && !force) return
  const token = ++requestVersion
  refreshing = true
  if (!background) { loading.value = true; error.value = '' }
  syncError.value = ''
  try {
    const data = await loadDashboard(appliedPeriod.value)
    if (disposed || token !== requestVersion) return
    activity.value = data.activity
    error.value = ''
    metrics.value = data.metrics
    pending.value = recruitmentRequestsEnabled ? data.pending : []
    funnel.value = data.funnel
    pendingInterviews.value = data.pendingInterviews
    failedTasks.value = data.failedTasks
    todos.value = data.todos
  } catch (cause) {
    if (disposed || token !== requestVersion) return
    const message = cause instanceof Error ? cause.message : '读取招聘概览失败'
    if (background) syncError.value = message
    else error.value = message
  } finally {
    if (token === requestVersion) { refreshing = false; loading.value = false }
  }
}

function openTodos() {
  todoSearch.value = ''
  todoCategory.value = ''
  todoDialog.value?.showModal()
  void refresh(true)
}

function openTodo(row: DashboardPayload['todos'][number]) {
  todoDialog.value?.close()
  void router.push(row.path)
}

function refreshWhenVisible() {
  if (document.visibilityState !== 'hidden') void refresh(true)
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

function openInterview(row: DashboardPayload['pendingInterviews'][number]) {
  router.push({ name: 'interview-detail', params: { id: row.id } })
}

function formatInterviewTime(value?: string) {
  if (!value) return '待安排'
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
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

onMounted(() => {
  void applyPeriod()
  window.addEventListener('focus', refreshWhenVisible)
  document.addEventListener('visibilitychange', refreshWhenVisible)
  refreshTimer = setInterval(refreshWhenVisible, 30_000)
})
onUnmounted(() => {
  disposed = true
  clearInterval(refreshTimer)
  window.removeEventListener('focus', refreshWhenVisible)
  document.removeEventListener('visibilitychange', refreshWhenVisible)
})
</script>

<template>
  <div class="page-header">
    <div><span class="header-meta"><span class="live-dot"></span>数据实时更新</span></div>
    <div class="inline-actions">
      <button v-if="recruitmentRequestsEnabled" class="btn btn-primary" type="button" @click="openRequirementForm"><span>＋</span> 新建需求</button>
      <button class="btn btn-secondary" type="button" @click="openJobForm"><span>＋</span> 新建岗位</button>
      <button class="btn btn-ghost" type="button" :disabled="loading" @click="refresh()">↻ 刷新</button>
    </div>
  </div>

  <form class="dashboard-period" aria-label="工作台日期筛选" @submit.prevent="shortcut = 'custom'; applyPeriod()">
    <span class="period-title"><CalendarDays :size="16" aria-hidden="true" />统计时段</span>
    <div class="period-shortcuts" role="group" aria-label="快捷时段">
      <button v-for="item in [{ value: 'all', label: '全部时间' }, { value: 'today', label: '今日' }, { value: '7', label: '近7天' }, { value: '30', label: '近30天' }]" :key="item.value" type="button" :aria-pressed="shortcut === item.value" @click="selectPeriod(item.value)">{{ item.label }}</button>
    </div>
    <label>开始日期<CalendarDatePicker v-model="rangeFrom" ariaLabel="统计开始日期" @update:model-value="shortcut = 'custom'" /></label>
    <span class="period-separator" aria-hidden="true">至</span>
    <label>结束日期<CalendarDatePicker v-model="rangeTo" ariaLabel="统计结束日期" @update:model-value="shortcut = 'custom'" /></label>
    <button class="btn btn-primary period-submit" type="submit"><Search :size="14" aria-hidden="true" />查询</button>
    <button v-if="appliedPeriod" class="period-reset" type="button" aria-label="恢复全部时间" title="恢复全部时间" @click="selectPeriod('all')"><RotateCcw :size="16" aria-hidden="true" /></button>
    <p v-if="rangeError" class="period-error" role="alert">{{ rangeError }}</p>
  </form>

  <div v-if="loading" class="loading-note">正在读取招聘概览...</div>
  <div v-else-if="error" class="error-note">{{ error }} <button class="btn btn-ghost" type="button" @click="refresh()">重试</button></div>
  <template v-else>
    <div v-if="syncError" class="error-note" role="status">同步失败：{{ syncError }} <button class="btn btn-ghost" type="button" @click="refresh(true)">重新同步</button></div>
    <div class="metric-grid dashboard-metrics">
      <MetricCard v-for="metric in metrics" :key="metric.label" :metric="metric" />
    </div>

    <div class="dashboard-overview-grid">
      <section class="dashboard-card todo-card">
        <div class="card-heading">
          <div><h3>待办事项 <em>{{ todoTotal }}</em></h3></div>
          <button class="heading-link" type="button" @click="openTodos">全部查看 →</button>
        </div>
        <div class="todo-list">
          <button v-for="row in visibleTodos.slice(0, 6)" :key="row.id" class="todo-item" type="button" @click="openTodo(row)">
            <span class="todo-bullet" :class="`category-${row.category}`"></span><span class="todo-copy"><strong>{{ row.title }}</strong><small :title="row.description">{{ categoryLabels[row.category] }} · {{ row.description }}</small></span><span class="todo-action">{{ row.actionLabel }}</span>
          </button>
          <div v-if="!todoTotal" class="todo-empty">太棒了，当前没有需要处理的待办事项 ✨</div>
        </div>
      </section>

      <section class="dashboard-card quickflow-card">
        <div class="card-heading">
          <div><h3>⚡ {{ quickFlowTitle }}</h3></div>
          <span class="flow-status"><span class="live-dot"></span>进行中</span>
        </div>
        <div class="quickflow-list">
          <button v-for="(step, index) in quickFlowSteps" :key="step.label" class="quickflow-step" type="button" @click="step.action"><span>{{ index + 1 }}. {{ step.label }}</span><b v-if="index < quickFlowSteps.length - 1">→</b></button>
        </div>
      </section>
    </div>

    <section class="dashboard-card progress-card">
      <div class="progress-summary"><h3>招聘阶段进度 · 全流程视图</h3><p v-if="!activity">当前整体转化率 <strong>{{ conversionRate }}%</strong></p><p v-else>所选时段内各阶段新增人数</p></div>
      <div class="progress-rail">
        <template v-for="(step, index) in flowSteps" :key="step.label">
          <div class="progress-node" :class="`is-${step.state}`"><span>{{ index + 1 }}</span><small>{{ step.label }}</small><b>{{ step.count }}</b></div>
          <i v-if="index < flowSteps.length - 1" class="progress-line" :class="{ 'is-done': step.state === 'done' }"></i>
        </template>
        <p v-if="!flowSteps.length" class="progress-empty">暂无阶段数据</p>
      </div>
    </section>

    <section class="section dashboard-section"><div class="section-heading"><div><h3 class="section-title">{{ activity ? '招聘阶段新增' : '招聘漏斗' }}</h3></div><span class="section-note">{{ activity ? '各阶段按实际进入时间分别计数' : '从收到申请到入职的完整转化' }}</span></div><FunnelSummary :steps="funnel" :period="!!activity" :previous-counts="activity ? [activity.previousCounts.applications, activity.previousCounts.screened, activity.previousCounts.interviews, activity.previousCounts.offers, activity.previousCounts.onboarded] : undefined" /></section>

    <section v-if="recruitmentRequestsEnabled" class="section dashboard-section"><div class="section-heading"><div><span class="section-eyebrow">需要推进</span><h3 class="section-title">待审批需求</h3></div><span class="section-note">共 {{ pending.length }} 条记录</span></div><div class="table-wrap dashboard-table"><table><thead><tr><th>需求</th><th>部门</th><th>审批人</th><th>状态</th></tr></thead><tbody><tr v-for="row in pending" :key="row.id" class="row-clickable" role="link" tabindex="0" @click="openRequisition(row)" @keydown.enter="openRequisition(row)"><td><span class="row-link" @click.stop="openRequisition(row)">{{ row.title }}</span></td><td>{{ row.department }}</td><td>{{ row.approver }}</td><td><StatusTag :status="row.status" /></td></tr><tr v-if="!pending.length"><td colspan="4" class="table-empty">暂无待审批需求</td></tr></tbody></table></div></section>

    <section class="section dashboard-section"><div class="section-heading"><div><h3 class="section-title">待完成面试</h3></div><span class="section-note">共 {{ pendingInterviews.length }} 条记录</span></div><div class="table-wrap dashboard-table"><table><thead><tr><th>候选人</th><th>岗位</th><th>轮次</th><th>计划时间</th></tr></thead><tbody><tr v-for="row in pendingInterviews" :key="row.id" class="row-clickable" role="link" tabindex="0" @click="openInterview(row)" @keydown.enter="openInterview(row)"><td><span class="row-link" @click.stop="openInterview(row)">{{ row.candidateName }}</span></td><td>{{ row.jobTitle }}</td><td>第 {{ row.round }} 轮</td><td><time v-if="row.scheduledStartAt" :datetime="row.scheduledStartAt">{{ formatInterviewTime(row.scheduledStartAt) }}</time><span v-else>待安排</span></td></tr><tr v-if="!pendingInterviews.length"><td colspan="4" class="table-empty">暂无待完成面试</td></tr></tbody></table></div></section>

    <section class="section dashboard-section"><div class="section-heading"><div><h3 class="section-title">失败分析任务</h3></div><span class="section-note">自动化处理队列</span></div><div class="table-wrap dashboard-table"><table><thead><tr><th>状态</th><th>尝试次数</th><th>失败原因</th><th>操作</th></tr></thead><tbody><tr v-for="row in failedTasks" :key="row.id"><td><StatusTag :status="row.status" /></td><td>{{ row.attempts }}</td><td>{{ formatAnalysisError(row.lastError) }}</td><td><button class="btn btn-primary" type="button" :disabled="retryingTaskId === row.id" @click="retryTask(row)">{{ retryingTaskId === row.id ? '重试中...' : '重新处理' }}</button></td></tr><tr v-if="!failedTasks.length"><td colspan="4" class="table-empty">暂无失败分析任务</td></tr></tbody></table></div></section>
  </template>
  <dialog ref="todoDialog" class="todos-dialog" aria-labelledby="todos-title" @click="event => { if (event.target === todoDialog) todoDialog?.close() }">
    <header class="todos-heading">
      <div><h2 id="todos-title">全部待办 <span>{{ todoTotal }}</span></h2><p>当前所有未处理事项</p></div>
      <button class="todos-close" type="button" aria-label="关闭待办列表" title="关闭" @click="todoDialog?.close()">×</button>
    </header>
    <div class="todos-filters">
      <input v-model="todoSearch" type="search" aria-label="搜索待办" placeholder="搜索候选人、岗位或事项" />
      <select v-model="todoCategory" aria-label="待办分类"><option value="">全部分类</option><option v-for="[key, label] in todoCategories" :key="key" :value="key">{{ label }}（{{ todoCounts[key] }}）</option></select>
    </div>
    <p class="todos-result" role="status">共 {{ filteredTodos.length }} 项<span v-if="syncError"> · 同步失败：{{ syncError }}</span></p>
    <div class="todos-scroll">
      <button v-for="row in filteredTodos" :key="row.id" class="todo-item" type="button" @click="openTodo(row)">
        <span class="todo-bullet" :class="`category-${row.category}`"></span><span class="todo-copy"><strong>{{ row.title }}</strong><small>{{ categoryLabels[row.category] }} · {{ row.description }}</small></span><span class="todo-action">{{ row.actionLabel }}</span>
      </button>
      <div v-if="!filteredTodos.length" class="todo-empty">{{ todoTotal ? '没有匹配的待办事项' : '当前没有待办事项' }}</div>
    </div>
  </dialog>
</template>

<style scoped>
.dashboard-period{display:flex;align-items:flex-end;flex-wrap:wrap;gap:12px;margin:0 0 18px;padding:14px 0;border-top:1px solid #e0ebf3;border-bottom:1px solid #e0ebf3;color:#526f85}
.period-title{display:flex;align-items:center;gap:7px;align-self:center;font-size:13px;font-weight:650}.period-title svg{color:#399b9a}
.period-shortcuts{display:flex;gap:2px;align-self:center;padding:3px;background:#eaf2f8;border-radius:7px}.period-shortcuts button{border:0;border-radius:5px;padding:8px 10px;background:transparent;color:#637d91;font-size:12px;cursor:pointer;white-space:nowrap}.period-shortcuts button[aria-pressed=true]{background:#fff;color:#287e8e;box-shadow:0 2px 5px #315c7a14}
.dashboard-period label{display:grid;gap:5px;width:210px;min-width:0;font-size:11px}.period-separator{align-self:flex-end;padding-bottom:10px;font-size:12px}.period-submit{display:flex;align-items:center;gap:6px;min-height:36px;white-space:nowrap}.period-reset{display:grid;place-items:center;flex:none;width:36px;height:36px;border:1px solid #cfe0ec;border-radius:7px;background:white;color:#638296;cursor:pointer}.period-error{flex-basis:100%;margin:0;color:#b54858;font-size:12px}
@media(max-width:680px){.dashboard-period{gap:10px}.period-title{flex-basis:100%}.dashboard-period label{flex:1 1 100%;width:100%;max-width:100%}.period-separator{display:none}.period-shortcuts{flex-basis:100%}.period-shortcuts button{flex:1;padding:9px 7px}}

.row-clickable { cursor: pointer; }
.row-clickable:hover td { background: #f5f9ff; }
.row-link { color: var(--primary); font-weight: 650; }
.row-link:hover { text-decoration: underline; }
.header-meta { display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; color: #6f8aa4; font-size: 11px; }
.live-dot { width: 7px; height: 7px; display: inline-block; border-radius: 50%; background: #34c987; box-shadow: 0 0 0 4px rgba(52, 201, 135, .13); }
.dashboard-overview-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; margin-bottom: 16px; }
.dashboard-card { min-width: 0; background: rgba(255,255,255,.94); border: 1px solid #e3edf5; border-radius: 18px; box-shadow: 0 10px 30px rgba(68, 107, 137, .08); }
.todo-card, .quickflow-card { padding: 20px; min-height: 284px; }
.card-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; margin-bottom: 16px; }
.section-eyebrow { display: block; color: #91a8bd; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; margin-bottom: 5px; }
.card-heading h3, .progress-summary h3 { margin: 0; color: #17324c; font-size: 16px; letter-spacing: -.01em; }
.card-heading h3 em { display: inline-grid; place-items: center; min-width: 22px; height: 20px; padding: 0 6px; margin-left: 5px; border-radius: 99px; background: #eef5ff; color: #3379e7; font-size: 11px; font-style: normal; vertical-align: 2px; }
.heading-link, .section-note { color: #89a0b5; font-size: 11px; white-space: nowrap; }
.heading-link { border: 0; background: #eef5ff; color: #286ccb; border-radius: 6px; padding: 7px 10px; cursor: pointer; }
.heading-link:hover { background: #dfecff; }
.heading-link:focus-visible, .todo-item:focus-visible, .todos-close:focus-visible { outline: 2px solid #367bea; outline-offset: 3px; }
.todos-dialog { width: min(760px, calc(100vw - 32px)); max-height: min(780px, calc(100dvh - 48px)); padding: 24px; box-sizing: border-box; border: 1px solid #dce9f5; border-radius: 8px; color: #294562; background: #fff; box-shadow: 0 24px 80px #213f632e; }
.todos-dialog[open] { display: flex; flex-direction: column; }
.todos-dialog::backdrop { background: #203c5b66; }
.todos-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.todos-heading h2 { margin: 0; font-size: 20px; }
.todos-heading h2 span { color: #367bea; font-size: 16px; }
.todos-heading p, .todos-result { color: #71869b; font-size: 12px; }
.todos-close { flex: 0 0 32px; height: 32px; border: 0; border-radius: 6px; background: #eff4fa; color: #516c86; font-size: 24px; cursor: pointer; }
.todos-filters { display: flex; gap: 12px; margin-top: 12px; }
.todos-filters input, .todos-filters select { min-width: 0; border: 1px solid #d5e3ef; border-radius: 6px; background: #f8fbff; padding: 10px 12px; font: inherit; font-size: 13px; color: inherit; }
.todos-filters input { flex: 1; }
.todos-scroll { min-height: 0; overflow-y: auto; padding: 4px; }
.todos-scroll .todo-copy strong, .todos-scroll .todo-copy small { white-space: normal; overflow-wrap: anywhere; line-height: 1.7; }
.todos-scroll .todo-item { padding: 16px 4px; }
.todos-scroll .todo-item:hover { background: #f4f8fd; }
.category-requisition, .category-offer { background: #efa350; }
.category-job, .category-interview { background: #5a9cf8; }
.category-resume { background: #38af98; }
.category-onboarding { background: #ba85ce; }
@media (max-width: 540px) { .todos-dialog { padding: 16px; } .todos-filters { flex-direction: column; } .todos-scroll .todo-item { gap: 8px; } }
.todo-list { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; }
.todo-item { width: 100%; min-width: 0; max-width: 100%; display: flex; align-items: center; gap: 10px; padding: 11px 0; border: 0; border-top: 1px solid #edf3f8; background: transparent; color: inherit; text-align: left; transition: .18s ease; }
.todo-item:first-child { border-top: 0; }
.todo-item:hover { padding-left: 6px; }
.todo-bullet { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; }
.bullet-orange { background: #fb8b57; box-shadow: 0 0 0 4px #fff1e9; }
.bullet-blue { background: #5a9cf8; box-shadow: 0 0 0 4px #edf4ff; }
.bullet-red { background: #ef6a85; box-shadow: 0 0 0 4px #fff0f3; }
.todo-copy { min-width: 0; flex: 1 1 0; overflow: hidden; }
.todo-copy strong, .todo-copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.todo-copy strong { color: #294562; font-size: 12.5px; font-weight: 650; }
.todo-copy small { margin-top: 4px; color: #8aa0b2; font-size: 11px; }
.todo-action { flex: 0 0 auto; white-space: nowrap; padding: 6px 10px; border-radius: 8px; background: #367bea; color: #fff; font-size: 11px; }
.todo-item:hover .todo-action { background: #2468d5; }
.todo-empty { padding: 36px 10px; color: #8aa0b2; text-align: center; font-size: 12px; }
.flow-status { display: inline-flex; align-items: center; gap: 7px; padding: 5px 9px; color: #3b86d9; background: #eff7ff; border-radius: 99px; font-size: 11px; }
.quickflow-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
.quickflow-step { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-height: 38px; padding: 8px 10px; border: 1px solid #e3edf4; border-radius: 10px; background: #fbfdff; color: #57728b; text-align: left; font-size: 11.5px; transition: .18s ease; }
.quickflow-step:hover { border-color: #8bb7ee; background: #f2f8ff; color: #2370d9; transform: translateY(-1px); box-shadow: 0 5px 12px rgba(62, 126, 214, .1); }
.quickflow-step b { color: #a7bfd4; font-size: 14px; font-weight: 400; }
.progress-card { display: flex; align-items: center; gap: 24px; padding: 18px 22px; margin-bottom: 26px; }
.progress-summary { flex: 0 0 220px; }
.progress-summary p { margin: 7px 0 0; color: #8ba0b3; font-size: 11px; }
.progress-summary p strong { color: #3281de; font-size: 14px; }
.progress-rail { display: flex; align-items: flex-start; flex: 1; min-width: 0; }
.progress-node { position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 62px; color: #9bb0c1; text-align: center; }
.progress-node span { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: #edf2f6; color: #8ca1b2; font-size: 11px; font-weight: 700; }
.progress-node small { white-space: nowrap; font-size: 10.5px; }
.progress-node b { position: absolute; top: -7px; right: 3px; min-width: 16px; padding: 2px 4px; border-radius: 99px; background: #e7f2ff; color: #4d91dd; font-size: 9px; }
.progress-node.is-done, .progress-node.is-current { color: #4b83bc; }
.progress-node.is-done span { background: #3bb875; color: #fff; }
.progress-node.is-current span { background: #3d83ec; color: #fff; box-shadow: 0 0 0 5px #e9f2ff; }
.progress-node.is-current small { color: #2d72d5; font-weight: 700; }
.progress-line { flex: 1; height: 2px; min-width: 14px; margin: 11px 7px 0; background: #e5edf3; }
.progress-line.is-done { background: #56c58b; }
.dashboard-section { margin-top: 25px; }
.section-heading { display: flex; align-items: end; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.section-heading .section-title { margin: 0; }
.dashboard-table { overflow: hidden; }
@media (max-width: 980px) { .dashboard-overview-grid { grid-template-columns: minmax(0, 1fr); } .progress-card { align-items: flex-start; flex-direction: column; gap: 14px; } .progress-summary { flex-basis: auto; } .progress-rail { width: 100%; } }
@media (max-width: 680px) { .todo-card, .quickflow-card { padding: 16px; } .quickflow-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } .progress-rail { overflow-x: auto; padding: 4px 2px 8px; } .progress-node { flex: 0 0 72px; } .progress-line { flex: 0 0 18px; } .section-heading { align-items: flex-start; flex-direction: column; gap: 4px; } }
</style>
