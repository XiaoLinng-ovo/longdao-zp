<script setup lang="ts">
import { questionConversationContext } from '../utils/question-conversation'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { ApiClientError, ApiNetworkError, apiClient } from '../../../shared/api'
import { getWorkspaceContext } from '../../../shared/api/workspace-context'
import { authSession } from '../../auth/session'
import { hasSubstantiveAnswer, savePendingAudio, removePendingAudio, restorePendingAudio, type PendingInterviewAudio } from '../utils/pending-audio'
import PageHeader from '../../../shared/components/PageHeader.vue'
import ApplicationResumeButton from '../../candidates/components/ApplicationResumeButton.vue'
import InterviewQuestionReferenceDialog from '../components/InterviewQuestionReferenceDialog.vue'
import InterviewAudioDialog from '../components/InterviewAudioDialog.vue'
import LiveDialogueAnalysisPanel from '../components/LiveDialogueAnalysisPanel.vue'
import TranscriptRefinementEditor from '../components/TranscriptRefinementEditor.vue'
import { COMMON_QUESTION_GROUPS } from '../utils/common-question-templates'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { addManualLiveSegment, analyzeLiveSegment, correctLiveSegmentRole, createLiveInterviewSession, endLiveInterviewSession, findActiveLiveInterviewSession, generateInterviewQuestions, getInterviewQuestions, refineInterviewQuestionGroup, getInterview, updateLiveInterviewQuestion, uploadLiveInterviewChunk, type ApiInterviewDetail, type GeneratedInterviewQuestion, type InterviewQuestionConversationMessage, type LiveAnswerAnalysis, type LiveInterviewSegment } from '../api'
import { loadQuestionSheets, stageOfRound } from '../api/question-sheets'
import { analysisMatchesUtterance, analysisSourceKey, analysisSourceSegments, buildUtterances, type LiveUtterance } from '../utils/utterance-state'
import { createSourceStreaming, type SourceStreamingState } from '../utils/source-streaming'
import { createSourceRecorderGroup, type SourceRecorderGroup } from '../utils/source-recorder'
import { createAnalysisRetryState } from '../utils/analysis-retry-state'
import { createInterviewAudioCapture, InterviewAudioCaptureError, type InterviewAudioCapture, type InterviewAudioMode, type InterviewAudioSource, type InterviewAudioSourceConfig } from '../utils/audio-capture'

const route = useRoute()
const editingRefinements = ref<Record<string, boolean>>({})
const router = useRouter()
const interviewId = String(route.params.id ?? '')
const workspace = getWorkspaceContext()
const audioScope = authSession.user?.id && workspace.workspaceId ? `${workspace.workspaceId}:${authSession.user.id}:${interviewId}` : ''
const detail = ref<ApiInterviewDetail | null>(null)
const candidateName = ref('')
const jobTitle = ref('')
const loading = ref(true)
const error = ref('')
const sessionId = ref('')
const status = ref<'idle' | 'starting' | 'recording' | 'paused' | 'manual' | 'stopping' | 'failed' | 'completed'>('idle')
const segments = ref<LiveInterviewSegment[]>([])
const currentQuestion = ref('请先做一下自我介绍，并重点说明与你应聘岗位相关的经历。')
const generatedQuestions = ref<GeneratedInterviewQuestion[]>([])
type ReferenceGroup = 'ai' | 'hr' | 'department' | 'boss'
const referenceGroup = ref<ReferenceGroup | null>(null)
const modificationSelection = ref<Record<ReferenceGroup, string>>({ ai: '', hr: '', department: '', boss: '' })
const audioDialogOpen = ref(false)
const audioPlaybackSession = ref('')
const audioPlaybackStartMs = ref(0)
function openAudio(session = sessionId.value, startMs = 0) {
  audioPlaybackSession.value = session; audioPlaybackStartMs.value = startMs; audioDialogOpen.value = true
}
function speakerLabel(segment: LiveInterviewSegment) {
  if (segment.speakerConfirmed || segment.speakerId?.startsWith('manual_')) return '手动确认'
  if (!segment.speakerId || segment.speakerId.includes(':stream_')) return '声音身份待确认'
  const ids = [...new Set([...segments.value].filter(row => row.sessionId === segment.sessionId && row.audioSource === segment.audioSource)
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id)).map(row => row.speakerId).filter(Boolean))]
  return '说话人 ' + (ids.indexOf(segment.speakerId) + 1)
}
const generatingQuestions = ref(false)
const questionLoadError = ref('')
const questionGenerationNotice = ref('')
const questionGenerationSlow = ref(false)
const questionGenerationSeconds = ref(0)
const questionGenerationGroup = ref<ReferenceGroup | null>(null)
const questionGenerationDeadlineSeconds = ref(615)
let questionGenerationController: AbortController | undefined
const questionGenerationWarning = ref(false)
let questionRevision = 0
const questionEngine = ref<'llm' | 'local_fallback' | ''>('')
const conversationMessages = ref<Record<ReferenceGroup, InterviewQuestionConversationMessage[]>>({
  ai: [],
  hr: [],
  department: [],
  boss: [],
})
const refinementLoading = ref<Record<ReferenceGroup, boolean>>({ ai: false, hr: false, department: false, boss: false })
const refinementErrors = ref<Record<ReferenceGroup, string>>({ ai: '', hr: '', department: '', boss: '' })
const refinementControllers = new Map<ReferenceGroup, AbortController>()
const microphoneState = ref<'unknown' | 'unsupported' | 'prompt' | 'ready' | 'denied' | 'not-found' | 'busy' | 'error'>('unknown')
const microphoneLabel = ref('未检测')
const audioInputCount = ref(0)
const audioInputs = ref<Array<{ deviceId: string; label: string }>>([])
const microphoneDeviceId = ref('')
const audioMode = ref<InterviewAudioMode>('microphone')
const recordingConsent = ref(false)
const microphoneLevel = ref(0)
const meetingLevel = ref(0)
const soundDetected = ref({ microphone: false, meeting: false })
const meetingState = ref<'idle' | 'authorizing' | 'connected' | 'failed' | 'ended'>('idle')
const meetingLabel = ref('')
const audioWarning = ref('')
const sourceSettings = ref<Record<InterviewAudioSource, InterviewAudioSourceConfig>>({
  microphone: { id: 'microphone', role: 'unknown', multipleSpeakers: true },
  meeting: { id: 'meeting', role: 'unknown', multipleSpeakers: true },
})
const sourceLabels: Record<InterviewAudioSource, string> = { microphone: '本机麦克风', meeting: '会议音频' }
const activeSources = computed<InterviewAudioSource[]>(() => audioMode.value === 'meeting' ? ['microphone', 'meeting'] : ['microphone'])
const sourceText = ref({ microphone: '', meeting: '' })
const sourceWarnings = ref({ microphone: '', meeting: '' })
const sourceStates = ref<Record<InterviewAudioSource, SourceStreamingState>>({ microphone: 'idle', meeting: 'idle' })
const streamingWarning = computed(() => activeSources.value.filter(source => sourceWarnings.value[source]).map(source => sourceLabels[source] + '：' + sourceWarnings.value[source]).join(' '))
const captureActive = ref(false)
const pausing = ref(false)
const audioSettingsLocked = computed(() => pausing.value || ['starting', 'recording', 'manual', 'stopping', 'completed'].includes(status.value) || (captureActive.value && status.value !== 'paused'))
const meetingStatusLabel = computed(() => ({ idle: '尚未共享', authorizing: '等待共享授权', connected: '音轨已接入', failed: '未接入会议音频', ended: '共享已停止' })[meetingState.value])
let audioCapture: InterviewAudioCapture | undefined
let captureVersion = 0

let disposed = false
const analyses = ref<Record<string, LiveAnswerAnalysis>>({})
const followUpQuestions = computed(() => [...new Set(Object.values(candidateAnalyses.value).map(analysis => analysis.nextQuestion.trim()).filter(question => question && !generatedQuestions.value.some(item => normalizeQuestion(item.question) === normalizeQuestion(question))))])
const analyzingId = ref('')
const analysisFeedback = ref<Record<string, { kind: 'error' | 'stale'; message: string }>>({})
const manualText = ref('')
const manualRole = ref<'candidate' | 'interviewer'>('candidate')
const elapsedSeconds = ref(0)
const recordingNowMs = ref(0)
const analysisRetryState = createAnalysisRetryState()
const analysisRetryTick = ref(0)
const externalServices = ref<Record<string, string>>({})
const funasrAvailable = computed(() => externalServices.value.funasr === 'ok')
const streamingText = computed(() => Object.values(sourceText.value).filter(Boolean).join(' '))
const streamingState = computed<SourceStreamingState>(() => {
  const states = activeSources.value.map(source => sourceStates.value[source])
  return states.includes('unavailable') ? 'unavailable' : states.includes('loading') ? 'loading'
    : states.includes('connecting') ? 'connecting' : states.every(state => state === 'ready') ? 'ready' : 'idle'
})
const sourceStreaming = Object.fromEntries((['microphone', 'meeting'] as const).map(source => [source, createSourceStreaming({
  isRecording: () => status.value === 'recording',
  onState: state => { sourceStates.value[source] = state },
  onText: text => { sourceText.value[source] = text },
  onWarning: message => { sourceWarnings.value[source] = message },
})])) as Record<InterviewAudioSource, ReturnType<typeof createSourceStreaming>>
const externalServiceWarning = computed(() => { const unavailable = Object.entries(externalServices.value).filter(([key, value]) => key !== 'fasterWhisper' && value === 'unavailable').map(([key]) => key); if (!unavailable.length) return ''; const labels: Record<string, string> = { funasr: '语音转写', llm: 'AI 回答分析', ocr: '简历 OCR 解析' }; return `外部服务提示：${unavailable.map(key => labels[key] ?? key).join('、')}不可用或未配置；录音采集不受影响，待处理音频将缓存。` })
let recorder: SourceRecorderGroup | undefined








let timer: ReturnType<typeof setInterval> | undefined
let chunkRotationTimer: ReturnType<typeof setTimeout> | undefined
let recordingStartedAt = 0
let uploadQueue: Promise<void> = Promise.resolve()
const pendingAudio: PendingInterviewAudio[] = []
const audioPersistence = new Map<string, Promise<void>>()
const pendingAudioCount = ref(0)
const localCacheWarning = ref('')
let uploadRetryTimer: ReturnType<typeof setTimeout> | undefined





let wakeLock: WakeLockSentinel | undefined
let wakeLockPending = false
let uploadRetryable = true
let uploadFailure = ''
const sourceUploads = new Map<InterviewAudioSource | undefined, Promise<void>>()
const failedSources = new Set<InterviewAudioSource | undefined>()
const uploadRetryNotice = ref('')
let recorderStopWaiter: Promise<void> = Promise.resolve()
let analysisRetryTimer: ReturnType<typeof setTimeout> | undefined
let externalServicesTimer: ReturnType<typeof setInterval> | undefined
const ANSWER_SILENCE_MS = 15_000
const TRANSCRIPTION_CHUNK_MS = 15_000

const elapsed = computed(() => `${String(Math.floor(elapsedSeconds.value / 60)).padStart(2, '0')}:${String(elapsedSeconds.value % 60).padStart(2, '0')}`)
const finalInterviewScore = ref<number | null>(null)
const finalInterviewScoreFormula = ref('')
async function refreshFinalInterviewScore(){ if(!detail.value)return; try { const view=await loadQuestionSheets(detail.value.applicationId); const stage=view.stages.find((item)=>item.stage===stageOfRound(detail.value!.round)); finalInterviewScore.value=stage?.breakdown.score ?? null; finalInterviewScoreFormula.value=stage?.breakdown.formula ?? '' } catch(cause) { error.value=describeApiFailure(cause,'读取阶段评分失败').message } }
const utterances = computed(() => buildUtterances(segments.value, recordingNowMs.value, ANSWER_SILENCE_MS))
const applicableAnalyses = computed(() => Object.fromEntries(utterances.value.flatMap(row => {
  const analysis = analyses.value[row.id]
  return analysis && analysisMatchesUtterance(analysis, row) ? [[row.id, analysis]] : []
})))
const candidateAnalyses = computed(() => Object.fromEntries(utterances.value.filter(row => row.role === 'candidate')
  .flatMap(row => applicableAnalyses.value[row.id] ? [[row.id, applicableAnalyses.value[row.id]!]] : [])))
const transcriptList = ref<HTMLElement | null>(null)
let followingTranscript = true
function trackTranscriptScroll() {
  const list = transcriptList.value
  if (list) followingTranscript = list.scrollHeight - list.scrollTop - list.clientHeight <= 48
}
watch(() => [utterances.value.map(row => `${row.id}:${row.text}`).join('\n'), streamingText.value], async () => {
  const follow = !loading.value && followingTranscript && ['recording', 'paused', 'stopping', 'manual'].includes(status.value)
  await nextTick()
  const list = transcriptList.value
  if (!disposed && follow && followingTranscript && list) list.scrollTop = list.scrollHeight
  else trackTranscriptScroll()
})
const statusLabel = computed(() => ({ idle: '尚未开始', starting: '正在启动', recording: '正在录音', paused: '录音已暂停', manual: '手动记录中', stopping: '正在保存', failed: '服务异常', completed: '面试已结束' })[status.value])
const microphoneStatusLabel = computed(() => ({
  unknown: '未检测',
  unsupported: '浏览器不支持麦克风',
  prompt: '等待麦克风授权',
  ready: audioInputCount.value ? `已检测到 ${audioInputCount.value} 个麦克风` : '麦克风可用',
  denied: '麦克风权限被拒绝',
  'not-found': '未检测到麦克风',
  busy: '麦克风被占用',
  error: '麦克风检测异常',
})[microphoneState.value])

function stopStreamingAudio() { Object.values(sourceStreaming).forEach(channel => channel.stop()) }
function restartStreamingAudio() {
  if (!audioCapture || disposed || status.value !== 'recording') return
  const tracks = audioCapture.sources ?? [{ source: 'microphone' as const, stream: audioCapture.stream }]
  for (const track of tracks) sourceStreaming[track.source].start(track.stream)
}
function pauseStreamingAudio() { Object.values(sourceStreaming).forEach(channel => channel.pause()) }
async function requestWakeLock() {
  if (wakeLock || wakeLockPending || status.value !== 'recording' || document.visibilityState !== 'visible' || !navigator.wakeLock) return
  wakeLockPending = true
  try {
    const lock = await navigator.wakeLock.request('screen')
    if (disposed || status.value !== 'recording') { await lock.release(); return }
    wakeLock = lock
    lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = undefined }, { once: true })
  } catch { /* Power policy must not prevent native recording. */ }
  finally { wakeLockPending = false }
}
function releaseWakeLock() { const lock = wakeLock; wakeLock = undefined; void lock?.release().catch(() => undefined) }
async function recoverAudio() {
  if (disposed || status.value !== 'recording') return
  try { await audioCapture?.resume?.() }
  catch { audioWarning.value = '音频采集恢复失败，请检查录音设备，必要时暂停后重新选择采集方式。' }
  if (disposed || status.value !== 'recording') return
  await Promise.all(Object.values(sourceStreaming).map(channel => channel.resume()))
  void requestWakeLock()

}
function reconnectAudio() {
  void recoverAudio()
  Object.values(sourceStreaming).forEach(channel => channel.reconnect())
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (!captureActive.value && !pendingAudio.length) return
  event.preventDefault(); event.returnValue = ''
}
function online() { retryUploads(); void recoverAudio() }
function retryUploads() {
  if (disposed) return
  if (uploadRetryTimer) clearTimeout(uploadRetryTimer)
  uploadRetryTimer = undefined
  uploadFailure = ''; uploadRetryable = true; failedSources.clear()
  queueAudioUploads()
}
onBeforeRouteLeave(() => {
  if (!captureActive.value && !pendingAudio.length) return true
  error.value = '请先结束面试并保存录音，再离开面试室。切换浏览器标签页或其他应用不影响本页录音。'
  return false
})

function toBase64(blob: Blob): Promise<string> { return new Promise((resolve, reject) => { const reader=new FileReader(); reader.onloadend=()=>resolve(String(reader.result).split(',')[1] || ''); reader.onerror=()=>reject(reader.error || new Error('读取录音片段失败')); reader.readAsDataURL(blob) }) }
function formatTimestamp(ms: number): string { const total=Math.max(0,Math.round(ms/1000)); return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}` }
function microphoneErrorState(error: unknown): typeof microphoneState.value { const name=(error as {name?:string})?.name; if(name==='NotAllowedError'||name==='PermissionDeniedError'||name==='SecurityError')return 'denied'; if(name==='NotFoundError'||name==='DevicesNotFoundError')return 'not-found'; if(name==='NotReadableError'||name==='TrackStartError')return 'busy'; return 'error' }
async function refreshMicrophoneState(requestPermission = false) {
  if (!navigator.mediaDevices?.enumerateDevices) { microphoneState.value = 'unsupported'; return }
  try {
    if (requestPermission) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneDeviceId.value ? { deviceId: { exact: microphoneDeviceId.value } } : true })
      stream.getTracks().forEach(track => track.stop())
    }
    const devices = await navigator.mediaDevices.enumerateDevices()
    const inputs = devices.filter(device => device.kind === 'audioinput')
    audioInputs.value = inputs.map((device, index) => ({ deviceId: device.deviceId, label: device.label || `麦克风 ${index + 1}` }))
    audioInputCount.value = inputs.length
    if (!audioCapture) microphoneLabel.value = inputs.find(device => device.deviceId === microphoneDeviceId.value)?.label || '默认麦克风'
    if (!inputs.length) { microphoneState.value = 'not-found'; return }
    if (!requestPermission) {
      const permission = await navigator.permissions?.query({ name: 'microphone' as PermissionName }).catch(() => undefined)
      if (permission?.state === 'denied') { microphoneState.value = 'denied'; return }
      if (permission?.state === 'prompt') { microphoneState.value = 'prompt'; return }
    }
    microphoneState.value = 'ready'
  } catch (cause) { microphoneState.value = microphoneErrorState(cause) }
}
function onMicrophoneDeviceChange(){void refreshMicrophoneState(false)}
function normalizeQuestion(value: string): string { return value.replace(/\s+/g, ' ').trim() }
watch(currentQuestion, () => { questionRevision++ }, { flush: 'sync' })
const isFinalRound = computed(() => detail.value?.stage === 'final' || (detail.value?.round ?? 1) >= 2)
const referenceEntries = computed<Array<{ id: ReferenceGroup; label: string }>>(() => isFinalRound.value
  ? [
      { id: 'department', label: '业务面试表' },
      { id: 'hr', label: 'HR面试表' },
      { id: 'boss', label: 'BOSS面试表' },
    ]
  : [
      { id: 'ai', label: 'AI简历题' },
      { id: 'hr', label: 'HR面试表' },
      { id: 'department', label: '用人部门面试表' },
    ])
const bankDescription = computed(() => isFinalRound.value ? '10 道简历题、5 道 HR 题、5 道业务题、5 道 BOSS 题' : '10 道简历题、5 道 HR 题、5 道用人部门题')
function isCompleteQuestionBank(questions: GeneratedInterviewQuestion[]): boolean {
  return questions.length === (isFinalRound.value ? 25 : 20)
    && questions.filter(question => question.group === 'ai').length === 10
    && COMMON_QUESTION_GROUPS.filter(group => group.id !== 'boss' || isFinalRound.value).every(group =>
      questions.filter(question => question.group === group.id).length === 5
      && group.dimensions.every(dimension => questions.filter(question => question.group === group.id && question.dimension === dimension.id).length === 1))
}
async function generateResumeQuestions(force = false) {
  if (!detail.value || generatingQuestions.value || Object.values(refinementLoading.value).some(Boolean) || (force && ['starting', 'stopping', 'completed'].includes(status.value))) return
  const targetGroup = force ? referenceGroup.value : null
  questionGenerationGroup.value = targetGroup
  questionGenerationDeadlineSeconds.value = targetGroup ? (targetGroup === 'ai' ? 255 : 135) : (isFinalRound.value ? 615 : 495)
  generatingQuestions.value = true
  questionLoadError.value = ''
  questionGenerationNotice.value = ''
  questionGenerationSlow.value = false
  questionGenerationWarning.value = false
  const controller = new AbortController()
  questionGenerationController = controller
  questionGenerationSeconds.value = 0
  const elapsedTimer = setInterval(() => { questionGenerationSeconds.value++ }, 1000)
  const deadlineTimer = setTimeout(() => controller.abort(new Error('题库生成等待超时，已停止等待并保留原题库。请重试；若反复超时，请检查模型服务响应和 API 连接。')), questionGenerationDeadlineSeconds.value * 1000)
  let rejectAborted!: (reason: unknown) => void
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject })
  const onAbort = () => rejectAborted(controller.signal.reason)
  controller.signal.addEventListener('abort', onAbort, { once: true })
  const revision = questionRevision
  const slowTimer = setTimeout(() => { questionGenerationSlow.value = true }, 15_000)
  try {
    const saved = force ? null : await Promise.race([getInterviewQuestions(detail.value.id, controller.signal), aborted])
    if (disposed) return
    if (status.value === 'completed' && !saved?.questions.length) { questionLoadError.value = '已完成面试暂无已保存题库，不会自动重新生成。'; return }
    const result = saved?.questions.length ? saved : await Promise.race([targetGroup ? generateInterviewQuestions(detail.value.id, 10, true, controller.signal, targetGroup) : generateInterviewQuestions(detail.value.id, 10, true, controller.signal), aborted])
    if (disposed) return
    if (!result || !Array.isArray(result.questions) || !result.questions.length || !result.questions.every(question => typeof question.question === 'string' && question.question.trim())) {
      throw new Error('服务未返回可用题目，本次未替换原题库。请检查 API 和模型配置后重试。')
    }
    const complete = isCompleteQuestionBank(result.questions)
    if (targetGroup) {
      const targetQuestions = result.questions.filter(question => (question.group ?? 'ai') === targetGroup)
      const dimensions = COMMON_QUESTION_GROUPS.find(group => group.id === targetGroup)?.dimensions
      if (targetQuestions.length !== (targetGroup === 'ai' ? 10 : 5) || (dimensions && !dimensions.every(dimension => targetQuestions.filter(question => question.dimension === dimension.id).length === 1))) {
        throw new Error('服务返回的题目不完整，本次未替换原题库。请确认新版 API 已重启后重试。')
      }
      if (targetQuestions.some(question => (question.sourceEngine ?? result.engine) !== 'llm')) {
        throw new Error(`${result.generationWarning ? result.generationWarning + ' ' : ''}模型生成未成功，本次未替换原题库，请重试。`)
      }
      const unchangedQuestions = generatedQuestions.value.filter(question => (question.group ?? 'ai') !== targetGroup).map(question => ({ ...question, sourceEngine: question.sourceEngine ?? (questionEngine.value || undefined) }))
      const targetIndex = generatedQuestions.value.findIndex(question => (question.group ?? 'ai') === targetGroup)
      const insertIndex = targetIndex < 0 ? unchangedQuestions.length : generatedQuestions.value.slice(0, targetIndex).filter(question => (question.group ?? 'ai') !== targetGroup).length
      unchangedQuestions.splice(insertIndex, 0, ...targetQuestions.map(question => ({ ...question, sourceEngine: 'llm' as const })))
      generatedQuestions.value = unchangedQuestions
      questionEngine.value = unchangedQuestions.every(question => question.sourceEngine === 'llm') ? 'llm' : 'local_fallback'
    } else {
      if (force && !complete) throw new Error('服务返回的题目数量不完整，本次未替换原题库。请确认新版 API 已重启后重试。')
      generatedQuestions.value = result.questions
      questionEngine.value = result.engine
    }
    if (targetGroup) modificationSelection.value[targetGroup] = ''
    else modificationSelection.value = { ai: '', hr: '', department: '', boss: '' }
    // Preserve the active session question independently from reference-sheet edits.
    if (!sessionId.value && revision === questionRevision && result.questions[0]) currentQuestion.value = result.questions[0].question
    if (targetGroup) {
      questionGenerationNotice.value = '当前面试表已重新生成并保存，其他表保持不变。'
    } else if (!complete) {
      questionGenerationWarning.value = true
      questionGenerationNotice.value = `这是旧版题库，点击重新生成可升级为 ${bankDescription.value}。`
    } else if (result.engine === 'local_fallback') {
      questionGenerationWarning.value = true
      questionGenerationNotice.value = `${result.generationWarning ? result.generationWarning + ' ' : ''}模型生成未成功，当前展示 ${isFinalRound.value ? 25 : 20} 道本地规则参考题，并非 AI 随机生成。请检查当前企业的模型配置或 API 日志后重试。`
    } else if (force) {
      questionGenerationNotice.value = `题库已重新生成：${bankDescription.value}。`
    }
  } catch (cause) {
    if (!disposed) questionLoadError.value = controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason.message : describeApiFailure(cause, '根据简历生成问题失败').message
  } finally {
    clearTimeout(slowTimer)
    clearTimeout(deadlineTimer)
    clearInterval(elapsedTimer)
    controller.signal.removeEventListener('abort', onAbort)
    if (questionGenerationController === controller) questionGenerationController = undefined
    generatingQuestions.value = false
    questionGenerationSlow.value = false
  }
}
function cancelQuestionGeneration() {
  questionGenerationController?.abort(new Error('已取消本次题库生成，原题库保留，可重新生成。'))
}
function selectBankQuestion(question: string) {
  const group = referenceGroup.value
  if (!group || generatingQuestions.value || Object.values(refinementLoading.value).some(Boolean) || ['starting', 'stopping', 'completed'].includes(status.value)) return
  modificationSelection.value[group] = modificationSelection.value[group] === question ? '' : question
}
async function refineCurrentQuestionGroup(content: string) {
  const group = referenceGroup.value
  if (!group || !detail.value || ['starting', 'stopping', 'completed'].includes(status.value)) return

  const trimmed = content.trim()
  if (!trimmed || generatingQuestions.value || Object.values(refinementLoading.value).some(Boolean)) return
  if (trimmed.length > 1200) { refinementErrors.value[group] = '调整要求请控制在 1200 字以内。'; return }

  const messages = conversationMessages.value[group]
  const groupQuestions = generatedQuestions.value.filter(question => (question.group ?? 'ai') === group)
  const selection = modificationSelection.value[group]
  const target = selection ? { index: groupQuestions.findIndex(question => question.question === selection), question: selection } : undefined
  if (target && target.index < 0) { refinementErrors.value[group] = '所选题目不在已保存题库中，请先重新生成完整题库后再选择。'; return }
  if (messages.at(-1)?.role !== 'user' || messages.at(-1)?.content !== trimmed) messages.push({ role: 'user', content: trimmed })
  refinementErrors.value[group] = ''
  refinementLoading.value[group] = true

  const controller = new AbortController()
  refinementControllers.set(group, controller)
  const deadline = setTimeout(() => controller.abort(new Error('调整题目等待超时，原题库未替换，请稍后重试。')), 135_000)
  let rejectAborted!: (reason: unknown) => void
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject })
  const onAbort = () => rejectAborted(controller.signal.reason)
  controller.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const result = await Promise.race([refineInterviewQuestionGroup(detail.value.id, group, questionConversationContext(messages), controller.signal, target), aborted])
    if (disposed || controller.signal.aborted || refinementControllers.get(group) !== controller) return

    // The API returns the complete bank so that the target group can be replaced
    // while all other groups remain untouched. Do not change the live question.
    generatedQuestions.value = result.questions
    if (target) modificationSelection.value[group] = result.questions.filter(question => (question.group ?? 'ai') === group)[target.index]?.question ?? ''
    questionEngine.value = result.engine
    if (result.assistantMessage?.trim()) messages.push({ role: 'assistant', content: result.assistantMessage.trim() })
    questionGenerationNotice.value = target ? '已修改选中的这一题并保存，其他题目保持不变。' : '当前整张面试表已由模型调整并保存，其他表保持不变。'
    questionGenerationWarning.value = false
  } catch (cause) {
    if (!disposed && refinementControllers.get(group) === controller) refinementErrors.value[group] = controller.signal.aborted
      ? (controller.signal.reason as Error).message
      : describeApiFailure(cause, '调整面试题失败').message
  } finally {
    clearTimeout(deadline)
    controller.signal.removeEventListener('abort', onAbort)
    if (refinementControllers.get(group) === controller) {
      refinementControllers.delete(group)
      refinementLoading.value[group] = false
    }
  }
}
function cancelQuestionRefinement() {
  const group = referenceGroup.value
  if (group) refinementControllers.get(group)?.abort(new Error('已取消本次调整，原题库保留，可重试。'))
}
function closeReferenceDialog() {
  cancelQuestionRefinement()
  referenceGroup.value = null
}
 async function refreshExternalServices(): Promise<boolean> {
  try {
    const res = await apiClient.getJson<any>('/ready')
    externalServices.value = res.data?.checks?.externalServices ?? {}
    return funasrAvailable.value
  } catch {
    return false
  }
}
function watchExternalServices(): void {
  if (externalServicesTimer) clearInterval(externalServicesTimer)
  externalServicesTimer = setInterval(() => {
    void refreshExternalServices().then((available) => {
      if (available && externalServicesTimer) {
        clearInterval(externalServicesTimer)
        externalServicesTimer = undefined
      }
    })
  }, 2_000)
}
async function load() {
  loading.value = true
  try {
    const id = String(route.params.id ?? '')
    detail.value = await getInterview(id)
    const [candidates, jobs, active] = await Promise.all([
      apiClient.getJson<Array<{ id: string; fullName: string }>>('/candidates'),
      apiClient.getJson<Array<{ id: string; title: string }>>('/jobs'),
      findActiveLiveInterviewSession(id),
    ])
    candidateName.value = candidates.data.find(item => item.id === detail.value?.application.candidateId)?.fullName || detail.value.application.candidateId
    jobTitle.value = jobs.data.find(item => item.id === detail.value?.application.jobId)?.title || detail.value.application.jobId
    if (active) {
      sessionId.value = active.session.id
      currentQuestion.value = active.session.currentQuestion
      segments.value = active.segments
      analyses.value = Object.fromEntries(active.segments.flatMap(item => item.analysis ? [[item.id, item.analysis]] : []))
      recordingNowMs.value = Math.max(0, ...active.segments.map(item => item.endMs)) + ANSWER_SILENCE_MS
      for (const row of utterances.value) {
        if (applicableAnalyses.value[row.id]) analysisRetryState.restore(analysisSourceKey(analysisSourceSegments(row)))
      }
      status.value = active.session.status === 'completed' ? 'completed' : 'paused'
      elapsedSeconds.value = Math.floor(Math.max(0, ...active.segments.map(item => item.endMs)) / 1000)
      if (active.session.status === 'completed') await refreshFinalInterviewScore()
    }
    const available = await refreshExternalServices()
    if (!available) watchExternalServices()
    void generateResumeQuestions(false)
    void refreshMicrophoneState(false)
  } catch (cause) {
    error.value = describeApiFailure(cause, '读取面试信息失败').message
  } finally { loading.value = false }
}
async function startManual() { if(!detail.value || status.value==='starting' || status.value==='manual' || !recordingConsent.value)return; error.value=''; status.value='starting'; try { if(!sessionId.value){const session=await createLiveInterviewSession(detail.value.id);sessionId.value=session.id; if(currentQuestion.value.trim()) await updateLiveInterviewQuestion(session.id,currentQuestion.value.trim(),'manual')} status.value='manual'; if(!timer) timer=setInterval(()=>{elapsedSeconds.value++;recordingNowMs.value=Math.max(recordingNowMs.value,elapsedSeconds.value*1000)},1000) } catch(cause) { error.value=describeApiFailure(cause,'启动手动面试失败').message; status.value='failed' } }
async function addManualSegment() { const text=manualText.value.trim(); if(!sessionId.value || !text)return; try { const startMs=recordingNowMs.value; const segment=await addManualLiveSegment(sessionId.value,text,manualRole.value,startMs,startMs); segments.value.push(segment); recordingNowMs.value=segment.endMs+ANSWER_SILENCE_MS; manualText.value='' } catch(cause) { error.value=describeApiFailure(cause,'添加发言失败').message } }
function scheduleChunkRotation() {
  if(chunkRotationTimer)clearTimeout(chunkRotationTimer)
  chunkRotationTimer=setTimeout(()=>{ if(recorder?.state==='recording')recorder.stop() },TRANSCRIPTION_CHUNK_MS)
}
function queueAudioUploads() {
  const running = uploadPendingAudio().catch(handleUploadFailure)
  uploadQueue = Promise.all([uploadQueue, running]).then(() => undefined)
}
async function uploadPendingAudio(): Promise<void> {
  const results = await Promise.allSettled(([undefined, 'microphone', 'meeting'] as const).map(source => {
    const existing = sourceUploads.get(source)
    if (existing) return existing
    if (failedSources.has(source) || !pendingAudio.some(row => row.audioSource?.id === source)) return Promise.resolve()
    const running = uploadSourcePendingAudio(source).catch(cause => { failedSources.add(source); throw cause })
      .finally(() => { sourceUploads.delete(source) })
    sourceUploads.set(source, running)
    return running
  }))
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed) throw failed.reason
}
async function uploadSourcePendingAudio(source: InterviewAudioSource | undefined): Promise<void> {
  while (!disposed) {
    const chunk = pendingAudio.find(row => row.audioSource?.id === source)
    if (!chunk) return
    await audioPersistence.get(chunk.id)
    const encoded = await toBase64(chunk.audio)
    if (disposed) return
    if (getWorkspaceContext().revision !== workspace.revision) { uploadRetryable = false; throw new Error('企业或账号已切换，已停止上传原企业录音，请返回原账号处理。') }
    for (let attempt = 0; ; attempt++) {
      if (disposed) return
      if (getWorkspaceContext().revision !== workspace.revision) { uploadRetryable = false; throw new Error('企业或账号已切换，请返回原账号处理录音。') }
      try {
        const uploaded = await uploadLiveInterviewChunk(chunk.sessionId, encoded, chunk.contentType, chunk.offsetMs, chunk.id, chunk.streamingTranscript, chunk.audioSource, chunk.endMs)
        if (disposed || getWorkspaceContext().revision !== workspace.revision) return
        const knownIds = new Set(segments.value.map(segment => segment.id))
        segments.value.push(...uploaded.filter(segment => !knownIds.has(segment.id)))
        if (chunk.audioSource) sourceStreaming[chunk.audioSource.id].acknowledge(chunk.id)
        else Object.values(sourceStreaming).forEach(channel => channel.acknowledge(chunk.id))
        if (uploaded.length && !uploaded.some(segment => hasSubstantiveAnswer(segment.text))) audioWarning.value = '本段仅识别到零散短字，请检查输入音量和录音设备；原始录音已保存，不会将短字自动评分。'
        pendingAudio.splice(pendingAudio.indexOf(chunk), 1)
        audioPersistence.delete(chunk.id)
        pendingAudioCount.value = pendingAudio.length
        if (chunk.scope) void removePendingAudio(chunk.id).catch(() => { localCacheWarning.value = '本地缓存清理失败，请在当前浏览器完成剩余录音保存。' })
        uploadFailure = ''
        uploadRetryNotice.value = ''
        break
      } catch (cause) {
        uploadRetryable = cause instanceof ApiNetworkError || cause instanceof ApiClientError && (cause.status === 429 || (cause.status ?? 0) >= 500)
        if (uploadRetryable && attempt < 2 && !disposed) {
          uploadRetryNotice.value = 'API 连接暂时中断，正在重试保存录音…'
          await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000))
          if (disposed) return
          continue
        }
        uploadFailure = describeApiFailure(cause, '语音转写失败').message
        uploadRetryNotice.value = ''
        throw cause
      }
    }
  }
}
function handleUploadFailure(cause: unknown) {
  const failure = describeApiFailure(cause, '语音转写失败')
  uploadFailure = failure.message
  if (failure.code?.startsWith('FUNASR_')) {
    externalServices.value = { ...externalServices.value, funasr: 'unavailable' }
    watchExternalServices()
  }
  uploadRetryNotice.value = `${failure.message}。${status.value === 'recording' ? '录音继续，' : ''}待处理音频已保留，${uploadRetryable ? '稍后自动重试' : '请检查权限后重试保存'}。`
  if (uploadRetryable && !disposed && !uploadRetryTimer) uploadRetryTimer = setTimeout(() => { uploadRetryTimer = undefined; retryUploads() }, 15000)
}
function startRecorderChunk(stream: MediaStream) {
  const capture = audioCapture
  const tracks = capture?.sources ?? [{ source: 'microphone' as const, stream }]
  const settings = { microphone: { ...sourceSettings.value.microphone }, meeting: { ...sourceSettings.value.meeting } }
  const boundaries = new Map<InterviewAudioSource, { chunk: PendingInterviewAudio; ready: Promise<void> }>()
  const nextRecorder = createSourceRecorderGroup(tracks, {
    now: () => Math.max(0, performance.now() - recordingStartedAt),
    onBoundary: ({ source, offsetMs, endMs }) => {
      const chunk: PendingInterviewAudio = { id: 'audio-' + crypto.randomUUID(), scope: audioScope, sessionId: sessionId.value,
        audio: new Blob(), contentType: 'audio/webm', offsetMs, endMs, audioSource: settings[source] }
      sourceStreaming[source].pause()
      boundaries.set(source, { chunk, ready: sourceStreaming[source].commit(chunk) })
    },
    onChunk: ({ source, audio, endMs }) => {
      if (!sessionId.value) return
      recordingNowMs.value = Math.max(recordingNowMs.value, endMs)
      const contentType = (audio.type || 'audio/webm').split(';', 1)[0] || 'audio/webm'
      const { chunk, ready: transcriptReady } = boundaries.get(source)!
      chunk.audio = audio; chunk.contentType = contentType
      pendingAudio.push(chunk)
      pendingAudioCount.value = pendingAudio.length
      const cache = () => savePendingAudio(chunk).catch(() => { localCacheWarning.value = '本地录音缓存不可用，未上传音频仅保留在当前页面，请勿刷新或关闭。' })
      const initialText = JSON.stringify(chunk.streamingTranscript)
      const persisted = cache().then(async () => {
        await transcriptReady
        if (JSON.stringify(chunk.streamingTranscript) !== initialText) await cache()
      })
      audioPersistence.set(chunk.id, persisted)
      queueAudioUploads()
    },
    onStopped: () => {
      if (recorder === nextRecorder) recorder = undefined
      if (status.value === 'recording' && audioCapture === capture) startRecorderChunk(stream)
    },
    onError: () => {
      if (disposed || recorder !== nextRecorder) return
      status.value = 'paused'; clearRecordingTimers(); releaseWakeLock()
      audioWarning.value = '浏览器录音发生异常，已保留各路片段，请点击「继续」恢复。'
      nextRecorder.stop()
      releaseAudioCapture(); stopStreamingAudio()
    },
  })
  recorder = nextRecorder
  recorderStopWaiter = nextRecorder.done
  if (status.value === 'recording') tracks.forEach(track => { void sourceStreaming[track.source].resume() })
  scheduleChunkRotation()
}
function clearRecordingTimers() {
  if (timer) clearInterval(timer)
  if (chunkRotationTimer) clearTimeout(chunkRotationTimer)
  timer = undefined
  chunkRotationTimer = undefined
}
function releaseAudioCapture() {
  releaseWakeLock()
  audioCapture?.stop()
  audioCapture = undefined
  captureActive.value = false
  microphoneLevel.value = 0
  meetingLevel.value = 0
  soundDetected.value = { microphone: false, meeting: false }
  if (meetingState.value === 'connected') meetingState.value = 'ended'
}
watch([audioMode, microphoneDeviceId], () => {
  if (status.value !== 'paused') return
  // A changed source is acquired by the next Continue click, not by the selector.
  captureVersion++
  stopStreamingAudio()
  releaseAudioCapture()
  meetingState.value = 'idle'
  meetingLabel.value = ''
  microphoneLabel.value = audioInputs.value.find(device => device.deviceId === microphoneDeviceId.value)?.label || '默认麦克风'
  audioWarning.value = ''
}, { flush: 'sync' })
function sourceEnded(source: InterviewAudioSource) {
  if (disposed || (status.value !== 'recording' && status.value !== 'paused')) return
  status.value = 'paused'
  clearRecordingTimers()
  pauseStreamingAudio()
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  stopStreamingAudio()
  releaseAudioCapture()
  if (source === 'meeting') meetingState.value = 'ended'
  else microphoneState.value = 'not-found'
  audioWarning.value = `${source === 'meeting' ? '会议共享已停止' : '麦克风已断开'}，录音已暂停，已采集内容将继续保存。点击「继续」重新授权；不会自动改为仅麦克风录音。`
}
function beginRecordingClock() {
  recordingStartedAt = performance.now() - recordingNowMs.value
  timer = setInterval(() => { recordingNowMs.value = Math.round(performance.now() - recordingStartedAt); elapsedSeconds.value = Math.floor(recordingNowMs.value / 1000) }, 1000)
}
async function start() {
  if (!detail.value || !recordingConsent.value || ['starting', 'recording', 'stopping', 'completed'].includes(status.value)) return
  const version = ++captureVersion
  error.value = ''; audioWarning.value = ''; status.value = 'starting'
  clearRecordingTimers()
  stopStreamingAudio()
  releaseAudioCapture()
  meetingState.value = audioMode.value === 'meeting' ? 'authorizing' : 'idle'
  try {
    if (!window.MediaRecorder) throw new Error('当前浏览器不支持音频录音')
    // Called directly from the click: request screen sharing before any API await.
    const capture = await createInterviewAudioCapture(audioMode.value, {
      microphoneDeviceId: microphoneDeviceId.value,
      onLevels: levels => {
        if (disposed || version !== captureVersion) return
        microphoneLevel.value = levels.microphone; meetingLevel.value = levels.meeting
      },
      onSourceEnded: source => { if (version === captureVersion) sourceEnded(source) },
      onSoundCheck: detected => { if (!disposed && version === captureVersion) soundDetected.value = detected },
      onWarning: message => { if (!disposed && version === captureVersion) audioWarning.value = message },
    })
    if (disposed || version !== captureVersion) { capture.stop(); return }
    audioCapture = capture
    captureActive.value = true
    await recorderStopWaiter
    await uploadQueue
    if (disposed || version !== captureVersion) return
    microphoneState.value = 'ready'
    microphoneLabel.value = capture.microphoneLabel
    audioInputCount.value = Math.max(1, audioInputCount.value)
    meetingLabel.value = capture.meetingLabel
    if (audioMode.value === 'meeting') meetingState.value = 'connected'
    if (!sessionId.value) {
      const session = await createLiveInterviewSession(detail.value.id)
      if (disposed || version !== captureVersion) return
      sessionId.value = session.id
      if (currentQuestion.value.trim()) await updateLiveInterviewQuestion(session.id, currentQuestion.value.trim(), 'manual')
    }
    if (disposed || version !== captureVersion) return
    if (audioCapture !== capture || (capture.sources ?? [{ stream: capture.stream }]).some(row => row.stream.getAudioTracks().every(track => track.readyState !== 'live'))) {
      throw new Error('音频来源已断开，请重新共享后继续。')
    }
    beginRecordingClock()
    startRecorderChunk(capture.stream)
    status.value = 'recording'
    void requestWakeLock()
    if (pendingAudio.length) retryUploads()
    sourceWarnings.value = { microphone: '', meeting: '' }
    restartStreamingAudio()
  } catch (cause) {
    if (disposed || version !== captureVersion) return
    clearRecordingTimers()
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    releaseAudioCapture()
    stopStreamingAudio()
    if (cause instanceof InterviewAudioCaptureError) {
      if (cause.source === 'microphone') microphoneState.value = microphoneErrorState(cause.cause)
      if (audioMode.value === 'meeting') meetingState.value = 'failed'
    }
    error.value = cause instanceof Error ? cause.message : '无法启动面试录音'
    status.value = sessionId.value || pendingAudio.length ? 'paused' : 'failed'
    if (pendingAudio.length) error.value += '。未上传录音仍保留在当前页面，请勿刷新，点击「继续」重试。'
  }
}
async function togglePause() {
  if (pausing.value) return
  if (status.value === 'recording') {
    pausing.value = true
    status.value = 'paused'
    recordingNowMs.value = Math.max(recordingNowMs.value, Math.round(performance.now() - recordingStartedAt))
    clearRecordingTimers()
    releaseWakeLock()
    pauseStreamingAudio()
    audioCapture?.setPaused(true)
    // Commit a complete file, not a paused file whose timestamps include a long gap.
    try {
      if (recorder && recorder.state !== 'inactive') { const stopped = recorderStopWaiter; recorder.stop(); await stopped }
    } finally { pausing.value = false }
    return
  }
  if (status.value !== 'paused' || !recordingConsent.value) return
  // Preserve the click activation needed to authorize meeting audio sharing.
  if (!audioCapture) { await start(); return }
  await uploadQueue
  if (status.value !== 'paused') return
  if (audioCapture) {
    await recorderStopWaiter
    if (status.value !== 'paused' || !audioCapture) return
    audioCapture.setPaused(false)
    beginRecordingClock()
    startRecorderChunk(audioCapture.stream)
    status.value = 'recording'
    void recoverAudio()
    void Promise.all(Object.values(sourceStreaming).map(channel => channel.resume()))
  } else await start()
}
async function stop() {
  if (!sessionId.value || status.value === 'stopping' || status.value === 'completed') return
  status.value = 'stopping'
  pauseStreamingAudio()
  captureVersion++
  clearRecordingTimers()
  if (recorder && recorder.state !== 'inactive') { const stopped = recorderStopWaiter; recorder.stop(); await stopped }
  releaseAudioCapture()
  await uploadQueue

  stopStreamingAudio()
  try {
    if (pendingAudio.length) { retryUploads(); await uploadQueue }
    if (pendingAudio.length) throw new Error('仍有录音未保存，已停止采集但尚未结束面试，请重试保存后再次结束，请勿清理浏览器数据。')
    // Overall evaluation runs on the saved dialogue in the background, not the selected reference question.
    const ended = await endLiveInterviewSession(sessionId.value)
    status.value = 'completed'
    await router.push({ path: `/interviews/${route.params.id}`, query: { openSummary: '1', ...(ended.summaryGeneration?.reason ? { reviewNotice: ended.summaryGeneration.reason } : {}) } })
  } catch (cause) {
    error.value = describeApiFailure(cause, '保存面试会话或打开总结表失败').message
    status.value = pendingAudio.length ? 'paused' : 'failed'
  }
}

async function setRole(segment:LiveInterviewSegment & {sourceIds?:string[]},role:'interviewer'|'candidate'){ try { const updated=await correctLiveSegmentRole(segment.id,role,segment.sourceIds??[segment.id]); updated.forEach((item)=>{const existing=segments.value.find((row)=>row.id===item.id);if(existing)Object.assign(existing,item)}) } catch(cause) { error.value=describeApiFailure(cause,'修正说话人失败').message } }
async function analyze(segment: LiveUtterance) {
  if (analyzingId.value || editingRefinements.value[segment.id] || !hasSubstantiveAnswer(segment.text)) return false
  const sources = analysisSourceSegments(segment)
  const key = analysisSourceKey(sources)
  let retryImmediately = false
  analyzingId.value = segment.id
  delete analysisFeedback.value[segment.id]
  error.value = ''
  try {
    const result = await analyzeLiveSegment(segment.id, '', sources.map(source => source.id))
    const analysis = { ...result, sourceSegments: result.sourceSegments ?? sources }
    const current = utterances.value.find(row => row.id === segment.id)
    if (disposed) return false
    if (!current || !analysisMatchesUtterance(analysis, current)) {
      analysisRetryState.fail(key)
      analysisFeedback.value[segment.id] = { kind: 'stale', message: '回答内容或说话人已变更，请重新分析完整回答。' }
      retryImmediately = true
      return false
    }
    analyses.value = { ...analyses.value, [segment.id]: analysis }
    analysisRetryState.succeed(key)
    retryImmediately = true
    return true
  } catch (cause) {
    analysisRetryState.fail(key)
    error.value = describeApiFailure(cause, '回答分析失败').message
    if (!disposed) analysisFeedback.value[segment.id] = { kind: 'error', message: error.value }
    return false
  } finally {
    analyzingId.value = ''
    if (!disposed) {
      if (retryImmediately) analysisRetryTick.value++
      else analysisRetryTimer = setTimeout(() => { analysisRetryTick.value++ }, 2000)
    }
  }
}
watch([utterances, analysisRetryTick, loading], ([rows]) => {
  if (disposed || loading.value || ['stopping', 'completed'].includes(status.value) || analyzingId.value) return
  const candidate = rows.find(row => !editingRefinements.value[row.id] && row.final && row.role === 'candidate' && row.confidence >= .6
    && hasSubstantiveAnswer(row.text) && analysisRetryState.claim(analysisSourceKey(analysisSourceSegments(row))))
  if (candidate) void analyze(candidate)
}, { deep: true })
onMounted(async()=>{
  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener('online', online)
  window.addEventListener('focus', recoverAudio)
  document.addEventListener('visibilitychange', recoverAudio)
  await load()
  if (disposed) return
  if (sessionId.value && status.value !== 'completed') {
    try {
      const restored = await restorePendingAudio(audioScope, sessionId.value)
      if (disposed) return
      pendingAudio.push(...restored); pendingAudioCount.value = pendingAudio.length
      recordingNowMs.value = Math.max(recordingNowMs.value, ...restored.map(row => row.endMs))
      if (restored.length) { uploadRetryNotice.value = '已恢复本机待处理录音，正在重试保存。'; retryUploads() }
    } catch { localCacheWarning.value = '本地录音缓存不可用，未上传音频仅保留在当前页面，请勿刷新或关闭。' }
  }
  void refreshMicrophoneState(false)
  navigator.mediaDevices?.addEventListener?.('devicechange',onMicrophoneDeviceChange)
})
onUnmounted(() => {
  disposed = true
  questionGenerationController?.abort(new Error('页面已关闭'))
  for (const controller of refinementControllers.values()) controller.abort(new Error('页面已关闭'))
  refinementControllers.clear()
  captureVersion++
  status.value = 'stopping'
  clearRecordingTimers()
  releaseWakeLock()
  if (uploadRetryTimer) clearTimeout(uploadRetryTimer)
  window.removeEventListener('beforeunload', beforeUnload)
  window.removeEventListener('online', online)
  window.removeEventListener('focus', recoverAudio)
  document.removeEventListener('visibilitychange', recoverAudio)
  if (analysisRetryTimer) clearTimeout(analysisRetryTimer)
  if (externalServicesTimer) clearInterval(externalServicesTimer)
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  releaseAudioCapture()
  stopStreamingAudio()
  Object.values(sourceStreaming).forEach(channel => channel.dispose())
  navigator.mediaDevices?.removeEventListener?.('devicechange', onMicrophoneDeviceChange)
})
</script>

<template>
  <div class="page live-page">
    <PageHeader class="live-page-header" title="AI 面试室" :description="`${candidateName || '候选人'} · ${jobTitle || '岗位加载中'}`">
      <template #center>
        <nav v-if="!loading && detail" class="reference-actions" aria-label="面试参考表">
          <ApplicationResumeButton :application-id="detail.applicationId" />
          <button class="btn btn-ghost btn-sm audio-recordings-button" type="button" aria-haspopup="dialog" :aria-expanded="audioDialogOpen" @click="openAudio()">查看原音频</button>
          <button v-for="entry in referenceEntries" :key="entry.id" class="btn btn-ghost btn-sm" type="button" :data-reference="entry.id" aria-haspopup="dialog" :aria-expanded="referenceGroup === entry.id" @click="referenceGroup = entry.id">{{ entry.label }}</button>
        </nav>
      </template>
      <template #default>
      <div class="live-header-actions">
        <template v-if="!loading && detail">
          <div class="session-summary">
            <span class="session-state"><span class="record-dot" :class="{ active: status === 'recording' || status === 'manual' }"></span><strong>{{ statusLabel }}</strong></span>
            <span class="session-elapsed">{{ elapsed }}</span>
            <span class="microphone-status"><span class="microphone-dot" :class="`state-${microphoneState}`"></span>麦克风：{{ microphoneStatusLabel }}</span>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="microphoneState === 'unsupported' || audioSettingsLocked" @click="refreshMicrophoneState(true)">检查麦克风</button>
          </div>
          <div class="inline-actions">
            <button v-if="status === 'idle' || status === 'failed'" class="btn btn-primary" type="button" :disabled="!recordingConsent" @click="start">开始面试</button>
            <button v-if="!funasrAvailable && (status === 'idle' || status === 'failed') && !pendingAudioCount && !captureActive" class="btn btn-ghost" type="button" :disabled="!recordingConsent" @click="startManual">仅手动记录</button>
            <button v-if="status === 'recording' || status === 'paused'" class="btn btn-ghost" type="button" :disabled="pausing || (status === 'paused' && !recordingConsent)" @click="togglePause">{{ status === 'paused' ? '继续' : '暂停' }}</button>
            <button v-if="status === 'recording' || status === 'paused' || status === 'manual'" class="btn btn-ghost" type="button" @click="stop">结束面试</button>
          </div>
        </template>
        <button class="btn btn-ghost" type="button" @click="router.push(`/interviews/${route.params.id}`)">返回面试详情</button>
      </div>
      </template>
    </PageHeader>
    <div v-if="loading" class="loading-note">正在准备面试室...</div>
    <div v-else-if="!detail" class="error-note" role="alert">{{ error || '无法读取面试信息' }}</div>
    <template v-else>
      <div v-if="error" class="error-note" role="alert">{{ error }}</div>
      <div v-if="uploadRetryNotice" class="loading-note" role="status">{{ uploadRetryNotice }}</div>
      <div v-if="pendingAudioCount || localCacheWarning" class="loading-note" role="status">
        <span v-if="pendingAudioCount">待保存录音：{{ pendingAudioCount }} 段</span>
        <span v-if="localCacheWarning"> {{ localCacheWarning }}</span>
        <button v-if="pendingAudioCount" class="btn btn-ghost btn-sm" type="button" @click="retryUploads">重试保存</button>
      </div>
      <button v-if="status === 'recording' && (audioWarning || streamingWarning || streamingState !== 'ready')" class="btn btn-ghost btn-sm" type="button" @click="reconnectAudio">{{ streamingState === 'ready' ? '恢复音频' : '重新连接' }}</button>
      <section v-if="status !== 'completed'" class="audio-capture-settings audio-settings-toolbar" aria-label="面试音频采集设置">
        <div class="audio-setting-row">
          <label class="audio-setting-field"><span>采集方式</span>
            <select v-model="audioMode" aria-label="音频采集方式" :disabled="audioSettingsLocked">
              <option value="microphone">现场面试：仅麦克风</option>
              <option value="meeting">线上面试：麦克风 + 会议声音</option>
            </select>
          </label>
          <label class="audio-setting-field"><span>录音输入</span>
            <select v-model="microphoneDeviceId" aria-label="录音输入设备" :disabled="audioSettingsLocked">
              <option value="">系统默认麦克风</option>
              <option v-for="device in audioInputs.filter(item => item.deviceId)" :key="device.deviceId" :value="device.deviceId">{{ device.label }}</option>
            </select>
          </label>
          <label class="recording-consent"><input v-model="recordingConsent" type="checkbox" :disabled="audioSettingsLocked" /><span>已告知参与者并取得录音、转写及 AI 辅助分析同意</span></label>
          <span class="audio-mode-badge">{{ audioMode === 'meeting' ? '双路采集' : '仅麦克风' }}</span>
        </div>
        <div class="source-role-settings">
          <div v-for="source in activeSources" :key="source" class="source-role-row">
            <strong>{{ sourceLabels[source] }}</strong>
            <label><span>确认角色</span><select v-model="sourceSettings[source].role" :aria-label="sourceLabels[source] + '角色'" :disabled="audioSettingsLocked">
              <option value="unknown">尚未确认</option><option value="interviewer">面试官</option><option value="candidate">候选人</option>
            </select></label>
            <label class="source-multiple"><input v-model="sourceSettings[source].multipleSpeakers" type="checkbox" :aria-label="sourceLabels[source] + '包含多人'" :disabled="audioSettingsLocked">该路包含多人</label>
            <small v-if="sourceSettings[source].multipleSpeakers && sourceSettings[source].role !== 'unknown'" class="source-multiple">多人音轨需逐人确认角色；仅一人时请取消勾选。</small>
          </div>
        </div>
        <div class="audio-source-status" aria-live="polite">
          <div class="audio-source">
            <span class="audio-source-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></svg></span>
            <div class="audio-source-content"><strong>麦克风<span v-if="captureActive" class="audio-source-state" :class="{ connected: soundDetected.microphone }">{{ soundDetected.microphone ? '已检测到声音' : '等待试音' }}</span></strong><span :title="microphoneLabel">{{ microphoneLabel }}</span></div>
            <meter :value="microphoneLevel" min="0" max="1" aria-label="麦克风输入音量" />
          </div>
          <div v-if="audioMode === 'meeting'" class="audio-source">
            <span class="audio-source-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M12 16v4m-4 0h8M8 9v2m4-4v6m4-4v2" /></svg></span>
            <div class="audio-source-content"><strong>会议音频<span class="audio-source-state" :class="{ connected: meetingState === 'connected' && soundDetected.meeting }">{{ meetingState === 'connected' ? (soundDetected.meeting ? '已检测到声音' : '等待对方试音') : meetingStatusLabel }}</span></strong><span v-if="meetingLabel" :title="meetingLabel">{{ meetingLabel }}</span></div>
            <meter :value="meetingLevel" min="0" max="1" aria-label="会议音频输入音量" />
          </div>
        </div>
        <p v-if="captureActive && activeSources.some(source => !soundDetected[source])" class="audio-warning" role="status">请双方依次说一句话，分别确认各路有声音。音源不等于角色；多人共用同一路时，请结合原音频确认说话人。</p>
        <p v-if="!funasrAvailable" class="audio-warning">{{ status === 'manual' ? '当前为手动记录，不会采集麦克风或会议音频。' : '转写服务暂不可用，开始面试仍会录音并缓存，服务恢复后自动重试。' }}</p>
        <p v-if="audioWarning" class="audio-warning" role="alert">{{ audioWarning }}</p>
        <p v-if="streamingWarning" class="audio-warning" role="alert">{{ streamingWarning }}</p>
      </section>
      <div v-if="externalServiceWarning && status !== 'completed'" class="list-muted external-service-warning" role="note">{{ externalServiceWarning }}</div>
      <InterviewAudioDialog v-if="audioDialogOpen" :interview-id="interviewId" :candidate="candidateName" :job="jobTitle" :pending-count="pendingAudioCount" :recording="captureActive" :initial-session-id="audioPlaybackSession" :start-ms="audioPlaybackStartMs" @close="audioDialogOpen = false" />
      <InterviewQuestionReferenceDialog v-if="referenceGroup" :key="referenceGroup" :group="referenceGroup" :candidate="candidateName" :job="jobTitle" :questions="generatedQuestions" :current-question="modificationSelection[referenceGroup]" :round="detail.round" :engine="questionEngine" :follow-ups="followUpQuestions" :disabled="status === 'starting' || status === 'stopping' || status === 'completed'" :messages="conversationMessages[referenceGroup]" :conversation-blocked="generatingQuestions || Object.entries(refinementLoading).some(([group, loading]) => group !== referenceGroup && loading)" :conversation-loading="refinementLoading[referenceGroup]" :conversation-error="refinementErrors[referenceGroup]" @close="closeReferenceDialog" @select="selectBankQuestion" @send="refineCurrentQuestionGroup" @cancel="cancelQuestionRefinement">
        <template #toolbar>
          <div class="question-bank-toolbar" :aria-busy="generatingQuestions">
            <ApplicationResumeButton :application-id="detail.applicationId" />
            <button class="btn btn-ghost btn-sm regenerate-question-bank" type="button" :disabled="generatingQuestions || Object.values(refinementLoading).some(Boolean) || status === 'starting' || status === 'stopping' || status === 'completed'" @click="generateResumeQuestions(true)">
              <span v-if="generatingQuestions" class="generation-spinner" aria-hidden="true"></span>{{ generatingQuestions ? (questionGenerationGroup ? '正在生成当前表…' : '正在生成面试题…') : '重新生成当前表' }}
            </button>
            <button v-if="generatingQuestions" class="btn btn-ghost btn-sm cancel-question-generation" type="button" @click="cancelQuestionGeneration">取消生成</button>
            <p v-if="generatingQuestions" class="question-bank-feedback" role="status">{{ questionGenerationSlow ? '模型仍在生成，原题库保留，可取消后重试。' : (questionGenerationGroup ? '正在生成当前面试表，其他表保持不变。' : '正在加载面试题，简历题分批生成。') }} 已等待 {{ questionGenerationSeconds }} 秒，最长等待 {{ questionGenerationDeadlineSeconds }} 秒。</p>
            <p v-if="questionLoadError" class="question-bank-feedback generation-error" role="alert">{{ questionLoadError }}</p>
            <p v-else-if="questionGenerationNotice" class="question-bank-feedback" :class="questionGenerationWarning ? 'generation-warning' : 'generation-success'" :role="questionGenerationWarning ? 'alert' : 'status'">{{ questionGenerationNotice }}</p>
            <p v-if="status === 'completed'" class="question-bank-feedback">面试已结束，只能浏览已保存题库，不再重新生成。</p>
          </div>
        </template>
      </InterviewQuestionReferenceDialog>
      <main class="interview-room" :class="{ 'completed-room': status === 'completed' }">
        <section class="room-panel transcript-panel">
          <header><span>实时转写</span><small>{{ streamingState === 'ready' ? '流式识别中' : streamingState === 'loading' ? '正在加载识别模型' : streamingState === 'connecting' ? '正在连接流式识别' : streamingState === 'unavailable' ? '流式不可用，使用分段识别' : `${utterances.length} 轮发言` }}</small></header>
          <div v-if="status === 'manual'" class="manual-entry"><select v-model="manualRole"><option value="candidate">候选人回答</option><option value="interviewer">面试官提问</option></select><textarea v-model="manualText" rows="3" placeholder="输入本轮发言内容" /><button class="btn btn-primary btn-sm" type="button" :disabled="!manualText.trim()" @click="addManualSegment">添加发言</button></div>
          <div ref="transcriptList" class="transcript-list" @scroll="trackTranscriptScroll">
            <div v-if="!utterances.length && !streamingText" class="room-empty">暂无转写记录</div>
            <article v-for="segment in utterances" :key="segment.id" class="utterance" :data-role="segment.role">
              <div class="utterance-head"><strong>{{ segment.role==='candidate'?'候选人':segment.role==='interviewer'?'面试官':'待确认' }}<span class="utterance-source">{{ segment.audioSource ? sourceLabels[segment.audioSource] : '历史记录 / 手动记录' }}</span></strong><small>{{ formatTimestamp(segment.startMs) }}–{{ formatTimestamp(segment.endMs) }} · {{ segment.final?'发言已结束':'正在继续...' }}</small></div>
              <div class="utterance-identity"><span>{{ speakerLabel(segment) }}</span><span v-if="segment.sourceIds.length > 1">已合并 {{ segment.sourceIds.length }} 段</span><span v-if="segment.role !== 'unknown' && segment.confidence < 1">角色为自动识别，可人工校正</span><span v-if="segment.overlapping" class="overlap-badge">重叠发言</span></div>
              <template v-if="applicableAnalyses[segment.id]?.transcriptRefinement">
                <TranscriptRefinementEditor :segment-id="segment.id" :refinement="applicableAnalyses[segment.id]!.transcriptRefinement!" :source-segments="analysisSourceSegments(segment)" :label="segment.role === 'interviewer' ? '整理后的发言' : '整理后的回答'" :disabled="analyzingId === segment.id" @editing-change="editingRefinements[segment.id] = $event" @saved="analyses[segment.id] = { ...analyses[segment.id]!, transcriptRefinement: $event }" />
                <details class="answer-original">
                  <summary>原始转写</summary>
                  <p>{{ segment.sourceSegments.map(source => source.text).join('\n') }}</p>
                </details>
                <details v-if="applicableAnalyses[segment.id]!.transcriptRefinement!.corrections.length" class="answer-corrections">
                  <summary>纠错记录 ({{ applicableAnalyses[segment.id]!.transcriptRefinement!.corrections.length }})</summary>
                  <p v-for="(correction, index) in applicableAnalyses[segment.id]!.transcriptRefinement!.corrections" :key="index"><del>{{ correction.original }}</del> → {{ correction.corrected }}</p>
                </details>
              </template>
              <p v-else>{{ segment.text }}</p>
              <details v-for="source in segment.sourceSegments.filter(row => row.transcriptComparison)" :key="source.id" class="transcript-comparison">
                <summary>识别版本对照 · {{ formatTimestamp(source.transcriptComparison!.startMs) }}–{{ formatTimestamp(source.transcriptComparison!.endMs) }}</summary>
                <strong>流式识别{{ source.transcriptComparison!.selectedSource === 'streaming' ? ' · 当前采用' : '' }}{{ source.transcriptComparison!.streamingComplete ? '' : ' · 未完成' }}</strong>
                <p>{{ source.transcriptComparison!.streamingText }}</p>
                <strong>录音分段识别{{ source.transcriptComparison!.selectedSource === 'offline' ? ' · 当前采用' : '' }}</strong>
                <p>{{ source.transcriptComparison!.offlineText }}</p>
              </details>
              <small v-if="segment.role === 'unknown' && segment.speakerId?.includes(':stream_')" class="stream-source">流式全文保留 · 说话人待确认</small>
              <div class="utterance-actions"><button v-if="!segment.speakerId?.startsWith('manual_')" type="button" title="从本段开始回听整场录音" @click="openAudio(segment.sessionId, segment.startMs)">回听本段</button><button type="button" :disabled="editingRefinements[segment.id]" title="标记为面试官" @click="setRole(segment,'interviewer')">面试官</button><button type="button" :disabled="editingRefinements[segment.id]" title="标记为候选人" @click="setRole(segment,'candidate')">候选人</button><button v-if="hasSubstantiveAnswer(segment.text) && segment.final && segment.role!=='unknown' && segment.confidence>=.6" class="analyze-button" type="button" :disabled="!!analyzingId || editingRefinements[segment.id]" :aria-busy="analyzingId === segment.id" :title="editingRefinements[segment.id] ? '请先保存或取消编辑' : analyzingId && analyzingId !== segment.id ? '请等待当前回答分析完成' : segment.role === 'interviewer' ? '整理面试官完整发言，不参与候选人评分' : '分析整段回答'" @click="analyze(segment)">{{ analyzingId===segment.id?'分析中...':analysisFeedback[segment.id]?'重新分析完整回答':'分析完整回答' }}</button></div>
              <div v-if="analyzingId === segment.id" class="answer-analysis-feedback" role="status">正在整理并分析完整回答…</div>
              <div v-else-if="analysisFeedback[segment.id]" class="answer-analysis-feedback" :class="analysisFeedback[segment.id]!.kind" :role="analysisFeedback[segment.id]!.kind === 'error' ? 'alert' : 'status'">{{ analysisFeedback[segment.id]!.message }}</div>
              <details v-if="segment.sourceSegments.length > 1" class="utterance-fragments">
                <summary>原始分段 ({{ segment.sourceSegments.length }})</summary>
                <div v-for="source in segment.sourceSegments" :key="source.id" class="utterance-fragment" :data-segment-id="source.id">
                  <small>{{ formatTimestamp(source.startMs) }}–{{ formatTimestamp(source.endMs) }}</small>
                  <p>{{ source.text }}</p>
                  <div class="utterance-actions">
                    <button v-if="!source.speakerId?.startsWith('manual_')" type="button" title="回听此原始分段" @click="openAudio(source.sessionId, source.startMs)">回听分段</button>
                    <button type="button" :disabled="editingRefinements[segment.id]" title="仅将此分段标记为面试官" @click="setRole(source, 'interviewer')">面试官</button>
                    <button type="button" :disabled="editingRefinements[segment.id]" title="仅将此分段标记为候选人" @click="setRole(source, 'candidate')">候选人</button>
                  </div>
                </div>
              </details>
            </article>
            <template v-if="status === 'recording' || status === 'paused' || status === 'stopping'">
              <div v-for="source in activeSources.filter(source => sourceText[source])" :key="source" class="stream-preview" :data-source="source"><strong>{{ sourceLabels[source] }} · 识别中</strong><p>{{ sourceText[source] }}</p></div>
            </template>
          </div>
        </section>
        <LiveDialogueAnalysisPanel :interview-id="interviewId" :session-id="sessionId" :completed="status === 'completed'" :segments="segments" :analyses="candidateAnalyses" :phase-score="finalInterviewScore" :phase-formula="finalInterviewScoreFormula" />
      </main>
    </template>
  </div>
</template>

<style scoped>
.transcript-comparison{margin-top:8px;font-size:12px;color:var(--text-muted)}
.transcript-comparison summary{cursor:pointer;padding:4px 0}
.transcript-comparison strong{display:block;margin-top:8px;font-size:12px}
.transcript-comparison p{white-space:pre-wrap;overflow-wrap:anywhere}
.answer-original p,.answer-corrections p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8}
.answer-original,.answer-corrections{margin-top:8px;font-size:12px;color:var(--text-muted)}
.answer-original summary,.answer-corrections summary{cursor:pointer;padding:4px 0}
.answer-original p,.answer-corrections p{margin:6px 0}
.answer-corrections del{color:#a04444}
.utterance-fragments{margin-top:10px;border-top:1px solid var(--border);font-size:12px}
.utterance-fragments summary{padding:10px 0;cursor:pointer;color:var(--text-muted)}
.utterance-fragment{padding:10px 0;border-top:1px dashed var(--border);min-width:0}
.utterance-fragment>small{color:var(--text-muted)}
.utterance-fragment p{white-space:pre-wrap;overflow-wrap:anywhere}
.source-role-settings{display:grid;gap:8px;padding:12px 0;border-top:1px solid var(--border)}
.source-role-row{display:flex;align-items:center;flex-wrap:wrap;gap:10px 18px;font-size:12px}.source-role-row>strong{min-width:86px}.source-role-row label{display:flex;align-items:center;gap:8px}.source-role-row select{min-width:120px;max-width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;background:white}.source-multiple{color:var(--text-muted)}
.utterance-source{display:inline-block;margin-left:8px;font-size:11px;font-weight:400;color:var(--text-muted)}.utterance-head{flex-wrap:wrap;gap:6px}.utterance-head small{overflow-wrap:anywhere}
.question-bank-toolbar{margin:12px 14px;display:flex;flex-direction:column;gap:8px}.regenerate-question-bank{width:100%;display:flex;justify-content:center;align-items:center;gap:7px;white-space:normal}.question-bank-feedback{margin:0;padding:8px 10px;border-radius:7px;background:#f1f7fc;color:#567389;font-size:12px;line-height:1.6;overflow-wrap:anywhere}.question-bank-feedback p{margin:0 0 7px}.generation-error{background:#fff0f0;color:#b33a45}.generation-warning{background:#fff8e9;color:#967019}.generation-success{background:#ecf8f2;color:#278064}.generation-spinner{width:12px;height:12px;flex-shrink:0;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:question-bank-spin .8s linear infinite}@keyframes question-bank-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.generation-spinner{animation:none}}

.audio-settings-toolbar{display:grid;grid-template-columns:minmax(0,1fr) minmax(200px,320px);align-items:center;gap:10px 20px;margin-bottom:16px;padding:0;border:0;background:transparent;box-shadow:none;min-width:0}
.audio-source-icon svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.audio-mode-badge{padding:3px 9px;border-radius:6px;background:var(--primary-bg);color:var(--primary);font-size:11px;white-space:nowrap}
.audio-setting-row{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;min-width:0}
.audio-setting-field{display:flex;align-items:center;gap:8px;flex:1 1 260px;min-width:0;font-size:12px;color:var(--muted)}
.audio-setting-field>span{flex:none}
.audio-setting-field select{width:100%;min-width:0;height:38px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:#fff;color:var(--text);font-size:13px;transition:border-color .15s,box-shadow .15s}
.audio-setting-field select:focus-visible{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-bg)}
.audio-setting-field select:disabled{background:#f8fafc;color:var(--muted);cursor:not-allowed}
.recording-consent{display:flex;align-items:center;gap:8px;flex:1.2 1 320px;min-width:0;min-height:38px;padding:0;background:transparent;font-size:12px;line-height:1.6;color:#526c80;cursor:pointer}
.recording-consent input{flex:none;width:15px;height:15px;margin:0;accent-color:var(--primary)}
.audio-settings-toolbar .source-role-settings{display:flex;flex-wrap:wrap;gap:8px 24px;min-width:0;padding:0;border:0}
.audio-settings-toolbar .source-role-row{min-width:0;gap:8px 12px;min-height:36px}
.audio-settings-toolbar .source-role-row>strong{min-width:0;color:#526c80;font-weight:500}
.audio-settings-toolbar .source-role-row select{height:34px;border-radius:8px;padding:0 8px}
.audio-settings-toolbar .source-multiple{line-height:1.6}
.audio-settings-toolbar .source-multiple input{margin:0;accent-color:var(--primary)}
.audio-source-status{display:grid;gap:8px;min-width:0;margin:0;padding:0;border:0}
.audio-source{display:flex;align-items:center;gap:8px;min-width:0;min-height:36px;padding:0;border:0;background:transparent}
.audio-source-icon{display:flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;color:var(--primary)}
.audio-source-content{display:grid;gap:1px;flex:1;min-width:0}
.audio-source-content strong{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:500;color:var(--text)}
.audio-source-content>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--muted)}
.audio-source-state{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--muted);font-weight:400;white-space:nowrap}
.audio-source-state::before{content:'';width:5px;height:5px;border-radius:50%;background:#a5b5c3}
.audio-source-state.connected{color:#21916e}.audio-source-state.connected::before{background:#38b98a}
.audio-source meter{flex:none;width:88px;height:8px;border:0;border-radius:999px;overflow:hidden}
.audio-source meter::-webkit-meter-bar{height:8px;border:0;border-radius:999px;background:#e9eff4;box-shadow:none}
.audio-source meter::-webkit-meter-optimum-value{border-radius:999px;background:#38b98a}
.audio-source meter::-moz-meter-bar{border-radius:999px;background:#38b98a}
.audio-warning{margin:12px 0 0;padding:9px 12px;border:1px solid #ffedd5;border-radius:8px;background:#fff7ed;color:#9a3412;font-size:12px;line-height:1.6}
.audio-settings-toolbar .audio-warning{grid-column:1/-1;margin:0}
@media(max-width:1000px){.audio-settings-toolbar{grid-template-columns:minmax(0,1fr)}.audio-source-status{grid-template-columns:repeat(2,minmax(0,1fr))}.recording-consent{flex-basis:calc(100% - 100px)}}
@media(max-width:600px){.audio-setting-row{gap:10px}.audio-setting-field{flex-basis:100%}.recording-consent{flex-basis:calc(100% - 90px)}.audio-source-status{grid-template-columns:minmax(0,1fr)}.audio-source meter{width:72px}}

.live-page{max-width:none}.live-header-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:10px;min-width:0}.session-summary{display:flex;align-items:center;flex-wrap:wrap;gap:10px;color:#475569;font-size:12px}.session-state{display:inline-flex;align-items:center;gap:7px}.session-elapsed{font-variant-numeric:tabular-nums;font-weight:600;color:var(--text)}.record-dot{width:9px;height:9px;border-radius:50%;background:#94a3b8}.record-dot.active{background:#dc2626;box-shadow:0 0 0 4px #fee2e2}.microphone-status{color:#475569;font-size:12px}.microphone-dot{width:8px;height:8px;border-radius:50%;background:#94a3b8}.microphone-dot.state-ready{background:#16a34a}.microphone-dot.state-prompt{background:#d97706}.microphone-dot.state-denied,.microphone-dot.state-busy,.microphone-dot.state-error{background:#dc2626}.btn-sm{padding:4px 8px;font-size:11.5px}.interview-room{display:grid;grid-template-columns:minmax(240px,.8fr) minmax(360px,1.4fr) minmax(280px,1fr);gap:12px;height:calc(100vh - 220px);min-height:480px}.room-panel{min-width:0;min-height:0;border:1px solid var(--border);background:#fff;display:flex;flex-direction:column;overflow:hidden}.question-panel,.analysis-panel{overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.transcript-panel{overflow:hidden}.transcript-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.room-panel>header{display:flex;justify-content:space-between;gap:10px;padding:13px 14px;border-bottom:1px solid var(--border);font-weight:700}.room-panel>header small{font-weight:400;color:var(--text-muted)}.external-service-warning{padding:8px 12px;border:1px solid var(--border);background:#fff;margin-bottom:10px;white-space:normal;overflow-wrap:anywhere;line-height:1.5}.question-panel .consent-note{margin-top:auto}.generated-questions{margin:0 14px 14px;border:1px solid var(--border);background:#fff}.generated-head{width:100%;display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 12px;border:0;background:transparent;text-align:left;cursor:pointer}.generated-head>span:first-child{display:grid;gap:2px}.generated-head small{color:var(--text-muted)}.generated-toggle{flex:none;color:#475569;font-size:12px}.generated-list{max-height:min(46vh,460px);overflow-y:auto}.generated-questions article{padding:11px 12px;border-bottom:1px solid #edf2f7}.generated-questions article:last-child{border-bottom:0}.question-number{display:inline-flex;margin-bottom:6px;padding:2px 7px;border-radius:5px;background:#eef2ff;color:#4338ca;font-size:11px;font-weight:600}.generated-questions p{margin:0 0 6px;line-height:1.6}.generated-questions article small{display:block;color:var(--text-muted);line-height:1.5}.generated-questions .btn{margin-top:8px}.next-question,.consent-note,.analysis-block{margin:0 14px 14px;padding:12px;background:#f8fafc;border:1px solid var(--border)}.next-question span{font-size:12px;color:var(--text-muted)}.next-question p{line-height:1.6}.consent-note{margin-top:auto;font-size:12px;color:var(--text-muted)}.manual-entry{display:grid;gap:8px;padding:12px;border-bottom:1px solid var(--border);background:#fff}.manual-entry textarea{resize:vertical}.manual-entry .btn{justify-self:end}.stream-preview{margin:12px 12px 0;padding:10px 12px;max-height:min(32vh,280px);overflow-y:auto;overscroll-behavior:contain;border:1px solid #99f6e4;background:#f0fdfa;color:#134e4a}.stream-preview strong{font-size:12px}.stream-preview p{margin:6px 0 0;line-height:1.6;white-space:pre-wrap}.transcript-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:4px 14px;display:block;white-space:normal;overflow-wrap:anywhere}.utterance{padding:12px 4px;border-bottom:1px solid #e2e8f0;background:transparent}.utterance:last-child{border-bottom:0}.utterance[data-role="interviewer"] .utterance-head strong{color:#2563eb}.utterance[data-role="candidate"] .utterance-head strong{color:#0f766e}.utterance-head{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}.utterance-identity{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;font-size:11px;color:#64748b}.overlap-badge{color:#9a3412;background:#fff7ed;padding:0 5px;border-radius:3px}.utterance[data-role="interviewer"]{border-left:3px solid #bfdbfe;padding-left:12px}.utterance[data-role="candidate"]{border-left:3px solid #99f6e4;padding-left:12px}.utterance p{margin:7px 0;line-height:1.6}.utterance-actions{display:flex;gap:6px;flex-wrap:wrap}.utterance-actions button{border:1px solid var(--border);background:#fff;padding:5px 8px;cursor:pointer}.utterance-actions .analyze-button{background:#0f766e;color:#fff;border-color:#0f766e}.analysis-panel{padding-bottom:14px}.final-score{display:grid;gap:6px;margin:14px;padding:14px;border:1px solid #bfdbfe;border-radius:8px;background:#eff6ff}.final-score strong{font-size:28px;color:#1d4ed8}.final-score small{color:var(--text-muted);line-height:1.5}.confidence,.score-list>div{display:flex;justify-content:space-between;gap:12px}.confidence{padding:14px}.analysis-summary{padding:0 14px;line-height:1.65}.score-list{display:grid;gap:8px;padding:0 14px 14px}.score-list>div{display:grid;grid-template-columns:1fr auto}.score-list small{grid-column:1/-1;color:var(--text-muted)}.room-empty{margin:auto;padding:28px;text-align:center;color:var(--text-muted);line-height:1.7}@media(max-width:1200px){.interview-room{grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);height:auto;min-height:0}.analysis-panel{grid-column:1/-1}.room-panel{min-height:360px}}@media(max-width:760px){.live-page :deep(.page-header){align-items:flex-start;flex-direction:column}.live-header-actions{justify-content:flex-start;width:100%}.interview-room{grid-template-columns:minmax(0,1fr)}.analysis-panel{grid-column:auto}.transcript-panel{height:70vh;min-height:420px}}
.live-page-header{display:grid;grid-template-columns:minmax(130px,1fr) auto minmax(280px,1.4fr);align-items:center}
.reference-actions{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:8px;min-width:0}.reference-actions .btn{min-height:34px;white-space:nowrap}
.question-bank-toolbar{margin:0 0 18px}.regenerate-question-bank{width:auto;align-self:flex-start}
.interview-room{grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);height:calc(100dvh - 350px);min-height:480px}.interview-room.completed-room{height:calc(100dvh - 280px)}.analysis-panel{grid-column:auto}
@media(max-width:1100px){.live-page-header{grid-template-columns:minmax(0,1fr) auto}.live-header-actions{grid-column:1/-1;justify-content:flex-start}.interview-room,.interview-room.completed-room{height:auto}.transcript-panel{height:70vh}}
@media(max-width:760px){.interview-room{grid-template-columns:minmax(0,1fr)}.live-page-header{grid-template-columns:minmax(0,1fr)}.reference-actions{justify-content:flex-start}.live-header-actions{width:100%}}
.utterance-actions .analyze-button:disabled{opacity:.6;cursor:wait}
.answer-analysis-feedback{margin-top:7px;font-size:12px;line-height:1.6;color:#0f766e;overflow-wrap:anywhere}
.answer-analysis-feedback.error{color:#b91c1c}
.answer-analysis-feedback.stale{color:#92400e}
</style>
