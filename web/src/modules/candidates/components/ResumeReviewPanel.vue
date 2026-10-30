<script setup lang="ts">
import { computed, ref } from 'vue'
import { updateResumeReview, type ResumeReviewInput } from '../api'
import type { ResumeScoreSummary } from '../../../shared/types/recruiting'

const props = defineProps<{
  summary: ResumeScoreSummary
  applicationStatus?: string
  canEdit?: boolean
  busy?: boolean
  initialAction?: 'evidence' | 'passed' | 'eliminated'
}>()
const emit = defineEmits<{ saved: [] }>()
const saving = ref(false)
const error = ref('')
const message = ref('')
const pendingDecision = ref<'passed' | 'eliminated' | undefined>(props.initialAction === 'passed' || props.initialAction === 'eliminated' ? props.initialAction : undefined)
const decisionReason = ref('')
const includeTalent = ref(props.summary.talentPool)
const reviewOpen = computed(() => ['pending_analysis', 'analysis_queued', 'human_review'].includes(props.applicationStatus ?? ''))
const editable = computed(() => props.canEdit && reviewOpen.value && !props.busy && props.summary.aiScore !== undefined)
const advice = computed(() => {
  const score = props.summary.aiScore
  if (props.busy) return 'AI 评分生成中，请稍候；历史分数仅供查看'
  if (score === undefined) return 'AI 评分未生成，暂不能给出筛选建议'
  return score >= 80 ? '建议通过，进入初试，可进行线上或线下面试邀约' : '建议淘汰（AI 评分低于 80 分）'
})
async function save(input: ResumeReviewInput) {
  if (saving.value) return false
  saving.value = true
  error.value = ''
  message.value = ''
  try {
    await updateResumeReview(props.summary.resultId, input)
    message.value = input.decision === 'passed' ? '已通过，进入初试待邀约；可到面试管理安排线上或线下初试。' : input.decision === 'eliminated' ? '已淘汰，人才库选择已保存。' : '人才库选择已保存。'
    emit('saved')
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败，请重试'
    return false
  } finally {
    saving.value = false
  }
}
function chooseDecision(decision: 'passed' | 'eliminated') {
  pendingDecision.value = decision
  decisionReason.value = ''
  includeTalent.value = props.summary.talentPool
  error.value = ''
}
async function confirmDecision() {
  if (!pendingDecision.value || props.summary.aiScore === undefined) {
    error.value = '请先完成 AI 评分，再选择通过或淘汰'
    return
  }
  const input: ResumeReviewInput = { decision: pendingDecision.value, comment: decisionReason.value.trim() }
  if (pendingDecision.value === 'eliminated' && props.summary.aiScore < 80) input.talentPool = includeTalent.value
  if (await save(input)) pendingDecision.value = undefined
}
</script>

<template>
  <div class="resume-review-panel">
    <div class="score-breakdown">
      <div class="final-score"><span>AI 评分</span><strong>{{ summary.aiScore ?? '待 AI 评分' }}<small v-if="summary.aiScore !== undefined">/100</small></strong></div>
    </div>
    <div v-if="summary.aiScore === undefined" class="ai-score-unavailable warning" role="status">
      <strong>{{ busy ? 'AI 评分生成中' : 'AI 评分未生成（不是 0 分）' }}</strong>
      <template v-if="!busy">
        <p v-for="(reason, index) in summary.risks" :key="index">{{ reason }}</p>
        <p v-if="!summary.risks.length">本次结果没有有效的岗位评分，请检查解析任务错误、已确认的岗位要求及模型服务后重新解析。</p>
      </template>
    </div>
    <div class="ai-advice" :class="{ positive: summary.aiScore !== undefined && summary.aiScore >= 80 }">
      <div><strong>AI 建议</strong><p>{{ advice }}</p></div>
      <span v-if="summary.decision" class="decision-tag">{{ summary.decision === 'passed' ? '已通过 · 待安排初试' : '已淘汰' }}</span>
      <span v-if="summary.talentPool" class="decision-tag">已加入人才库</span>
    </div>
    <div class="review-actions">
      <button v-if="canEdit" class="btn btn-ghost pass-button" type="button" :disabled="!editable || saving || summary.aiScore === undefined" @click="chooseDecision('passed')">通过</button>
      <button v-if="canEdit" class="btn btn-ghost eliminate-button" type="button" :disabled="!editable || saving || summary.aiScore === undefined" @click="chooseDecision('eliminated')">淘汰</button>
      <button v-if="canEdit && summary.aiScore !== undefined && (summary.aiScore < 80 || summary.talentPool)" class="btn btn-ghost" type="button" :disabled="saving || busy" @click="save({ talentPool: !summary.talentPool })">{{ summary.talentPool ? '移出人才库' : '加入人才库' }}</button>
    </div>
    <p v-if="busy" class="muted">简历正在解析，请完成后再进行评分或筛选。</p>
    <p v-else-if="canEdit && !reviewOpen && summary.aiScore !== undefined" class="muted">该申请已结束简历筛选，评分与通过/淘汰结果已锁定。</p>
    <div v-if="error" class="error-note" role="alert">{{ error }}</div>
    <div v-if="message" class="success-note" role="status">{{ message }}</div>

    <div v-if="pendingDecision" class="review-form decision-confirm">
      <h4>{{ pendingDecision === 'passed' ? '确认通过，进入初试' : '确认淘汰' }}</h4>
      <p v-if="summary.aiScore !== undefined">AI 评分：{{ summary.aiScore }}。{{ pendingDecision === 'passed' ? '通过后进入面试待安排' : '淘汰后保留简历和评分记录，不会删除候选人。' }}</p>
      <p v-if="pendingDecision === 'passed' && summary.aiScore !== undefined && summary.aiScore < 80" class="warning">AI 建议淘汰，是否仍由人工确认通过并进入初试？</p>
      <p v-if="pendingDecision === 'eliminated' && summary.aiScore !== undefined && summary.aiScore >= 80" class="warning">AI 建议通过，是否仍由人工确认淘汰？</p>
      <label :for="`decision-reason-${summary.resultId}`">处理说明（可选）</label>
      <textarea :id="`decision-reason-${summary.resultId}`" v-model="decisionReason" rows="2" :disabled="saving"></textarea>
      <label v-if="pendingDecision === 'eliminated' && summary.aiScore !== undefined && summary.aiScore < 80" class="talent-check"><input v-model="includeTalent" type="checkbox" :disabled="saving" />同时加入人才库，供后续岗位筛选</label>
      <div class="review-actions">
        <button class="btn btn-ghost" type="button" :disabled="saving" @click="pendingDecision = undefined">取消</button>
        <button class="btn btn-primary" type="button" :disabled="saving || !editable || summary.aiScore === undefined" @click="confirmDecision">{{ saving ? '保存中…' : '确认' }}</button>
      </div>
    </div>

    <details class="scoring-evidence" open>
      <summary>评分依据 · 来自简历解析与岗位要求匹配</summary>
      <p v-if="!summary.evidence.length" class="muted">本次分析未提供具体评分依据，请重新解析简历后查看；不会自动编造评分说明。</p>
      <article v-for="(item, index) in summary.evidence" :key="index" class="evidence-item">
        <h4><span :class="item.outcome">{{ item.outcome === 'partial' ? '部分满足' : item.outcome === 'matched' ? '匹配' : item.outcome === 'conflict' ? '明确不符' : '待核实' }}</span>{{ item.label }}<small v-if="item.score !== undefined"> · {{ item.score }}/100</small></h4>
        <p>{{ item.rationale || '本项未提供匹配说明' }}</p>
        <blockquote v-for="(text, i) in item.sourceTexts" :key="i">简历依据：{{ text }}</blockquote>
        <small v-if="!item.sourceTexts.length" class="muted">未提供直接简历证据，建议人工核实。</small>
      </article>
    </details>
  </div>
</template>

<style scoped>

.resume-review-panel { min-width: 0; color: #334155; }
.score-breakdown { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
.score-breakdown > div { padding: 16px; border: 1px solid #e2e8f0; border-radius: 12px; background: #f8fafc; }
.score-breakdown span { display: block; font-size: 12px; color: #64748b; }
.score-breakdown strong { display: block; margin-top: 8px; font-size: 23px; }
.score-breakdown small { margin-left: 3px; font-size: 11px; font-weight: 400; }
.score-breakdown .final-score { border-color: #bfdbfe; background: #eff6ff; color: #1d4ed8; }
.muted, .ai-advice small { font-size: 12px; line-height: 1.6; color: #64748b; }
.ai-advice { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 14px 16px; border-radius: 12px; border: 1px solid #fde68a; background: #fffbeb; margin: 14px 0; }
.ai-advice.positive { border-color: #a7f3d0; background: #ecfdf5; }
.ai-advice p { margin: 6px 0; font-size: 14px; }
.decision-tag { padding: 5px 9px; border-radius: 8px; background: #fff; font-size: 12px; }
.review-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.pass-button { color: #15803d; border-color: #bbf7d0; }.eliminate-button { color: #b91c1c; border-color: #fecaca; }
button:disabled { opacity: .5; cursor: not-allowed; }
.review-form { padding: 16px; border: 1px solid #bfdbfe; border-radius: 12px; margin: 15px 0; background: #f8fafc; }
.review-form h4 { margin: 0 0 14px; }.review-form label { display: block; font-size: 13px; margin: 12px 0 6px; }
.review-form textarea { width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; background: #fff; font: inherit; }
.review-form p { font-size: 13px; line-height: 1.7; }.talent-check { display: flex !important; gap: 8px; align-items: center; }.warning { color: #b45309; }
.scoring-evidence { margin-top: 22px; border-top: 1px solid #e2e8f0; padding-top: 16px; }.scoring-evidence summary { cursor: pointer; font-weight: 700; font-size: 14px; }
.evidence-item { margin: 12px 0; padding: 12px; border: 1px solid #e2e8f0; border-radius: 8px; }.evidence-item h4 { margin: 0; font-size: 13px; }.evidence-item h4 span { margin-right: 8px; font-size: 11px; padding: 3px 6px; border-radius: 5px; background: #f1f5f9; }.matched { color: #15803d; }.conflict { color: #b91c1c; }.missing { color: #b45309; }.evidence-item p { font-size: 13px; line-height: 1.7; }.evidence-item blockquote { margin: 8px 0 0; padding: 8px 12px; border-left: 3px solid #93c5fd; background: #eff6ff; font-size: 12px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 640px) { .score-breakdown { grid-template-columns: 1fr; } }
</style>
