<script setup lang="ts">
import { computed } from 'vue'
import StatusTag from '../../../shared/components/StatusTag.vue'

const props = defineProps<{ status: string; progress?: number; attempt?: number; error?: string }>()
const active = computed(() => props.status === 'processing' || props.status === 'queued')
const ceiling = computed(() => props.status === 'queued' ? 30 : 95)
const percentage = computed(() => Math.floor(serverProgress()))
const progressHint = computed(() => active.value
  ? '后台任务进行中，等待完整的模型响应'
  : undefined)

function serverProgress() {
  if (props.status === 'completed') return 100
  const fallback = props.status === 'processing' ? 65 : props.status === 'queued' ? 15 : 0
  const progress = typeof props.progress === 'number' && Number.isFinite(props.progress) ? props.progress : fallback
  return Math.min(active.value ? ceiling.value : 100, Math.max(0, progress))
}

</script>

<template>
  <div class="analysis-progress" :aria-busy="active" :title="progressHint">
    <div class="progress-head">
      <StatusTag :status="status" :class="{ 'is-analyzing': status === 'processing' }" />
      <span class="progress-percentage">{{ active ? status === 'queued' ? '等待处理' : '等待模型' : status === 'failed' ? '未完成' : percentage + '%' }}</span>
    </div>
    <div class="progress-track" role="progressbar" aria-label="AI 简历分析进度" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="percentage" :aria-valuetext="active ? `${percentage}%，阶段预估，等待实际分析结果` : `${percentage}%`">
      <span class="progress-value" :class="{ failed: status === 'failed', completed: status === 'completed' }" :style="{ width: `${percentage}%` }"></span>
    </div>
    <small v-if="error" class="progress-error" :title="error">{{ error }}</small>
  </div>
</template>

<style scoped>
.analysis-progress { min-width: 0; }
.progress-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; margin-bottom: 6px; color: var(--muted); font-size: 11px; }
.progress-percentage { min-width: 32px; text-align: right; font-variant-numeric: tabular-nums; }
.progress-track { height: 6px; overflow: hidden; border-radius: 999px; background: #e2e8f0; }
.progress-value { display: block; height: 100%; border-radius: inherit; background: #d97706; transition: width .8s ease-in-out; }
.progress-value.completed { background: #16a34a; }
.progress-value.failed { background: #dc2626; }
.progress-error { display: block; max-width: 100%; margin-top: 5px; overflow: hidden; color: #b91c1c; font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
:deep(.status-processing .status-bullet), :deep(.status-queued .status-bullet) { background: #d97706; }
:deep(.status-failed .status-bullet) { background: #dc2626; }
:deep(.is-analyzing .status-bullet) { animation: analysis-dot-pulse 1.4s ease-in-out infinite; }
@keyframes analysis-dot-pulse {
  0%, 100% { opacity: .35; box-shadow: 0 0 0 0 rgb(217 119 6 / 0%); }
  50% { opacity: 1; box-shadow: 0 0 0 3px rgb(217 119 6 / 14%); }
}
@media (prefers-reduced-motion: reduce) {
  .progress-value { transition: none; }
  :deep(.is-analyzing .status-bullet) { animation: none; }
}
</style>
