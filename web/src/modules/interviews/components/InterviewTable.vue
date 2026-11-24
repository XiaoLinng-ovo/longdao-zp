<script setup lang="ts">
import { formatAnalysisError } from '../../../shared/utils/analysis-error'
import type { InterviewView } from '../api'
import { questionPreparationFailureLabel } from '../api/question-preparation'
const preparationLabels = { not_started: '未准备', queued: '准备中', generating: '准备中', ready: '已就绪', failed: '准备失败', cancelled: '已停止' }
import { aiScoreLabel, interviewResult, INTERVIEW_RESULT_LABELS } from '../utils/interview-result'

const props = defineProps<{
  rows: InterviewView[]
  confirmingDeleteId?: string | null
  deletingInterviewId?: string | null
  preparingInterviewId?: string | null
  emptyMessage?: string
}>()

const emit = defineEmits<{
  prepare: [row: InterviewView]
  arrange: [row: InterviewView]
  reschedule: [row: InterviewView]
  conclude: [row: InterviewView]
  detail: [row: InterviewView]
  delete: [row: InterviewView]
  confirmDelete: [row: InterviewView]
  cancelDelete: []
}>()

function rowId(row: InterviewView): string {
  return row.entityId || row.id
}

function needsFinalSchedule(row: InterviewView): boolean {
  const isFinal = row.stage === 'final' || (!row.stage && Number.parseInt(row.round, 10) >= 2)
  const missingStart = row.scheduledStartAt === undefined ? row.scheduledAt === '待安排' : !row.scheduledStartAt
  return isFinal && row.status === 'scheduled' && (missingStart || !row.interviewerIds.length)
}
</script>

<template>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th class="candidate-column">候选人</th>
          <th class="job-column">岗位</th>
          <th class="round-column">轮次</th>
          <th class="time-column">时间</th>
          <th class="interviewer-column">面试官</th>
          <th class="preparation-column">面试表</th>
          <th class="score-column">AI 评分</th>
          <th class="result-column">面试结果</th>
          <th class="actions-column">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.entityId || row.id">
          <td class="candidate-cell"><strong>{{ row.candidate }}</strong></td>
          <td class="job-cell">{{ row.job }}</td>
          <td class="round-cell">{{ row.round }}</td>
          <td class="time-cell">{{ row.scheduledAt }}</td>
          <td class="interviewer-cell">{{ row.interviewers.join('、') || '未分配' }}</td>
          <td class="preparation-cell-wrap">
            <div class="preparation-cell" v-if="row.questionPreparation">
              <span class="preparation-tag" :data-state="row.questionPreparation.status" :title="row.questionPreparation.error ? formatAnalysisError(row.questionPreparation.error) : undefined">
                {{ preparationLabels[row.questionPreparation.status] }}
                <small v-if="['queued', 'generating'].includes(row.questionPreparation.status) && row.questionPreparation.completedGroups.length">{{ row.questionPreparation.completedGroups.length }}/{{ row.stage === 'final' || Number.parseInt(row.round, 10) >= 2 ? 4 : 3 }}</small>
              </span>
              <button v-if="row.status === 'scheduled' && ['failed', 'not_started'].includes(row.questionPreparation.status)" class="btn btn-ghost btn-sm preparation-retry" type="button" :disabled="props.preparingInterviewId === rowId(row)" @click="emit('prepare', row)">{{ props.preparingInterviewId === rowId(row) ? '提交中…' : row.questionPreparation.status === 'failed' ? '重试' : '准备' }}</button>
              <small v-if="row.questionPreparation.rubricsStatus" class="preparation-progress">评价表{{ row.questionPreparation.rubricsStatus === 'ready' ? '已就绪' : '载入中' }} · 题组 {{ row.questionPreparation.completedGroups.length }}/{{ row.stage === 'final' || Number.parseInt(row.round, 10) >= 2 ? 4 : 3 }}</small>
              <details v-if="row.questionPreparation.error && ['failed', 'queued', 'generating'].includes(row.questionPreparation.status)" class="preparation-error" :open="row.questionPreparation.status === 'failed'">
                <summary>{{ row.questionPreparation.failure ? questionPreparationFailureLabel(row.questionPreparation.failure) : '查看失败原因' }}</summary>
                <p>{{ formatAnalysisError(row.questionPreparation.error) }}</p>
                <p v-if="row.questionPreparation.status !== 'failed'">{{ row.questionPreparation.status === 'queued' ? '等待自动重试' : '正在重试' }} · 第 {{ (row.questionPreparation.attempts || 0) + (row.questionPreparation.status === 'queued' ? 1 : 0) }} 次尝试</p>
                <p v-if="row.questionPreparation.failure?.retryable === false">自动重试已停止，修复上述问题后可手动重试。</p>
                <p v-if="row.questionPreparation.failure?.durationMs">耗时：{{ (row.questionPreparation.failure.durationMs / 1000).toFixed(1) }} 秒</p>
              </details>
            </div>
            <span v-else class="preparation-unavailable">—</span>
          </td>
          <td class="score-cell"><span class="ai-score" :class="{ scored: row.aiScore !== null && row.aiScore !== undefined }">{{ aiScoreLabel(row) }}<small v-if="row.aiScore !== null && row.aiScore !== undefined"> / 100</small></span></td>
          <td class="result-cell"><span class="result-tag" :data-result="interviewResult(row)">{{ INTERVIEW_RESULT_LABELS[interviewResult(row)] }}</span><small v-if="row.status !== 'cancelled'" class="lifecycle-state">{{ row.status === 'completed' ? '已完成' : needsFinalSchedule(row) ? '待安排' : '待开始' }}</small></td>
          <td class="actions-cell">
            <div class="inline-actions" :class="{ 'is-confirming': props.confirmingDeleteId === rowId(row) }">
              <button class="btn btn-ghost" type="button" @click="emit('detail', row)">详情</button>
              <button
                v-if="needsFinalSchedule(row)"
                class="btn btn-primary"
                type="button"
                @click="emit('arrange', row)"
              >
                安排复试
              </button>
              <button v-if="row.status === 'cancelled'" class="btn btn-primary" type="button" @click="emit('reschedule', row)">重新安排</button>
              <button
                v-if="row.status !== 'cancelled' && !row.outcome && !needsFinalSchedule(row)"
                class="btn btn-primary"
                type="button"
                @click="emit('conclude', row)"
              >完成</button>
              <template v-if="props.confirmingDeleteId === rowId(row)">
                <span class="list-muted">删除后不可恢复</span>
                <button
                  class="btn btn-danger"
                  type="button"
                  :disabled="props.deletingInterviewId === rowId(row)"
                  @click="emit('confirmDelete', row)"
                >
                  {{ props.deletingInterviewId === rowId(row) ? '删除中...' : '确认删除' }}
                </button>
                <button
                  class="btn btn-ghost"
                  type="button"
                  :disabled="props.deletingInterviewId === rowId(row)"
                  @click="emit('cancelDelete')"
                >
                  取消
                </button>
              </template>
              <button
                v-else
                class="btn btn-danger"
                type="button"
                :disabled="Boolean(props.deletingInterviewId)"
                @click="emit('delete', row)"
              >
                删除
              </button>
            </div>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td class="table-empty" colspan="9">{{ props.emptyMessage || '暂无面试记录，请先点击右上角「安排面试」发起面试' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.table-wrap table{width:100%;min-width:1200px;table-layout:fixed}
.candidate-column{width:10%}.job-column{width:14%}.round-column{width:6%}.time-column{width:9%}.interviewer-column{width:9%}.preparation-column{width:16%}.score-column{width:7%}.result-column{width:8%}.actions-column{width:21%}
.candidate-cell strong,.job-cell,.interviewer-cell{overflow-wrap:anywhere}
.round-cell,.time-cell,.score-cell,.result-cell{white-space:nowrap}
.lifecycle-state{display:block;margin-top:4px;color:var(--muted)}
.actions-cell .inline-actions{flex-wrap:nowrap}
.actions-cell .inline-actions.is-confirming{flex-wrap:wrap}
.actions-cell .btn{flex:none;white-space:nowrap}
.preparation-cell{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;min-height:32px}
.preparation-tag{display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:6px;font-size:12px;background:#edf3f6;color:#637f8a}
.preparation-tag[data-state="ready"]{background:#e4f4eb;color:#287452}
.preparation-tag[data-state="queued"],.preparation-tag[data-state="generating"]{background:#e6f1fb;color:#3876a8}
.preparation-tag[data-state="failed"]{background:#fcecee;color:#b64d5f}
.preparation-error{flex-basis:100%;max-width:260px;color:#9f4654;font-size:11px;line-height:1.5;white-space:normal;overflow-wrap:anywhere}
.preparation-error summary{cursor:pointer}.preparation-error p{margin:5px 0}.preparation-progress{flex-basis:100%;font-size:11px;line-height:1.5;color:#637f8a;white-space:normal}
.preparation-tag small{font-variant-numeric:tabular-nums}.preparation-unavailable{color:#9aadb8}
.preparation-retry{padding:4px 7px;font-size:12px}
.ai-score{color:#7890a0;font-variant-numeric:tabular-nums;white-space:nowrap}
.ai-score.scored{color:#237a82;font-size:16px;font-weight:700}
.ai-score small{font-size:11px;font-weight:400;color:#7890a0}
.result-tag{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:12px;color:#6b8291}
.result-tag::before{content:'';width:6px;height:6px;flex:none;border-radius:50%;background:#9aadb8}
.result-tag[data-result$="pass"]{color:#24785f}.result-tag[data-result$="pass"]::before{background:#36ac84}
.result-tag[data-result$="reject"]{color:#ba5a64}.result-tag[data-result$="reject"]::before{background:#df7f8a}
.result-tag[data-result="pending"]::before{background:#dfa14c}
.list-muted {
  color: #b45309;
  font-size: 12px;
  white-space: nowrap;
}
</style>
