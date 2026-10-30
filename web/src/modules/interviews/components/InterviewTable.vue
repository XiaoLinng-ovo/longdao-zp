<script setup lang="ts">
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
  return isFinal && row.status === 'scheduled' && missingStart
}
</script>

<template>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>候选人</th>
          <th>岗位</th>
          <th>轮次</th>
          <th>时间</th>
          <th>面试官</th>
          <th>面试表</th>
          <th>AI 评分</th>
          <th>面试结果</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.entityId || row.id">
          <td><strong>{{ row.candidate }}</strong></td>
          <td>{{ row.job }}</td>
          <td>{{ row.round }}</td>
          <td>{{ row.scheduledAt }}</td>
          <td>{{ row.interviewers.join('、') || '未分配' }}</td>
          <td>
            <div class="preparation-cell" v-if="row.questionPreparation">
              <span class="preparation-tag" :data-state="row.questionPreparation.status" :title="row.questionPreparation.error">
                {{ preparationLabels[row.questionPreparation.status] }}
                <small v-if="['queued', 'generating'].includes(row.questionPreparation.status) && row.questionPreparation.completedGroups.length">{{ row.questionPreparation.completedGroups.length }}/{{ row.stage === 'final' || Number.parseInt(row.round, 10) >= 2 ? 4 : 3 }}</small>
              </span>
              <button v-if="row.status === 'scheduled' && ['failed', 'not_started'].includes(row.questionPreparation.status)" class="btn btn-ghost btn-sm preparation-retry" type="button" :disabled="props.preparingInterviewId === rowId(row)" @click="emit('prepare', row)">{{ props.preparingInterviewId === rowId(row) ? '提交中…' : row.questionPreparation.status === 'failed' ? '重试' : '准备' }}</button>
              <small v-if="row.questionPreparation.rubricsStatus" class="preparation-progress">评价表{{ row.questionPreparation.rubricsStatus === 'ready' ? '已就绪' : '载入中' }} · 题组 {{ row.questionPreparation.completedGroups.length }}/{{ row.stage === 'final' || Number.parseInt(row.round, 10) >= 2 ? 4 : 3 }}</small>
              <details v-if="row.questionPreparation.error && ['failed', 'queued', 'generating'].includes(row.questionPreparation.status)" class="preparation-error" :open="row.questionPreparation.status === 'failed'">
                <summary>{{ row.questionPreparation.failure ? questionPreparationFailureLabel(row.questionPreparation.failure) : '查看失败原因' }}</summary>
                <p>{{ row.questionPreparation.error }}</p>
                <p v-if="row.questionPreparation.status !== 'failed'">{{ row.questionPreparation.status === 'queued' ? '等待自动重试' : '正在重试' }} · 第 {{ (row.questionPreparation.attempts || 0) + (row.questionPreparation.status === 'queued' ? 1 : 0) }} 次尝试</p>
                <p v-if="row.questionPreparation.failure?.code">错误码：{{ row.questionPreparation.failure.code }}</p>
                <p v-if="row.questionPreparation.failure?.retryable === false">自动重试已停止，修复上述问题后可手动重试。</p>
                <p v-if="row.questionPreparation.failure?.model">模型：{{ row.questionPreparation.failure.model }}</p>
                <p v-if="row.questionPreparation.failure?.durationMs">耗时：{{ (row.questionPreparation.failure.durationMs / 1000).toFixed(1) }} 秒</p>
                <p v-if="row.questionPreparation.failure?.diagnosticId">诊断编号：{{ row.questionPreparation.failure.diagnosticId }}</p>
              </details>
            </div>
            <span v-else class="preparation-unavailable">—</span>
          </td>
          <td><span class="ai-score" :class="{ scored: row.aiScore !== null && row.aiScore !== undefined }">{{ aiScoreLabel(row) }}<small v-if="row.aiScore !== null && row.aiScore !== undefined"> / 100</small></span></td>
          <td><span class="result-tag" :data-result="interviewResult(row)">{{ INTERVIEW_RESULT_LABELS[interviewResult(row)] }}</span></td>
          <td>
            <div class="inline-actions">
              <button class="btn btn-ghost" type="button" @click="emit('detail', row)">详情</button>
              <button
                v-if="needsFinalSchedule(row)"
                class="btn btn-primary"
                type="button"
                @click="emit('arrange', row)"
              >
                安排复试
              </button>
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
table{min-width:1200px}
.preparation-cell{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;min-height:32px}
.preparation-tag{display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:6px;font-size:12px;background:#edf3f6;color:#637f8a}
.preparation-tag[data-state="ready"]{background:#e4f4eb;color:#287452}
.preparation-tag[data-state="queued"],.preparation-tag[data-state="generating"]{background:#e6f1fb;color:#3876a8}
.preparation-tag[data-state="failed"]{background:#fcecee;color:#b64d5f}
.preparation-error{flex-basis:100%;max-width:260px;color:#9f4654;font-size:11px;line-height:1.5;white-space:normal;overflow-wrap:anywhere}
.preparation-error summary{cursor:pointer}.preparation-error p{margin:5px 0}.preparation-progress{flex-basis:100%;font-size:11px;line-height:1.5;color:#637f8a;white-space:normal}
.preparation-tag small{font-variant-numeric:tabular-nums}.preparation-unavailable{color:#9aadb8}
.preparation-retry{padding:4px 7px;font-size:12px}th,td{white-space:nowrap}
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
