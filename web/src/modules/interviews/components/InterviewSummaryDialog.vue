<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { loadInterviewSummary, requestInterviewSummary, type SummaryEvidence, type InterviewSummaryView } from '../api/summary'

const props = defineProps<{ open: boolean; interviewId: string }>()
const emit = defineEmits<{ (event: 'close'): void }>()
const view = ref<InterviewSummaryView | null>(null)
const report = computed(() => view.value?.report)
const busy = ref(false)
const loading = ref(false)
const error = ref('')
const transcriptDetails = ref<HTMLDetailsElement | null>(null)
async function showEvidence(evidence: SummaryEvidence) {
  if (evidence.turnId && transcriptDetails.value) transcriptDetails.value.open = true
  await nextTick()
  const id = evidence.turnId ? `turn-${evidence.turnId}` : `pair-${evidence.pairId}`
  document.getElementById(id)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
}
let timer: ReturnType<typeof setTimeout> | undefined
let version = 0
let requestVersion = 0
let readFailures = 0
let bodyOverflow = ''
let ownsScrollLock = false
const pending = computed(() => view.value?.status === 'pending' || view.value?.status === 'generating')
const labels = { interviewer: '面试官', candidate: '候选人', unknown: '说话人待确认' }
const kinds = { assessment: '正式考察', logistics: '流程与安排', unreviewed: '待核实' }
const time = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
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
watch(() => [props.open, props.interviewId] as const, ([open]) => {
  version++; requestVersion++; readFailures = 0; clearTimer(); busy.value = false; loading.value = false; error.value = ''; view.value = null
  if (open) {
    if (!ownsScrollLock) {
      bodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      ownsScrollLock = true
    }
    document.addEventListener('keydown', keydown)
    void load()
  } else { document.removeEventListener('keydown', keydown); releaseScrollLock() }
}, { immediate: true })
onUnmounted(() => { version++; clearTimer(); document.removeEventListener('keydown', keydown); releaseScrollLock() })
</script>

<template>
  <div v-if="open" class="overlay summary-overlay" role="presentation" @click.self="emit('close')">
    <section class="interview-report" role="dialog" aria-modal="true" aria-label="面试总结表">
      <header class="report-head">
        <h2>面试总结表</h2>
        <div class="inline-actions">
          <button class="btn btn-ghost" type="button" :disabled="loading || busy" @click="load">刷新</button>
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
          <section class="report-overview" aria-label="总体评价">
            <div class="report-score"><strong>{{ pending || view?.status === 'failed' ? '待评分' : report.overallScore ?? '未评分' }}</strong><span v-if="report.overallScore !== null && !pending && view?.status !== 'failed'"> / 100</span></div>
            <div><h3>总体评价</h3><p>{{ report.summary }}</p><small>依据完整实际对话理解已体现的能力；参考面试表不作为必答清单，未考察内容不扣分。</small><small>实际面试评价 · {{ report.dimensions.length }} 个已考察维度 · {{ new Date(report.generatedAt).toLocaleString('zh-CN') }}</small></div>
          </section>
          <p v-if="report.version === 'actual-dialogue-v1'" class="muted">这是历史问答报告，可点击“重新生成”按完整对话重新分析；历史分数不参与当前录音分计算。</p>
          <ul v-if="report.warnings.length" class="report-warnings"><li v-for="warning in report.warnings" :key="warning">{{ warning }}</li></ul>
          <section v-if="report.dimensions.length" class="report-section">
            <h3>维度评分</h3>
            <div class="report-table-wrap"><table class="report-table"><thead><tr><th>考察维度</th><th>分数</th><th>评价与原文证据</th></tr></thead>
              <tbody><tr v-for="dimension in report.dimensions" :key="dimension.name"><th>{{ dimension.name }}</th><td>{{ dimension.score }}</td><td><p>{{ dimension.text }}</p><blockquote v-for="(evidence, index) in dimension.evidence" :key="index"><a :href="evidence.turnId ? `#turn-${evidence.turnId}` : `#pair-${evidence.pairId}`" @click.prevent="showEvidence(evidence)">{{ evidence.turnId ? '发言原文' : '对应问答' }}</a>：“{{ evidence.quote }}”</blockquote></td></tr></tbody>
            </table></div>
          </section>
          <section v-for="group in [{ title: '已体现的优势', rows: report.strengths }, { title: '风险与关注点', rows: report.concerns }]" :key="group.title" class="report-section">
            <h3>{{ group.title }}</h3><p v-if="!group.rows.length" class="muted">暂无有充分原文依据的评价。</p>
            <div v-for="(finding, index) in group.rows" :key="index" class="report-finding"><p>{{ finding.text }}</p><blockquote v-for="(evidence, evidenceIndex) in finding.evidence" :key="evidenceIndex">“{{ evidence.quote }}”</blockquote></div>
          </section>
          <section v-if="report.unassessed.length" class="report-section"><h3>未考察与待核实</h3><ul><li v-for="item in report.unassessed" :key="item">{{ item }}</li></ul></section>
          <section class="report-section"><h3>实际面试问答 <small>{{ report.pairs.length }} 组</small></h3>
            <p v-if="!report.pairs.length" class="muted">没有可可靠配对的提问与回答。</p>
            <article v-for="(pair, index) in report.pairs" :id="`pair-${pair.id}`" :key="pair.id" class="report-pair">
              <div class="report-meta"><span>{{ index + 1 }} · {{ time(pair.startMs) }}–{{ time(pair.endMs) }}</span><span>{{ kinds[pair.kind] }}</span></div>
              <h4>{{ pair.question }}</h4><p>{{ pair.answer || '未记录到可确认的候选人回答，不计分。' }}</p>
            </article>
          </section>
          <details ref="transcriptDetails" class="report-section"><summary>完整语音转写 <small>{{ report.transcript.length }} 段</small></summary>
            <div v-for="turn in report.transcript" :id="`turn-${turn.id}`" :key="turn.id" class="report-turn"><div class="report-meta">{{ time(turn.startMs) }}–{{ time(turn.endMs) }} · {{ labels[turn.role] }}</div><p>{{ turn.text }}</p></div>
          </details>
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
.report-overview { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 20px; padding: 22px 0; border-bottom: 1px solid #dce4df; }
.report-score { align-self: center; color: #14795b; font-variant-numeric: tabular-nums; }
.report-score strong { font-size: 30px; }
.report-score span, small, .muted { color: #64706a; font-size: 12px; }
h3 { margin: 0 0 10px; font-size: 15px; } h4 { font-size: 14px; margin: 8px 0; }
p { margin: 6px 0; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.report-pair p, .report-turn p { white-space: normal; }
.report-section { padding: 20px 0; border-bottom: 1px solid #e5ebe7; }
.report-section ul { padding-left: 20px; font-size: 13px; line-height: 1.8; }
.report-warnings { color: #985d16; background: #fff9e9; padding: 12px 14px 12px 32px; font-size: 12px; line-height: 1.8; }
.report-table-wrap { overflow-x: auto; }
.report-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 13px; }
.report-table th, .report-table td { text-align: left; vertical-align: top; padding: 10px; border-bottom: 1px solid #e5ebe7; overflow-wrap: anywhere; }
.report-table th:first-child { width: 22%; } .report-table th:nth-child(2) { width: 54px; }
.report-table thead { background: #f3f6f4; }
blockquote { margin: 8px 0; padding-left: 10px; border-left: 2px solid #86b5a4; font-size: 12px; line-height: 1.7; color: #64706a; overflow-wrap: anywhere; }
.report-pair, .report-finding, .report-turn { padding: 12px 0; border-bottom: 1px solid #edf1ee; }
.report-meta { display: flex; flex-wrap: wrap; gap: 12px; color: #64706a; font-size: 11px; }
summary { cursor: pointer; font-size: 15px; font-weight: 600; }
@media(max-width: 600px) { .summary-overlay { padding: 8px; } .report-head { padding: 12px; } .report-body { padding: 0 12px 12px; } .report-overview { grid-template-columns: 1fr; gap: 8px; } .report-score strong { font-size: 26px; } .report-table th, .report-table td { padding: 6px; } }
</style>
