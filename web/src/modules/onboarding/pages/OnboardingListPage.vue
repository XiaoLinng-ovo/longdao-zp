<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RefreshCw, Search } from '@lucide/vue'
import {
  getOnboardingReport,
  listOnboardingWorkbench,
  ONBOARDING_STATUS_LABEL,
  type ApiOnboardingReport,
  type ApiOnboardingWorkbenchItem,
  type OnboardingStatus,
} from '../api'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import PageHeader from '../../../shared/components/PageHeader.vue'
import PageFeedback from '../../../shared/components/workflow/PageFeedback.vue'
import OnboardingTable from '../components/OnboardingTable.vue'
import OnboardingDetailDialog from '../components/OnboardingDetailDialog.vue'

const items = ref<ApiOnboardingWorkbenchItem[]>([])
const report = ref<ApiOnboardingReport | null>(null)
const loading = ref(true)
const error = ref('')
const feedback = ref('')
const search = ref('')
const status = ref<OnboardingStatus | ''>('')
const risk = ref<'' | 'high' | 'normal'>('')
const department = ref('')
const dateFrom = ref('')
const selected = ref<ApiOnboardingWorkbenchItem | null>(null)

const departments = computed(() => [...new Set(items.value.map((item) => item.department).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN')))

function visibleRiskReasons(item: ApiOnboardingWorkbenchItem): string[] {
  return item.highRiskReasons.filter((reason) => !reason.includes('系统集成') && !reason.includes('提醒'))
}
const highRiskCount = computed(() => items.value.filter((item) => visibleRiskReasons(item).length > 0).length)
const preparingCount = computed(() => items.value.filter((item) => ['pending', 'preparing'].includes(item.onboarding.status)).length)
const scheduledCount = computed(() => items.value.filter((item) => item.onboarding.status === 'scheduled').length)
const filteredItems = computed(() => {
  const keyword = search.value.trim().toLocaleLowerCase('zh-CN')
  return items.value.filter((item) => {
    const searchable = [item.candidateName, item.jobTitle, item.department, item.offerCode].join(' ').toLocaleLowerCase('zh-CN')
    return (!keyword || searchable.includes(keyword))
      && (!status.value || item.onboarding.status === status.value)
      && (!risk.value || (risk.value === 'high' ? visibleRiskReasons(item).length > 0 : visibleRiskReasons(item).length === 0))
      && (!department.value || item.department === department.value)
      && (!dateFrom.value || (item.onboarding.plannedStartDate ?? '') >= dateFrom.value)
  })
})

function percent(value: number | null): string {
  return value === null ? '暂无样本' : `${Math.round(value * 100)}%`
}

function clearFilters() {
  search.value = ''
  status.value = ''
  risk.value = ''
  department.value = ''
  dateFrom.value = ''
}

async function refresh(showLoading = true) {
  if (showLoading) loading.value = true
  error.value = ''
  try {
    const [workbench, summary] = await Promise.all([listOnboardingWorkbench(), getOnboardingReport()])
    items.value = workbench
    report.value = summary
    if (selected.value) selected.value = workbench.find((item) => item.onboarding.id === selected.value?.onboarding.id) ?? null
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取入职归档工作台失败').message
  } finally {
    loading.value = false
  }
}

async function handleUpdated(message: string) {
  feedback.value = message
  await refresh(false)
}

onMounted(() => refresh())
</script>

<template>
  <section class="onboarding-page">
    <PageHeader title="入职归档" description="把 Offer 后的报到安排、跨部门交接和材料核验统一推进到正式到岗。">
      <button class="btn btn-ghost icon-button" type="button" :disabled="loading" title="刷新工作台" @click="refresh()">
        <RefreshCw :size="16" aria-hidden="true" />刷新
      </button>
    </PageHeader>

    <PageFeedback :error="error" :feedback="feedback" @clear-error="error = ''" @clear-feedback="feedback = ''" />

    <div class="metric-grid onboarding-metrics">
      <article class="metric-card">
        <span>全部归档</span>
        <strong>{{ report?.totals.all ?? items.length }}</strong>
        <small>已接受 Offer 进入准备流程</small>
      </article>
      <article class="metric-card tone-blue">
        <span>准备中</span>
        <strong>{{ preparingCount }}</strong>
        <small>{{ report?.totals.pending ?? 0 }} 项待启动 · {{ report?.totals.preparing ?? 0 }} 项推进中</small>
      </article>
      <article class="metric-card tone-amber">
        <span>待报到</span>
        <strong>{{ scheduledCount }}</strong>
        <small>{{ report?.overdueTasks ?? 0 }} 项任务逾期 · {{ report?.blockedTasks ?? 0 }} 项阻塞</small>
      </article>
      <article class="metric-card tone-red">
        <span>高风险</span>
        <strong>{{ highRiskCount }}</strong>
        <small>缺少关键信息或临期阻塞</small>
      </article>
    </div>

    <section class="report-strip" aria-label="入职转化指标">
      <div><span>实际到岗率</span><strong>{{ percent(report?.arrivalRate ?? null) }}</strong></div>
      <div><span>必选任务准时率</span><strong>{{ percent(report?.requiredTaskOnTimeRate ?? null) }}</strong></div>
      <div><span>平均准备周期</span><strong>{{ report?.averagePreparationDays === null || report?.averagePreparationDays === undefined ? '暂无样本' : `${report.averagePreparationDays} 天` }}</strong></div>
    </section>

    <section class="workbench-panel">
      <div class="filter-bar">
        <label class="search-box">
          <Search :size="15" aria-hidden="true" />
          <input v-model="search" type="search" placeholder="搜索候选人、岗位、部门或 Offer 编号" aria-label="搜索入职归档" />
        </label>
        <select v-model="status" class="filter" aria-label="按状态筛选">
          <option value="">全部状态</option>
          <option v-for="(label, value) in ONBOARDING_STATUS_LABEL" :key="value" :value="value">{{ label }}</option>
        </select>
        <select v-model="risk" class="filter" aria-label="按风险筛选">
          <option value="">全部风险</option>
          <option value="high">仅高风险</option>
          <option value="normal">风险正常</option>
        </select>
        <select v-model="department" class="filter" aria-label="按部门筛选">
          <option value="">全部部门</option>
          <option v-for="name in departments" :key="name" :value="name">{{ name }}</option>
        </select>
        <input v-model="dateFrom" class="filter" type="date" aria-label="计划入职起始日期" />
        <button v-if="search || status || risk || department || dateFrom" class="btn btn-ghost" type="button" @click="clearFilters">清除筛选</button>
      </div>

      <div class="table-heading">
        <div><strong>{{ filteredItems.length }}</strong><span> 条记录</span></div>
        <span>按计划入职日期由近到远排序</span>
      </div>
      <div v-if="loading" class="loading-note">正在汇总入职准备状态...</div>
      <OnboardingTable v-else :rows="filteredItems" @open="selected = $event" />
    </section>

    <OnboardingDetailDialog
      v-if="selected"
      :item="selected"
      @close="selected = null"
      @updated="handleUpdated"
    />
  </section>
</template>

<style scoped>
.onboarding-page { min-width: 0; }
.icon-button { display: inline-flex; align-items: center; gap: 7px; }
.onboarding-metrics { margin-bottom: 16px; }
.report-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; overflow: hidden; margin-bottom: 18px; border: 1px solid #dfeaf1; border-radius: 12px; background: #e7eff5; box-shadow: 0 5px 16px rgba(69, 107, 135, .05); }
.report-strip div { min-width: 0; padding: 13px 16px; background: #fff; }
.report-strip span { display: block; color: #8aa0b2; font-size: 11px; }
.report-strip strong { display: block; margin-top: 5px; color: #27465f; font-size: 17px; }
.workbench-panel { min-width: 0; }
.filter-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.search-box { display: flex; align-items: center; gap: 7px; min-width: 260px; flex: 1 1 300px; max-width: 430px; padding: 0 10px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; color: #8ba1b1; }
.search-box input { min-width: 0; width: 100%; border: 0; outline: 0; padding: 8px 0; background: transparent; color: #27465f; }
.filter-bar .filter { min-height: 35px; }
.table-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 10px 2px; color: #8aa0b2; font-size: 11.5px; }
.table-heading strong { color: #27465f; font-size: 14px; }
@media (max-width: 900px) {
  .report-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .report-strip { grid-template-columns: 1fr; }
  .search-box { max-width: none; flex-basis: 100%; }
  .filter-bar .filter { flex: 1 1 calc(50% - 8px); min-width: 0; }
  .table-heading { align-items: flex-start; flex-direction: column; gap: 4px; }
}
</style>
