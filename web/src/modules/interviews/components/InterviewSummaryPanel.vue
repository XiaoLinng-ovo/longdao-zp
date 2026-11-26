<script setup lang="ts">
import { History, RefreshCw, RotateCw, X } from '@lucide/vue'
import TranscriptRoleCorrection from './TranscriptRoleCorrection.vue'
import { computed, onUnmounted, ref, watch } from 'vue'
import { authSession } from '../../auth/session'
import { backgroundAudio } from '../utils/background-audio'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { loadInterviewSummaryVersions, loadInterviewSummary, requestInterviewSummary, type InterviewSummaryView } from '../api/summary'
import { loadQuestionSheets, STAGE_DECISION_LABEL, STAGE_LABEL, type ApiStageReview, type InterviewStage } from '../api/question-sheets'

const props = withDefaults(defineProps<{ open?: boolean; embedded?: boolean; interviewId: string; applicationId?: string; stage?: InterviewStage; candidateName?: string; jobTitle?: string; interviewDate?: string }>(), { open: true, embedded: true })
const emit = defineEmits<{ (event: 'close'): void; (event: 'updated', value: InterviewSummaryView | null): void }>()
const view = ref<InterviewSummaryView | null>(null)
const historical = ref<InterviewSummaryView['report']>(null)
const versions = ref<Awaited<ReturnType<typeof loadInterviewSummaryVersions>>>([])
const historyOpen = ref(false), historyLoading = ref(false), selectedVersion = ref('')
watch(selectedVersion, id => { historical.value = versions.value.find(item => item.id === id)?.report ?? null })
const report = computed(() => historical.value ?? view.value?.report)
let historyVersion = 0
async function loadHistory() {
  const version = ++historyVersion
  const interviewId = props.interviewId
  historyOpen.value = !historyOpen.value
  if (!historyOpen.value) { selectedVersion.value = ''; historical.value = null; return }
  historyLoading.value = true
  try {
    const result = await loadInterviewSummaryVersions(interviewId)
    if (version === historyVersion && props.open && props.interviewId === interviewId && historyOpen.value) versions.value = result
  } catch (cause) {
    if (version === historyVersion && props.open && props.interviewId === interviewId && historyOpen.value) error.value = describeApiFailure(cause, '读取历史评分失败').message
  } finally { if (version === historyVersion) historyLoading.value = false }
}
const busy = ref(false)
const loading = ref(false)
const error = ref('')
const audioPending = computed(() => {
  const user = authSession.user
  const scope = user?.workspaceId && user.id ? user.workspaceId + ':' + user.id + ':' + props.interviewId : ''
  return !!scope && backgroundAudio.jobs.some(job => job.scope === scope && !['completed','review_required'].includes(job.phase))
})
const review = ref<ApiStageReview | null>(null)
const reviewLoading = ref(false)
const reviewError = ref('')
let reviewVersion = 0
const recommendationLabels = { advance: '建议推进后续流程', reject: '不建议推进后续流程', hold: '建议补充评估' }
const analysisReady = computed(() => !historical.value && !view.value?.stale && !audioPending.value && !pending.value && !report.value?.reviewRequired && view.value?.status === 'ready')
const displayScore = computed(() => historical.value ? !historical.value.reviewRequired : analysisReady.value)
const recommendation = computed(() => analysisReady.value ? report.value?.recommendation : null)
const recommendationLabel = computed(() => recommendation.value ? recommendationLabels[recommendation.value.outcome] : '')
const resultLabel = computed(() => reviewLoading.value ? '读取中' : reviewError.value ? '暂时无法读取' : review.value?.decision ? STAGE_DECISION_LABEL[review.value.decision] : '待人工确认')
function formatDate(value?: string) {
  if (!value) return '未记录'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '未记录'
}
async function loadReview() {
  if (!props.applicationId || !props.stage) return
  const current = ++reviewVersion
  reviewLoading.value = true
  reviewError.value = ''
  try {
    const data = await loadQuestionSheets(props.applicationId)
    if (current === reviewVersion && props.open) review.value = data.reviews.find(row => row.stage === props.stage) ?? null
  } catch (cause) {
    if (current === reviewVersion) {
      review.value = null
      reviewError.value = describeApiFailure(cause, '读取面试结果失败').message
    }
  } finally { if (current === reviewVersion) reviewLoading.value = false }
}
function refresh() { void load(); void loadReview() }
function rolesChanged() {
  requestVersion++; loading.value = false; clearTimer()
  if (view.value) view.value = { ...view.value, stale: true, status: 'none', error: null }
  void load()
}
let timer: ReturnType<typeof setTimeout> | undefined
let version = 0
let requestVersion = 0
let readFailures = 0
const pending = computed(() => view.value?.status === 'pending' || view.value?.status === 'generating' || ['transcribing', 'role_review'].includes(view.value?.phase ?? ''))
const phaseLabel = computed(() => view.value?.phase === 'transcribing' ? '录音转写中' : view.value?.phase === 'role_review' ? '说话人自动识别中' : '评分中')
function clearTimer() { if (timer) clearTimeout(timer); timer = undefined }
function schedule(retry = false) {
  clearTimer()
  if ((audioPending.value || pending.value || retry) && props.open) timer = setTimeout(() => void load(), retry ? Math.min(15000, 2500 * 2 ** Math.min(readFailures - 1, 3)) : 2500)
}
async function load() {
  if (loading.value || busy.value || !props.open) return
  const current = version
  const request = ++requestVersion
  clearTimer()
  loading.value = true
  try {
    const next = await loadInterviewSummary(props.interviewId)
    if (current !== version || request !== requestVersion) return
    view.value = next
    error.value = ''
    readFailures = 0
    schedule()
  } catch (cause) {
    if (current === version && request === requestVersion) {
      readFailures++
      error.value = describeApiFailure(cause, '读取面试总结失败').message + '；正在自动重试，已生成内容仍保留。'
      schedule(true)
    }
  }
  finally { if (current === version && request === requestVersion) loading.value = false }
}
async function generate() {
  if (busy.value || pending.value || audioPending.value) return
  const current = version
  const request = ++requestVersion
  clearTimer(); loading.value = false
  busy.value = true
  try {
    const next = await requestInterviewSummary(props.interviewId)
    if (current !== version || request !== requestVersion) return
    readFailures = 0
    selectedVersion.value = ''; historical.value = null; view.value = next; error.value = ''; schedule()
  } catch (cause) {
    if (current === version && request === requestVersion) {
      error.value = describeApiFailure(cause, '生成面试总结失败').message
      // The server may have accepted the job before the response connection broke.
      readFailures = 1; schedule(true)
    }
  }
  finally { if (current === version) busy.value = false }
}
watch(() => [props.open, props.interviewId, props.applicationId, props.stage] as const, ([open]) => {
  version++; requestVersion++; readFailures = 0; clearTimer(); busy.value = false; loading.value = false; error.value = ''; view.value = null
  reviewVersion++; review.value = null; reviewLoading.value = false; reviewError.value = ''
  if (open) refresh()
}, { immediate: true })
watch(() => [props.interviewId, props.open], () => { historyVersion++; historyLoading.value = false; selectedVersion.value = ''; historical.value = null; versions.value = []; historyOpen.value = false })
watch(view, value => emit('updated', value))
watch(audioPending, () => { if (props.open) void load() })
onUnmounted(() => { version++; reviewVersion++; historyVersion++; clearTimer() })
</script>

<template>
    <section v-if="open" class="interview-report" :class="{ 'is-embedded': embedded }" :role="embedded ? 'region' : 'dialog'" :aria-modal="embedded ? undefined : true" aria-label="面试总结表">
      <header class="report-head">
        <div class="report-heading"><h2>面试总结</h2><span class="summary-state" role="status">{{ historical ? '历史版本' : pending ? phaseLabel : view?.status === 'failed' ? '分析失败' : view?.stale ? '待重新评分' : report?.reviewRequired ? '证据不足' : report ? '已生成' : '暂无总结' }}</span><small v-if="report">{{ formatDate(report.generatedAt) }}</small></div>
        <div class="inline-actions">
          <button class="btn btn-ghost" type="button" :disabled="loading || busy || reviewLoading" @click="refresh" title="刷新总结"><RefreshCw :size="14" />刷新</button>
          <button class="btn btn-primary" type="button" v-if="view?.sessionId" :disabled="busy || pending || loading || audioPending" @click="generate"><RotateCw :size="14" />{{ audioPending ? '录音保存中' : pending ? phaseLabel : report ? '重新评分' : '生成总结' }}</button>
          <button v-if="view?.sessionId" class="btn btn-ghost" type="button" :disabled="historyLoading" :aria-expanded="historyOpen" @click="loadHistory"><History :size="14" />历史评分</button>
          <button v-if="!embedded" class="report-close" type="button" aria-label="关闭面试总结表" title="关闭" @click="emit('close')"><X :size="18" /></button>
        </div>
      </header>
      <div class="report-body">
        <div v-if="historyOpen" class="history-controls">
          <label>报告版本 <select v-model="selectedVersion" :disabled="historyLoading"><option value="">当前版本</option><option v-for="item in versions" :key="item.id" :value="item.id">第 {{ item.revision }} 版 · {{ formatDate(item.createdAt) }}</option></select></label>
          <span v-if="historyLoading">正在读取历史评分...</span><span v-else-if="!versions.length">暂无历史评分</span>
        </div>
        <p v-if="historical" class="loading-note">正在查看历史报告，不代表当前评分。</p>
        <p v-if="view?.stale && !historical" class="loading-note" role="status">角色或转写已更新，当前保留的是上一版报告，需重新评分。</p>
        <p v-if="audioPending" class="loading-note" role="status">录音仍在后台保存，会话结束后自动生成完整对话总结。</p>
        <p v-if="error || view?.error" class="error-note" role="alert">{{ error || view?.error }}</p>
        <p v-if="pending" class="loading-note" role="status">{{ phaseLabel }}，完成后自动更新结果。<template v-if="!embedded">可以关闭窗口，稍后查看结果。</template></p>
        <p v-else-if="loading && !view" class="loading-note">正在读取面试总结...</p>
        <div v-else-if="!report && !pending && !audioPending && !error && view?.status !== 'failed'" class="summary-empty"><p>{{ view?.sessionId ? '尚无面试总结。' : '尚无已保存的面试录音' }}</p><slot name="empty-action" v-if="!view?.sessionId" /></div>
        <template v-if="report">
          <dl v-if="!embedded" class="report-info" aria-label="面试信息">
            <div><dt>候选人</dt><dd>{{ candidateName || '未记录' }}</dd></div>
            <div><dt>应聘岗位</dt><dd>{{ jobTitle || '未记录' }}</dd></div>
            <div><dt>面试阶段</dt><dd>{{ stage ? STAGE_LABEL[stage] : '未记录' }}</dd></div>
            <div><dt>面试日期</dt><dd>{{ formatDate(interviewDate) }}</dd></div>
          </dl>
          <section class="report-overview" aria-label="总体评价">
            <div class="score-column"><h3>候选人评分</h3><div class="report-score"><strong>{{ historical ? (report.reviewRequired ? '证据不足' : report.overallScore ?? '未评分') : audioPending || pending || view?.status === 'failed' ? '待评分' : view?.stale ? '待重新评分' : report.reviewRequired ? '证据不足' : report.overallScore ?? '未评分' }}</strong><span v-if="report.overallScore !== null && displayScore"> / 100</span></div><small>AI 综合评价</small></div>
            <div><h3>AI 总体评价</h3><p>{{ report.summary }}</p><small class="report-context">未考察内容不扣分 · {{ report.dimensions.length }} 个已考察维度</small></div>
          </section>
          <p v-if="report.version === 'actual-dialogue-v1'" class="muted">这是历史问答报告，可点击“重新生成”按完整对话重新分析；历史分数不参与当前录音分计算。</p>
          <ul v-if="report.warnings.length" class="report-warnings"><li v-for="warning in report.warnings" :key="warning">{{ warning }}</li></ul>
          <div class="report-analysis">
            <section v-for="group in [{ title: '优势分析', tone: 'strengths', rows: report.strengths }, { title: '劣势与待提升', tone: 'concerns', rows: report.concerns }]" :key="group.title" class="analysis-column" :class="group.tone" :aria-label="group.title">
              <h3>{{ group.title }}</h3><p v-if="!group.rows.length" class="muted">暂无有充分原文依据的评价。</p>
              <ol v-else class="finding-list"><li v-for="(finding, index) in group.rows" :key="index" class="report-finding"><p>{{ finding.text }}</p><blockquote v-for="(evidence, evidenceIndex) in finding.evidence" :key="evidenceIndex">{{ evidence.quote }}</blockquote></li></ol>
            </section>
          </div>
          <section v-if="report.dimensions.length && displayScore" class="report-section">
            <h3>维度评分</h3>
            <div class="report-table-wrap"><table class="report-table"><thead><tr><th>考察维度</th><th>分数</th><th>评价与原文证据</th></tr></thead>
              <tbody><tr v-for="dimension in report.dimensions" :key="dimension.name"><th>{{ dimension.name }}</th><td>{{ dimension.score }}</td><td><p>{{ dimension.text }}</p><blockquote v-for="(evidence, index) in dimension.evidence" :key="index">“{{ evidence.quote }}”</blockquote></td></tr></tbody>
            </table></div>
          </section>
          <section v-if="report.unassessed.length" class="report-section"><h3>待核实</h3><ul><li v-for="item in report.unassessed" :key="item">{{ item }}</li></ul></section>
          <section class="report-section report-recommendation" aria-label="推荐建议">
            <h3>推荐建议</h3>
            <template v-if="recommendation">
              <p class="recommendation-value">{{ recommendationLabel }}</p>
              <p>{{ recommendation.text }}</p>
            </template>
            <p v-else class="muted">{{ report.reviewRequired ? '证据不足，暂不提供推荐建议。' : pending ? '正在生成推荐建议。' : view?.status === 'failed' ? '分析未完成，暂不提供推荐建议。' : '暂无有充分依据的推荐建议，可重新生成总结或补充评估。' }}</p>
            <small>AI 建议仅供参考，不替代人工面试结论。</small>
          </section>
          <section class="report-section human-result">
            <h3>面试结果</h3>
            <p class="result-value" :data-decision="review?.decision || 'pending'">{{ resultLabel }}</p>
            <small v-if="review?.decision && !reviewError && !reviewLoading">人工确认<span v-if="review.decidedAt"> · {{ formatDate(review.decidedAt) }}</span></small>
            <p v-if="reviewError" class="muted">{{ reviewError }}</p>
          </section>
          <footer class="report-meta">总结生成时间：{{ formatDate(report.generatedAt) }}</footer>
        </template>
        <TranscriptRoleCorrection v-if="view?.sessionId && !historical && !audioPending && !pending" :session-id="view.sessionId" @changed="rolesChanged" />
      </div>
    </section>
</template>

<style scoped>
.report-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; min-width: 0; }
.summary-state { font-size: 12px; color: #64706a; }
.report-head .btn { display: inline-flex; align-items: center; gap: 6px; }
.history-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 16px 0; font-size: 13px; }
.history-controls label { display: flex; align-items: center; gap: 8px; min-width: 0; }
.history-controls select { min-width: 0; max-width: 100%; }
.summary-empty { padding: 24px 0; color: #64706a; }
.summary-empty p { margin-bottom: 12px; }
.interview-report.is-embedded { width: 100%; max-height: none; min-width: 0; margin: 20px 0; border-radius: 0; overflow: visible; }
.is-embedded .report-body { overflow: visible; }
.is-embedded .analysis-column { padding: 4px 0; border: 0; background: transparent; }
.is-embedded .report-recommendation { margin: 0; padding: 20px 0; background: transparent; border-left: 0; }
.interview-report { display: flex; flex-direction: column; width: min(1080px, 100%); max-height: 92dvh; background: white; border-radius: 8px; overflow: hidden; color: #25352f; }
.report-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 16px 22px; border-bottom: 1px solid #dce4df; }
.report-head h2 { margin: 0; font-size: 18px; }
.report-close { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 0; background: transparent; cursor: pointer; font-size: 24px; color: #59665f; }
.report-body { overflow: auto; overscroll-behavior: contain; padding: 0 22px 22px; }
.report-info { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 20px; margin: 0; padding: 22px 0; border-bottom: 1px solid #dce4df; }
.report-info dt { margin-bottom: 8px; color: #64706a; font-size: 12px; }
.report-info dd { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.6; overflow-wrap: anywhere; }
.report-overview { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 26px; padding: 26px 0; border-bottom: 1px solid #dce4df; }
.score-column { border-right: 1px solid #dce4df; }
.score-column h3 { color: #64706a; font-size: 13px; font-weight: 500; }
.report-context { display: block; margin-top: 12px; }
.report-score { align-self: center; color: #14795b; font-variant-numeric: tabular-nums; }
.report-score strong { font-size: 30px; }
.report-score span, small, .muted { color: #64706a; font-size: 12px; }
h3 { margin: 0 0 10px; font-size: 15px; } h4 { font-size: 14px; margin: 8px 0; }
p { margin: 6px 0; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.report-section { padding: 20px 0; border-bottom: 1px solid #e5ebe7; }
.report-analysis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; padding: 24px 0; border-bottom: 1px solid #e5ebe7; }
.analysis-column { padding: 20px; min-width: 0; border-top: 3px solid; }
.strengths { background: #eff8f3; border-color: #60a98a; }
.strengths h3 { color: #21634c; }
.concerns { background: #fff8ed; border-color: #d6a34e; }
.concerns h3 { color: #885d22; }
.finding-list { margin: 0; padding-left: 20px; }
.report-finding { padding: 10px 0; font-size: 13px; }
.report-finding + .report-finding { border-top: 1px solid #dfe6df; }
.report-finding::marker { font-weight: 600; color: #64706a; }
.report-recommendation { padding: 20px; margin-top: 20px; background: #eef6fc; border-left: 3px solid #79a9ce; }
.recommendation-value { color: #2b618b; font-weight: 600; font-size: 15px; }
.human-result { display: flex; align-items: center; gap: 12px 20px; flex-wrap: wrap; }
.human-result h3 { margin: 0; }
.result-value { margin: 0; padding: 4px 12px; border-radius: 6px; background: #f0f2f4; color: #5d6872; font-weight: 600; }
.result-value[data-decision="advanced"], .result-value[data-decision="hired"] { color: #21634c; background: #e3f4e9; }
.result-value[data-decision="rejected"] { color: #a04444; background: #fceeee; }
.result-value[data-decision="hold"] { color: #885d22; background: #fff3d8; }
.report-section ul { padding-left: 20px; font-size: 13px; line-height: 1.8; }
.report-warnings { color: #985d16; background: #fff9e9; padding: 12px 14px 12px 32px; font-size: 12px; line-height: 1.8; }
.report-table-wrap { overflow-x: auto; }
.report-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 13px; }
.report-table th, .report-table td { text-align: left; vertical-align: top; padding: 10px; border-bottom: 1px solid #e5ebe7; overflow-wrap: anywhere; }
.report-table th:first-child { width: 22%; } .report-table th:nth-child(2) { width: 54px; }
.report-table thead { background: #f3f6f4; }
blockquote { margin: 8px 0; padding-left: 10px; border-left: 2px solid #86b5a4; font-size: 12px; line-height: 1.7; color: #64706a; overflow-wrap: anywhere; }
.report-meta { padding-top: 16px; color: #64706a; font-size: 11px; }
@media(max-width: 600px) { .summary-overlay { padding: 8px; } .report-head { padding: 12px; } .report-body { padding: 0 12px 12px; } .report-info { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; } .report-overview, .report-analysis { grid-template-columns: 1fr; gap: 16px; } .score-column { border-right: 0; } .report-score strong { font-size: 26px; } .report-table th, .report-table td { padding: 6px; } }
</style>

