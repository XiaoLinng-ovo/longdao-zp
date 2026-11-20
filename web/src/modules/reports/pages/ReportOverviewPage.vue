<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Filter, RotateCcw, RefreshCw } from '@lucide/vue'
import PageHeader from '../../../shared/components/PageHeader.vue'
import CalendarDatePicker from '../../../shared/components/CalendarDatePicker.vue'
import { STATUS_LABEL } from '../../../shared/utils/labels'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import ReportMetricGrid from '../components/ReportMetricGrid.vue'
import { loadReports, type RecruitingReport, type ReportFilters } from '../api'

const report = ref<RecruitingReport>()
const loading = ref(true)
const error = ref('')
const route = useRoute(), router = useRouter()
const keys = ['from', 'to', 'jobId', 'channel', 'status'] as const
const filters = ref<ReportFilters>(Object.fromEntries(keys.map((key) => [key, typeof route.query[key] === 'string' ? route.query[key] : ''])))
const applied = ref<ReportFilters>({ ...filters.value })
const extraMetrics = computed(() => report.value ? [
  { label: '平均招聘周期', value: report.value.recruitmentCycle.averageDaysToHire ?? '暂无', detail: '天 · 已入职申请' },
  { label: '反馈完成率', value: report.value.feedbackCompletion.completionRate === null ? '暂无' : report.value.feedbackCompletion.completionRate + '%', detail: '已锁定反馈 / 应提交反馈' },
  { label: 'Offer 接受率', value: report.value.offerAcceptance.acceptanceRate === null ? '暂无' : report.value.offerAcceptance.acceptanceRate + '%', detail: '已接受 / 已发送 Offer' },
] : [])
async function applyFilters() {
  if (filters.value.from && filters.value.to && filters.value.from > filters.value.to) { error.value = '结束日期不能早于开始日期'; return }
  applied.value = { ...filters.value }
  await router.replace({ query: Object.fromEntries(Object.entries(applied.value).filter(([, value]) => value)) })
  await refresh()
}
async function resetFilters() { filters.value = {}; await applyFilters() }

const funnelMax = computed(() => Math.max(1, ...(report.value?.funnel ?? []).map((step) => step.count)))
const channelMax = computed(() => Math.max(1, ...(report.value?.channels ?? []).map((row) => row.applications)))

function width(value: number, max: number): string {
  return `${Math.max(value > 0 ? 6 : 0, Math.min(100, value / max * 100))}%`
}

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    report.value = await loadReports(applied.value)
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取招聘数据看板失败').message
  } finally {
    loading.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <PageHeader title="招聘数据看板" description="洞察 / 数据看板">
    <button class="btn btn-ghost" type="button" :disabled="loading" @click="refresh"><RefreshCw :size="16" />刷新</button>
  </PageHeader>

  <form class="report-filters" @submit.prevent="applyFilters">
    <label>申请开始日期<CalendarDatePicker :model-value="filters.from ?? ''" ariaLabel="申请开始日期" @update:model-value="filters.from = $event" /></label>
    <label>申请结束日期<CalendarDatePicker :model-value="filters.to ?? ''" ariaLabel="申请结束日期" @update:model-value="filters.to = $event" /></label>
    <label>岗位<select v-model="filters.jobId" aria-label="岗位筛选"><option value="">全部岗位</option><option v-for="job in report?.filterOptions?.jobs" :key="job.id" :value="job.id">{{ job.title }}</option></select></label>
    <label>渠道<select v-model="filters.channel" aria-label="渠道筛选"><option value="">全部渠道</option><option v-for="channel in report?.filterOptions?.channels" :key="channel">{{ channel }}</option></select></label>
    <label>状态<select v-model="filters.status" aria-label="状态筛选"><option value="">全部状态</option><option v-for="status in report?.filterOptions?.statuses" :key="status" :value="status">{{ STATUS_LABEL[status] ?? status }}</option></select></label>
    <button class="btn btn-primary" type="submit" :disabled="loading"><Filter :size="16" />筛选</button>
    <button class="btn btn-ghost" type="button" :disabled="loading" @click="resetFilters"><RotateCcw :size="16" />重置</button>
  </form>

  <div v-if="loading" class="loading-note">正在读取招聘数据...</div>
  <div v-else-if="error" class="error-note" role="alert">{{ error }} <button class="btn btn-ghost" type="button" @click="refresh">重试</button></div>
  <template v-else-if="report">
    <ReportMetricGrid :rows="report.summary" />
    <dl class="report-indicators"><div v-for="metric in extraMetrics" :key="metric.label"><dt>{{ metric.label }}</dt><dd>{{ metric.value }}</dd><small>{{ metric.detail }}</small></div></dl>

    <div class="report-grid">
      <section class="report-panel">
        <h3>招聘漏斗</h3>
        <div class="bar-list">
          <div v-for="step in report.funnel" :key="step.stage" class="bar-row">
            <span class="bar-label">{{ step.stage }}</span>
            <div class="bar-track"><span :style="{ width: width(step.count, funnelMax) }"></span></div>
            <strong>{{ step.count }}</strong>
            <small v-if="step.conversionRate !== null">{{ step.conversionRate }}%</small>
          </div>
          <p v-if="!report.funnel.length" class="table-empty">暂无漏斗数据</p>
        </div>
      </section>

      <section class="report-panel">
        <h3>渠道效果对比</h3>
        <div class="bar-list">
          <div v-for="row in report.channels" :key="row.channel" class="bar-row channel-row">
            <span class="bar-label">{{ row.channel }}</span>
            <div class="bar-track"><span :style="{ width: width(row.applications, channelMax) }"></span></div>
            <strong>{{ row.applications }} 份</strong>
            <small>转化率 {{ row.conversionRate }}%</small>
          </div>
          <p v-if="!report.channels.length" class="table-empty">暂无渠道数据</p>
        </div>
      </section>
    </div>
    <section class="job-filling"><h3>岗位填补情况</h3><div class="table-wrap"><table><thead><tr><th>岗位</th><th>招聘人数</th><th>已入职</th><th>缺口</th><th>填补率</th></tr></thead><tbody><tr v-for="job in report.jobFilling" :key="job.jobId"><td>{{ job.title }}</td><td>{{ job.headcount }}</td><td>{{ job.filledCount }}</td><td>{{ job.openCount }}</td><td>{{ job.fillRate }}%</td></tr><tr v-if="!report.jobFilling.length"><td colspan="5" class="table-empty">暂无岗位数据</td></tr></tbody></table></div></section>
  </template>
</template>

<style scoped>
.report-filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; margin-bottom: 18px; }
.report-filters > label { display: grid; gap: 5px; flex: 1 1 160px; min-width: 0; font-size: 12px; }
.report-filters select { min-width: 0; max-width: 100%; padding: 9px; border: 1px solid var(--border); border-radius: 5px; background: var(--card); }
.report-indicators { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 18px 0; border-block: 1px solid var(--border); }
.report-indicators > div { padding: 16px 10px; }.report-indicators dt, .report-indicators small { font-size: 12px; color: var(--muted); }.report-indicators dd { margin: 8px 0; font-size: 22px; font-weight: 650; }
.job-filling { min-width: 0; margin-top: 22px; }.job-filling h3 { font-size: 15px; }
.report-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.report-panel { min-width: 0; padding: 18px 0; border-block: 1px solid var(--border); }
.report-panel h3 { margin: 0 0 16px; color: #1e293b; font-size: 15px; }
.bar-list { display: grid; gap: 14px; }
.bar-row { display: grid; grid-template-columns: 88px minmax(120px, 1fr) 54px 86px; gap: 10px; align-items: center; }
.channel-row { grid-template-columns: 88px minmax(120px, 1fr) 64px 96px; }
.bar-label { min-width: 0; overflow: hidden; color: #334155; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { height: 10px; overflow: hidden; border-radius: 999px; background: #e2e8f0; }
.bar-track span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #2563eb, #7c3aed); }
.bar-row strong { color: #1e293b; font-size: 13px; text-align: right; }
.bar-row small { color: var(--muted); font-size: 11.5px; text-align: right; white-space: nowrap; }
@media (max-width: 900px) {
  .report-grid { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .report-indicators { grid-template-columns: 1fr; }
  .bar-row, .channel-row { grid-template-columns: 74px minmax(80px, 1fr) auto; }
  .bar-row small { grid-column: 2 / -1; text-align: left; }
}
</style>
