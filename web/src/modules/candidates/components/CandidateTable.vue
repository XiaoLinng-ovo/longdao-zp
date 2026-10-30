<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Candidate } from '../../../shared/types/recruiting'
import { aiResumeScore, canArrangeInitialInterview, canStartInitialInterview, interviewProgressLabel } from '../utils/ai-screening'
import StatusTag from '../../../shared/components/StatusTag.vue'
import CandidateAnalysisProgress from './CandidateAnalysisProgress.vue'
const props = defineProps<{ rows: readonly Candidate[]; canDelete?: boolean; canReview?: boolean; canArrange?: boolean; canApply?: boolean; deletingId?: string }>()
const emit = defineEmits<{ apply: [row: Candidate]; analyze: [row: Candidate]; open: [row: Candidate]; arrange: [row: Candidate]; delete: [row: Candidate]; review: [row: Candidate, action: 'evidence' | 'passed' | 'eliminated'] }>()
const expanded = ref(new Set<string>())
const candidateKey = (row: Candidate) => row.entityId || row.id
function interviewHints(row: Candidate) {
  const applications = row.applicationRows || [row]
  return applications.flatMap((application) => {
    const label = interviewProgressLabel(application)
    return label ? [{ id: application.applicationId || application.id, status: application.interviewProgress?.status || 'pending', text: applications.length > 1 ? `${application.job} · ${label}` : label }] : []
  })
}
function toggleApplications(row: Candidate) {
  const key = candidateKey(row)
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
}
const displayRows = computed(() => props.rows.flatMap((row) => {
  const children = expanded.value.has(candidateKey(row))
    ? (row.applicationRows || []).filter((application) => application.applicationId !== row.applicationId)
    : []
  return [{ row, child: false, span: children.length + 1 }, ...children.map((application) => ({ row: application, child: true, span: 0 }))]
}))
</script>

<template>
  <div class="table-wrap candidate-table"><table>
    <colgroup><col class="col-candidate" /><col class="col-job" /><col class="col-source" /><col class="col-tags" /><col class="col-score" /><col class="col-advice" /><col class="col-analysis" /><col class="col-status" /><col class="col-updated" /><col class="col-actions" /></colgroup>
    <thead><tr><th class="candidate-heading">候选人</th><th>应聘岗位</th><th>来源</th><th>标签</th><th>AI 评分</th><th>AI 建议</th><th>AI 分析</th><th>申请状态</th><th>更新时间</th><th class="op-col">操作</th></tr></thead>
    <tbody>
      <tr v-for="{ row, child, span } in displayRows" :key="`${candidateKey(row)}:${row.applicationId || row.id}`" :class="{ 'application-subrow': child }">
        <td v-if="!child" :rowspan="span" class="candidate-cell">
          <button class="name-link" type="button" @click="emit('open', row)"><strong>{{ row.name }}</strong></button>
          <small v-for="hint in interviewHints(row)" :key="hint.id" class="interview-hint" :class="`interview-${hint.status}`"><span class="interview-dot" aria-hidden="true"></span><span>{{ hint.text }}</span></small>
          <button v-if="(row.applicationRows?.length || 0) > 1" class="applications-toggle" type="button" :aria-expanded="expanded.has(candidateKey(row))" @click="toggleApplications(row)">{{ expanded.has(candidateKey(row)) ? '收起' : '展开' }} {{ row.applicationRows!.length }} 个岗位申请</button>
        </td>
        <td class="job-cell">{{ row.job }}</td>
        <td class="source-cell">{{ row.source || '未标注' }}</td>
        <td><span class="tag-list">{{ (row.tags || []).join('、') || '—' }}</span></td>
        <td class="score-cell">
          <div><strong>{{ aiResumeScore(row) ?? '—' }}</strong><span v-if="aiResumeScore(row) !== undefined"> /100</span></div>
          <button v-if="row.resumeReview" class="basis-link" type="button" @click="emit('review', row, 'evidence')">查看评分依据</button>
        </td>
        <td class="advice-cell">
          <span v-if="aiResumeScore(row) === undefined" class="muted">{{ ['queued', 'processing'].includes(row.analysisStatus || '') ? 'AI 评分生成中' : '暂无有效 AI 评分' }}</span>
          <span v-else :class="aiResumeScore(row)! >= 80 ? 'advice-pass' : 'advice-reject'">{{ aiResumeScore(row)! >= 80 ? '建议通过，进入初试' : '建议淘汰（AI 评分低于 80 分）' }}</span>
          <small v-if="row.resumeReview?.talentPool" class="talent-tag">已加入人才库</small>
          <small v-if="row.resumeReview?.decision === 'eliminated'" class="muted">已淘汰</small>
        </td>
        <td>
          <CandidateAnalysisProgress
            :status="row.analysisStatus || row.aiStatus"
            :progress="row.analysisProgress"
            :attempt="row.analysisAttempts"
            :error="row.analysisError"
          />
        </td>
        <td><StatusTag :status="row.applicationStatus" /></td>
        <td>{{ row.updatedAt }}</td>
        <td><div class="row-actions">
          <div class="action-row primary-actions">
            <button class="btn btn-ghost btn-sm" type="button" @click="emit('open', row)">详情</button>
            <button v-if="canApply && !child" class="btn btn-ghost btn-sm apply-button" type="button" @click="emit('apply', row)">新增应聘</button>
            <button v-if="canApply && row.applicationId && (row.aiStatus !== 'completed' || row.analysisStatus === 'failed') && ['pending_analysis', 'analysis_queued', 'human_review'].includes(row.rawApplicationStatus || '')" class="btn btn-ghost btn-sm analyze-button" type="button" :disabled="['queued', 'processing'].includes(row.analysisStatus || '')" @click="emit('analyze', row)">{{ row.analysisStatus === 'failed' ? '重试解析' : ['queued', 'processing'].includes(row.analysisStatus || '') ? '解析中…' : '解析简历' }}</button>
            <button v-if="canArrange && canArrangeInitialInterview(row) && (row.rawApplicationStatus === 'interviewing' || canReview)" class="btn btn-primary btn-sm" type="button" @click="emit('arrange', row)">{{ row.rawApplicationStatus === 'interviewing' ? '安排面试' : '初试邀约' }}</button>
          </div>
          <div v-if="canReview || canDelete" class="action-row decision-actions">
            <button v-if="canReview" class="btn btn-ghost btn-sm advice-pass" type="button" :disabled="!row.resumeReview || !canStartInitialInterview(row)" @click="emit('review', row, 'passed')">通过</button>
            <button v-if="canReview" class="btn btn-ghost btn-sm reject-button" type="button" :disabled="!row.resumeReview || !canStartInitialInterview(row)" @click="emit('review', row, 'eliminated')">淘汰</button>
            <button v-if="canDelete" class="btn btn-ghost btn-sm delete-button" type="button" :disabled="!!deletingId" :aria-label="row.applicationId ? `删除岗位申请 ${row.name} · ${row.job}` : `删除候选人 ${row.name}`" @click.stop="emit('delete', row)">{{ deletingId === (row.applicationId || row.entityId || row.id) ? '删除中…' : row.applicationId ? '删除申请' : '删除档案' }}</button>
          </div>
        </div></td>
      </tr>
      <tr v-if="!rows.length"><td colspan="10" class="table-empty">暂无数据</td></tr>
    </tbody>
  </table></div>
</template>

<style scoped>
.candidate-cell, .candidate-heading { text-align: center; vertical-align: middle; }.candidate-cell { background: white; }.candidate-cell .name-link { display: block; width: 100%; text-align: center; }.applications-toggle { display: block; width: 100%; text-align: center; margin-top: 7px; padding: 3px 0; border: 0; background: transparent; color: #2563eb; cursor: pointer; font-size: 11px; }.application-subrow { background: #f8fbff; }.application-subrow .name-link { color: #64748b; font-size: 12px; }.apply-button { color: #2563eb; border-color: #bfdbfe; }
.tag-list { font-size: 12px; color: #334155; }
.name-link { border: 0; background: transparent; padding: 0; color: var(--primary); cursor: pointer; }
.name-link:hover { text-decoration: underline; }
.muted { display: block; margin-top: 5px; font-size: 11px; color: var(--muted); }
.interview-hint { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 5px; font-size: 11px; line-height: 1.5; color: #94a3b8; overflow-wrap: anywhere; }
.interview-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: #d97706; }
.interview-scheduled .interview-dot { background: #3b82f6; }
.interview-completed .interview-dot { background: #16a34a; }
.candidate-table { max-width: 100%; overflow-x: auto; }
.candidate-table table { min-width: 1040px; table-layout: fixed; }
.col-candidate, .col-job { width: 9%; }
.col-source { width: 7%; }.col-tags { width: 5%; }.col-score, .col-updated { width: 8.5%; }
.col-advice { width: 12%; }.col-analysis { width: 13%; }.col-status { width: 8%; }.col-actions { width: 20%; }
th, td { overflow-wrap: anywhere; }
thead th { white-space: nowrap; }
.score-cell { font-size: 12px; }.score-cell span { color: #64748b; }.score-cell span:not(:first-child) { margin-left: 6px; }.final-line { margin-top: 6px; color: #1d4ed8; }
.basis-link { padding: 0; margin-top: 7px; background: transparent; color: var(--primary); font-size: 11px; border: 0; cursor: pointer; }
.advice-cell { font-size: 12px; line-height: 1.6; }.advice-pass { color: #15803d; }.advice-reject { color: #b45309; }.talent-tag { display: block; margin-top: 6px; color: #0369a1; }
button:disabled { opacity: .5; cursor: not-allowed; }
.row-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; white-space: nowrap; }
.action-row { display: flex; align-items: center; gap: 6px; }
.primary-actions { flex-wrap: wrap; }
.decision-actions { flex-wrap: nowrap; }
.decision-actions .btn { flex-shrink: 0; }
.reject-button { color: #dc2626; border-color: #fecaca; }
.reject-button:hover:not(:disabled) { background: #fef2f2; border-color: #f87171; }
.reject-button:disabled { cursor: not-allowed; opacity: .55; }
.btn-sm { padding: 4px 8px; font-size: 11.5px; }
@media (max-width: 1440px) {
  .candidate-table th, .candidate-table td { padding: 12px 8px; }
}
</style>
