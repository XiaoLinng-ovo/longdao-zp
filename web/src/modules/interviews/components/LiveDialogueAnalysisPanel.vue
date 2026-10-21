<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { LiveAnswerAnalysis, LiveInterviewSegment } from '../api'
import { loadInterviewSummary, type InterviewSummaryView } from '../api/summary'
import { buildLiveSummary } from '../utils/live-summary'
import { describeApiFailure } from '../../../shared/utils/errorMessage'

const props = defineProps<{
  interviewId: string; sessionId: string; completed: boolean
  segments: LiveInterviewSegment[]; analyses: Record<string, LiveAnswerAnalysis>
  phaseScore: number | null; phaseFormula: string
}>()
const view = ref<InterviewSummaryView | null>(null)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const live = computed(() => buildLiveSummary(props.segments.filter(row => row.sessionId === props.sessionId), props.analyses))
const report = computed(() => view.value?.report)
const pairs = computed(() => report.value?.pairs ?? live.value.pairs)
const unpaired = computed(() => {
  if (!report.value) return live.value.unpaired
  const paired = new Set(report.value.pairs.flatMap(pair => [...pair.questionSegmentIds, ...pair.answerSegmentIds]))
  return report.value.transcript.filter(turn => !turn.segmentIds.some(id => paired.has(id)))
    .map(turn => ({ ...turn, analyses: [] as LiveAnswerAnalysis[] }))
})
const pending = computed(() => view.value?.status === 'pending' || view.value?.status === 'generating')
const kinds = { assessment: '正式考察', logistics: '流程与安排', unreviewed: '待核实' }
const labels = { interviewer: '面试官', candidate: '候选人', unknown: '说话人待确认' }
const time = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
const pairAnalyses = (ids: string[]) => report.value ? [] : live.value.analysesFor(ids)
let timer: ReturnType<typeof setTimeout> | undefined
let version = 0
let attempts = 0
let failures = 0
function clearTimer() { if (timer) clearTimeout(timer); timer = undefined }
function schedule(retry = false) {
  if (!props.completed || !props.sessionId) return
  if (attempts >= 120 || failures >= 4) {
    notice.value = '自动刷新已暂停，可手动刷新总结；已记录的问答仍保留。'
    return
  }
  timer = setTimeout(() => void load(), retry ? Math.min(15000, 2500 * 2 ** Math.max(0, failures - 1)) : 2500)
}
async function load(manual = false) {
  if (loading.value || !props.completed || !props.sessionId) return
  if (manual) { attempts = 0; failures = 0; notice.value = '' }
  clearTimer()
  const current = version
  loading.value = true
  attempts++
  try {
    const next = await loadInterviewSummary(props.interviewId)
    if (current !== version) return
    failures = 0; error.value = ''
    // A summary for a previous recording must never replace this room's dialogue.
    if (next?.sessionId === props.sessionId) view.value = next
    if (!next || next.sessionId !== props.sessionId || next.status === 'none' || pending.value) schedule()
  } catch (cause) {
    if (current !== version) return
    failures++
    error.value = describeApiFailure(cause, '读取面试总结失败').message
    schedule(true)
  } finally { if (current === version) loading.value = false }
}
watch(() => [props.interviewId, props.sessionId, props.completed] as const, () => {
  version++; clearTimer(); attempts = 0; failures = 0
  view.value = null; loading.value = false; error.value = ''; notice.value = ''
  if (props.completed && props.sessionId) void load()
}, { immediate: true })
onUnmounted(() => { version++; clearTimer() })
</script>

<template>
  <section class="room-panel analysis-panel">
    <header class="panel-head"><span>阶段评分与对话分析</span><small>仅供面试官参考</small></header>
    <div class="analysis-content">
      <div v-if="completed" class="phase-score"><span>阶段综合参考分</span><strong>{{ phaseScore === null ? '暂无评分' : `${phaseScore}/100` }}</strong><small>{{ phaseFormula || '暂无可用于计算的分数' }}</small></div>
      <div v-if="completed" class="summary-status" aria-live="polite">
        <span>{{ pending ? '总结生成中，已记录问答保留。' : loading ? '读取面试总结中…' : view?.status === 'failed' ? '总结分析暂未完成，已保留原文。' : report ? '已同步面试总结表' : '等待本场面试总结' }}</span>
        <button type="button" :disabled="loading" @click="load(true)">刷新总结</button>
        <p v-if="error || view?.error" role="status">{{ error || view?.error }}</p>
        <p v-if="notice" role="status">{{ notice }}</p>
      </div>

      <section class="dialogue-section">
        <h3>实际面试问答 <small>{{ pairs.length }} 组</small></h3>
        <p v-if="!pairs.length" class="muted">等待可确认的实际提问与回答。</p>
        <article v-for="(pair, index) in pairs" :key="pair.id" class="dialogue-pair">
          <div class="dialogue-meta"><span>{{ index + 1 }} · {{ time(pair.startMs) }}–{{ time(pair.endMs) }}</span><span>{{ kinds[pair.kind] }}</span></div>
          <h4>{{ pair.question }}</h4>
          <p class="candidate-answer">{{ pair.answer || (completed ? '未记录到可确认的候选人回答，不计分。' : '等待候选人回答，不计分。') }}</p>
          <p v-if="!report && pair.answer && !pairAnalyses(pair.answerSegmentIds).length" class="muted">回答已记录，暂无分析。</p>
          <div v-for="(analysis, analysisIndex) in pairAnalyses(pair.answerSegmentIds)" :key="analysisIndex" class="answer-analysis">
            <p class="analysis-summary">{{ analysis.summary }}</p>
            <div class="score-list"><div v-for="score in analysis.scores" :key="score.dimension"><strong>{{ score.dimension }} · {{ score.score }}/10</strong><p>{{ score.rationale }}</p><small v-if="score.questionQuote">实际提问：{{ score.questionQuote }}</small><blockquote v-for="quote in score.evidence" :key="quote">{{ quote }}</blockquote></div></div>
            <p v-if="!analysis.scores.length" class="muted">暂不评分</p>
            <blockquote v-for="quote in analysis.evidence" :key="quote">{{ quote }}</blockquote>
            <p v-if="analysis.concerns.length">需要核实：{{ analysis.concerns.join('；') }}</p>
          </div>
        </article>
      </section>

      <section v-if="unpaired.length" class="dialogue-section unpaired-section">
        <h3>未配对与待确认发言</h3>
        <article v-for="turn in unpaired" :key="turn.id" class="dialogue-turn">
          <div class="dialogue-meta">{{ time(turn.startMs) }}–{{ time(turn.endMs) }} · {{ labels[turn.role] }}</div><p>{{ turn.text }}</p>
          <div v-for="(analysis, index) in turn.analyses" :key="index" class="answer-analysis">
            <p class="analysis-summary">{{ analysis.summary }}</p>
            <div class="score-list"><div v-for="score in analysis.scores" :key="score.dimension"><strong>{{ score.dimension }} · {{ score.score }}/10</strong><p>{{ score.rationale }}</p><small v-if="score.questionQuote">实际提问：{{ score.questionQuote }}</small><blockquote v-for="quote in score.evidence" :key="quote">{{ quote }}</blockquote></div></div>
            <p v-if="!analysis.scores.length" class="muted">暂不评分</p>
            <blockquote v-for="quote in analysis.evidence" :key="quote">{{ quote }}</blockquote>
            <p v-if="analysis.concerns.length">需要核实：{{ analysis.concerns.join('；') }}</p>
          </div>
        </article>
      </section>

      <section v-if="report" class="dialogue-section report-analysis">
        <h3>整场总结与评分</h3>
        <div class="overall-score"><span>整场语义参考分</span><strong>{{ view?.status !== 'ready' || report.overallScore === null ? '待评分' : `${report.overallScore}/100` }}</strong></div>
        <p>{{ report.summary }}</p>
        <template v-if="view?.status === 'ready'">
          <article v-for="dimension in report.dimensions" :key="dimension.name" class="report-dimension"><h4>{{ dimension.name }} · {{ dimension.score }}/100</h4><p>{{ dimension.text }}</p><blockquote v-for="(evidence, index) in dimension.evidence" :key="index">{{ evidence.quote }}</blockquote></article>
          <div v-for="group in [{ title: '已体现的优势', rows: report.strengths }, { title: '风险与关注点', rows: report.concerns }]" :key="group.title"><h4>{{ group.title }}</h4><p v-if="!group.rows.length" class="muted">暂无有充分原文依据的评价。</p><div v-for="(finding, index) in group.rows" :key="index"><p>{{ finding.text }}</p><blockquote v-for="(evidence, i) in finding.evidence" :key="i">{{ evidence.quote }}</blockquote></div></div>
        </template>
        <template v-if="report.unassessed.length"><h4>未考察与待核实</h4><ul><li v-for="item in report.unassessed" :key="item">{{ item }}</li></ul></template>
        <p v-for="warning in report.warnings" :key="warning" class="warning">{{ warning }}</p>
      </section>
    </div>
  </section>
</template>

<style scoped>
.room-panel.analysis-panel{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;scrollbar-gutter:auto;padding:0;background:white;border:1px solid var(--border,#dce4df);border-radius:8px}
.panel-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:14px;border-bottom:1px solid var(--border,#dce4df);flex-shrink:0;font-size:14px;font-weight:600}
.analysis-content{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:0 14px 14px;overflow-wrap:anywhere}
h3{margin:0 0 12px;font-size:14px}h4{margin:8px 0;font-size:13px;line-height:1.7}p{font-size:13px;line-height:1.8;margin:6px 0;white-space:normal}small,.muted,.dialogue-meta{font-size:12px;color:#64706a;font-weight:400}
.phase-score{display:grid;gap:6px;padding:14px 0;border-bottom:1px solid #e5ebe7;font-size:13px}.phase-score strong{font-size:26px;color:#1d4ed8}.phase-score small{line-height:1.6}
.summary-status{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 0;font-size:12px;color:#64706a}.summary-status button{margin-left:auto;padding:5px 8px;background:white;border:1px solid #dce4df;border-radius:4px;cursor:pointer;font-size:12px}.summary-status p{flex-basis:100%;color:#985d16}.summary-status button:disabled{opacity:.5;cursor:wait}
.dialogue-section{padding:16px 0;border-bottom:1px solid #e5ebe7}.dialogue-pair,.dialogue-turn,.report-dimension{padding:12px 0;border-bottom:1px solid #edf1ee}.dialogue-pair:last-child,.dialogue-turn:last-child{border-bottom:0}.dialogue-meta{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;font-variant-numeric:tabular-nums}.candidate-answer{border-left:2px solid #86b5a4;padding-left:10px}
.answer-analysis{padding-top:6px}.analysis-summary{color:#334155}.score-list{display:grid;gap:8px;font-size:12px}.score-list p{font-size:12px}.score-list small{display:block;line-height:1.7}blockquote{border-left:2px solid #86b5a4;padding-left:10px;margin:8px 0;font-size:12px;line-height:1.7;color:#64706a}
.overall-score{display:flex;justify-content:space-between;gap:8px;font-size:13px}.overall-score strong{color:#14795b}ul{padding-left:20px;font-size:13px;line-height:1.8}.warning{color:#985d16;font-size:12px}
@media(max-width:1100px){.analysis-panel{height:70vh;min-height:360px;max-height:800px}}
</style>
