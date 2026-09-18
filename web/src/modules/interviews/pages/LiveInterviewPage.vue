<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiClient } from '../../../shared/api'
import PageHeader from '../../../shared/components/PageHeader.vue'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { analyzeLiveSegment, correctLiveSegmentRole, createLiveInterviewSession, endLiveInterviewSession, findActiveLiveInterviewSession, getInterview, uploadLiveInterviewChunk, type ApiInterviewDetail, type LiveAnswerAnalysis, type LiveInterviewSegment } from '../api'
import { buildUtterances } from '../utils/utterance-state'

const route = useRoute()
const router = useRouter()
const detail = ref<ApiInterviewDetail | null>(null)
const candidateName = ref('')
const jobTitle = ref('')
const loading = ref(true)
const error = ref('')
const sessionId = ref('')
const status = ref<'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'failed'>('idle')
const segments = ref<LiveInterviewSegment[]>([])
const currentQuestion = ref('请先做一下自我介绍，并重点说明与你应聘岗位相关的经历。')
const analyses = ref<Record<string, LiveAnswerAnalysis>>({})
const analyzingId = ref('')
const elapsedSeconds = ref(0)
const recordingNowMs = ref(0)
const analyzedUtterances = new Set<string>()
let recorder: MediaRecorder | undefined
let timer: ReturnType<typeof setInterval> | undefined
let recordingStartedAt = 0
let lastChunkEndedAt = 0
const ANSWER_SILENCE_MS = 1600

const elapsed = computed(() => `${String(Math.floor(elapsedSeconds.value / 60)).padStart(2, '0')}:${String(elapsedSeconds.value % 60).padStart(2, '0')}`)
const latestAnalysis = computed(() => { const values=Object.values(analyses.value); return values[values.length - 1] })
const utterances = computed(() => buildUtterances(segments.value, recordingNowMs.value, ANSWER_SILENCE_MS))
const statusLabel = computed(() => ({ idle: '尚未开始', starting: '正在启动', recording: '正在录音', paused: '录音已暂停', stopping: '正在保存', failed: '服务异常' })[status.value])

function toBase64(blob: Blob): Promise<string> { return new Promise((resolve, reject) => { const reader=new FileReader(); reader.onloadend=()=>resolve(String(reader.result).split(',')[1] || ''); reader.onerror=()=>reject(reader.error || new Error('读取录音片段失败')); reader.readAsDataURL(blob) }) }
async function load() { loading.value=true; try { const id=String(route.params.id ?? ''); detail.value=await getInterview(id); const [candidates,jobs,active]=await Promise.all([apiClient.getJson<Array<{id:string;fullName:string}>>('/candidates'),apiClient.getJson<Array<{id:string;title:string}>>('/jobs'),findActiveLiveInterviewSession(id)]); candidateName.value=candidates.data.find((item)=>item.id===detail.value?.application.candidateId)?.fullName || detail.value.application.candidateId; jobTitle.value=jobs.data.find((item)=>item.id===detail.value?.application.jobId)?.title || detail.value.application.jobId; if(active){sessionId.value=active.session.id;segments.value=active.segments;recordingNowMs.value=Math.max(0,...active.segments.map((item)=>item.endMs))+ANSWER_SILENCE_MS;status.value='paused'} } catch(cause) { error.value=describeApiFailure(cause,'读取面试信息失败').message } finally { loading.value=false } }
async function start() { if(!detail.value || status.value==='starting' || status.value==='recording')return; error.value=''; status.value='starting'; try { if(!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)throw new Error('当前浏览器不支持麦克风录音'); const stream=await navigator.mediaDevices.getUserMedia({audio:true}); if(!sessionId.value){const session=await createLiveInterviewSession(detail.value.id);sessionId.value=session.id} recorder=new MediaRecorder(stream); recordingStartedAt=performance.now()-recordingNowMs.value; lastChunkEndedAt=recordingNowMs.value; recorder.ondataavailable=async(event)=>{ if(!event.data.size || !sessionId.value)return; const chunkEndedAt=Math.round(performance.now()-recordingStartedAt); const chunkOffsetMs=lastChunkEndedAt; lastChunkEndedAt=chunkEndedAt; recordingNowMs.value=chunkEndedAt; try { segments.value.push(...await uploadLiveInterviewChunk(sessionId.value,await toBase64(event.data),event.data.type || 'audio/webm',chunkOffsetMs)) } catch(cause) { error.value=describeApiFailure(cause,'语音转写失败').message; status.value='failed' } }; recorder.onstop=()=>stream.getTracks().forEach((track)=>track.stop()); recorder.start(1000); timer=setInterval(()=>{elapsedSeconds.value++;recordingNowMs.value=Math.round(performance.now()-recordingStartedAt)},1000); status.value='recording' } catch(cause) { error.value=cause instanceof Error?cause.message:'无法启动 AI 面试'; status.value='failed' } }
function togglePause() { if(recorder?.state==='recording'){recorder.pause();status.value='paused'}else if(recorder?.state==='paused'){recorder.resume();status.value='recording'} }
async function stop() { if(!recorder || !sessionId.value)return; status.value='stopping'; recorder.stop(); if(timer)clearInterval(timer); try { await endLiveInterviewSession(sessionId.value); status.value='idle' } catch(cause) { error.value=describeApiFailure(cause,'保存面试会话失败').message; status.value='failed' } }
async function setRole(segment:LiveInterviewSegment,role:'interviewer'|'candidate'){ try { Object.assign(segment,await correctLiveSegmentRole(segment.id,role)) } catch(cause) { error.value=describeApiFailure(cause,'修正说话人失败').message } }
async function analyze(segment:LiveInterviewSegment & {sourceIds?:string[]}){ if(!currentQuestion.value.trim() || analyzingId.value)return; analyzingId.value=segment.id; error.value=''; try { const result=await analyzeLiveSegment(segment.id,currentQuestion.value.trim(),segment.sourceIds ?? [segment.id]); analyses.value={...analyses.value,[segment.id]:result}; currentQuestion.value=result.nextQuestion } catch(cause) { error.value=describeApiFailure(cause,'回答分析失败').message } finally { analyzingId.value='' } }
watch(utterances,(rows)=>{ const candidate=rows.find((row)=>row.final&&row.role==='candidate'&&row.confidence>=.6&&!analyzedUtterances.has(row.id)); if(!candidate||analyzingId.value)return; analyzedUtterances.add(candidate.id); void analyze(candidate) },{deep:true})
onMounted(load)
onUnmounted(()=>{if(timer)clearInterval(timer);if(recorder&&recorder.state!=='inactive')recorder.stop()})
</script>

<template>
  <div class="page live-page">
    <PageHeader title="AI 面试室" :subtitle="`${candidateName || '候选人'} · ${jobTitle || '岗位加载中'}`" icon="④" :crumb="detail ? `面试 / ${detail.code} / AI 面试室` : '面试 / AI 面试室'">
      <button class="btn btn-ghost" type="button" @click="router.push(`/interviews/${route.params.id}`)">返回面试详情</button>
    </PageHeader>
    <div v-if="loading" class="loading-note">正在准备面试室...</div>
    <div v-else-if="!detail" class="error-note" role="alert">{{ error || '无法读取面试信息' }}</div>
    <template v-else>
      <div class="session-bar">
        <div><span class="record-dot" :class="{ active: status === 'recording' }"></span><strong>{{ statusLabel }}</strong><span>{{ elapsed }}</span></div>
        <div class="inline-actions"><button v-if="status === 'idle' || status === 'failed'" class="btn btn-primary" type="button" @click="start">开始面试</button><button v-if="status === 'recording' || status === 'paused'" class="btn btn-ghost" type="button" @click="togglePause">{{ status === 'paused' ? '继续' : '暂停' }}</button><button v-if="status === 'recording' || status === 'paused'" class="btn btn-ghost" type="button" @click="stop">结束面试</button></div>
      </div>
      <div v-if="error" class="error-note" role="alert">{{ error }}</div>
      <main class="interview-room">
        <section class="room-panel question-panel"><header><span>当前问题</span><small>面试官可修改后提问</small></header><textarea v-model="currentQuestion" rows="7" /><div v-if="latestAnalysis" class="next-question"><span>AI 推荐追问</span><p>{{ latestAnalysis.nextQuestion }}</p><button class="btn btn-primary" type="button" @click="currentQuestion=latestAnalysis.nextQuestion">采用该问题</button></div><div class="consent-note">开始录音前，请确认候选人已知悉并同意录音与 AI 辅助分析。</div></section>
        <section class="room-panel transcript-panel"><header><span>实时转写</span><small>{{ utterances.length }} 轮发言</small></header><div v-if="!utterances.length" class="room-empty">面试开始后，系统会根据说话人和停顿合并完整发言，不会把网络传输包显示成回答。</div><div v-else class="transcript-list"><article v-for="segment in utterances" :key="segment.id" class="utterance" :data-role="segment.role"><div class="utterance-head"><strong>{{ segment.role==='candidate'?'候选人':segment.role==='interviewer'?'面试官':'待确认' }}</strong><small>{{ segment.final?'发言已结束':'正在继续...' }} · {{ Math.round(segment.confidence*100) }}%</small></div><p>{{ segment.text }}</p><div class="utterance-actions"><button type="button" title="标记为面试官" @click="setRole(segment,'interviewer')">面试官</button><button type="button" title="标记为候选人" @click="setRole(segment,'candidate')">候选人</button><button v-if="segment.final && segment.role==='candidate' && segment.confidence>=.6" class="analyze-button" type="button" :disabled="!!analyzingId" @click="analyze(segment)">{{ analyzingId===segment.id?'分析中...':'分析完整回答' }}</button></div></article></div></section>
        <section class="room-panel analysis-panel"><header><span>回答分析</span><small>仅供面试官参考</small></header><div v-if="!latestAnalysis" class="room-empty">确认候选人的回答片段后，可以生成有证据的分析和下一题。</div><template v-else><div class="confidence"><span>分析置信度</span><strong>{{ Math.round(latestAnalysis.confidence*100) }}%</strong></div><p class="analysis-summary">{{ latestAnalysis.summary }}</p><div class="score-list"><div v-for="score in latestAnalysis.scores" :key="score.dimension"><span>{{ score.dimension }}</span><strong>{{ score.score }}/10</strong><small>{{ score.rationale }}</small></div></div><div class="analysis-block"><strong>回答证据</strong><p>{{ latestAnalysis.evidence.join('；') || '未提取到明确证据' }}</p></div><div class="analysis-block"><strong>需要核实</strong><p>{{ latestAnalysis.concerns.join('；') || '暂未发现' }}</p></div></template></section>
      </main>
    </template>
  </div>
</template>

<style scoped>
.live-page{max-width:none}.session-bar{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:10px 14px;border:1px solid var(--border);background:#fff}.session-bar>div{display:flex;align-items:center;gap:10px}.record-dot{width:9px;height:9px;border-radius:50%;background:#94a3b8}.record-dot.active{background:#dc2626;box-shadow:0 0 0 4px #fee2e2}.interview-room{display:grid;grid-template-columns:minmax(240px,.8fr) minmax(360px,1.4fr) minmax(280px,1fr);gap:12px;min-height:620px}.room-panel{min-width:0;border:1px solid var(--border);background:#fff;display:flex;flex-direction:column}.room-panel>header{display:flex;justify-content:space-between;gap:10px;padding:13px 14px;border-bottom:1px solid var(--border);font-weight:700}.room-panel>header small{font-weight:400;color:var(--text-muted)}.question-panel textarea{margin:14px;resize:vertical}.next-question,.consent-note,.analysis-block{margin:0 14px 14px;padding:12px;background:#f8fafc;border:1px solid var(--border)}.next-question span{font-size:12px;color:var(--text-muted)}.next-question p{line-height:1.6}.consent-note{margin-top:auto;font-size:12px;color:var(--text-muted)}.transcript-list{overflow:auto;padding:12px;display:grid;gap:10px}.utterance{padding:11px;border-left:3px solid #94a3b8;background:#f8fafc}.utterance[data-role="interviewer"]{border-color:#2563eb}.utterance[data-role="candidate"]{border-color:#0f766e}.utterance-head{display:flex;justify-content:space-between}.utterance p{margin:7px 0;line-height:1.6}.utterance-actions{display:flex;gap:6px;flex-wrap:wrap}.utterance-actions button{border:1px solid var(--border);background:#fff;padding:5px 8px;cursor:pointer}.utterance-actions .analyze-button{background:#0f766e;color:#fff;border-color:#0f766e}.analysis-panel{padding-bottom:14px}.confidence,.score-list>div{display:flex;justify-content:space-between;gap:12px}.confidence{padding:14px}.analysis-summary{padding:0 14px;line-height:1.65}.score-list{display:grid;gap:8px;padding:0 14px 14px}.score-list>div{display:grid;grid-template-columns:1fr auto}.score-list small{grid-column:1/-1;color:var(--text-muted)}.room-empty{margin:auto;padding:28px;text-align:center;color:var(--text-muted);line-height:1.7}@media(max-width:1050px){.interview-room{grid-template-columns:1fr 1.4fr}.analysis-panel{grid-column:1/-1}}@media(max-width:720px){.session-bar{align-items:flex-start;flex-direction:column}.interview-room{grid-template-columns:1fr}.analysis-panel{grid-column:auto}.room-panel{min-height:360px}}
</style>
