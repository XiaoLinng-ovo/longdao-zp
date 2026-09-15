<script setup lang="ts">
import { loadReports, type RecruitingReport } from '../api'
import { computed, onMounted, ref } from 'vue'
import PageHeader from '../../../shared/components/PageHeader.vue'
import ReportMetricGrid from '../components/ReportMetricGrid.vue'
import StatusTag from '../../../shared/components/StatusTag.vue'

const report = ref<RecruitingReport>()
const loading = ref(true)
const error = ref('')
const funnelMax = computed(() => Math.max(1, ...(report.value?.funnel ?? []).map((step) => step.count)))
const channelMax = computed(() => Math.max(1, ...(report.value?.channels ?? []).map((row) => Math.max(row.applications, row.screened, row.interviewed, row.offers, row.hired))))
function ratioWidth(value: number): string { return `${Math.max(0, Math.min(100, value))}%` }
async function refresh() { loading.value = true; error.value = ''; report.value = undefined; try { report.value = await loadReports() } catch (cause) { error.value = cause instanceof Error ? cause.message : '读取报表失败' } finally { loading.value = false } }
onMounted(refresh)
</script>

<template>
  <PageHeader title="招聘报表" description="从漏斗、渠道与效率维度查看招聘表现"><button class="btn btn-ghost" type="button" :disabled="loading" @click="refresh">刷新</button></PageHeader>
  <div v-if="loading" class="loading-note">正在读取报表...</div><div v-else-if="error" class="error-note" role="alert">{{ error }} <button class="btn btn-ghost" type="button" @click="refresh">重试</button></div><template v-else-if="report"><ReportMetricGrid :rows="report.summary" />
  <section class="section"><h3 class="section-title">招聘漏斗</h3><div class="funnel"><div v-for="step in report.funnel" :key="step.stage" class="funnel-step funnel-step-visual"><div class="funnel-copy"><strong>{{ step.count }}</strong><span>{{ step.stage }}<template v-if="step.conversionRate !== null"> · {{ step.conversionRate }}%</template></span></div><div class="funnel-track"><div class="funnel-fill" :style="{ width: ratioWidth((step.count / funnelMax) * 100) }"></div></div></div></div></section>
  <section class="section">
    <h3 class="section-title">岗位填充</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>岗位</th><th>需求人数</th><th>已填充</th><th>缺口</th><th>填充率</th></tr></thead><tbody><tr v-for="row in report.jobFilling" :key="row.jobId"><td>{{ row.title }}</td><td>{{ row.headcount }}</td><td>{{ row.filledCount }}</td><td>{{ row.openCount }}</td><td>{{ row.fillRate }}%</td></tr><tr v-if="!report.jobFilling.length"><td colspan="5" class="table-empty">暂无岗位数据</td></tr></tbody>
      </table>
    </div>
  </section>
  <section class="section"><h3 class="section-title">各阶段状态分布</h3><div class="table-wrap"><table><thead><tr><th>实体</th><th>状态</th><th>数量</th></tr></thead><tbody><tr v-for="row in report.statusStats" :key="row.entity+row.status"><td>{{ row.entity }}</td><td><StatusTag :status="row.status" /></td><td>{{ row.count }}</td></tr><tr v-if="!report.statusStats.length"><td colspan="3" class="table-empty">暂无状态分布数据</td></tr></tbody></table></div></section>
  <section class="section"><h3 class="section-title">渠道数据</h3><div class="table-wrap"><table><thead><tr><th>渠道</th><th>申请</th><th>筛选</th><th>面试</th><th>Offer</th><th>入职</th><th>转化率</th></tr></thead><tbody><tr v-for="row in report.channels" :key="row.channel"><td>{{ row.channel }}</td><td>{{ row.applications }}</td><td>{{ row.screened }}</td><td>{{ row.interviewed }}</td><td>{{ row.offers }}</td><td>{{ row.hired }}</td><td><div class="mini-rate"><span>{{ row.conversionRate }}%</span><span class="mini-track"><span class="mini-fill" :style="{ width: ratioWidth(Number(row.conversionRate) || 0) }"></span></span></div></td></tr><tr v-if="!report.channels.length"><td colspan="7" class="table-empty">暂无渠道数据</td></tr></tbody></table></div></section>
  <section class="section"><h3 class="section-title">招聘周期</h3><div class="metric-grid compact"><div class="metric-card"><strong>{{ report.recruitmentCycle.hiredCount }}</strong><span>已入职人数</span></div><div class="metric-card"><strong>{{ report.recruitmentCycle.averageDaysToHire ?? '—' }}</strong><span>平均入职天数</span></div><div class="metric-card"><strong>{{ report.recruitmentCycle.medianDaysToHire ?? '—' }}</strong><span>中位入职天数</span></div></div></section>
  <section class="section"><h3 class="section-title">面试反馈完成度</h3><div class="metric-grid compact"><div class="metric-card"><strong>{{ report.feedbackCompletion.locked }}</strong><span>已锁定反馈</span></div><div class="metric-card"><strong>{{ report.feedbackCompletion.expected }}</strong><span>应完成反馈</span></div><div class="metric-card"><strong>{{ report.feedbackCompletion.completionRate ?? '—' }}</strong><span>完成率（%）</span></div></div></section>
  <section class="section"><h3 class="section-title">Offer 接受率</h3><div class="metric-grid compact"><div class="metric-card"><strong>{{ report.offerAcceptance.sent }}</strong><span>已发送 Offer</span></div><div class="metric-card"><strong>{{ report.offerAcceptance.accepted }}</strong><span>已接受 Offer</span></div><div class="metric-card"><strong>{{ report.offerAcceptance.acceptanceRate ?? '—' }}</strong><span>接受率（%）</span></div></div></section></template>
</template>

<style scoped>
.funnel-step-visual { display: block; }
.funnel-copy { display: flex; justify-content: space-between; gap: 14px; margin-bottom: 5px; }
.funnel-track, .mini-track { display: block; height: 8px; border-radius: 999px; background: #e2e8f0; overflow: hidden; }
.funnel-fill, .mini-fill { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #0f766e, #14b8a6); }
.mini-rate { display: flex; flex-direction: column; gap: 4px; min-width: 130px; }
.mini-rate > span:first-child { font-weight: 600; }
</style>
