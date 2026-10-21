<script setup lang="ts">
import { computed } from 'vue'

interface FunnelStep {
  label: string
  value: string | number
  conversionRate?: number | null
}

const props = defineProps<{ steps: readonly FunnelStep[] }>()

const totalValue = computed(() => numericValue(props.steps[0]?.value ?? 0))

function numericValue(value: string | number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function barWidth(value: string | number): string {
  if (totalValue.value <= 0) return '0%'
  const percent = (numericValue(value) / totalValue.value) * 100
  return `${Math.max(6, Math.min(100, percent))}%`
}

function overallConversionText(value: string | number): string {
  if (totalValue.value <= 0) return '—'
  return `${Math.round((numericValue(value) / totalValue.value) * 10000) / 100}%`
}

function lossText(index: number): string {
  if (index === 0) return '—'
  const previous = numericValue(props.steps[index - 1]?.value ?? 0)
  const current = numericValue(props.steps[index]?.value ?? 0)
  const delta = previous - current
  if (delta > 0) return `减少 ${delta}`
  if (delta < 0) return `增加 ${Math.abs(delta)}`
  return '持平'
}

const chartLabel = computed(() => props.steps.map((step) => `${step.label} ${step.value}`).join('，'))
</script>

<template>
  <div class="funnel-visual" aria-label="招聘漏斗">
    <div class="funnel-chart" role="img" :aria-label="`招聘漏斗：${chartLabel}`">
      <div v-for="(step, index) in steps" :key="step.label" class="funnel-row">
        <div class="funnel-label">
          <strong>{{ step.label }}</strong>
          <span>{{ step.value }}</span>
        </div>
        <div class="funnel-bar-track">
          <div class="funnel-bar" :style="{ width: barWidth(step.value) }"></div>
        </div>
        <span class="funnel-rate">{{ overallConversionText(step.value) }}</span>
      </div>
    </div>

    <div class="table-wrap funnel-table">
      <table>
        <thead>
          <tr><th>阶段</th><th>人数</th><th>整体转化率</th><th>阶段变化</th></tr>
        </thead>
        <tbody>
          <tr v-for="(step, index) in steps" :key="step.label">
            <td>{{ step.label }}</td>
            <td>{{ step.value }}</td>
            <td>{{ overallConversionText(step.value) }}</td>
            <td>{{ lossText(index) }}</td>
          </tr>
          <tr v-if="!steps.length"><td colspan="4" class="table-empty">暂无漏斗数据</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.funnel-visual {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(360px, 0.85fr);
  gap: 14px;
  align-items: start;
}

.funnel-chart {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  box-shadow: var(--shadow);
}

.funnel-row {
  display: grid;
  grid-template-columns: 94px minmax(0, 1fr) 62px;
  gap: 11px;
  align-items: center;
}

.funnel-label {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.funnel-label strong {
  color: #1e293b;
  font-size: 12.5px;
  font-weight: 650;
}

.funnel-label span,
.funnel-rate {
  color: var(--muted);
  font-size: 11.5px;
}

.funnel-rate {
  text-align: right;
  white-space: nowrap;
}

.funnel-bar-track {
  height: 10px;
  overflow: hidden;
  border-radius: 999px;
  background: #e2e8f0;
}

.funnel-bar {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #0f766e, #14b8a6);
}

.funnel-table table {
  min-width: 420px;
}

@media (max-width: 900px) {
  .funnel-visual {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 560px) {
  .funnel-row {
    grid-template-columns: 1fr auto;
    gap: 6px 10px;
  }

  .funnel-bar-track {
    grid-column: 1 / -1;
    grid-row: 2;
  }
}
</style>
