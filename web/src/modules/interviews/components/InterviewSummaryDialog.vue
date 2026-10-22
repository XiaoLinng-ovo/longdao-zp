<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { loadInterviewSummary, requestInterviewSummary, type InterviewSummaryView } from '../api/summary'
import { loadQuestionSheets, STAGE_DECISION_LABEL, STAGE_LABEL, type ApiStageReview, type InterviewStage } from '../api/question-sheets'

const props = defineProps<{ open: boolean; interviewId: string; applicationId?: string; stage?: InterviewStage; candidateName?: string; jobTitle?: string; interviewDate?: string }>()
const emit = defineEmits<{ (event: 'close'): void }>()
const view = ref<InterviewSummaryView | null>(null)
const report = computed(() => view.value?.report)
const busy = ref(false)
const loading = ref(false)
const error = ref('')
const review = ref<ApiStageReview | null>(null)
const reviewLoading = ref(false)
const reviewError = ref('')
let reviewVersion = 0
const recommendationLabels = { advance: '建议推进后续流程', reject: '不建议推进后续流程', hold: '建议补充评估' }
const analysisReady = computed(() => view.value?.status === 'ready')
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
let timer: ReturnType<typeof setTimeout> | undefined
let version = 0
let requestVersion = 0
let readFailures = 0
let bodyOverflow = ''
let ownsScrollLock = false
const pending = computed(() => view.value?.status === 'pending' || view.value?.status === 'generating')
function clearTimer() { if (timer) clearTimeout(timer); timer = undefined }
function schedule(retry = false) {
  clearTimer()
  if ((pending.value || retry) && props.open) timer = setTimeout(() => void load(), retry ? Math.min(15000, 2500 * 2 ** Math.min(readFailures - 1, 3)) : 2500)
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
  if (busy.value || pending.value) return
  const current = version
  const request = ++requestVersion
  clearTimer(); loading.value = false
  busy.value = true
  try {
    const next = await requestInterviewSummary(props.interviewId)
    if (current !== version || request !== requestVersion) return
    readFailures = 0
    view.value = next; error.value = ''; schedule()
  } catch (cause) {
    if (current === version && request === requestVersion) {
      error.value = describeApiFailure(cause, '生成面试总结失败').message
      // The server may have accepted the job before the response connection broke.
      readFailures = 1; schedule(true)
    }
  }
  finally { if (current === version) busy.value = false }
}
function keydown(event: KeyboardEvent) { if (event.key === 'Escape') emit('close') }
function releaseScrollLock() {
  if (!ownsScrollLock) return
  document.body.style.overflow = bodyOverflow
  ownsScrollLock = false
}
watch(() => [props.open, props.interviewId, props.applicationId, props.stage] as const, ([open]) => {
  version++; requestVersion++; readFailures = 0; clearTimer(); busy.value = false; loading.value = false; error.value = ''; view.value = null
  reviewVersion++; review.value = null; reviewLoading.value = false; reviewError.value = ''
  if (open) {
    if (!ownsScrollLock) {
      bodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      ownsScrollLock = true
    }
    document.addEventListener('keydown', keydown)
    refresh()
  } else { document.removeEventListener('keydown', keydown); releaseScrollLock() }
}, { immediate: true })
onUnmounted(() => { version++; reviewVersion++; clearTimer(); document.removeEventListener('keydown', keydown); releaseScrollLock() })
</script>

<template>
  <div v-if="open" class="overlay summary-overlay" role="presentation" @click.self="emit('close')">
    <section class="interview-report" role="dialog" aria-modal="true" aria-label="面试总结表">
      <header class="report-head">
        <h2>面试总结表</h2>
        <div class="inline-actions">
          <button class="btn btn-ghost" type="button" :disabled="loading || busy || reviewLoading" @click="refresh">刷新</button>
          <button class="btn btn-primary" type="button" :disabled="busy || pending || loading" @click="generate">{{ pending ? '总结生成中' : report ? '重新生成' : '生成总结' }}</button>
          <button class="report-close" type="button" aria-label="关闭面试总结表" title="关闭" @click="emit('close')">&times;</button>
        </div>
      </header>
      <div class="report-body">
        <p v-if="error || view?.error" class="error-note" role="alert">{{ error || view?.error }}</p>
        <p v-if="pending" class="loading-note" role="status">{{ view?.status === 'pending' ? '总结已排队，等待开始分析。' : '正在分析完整面试对话，长面试可能需要数分钟；临时连接失败会自动重试。' }}可以关闭窗口，稍后查看结果。</p>
        <p v-else-if="loading && !view" class="loading-note">正在读取面试总结...</p>
        <p v-else-if="!report" class="empty-state">尚无面试总结。</p>
        <template v-if="report">
          <dl class="report-info" aria-label="面试信息">
            <div><dt>候选人</dt><dd>{{ candidateName || '未记录' }}</dd></div>
            <div><dt>应聘岗位</dt><dd>{{ jobTitle || '未记录' }}</dd></div>
            <div><dt>面试阶段</dt><dd>{{ stage ? STAGE_LABEL[stage] : '未记录' }}</dd></div>
            <div><dt>面试日期</dt><dd>{{ formatDate(interviewDate) }}</dd></div>
          </dl>
          <section class="report-overview" aria-label="总体评价">
            <div class="score-column"><h3>候选人评分</h3><div class="report-score"><strong>{{ pending || view?.status === 'failed' ? '待评分' : report.overallScore ?? '未评分' }}</strong><span v-if="report.overallScore !== null && !pending && view?.status !== 'failed'"> / 100</span></div><small>AI 综合评价</small></div>
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
          <section v-if="report.dimensions.length" class="report-section">
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
            <p v-else class="muted">{{ pending ? '正在生成推荐建议。' : view?.status === 'failed' ? '分析未完成，暂不提供推荐建议。' : '暂无有充分依据的推荐建议，可重新生成总结或补充评估。' }}</p>
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
      </div>
    </section>
  </div>
</template>

<style scoped>
.summary-overlay { padding: 20px; z-index: 65; }
.interview-report { display: flex; flex-direction: column; width: min(1080px, 100%); max-height: 92dvh; background: white; border-radius: 8px; overflow: hidden; color: #25352f; }
.report-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 16px 22px; border-bottom: 1px solid #dce4df; }
.report-head h2 { margin: 0; font-size: 18px; }
.report-close { width: 32px; height: 32px; border: 0; background: transparent; cursor: pointer; font-size: 24px; color: #59665f; }
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
