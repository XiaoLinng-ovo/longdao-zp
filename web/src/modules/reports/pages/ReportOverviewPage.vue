<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import PageHeader from '../../../shared/components/PageHeader.vue'
import ReportMetricGrid from '../components/ReportMetricGrid.vue'
import { loadReports, type RecruitingReport } from '../api'

const report = ref<RecruitingReport>()
const loading = ref(true)
const error = ref('')

const funnelMax = computed(() => Math.max(1, ...(report.value?.funnel ?? []).map((step) => step.count)))
const channelMax = computed(() => Math.max(1, ...(report.value?.channels ?? []).map((row) => row.applications)))

function width(value: number, max: number): string {
  return `${Math.max(value > 0 ? 6 : 0, Math.min(100, value / max * 100))}%`
}

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    report.value = await loadReports()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取招聘数据看板失败'
  } finally {
    loading.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <PageHeader title="招聘数据看板" description="洞察 / 数据看板">
    <button class="btn btn-ghost" type="button" :disabled="loading" @click="refresh">刷新</button>
  </PageHeader>

  <div v-if="loading" class="loading-note">正在读取招聘数据...</div>
  <div v-else-if="error" class="error-note" role="alert">{{ error }} <button class="btn btn-ghost" type="button" @click="refresh">重试</button></div>
  <template v-else-if="report">
    <ReportMetricGrid :rows="report.summary" />

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
  </template>
</template>

<style scoped>
.report-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.report-panel { min-width: 0; padding: 18px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); box-shadow: var(--shadow); }
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
  .bar-row, .channel-row { grid-template-columns: 74px minmax(80px, 1fr) auto; }
  .bar-row small { grid-column: 2 / -1; text-align: left; }
}
</style>
