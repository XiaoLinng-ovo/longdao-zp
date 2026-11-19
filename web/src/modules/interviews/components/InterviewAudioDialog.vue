<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { getFullAudioTranscription, listInterviewRecordings, loadFullInterviewRecording, startFullAudioTranscription, type FullAudioSource, type FullAudioTranscriptionJob, type InterviewAudioRecording } from '../api/recordings'
import { WORKSPACE_CONTEXT_EVENT } from '../../../shared/api/workspace-context'

const props = defineProps<{ interviewId: string; candidate: string; job: string; pendingCount?: number; recording?: boolean; initialSessionId?: string; startMs?: number }>()
const emit = defineEmits<{ close: [] }>()
const rows = ref<InterviewAudioRecording[]>([])
const loading = ref(false), audioLoading = ref(false), error = ref(''), audioError = ref('')
const transcription = ref<FullAudioTranscriptionJob | null>(null), transcriptionLoading = ref(false), transcriptionError = ref(''), copied = ref(false)
const selectedSession = ref(props.initialSessionId || ''), source = ref<FullAudioSource>('all'), speed = ref(1), audioUrl = ref('')
const player = ref<HTMLAudioElement>(), dialog = ref<HTMLElement>(), closeButton = ref<HTMLButtonElement>()
const sessions = computed(() => [...new Map(rows.value.map(row => [row.sessionId, { id: row.sessionId, startedAt: row.sessionStartedAt }])).values()])
const sessionRows = computed(() => rows.value.filter(row => row.sessionId === selectedSession.value))
const sources = computed(() => {
  const result: { id: FullAudioSource; label: string }[] = [{ id: 'all', label: '完整对话' }]
  if (sessionRows.value.some(row => row.audioSource === 'microphone')) result.push({ id: 'microphone', label: '本机麦克风' })
  if (sessionRows.value.some(row => row.audioSource === 'meeting')) result.push({ id: 'meeting', label: '会议音频' })
  if (sessionRows.value.some(row => !row.audioSource)) result.push({ id: 'legacy', label: '来源未记录' })
  return result
})
const previousFocus = document.activeElement as HTMLElement | null
let previousOverflow = '', disposed = false, seekSeconds = Math.max(0, (props.startMs || 0) / 1000)
let listController: AbortController | undefined, audioController: AbortController | undefined, transcriptionController: AbortController | undefined, transcriptionTimer: ReturnType<typeof setTimeout> | undefined
const close = () => emit('close')
function releaseAudio() {
  player.value?.pause()
  if (audioUrl.value) URL.revokeObjectURL(audioUrl.value)
  audioUrl.value = ''
}
function cancelTranscriptionPoll() {
  transcriptionController?.abort(); transcriptionController = undefined
  if (transcriptionTimer) clearTimeout(transcriptionTimer)
  transcriptionTimer = undefined
  transcriptionLoading.value = false
}
async function readTranscription(start = false) {
  cancelTranscriptionPoll(); transcriptionError.value = ''; copied.value = false
  if (!selectedSession.value || disposed) return
  const controller = new AbortController(); transcriptionController = controller
  transcriptionLoading.value = true
  try {
    const job = start
      ? await startFullAudioTranscription(props.interviewId, selectedSession.value, source.value, controller.signal)
      : await getFullAudioTranscription(props.interviewId, selectedSession.value, source.value, controller.signal)
    if (disposed || controller.signal.aborted || transcriptionController !== controller) return
    transcription.value = job
    if (job?.status === 'processing') transcriptionTimer = setTimeout(() => { void readTranscription() }, 1500)
    else if (job?.status === 'failed') transcriptionError.value = job.error || '整段转写失败，请重试。'
  } catch (e) {
    if (!disposed && !controller.signal.aborted) transcriptionError.value = e instanceof Error ? e.message : '转写状态加载失败，请重试。'
  } finally {
    if (!disposed && transcriptionController === controller && !transcriptionTimer) transcriptionLoading.value = false
  }
}
async function copyTranscript() {
  if (!transcription.value?.text) return
  try { await navigator.clipboard.writeText(transcription.value.text); copied.value = true }
  catch { transcriptionError.value = '复制失败，请手动选择并复制转写文本。' }
}
function downloadTranscript() {
  if (!transcription.value?.text) return
  const safeName = (props.candidate || '面试').replace(/[<>:"/\\|?*]/g, '_')
  const blob = new Blob([transcription.value.text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = safeName + '-面试整段转写-' + selectedSession.value + '.txt'
  document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url)
}
async function refresh() {
  listController?.abort(); audioController?.abort()
  const position = player.value?.currentTime ?? seekSeconds
  const controller = new AbortController(); listController = controller
  loading.value = true; error.value = ''
  try {
    const result = await listInterviewRecordings(props.interviewId, controller.signal)
    if (disposed || controller.signal.aborted) return
    rows.value = result
    if (!sessions.value.some(row => row.id === selectedSession.value)) {
      selectedSession.value = sessions.value.at(-1)?.id || ''; source.value = 'all'; seekSeconds = 0
    } else seekSeconds = position
    if (!sources.value.some(row => row.id === source.value)) source.value = 'all'
    if (selectedSession.value) { void load(); void readTranscription() }
    else { releaseAudio(); audioLoading.value = false; audioError.value = '' }
  } catch (e) { if (!disposed && !controller.signal.aborted) error.value = e instanceof Error ? e.message : '录音加载失败，请重试。' }
  finally { if (!disposed && listController === controller) loading.value = false }
}
async function load() {
  audioController?.abort(); releaseAudio()
  const controller = new AbortController(); audioController = controller
  audioLoading.value = true; audioError.value = ''
  try {
    const blob = await loadFullInterviewRecording(props.interviewId, selectedSession.value, source.value, controller.signal)
    if (disposed || controller.signal.aborted) return
    audioUrl.value = URL.createObjectURL(blob)
  } catch (e) { if (!disposed && !controller.signal.aborted) audioError.value = e instanceof Error ? e.message : '整场音频加载失败，请重试。' }
  finally { if (!disposed && audioController === controller) audioLoading.value = false }
}
function changeSession() { seekSeconds = 0; source.value = 'all'; transcription.value = null; void load(); void readTranscription() }
function changeSource() { seekSeconds = player.value?.currentTime ?? seekSeconds; transcription.value = null; void load(); void readTranscription() }
function loaded() {
  if (!player.value) return
  const duration = player.value.duration
  player.value.currentTime = Number.isFinite(duration) ? Math.min(seekSeconds, Math.max(0, duration - 0.01)) : seekSeconds
  player.value.playbackRate = speed.value
}
function download() {
  if (!audioUrl.value) return
  const name = (props.candidate || '面试').replace(/[<>:"/\\|?*]/g, '_').split('').filter(c => c.charCodeAt(0) >= 32).join('')
  const label = sources.value.find(row => row.id === source.value)?.label || '完整对话'
  const link = document.createElement('a'); link.href = audioUrl.value
  link.download = name + '-面试整场录音-' + label + '-' + selectedSession.value + '.m4a'
  document.body.append(link); link.click(); link.remove()
}
function date(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); close(); return }
  if (event.key !== 'Tab') return
  const focusable = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), audio[controls], select:not(:disabled), a[href], [tabindex="0"]') ?? []).filter(el => el.getClientRects().length > 0)
  const first = focusable[0], last = focusable.at(-1)
  if (!first || !last) { event.preventDefault(); return }
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
onMounted(() => {
  previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; closeButton.value?.focus()
  window.addEventListener(WORKSPACE_CONTEXT_EVENT, close); void refresh()
})
onUnmounted(() => {
  disposed = true; listController?.abort(); audioController?.abort(); cancelTranscriptionPoll(); releaseAudio()
  window.removeEventListener(WORKSPACE_CONTEXT_EVENT, close); document.body.style.overflow = previousOverflow
  if (previousFocus?.isConnected) previousFocus.focus()
})
</script>

<template>
  <div class="audio-overlay" @click.self="close" @keydown="keydown">
    <section ref="dialog" class="audio-dialog" role="dialog" aria-modal="true" aria-labelledby="audio-title">
      <header><div><h3 id="audio-title">面试整场录音</h3><p>{{ candidate }} · {{ job }}</p></div><button ref="closeButton" type="button" aria-label="关闭原音频" @click="close">×</button></header>
      <div class="audio-body">
        <div class="audio-toolbar"><strong>{{ recording || pendingCount ? '已保存部分' : '整场回放' }}</strong><button type="button" :disabled="loading" @click="refresh">{{ loading ? '加载中…' : '刷新录音' }}</button></div>
        <p class="audio-note">每场采集提供一份连续录音，可拖动进度、调整语速或下载整场音频。线上面试可分别回听本机麦克风与会议音频。</p>
        <p v-if="pendingCount" class="audio-notice">还有 {{ pendingCount }} 份录音正在上传或等待重试，请保留面试页面，上传完成后刷新录音。</p>
        <p v-if="recording" class="audio-note">正在采集中，当前仅包含已保存的声音。建议戴耳机回放，避免播放声音被再次录入。</p>
        <p v-if="error" role="alert" class="audio-error">{{ error }}</p>
        <label v-if="sessions.length" class="field">采集场次<select v-model="selectedSession" aria-label="采集场次" :disabled="loading" @change="changeSession"><option v-for="session in sessions" :key="session.id" :value="session.id">{{ date(session.startedAt) }}</option></select></label>
        <div v-if="sessionRows.length" class="audio-player">
          <label class="field">回听音源<select v-model="source" aria-label="回听音源" :disabled="loading" @change="changeSource"><option v-for="item in sources" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
          <p v-if="sessionRows.some(row => !row.audioSource)" class="audio-note">本场包含来源未记录的历史录音，无法还原为独立的麦克风和会议音轨。</p>
          <p v-if="audioLoading" role="status">正在整理整场音频，首次加载可能需要一些时间…</p>
          <audio v-if="audioUrl" ref="player" :src="audioUrl" controls preload="metadata" @loadedmetadata="loaded" @error="audioError = '浏览器无法播放此音频，请下载后使用本地播放器打开。'" />
          <p v-if="audioError" role="alert" class="audio-error">{{ audioError }} <button type="button" @click="load">重试加载</button></p>
          <div class="audio-toolbar"><label class="field speed">播放速度<select v-model.number="speed" aria-label="播放速度" @change="player && (player.playbackRate = speed)"><option v-for="rate in [0.75,1,1.25,1.5,2]" :key="rate" :value="rate">{{ rate }} 倍</option></select></label><button type="button" :disabled="!audioUrl || audioLoading" @click="download">{{ source === 'all' ? '下载整场音频' : '下载当前音源整场音频' }}</button></div>
          <section class="transcription" aria-labelledby="transcription-title">
            <div class="audio-toolbar"><strong id="transcription-title">整段转文字</strong><button type="button" :disabled="transcriptionLoading" @click="readTranscription(true)">{{ transcription?.status === 'failed' ? '重试转写' : transcription?.status === 'completed' ? '重新转写' : transcription?.status === 'processing' ? '正在转写…' : '开始转写' }}</button></div>
            <p class="audio-note">使用整场音频识别并按时间顺序合并为一份文本，不会改动面试实时转写和评分记录。</p>
            <div v-if="transcription?.status === 'processing'" role="status" class="transcription-progress"><progress :value="transcription.progress" max="100" /> <span>整段转写中 {{ transcription.progress }}%</span></div>
            <p v-if="transcriptionError" role="alert" class="audio-error">{{ transcriptionError }}</p>
            <textarea v-if="transcription?.text" aria-label="整段转写结果" readonly :value="transcription.text" />
            <p v-else-if="transcription?.status === 'completed'" class="audio-note">未识别到可显示的语音内容。</p>
            <div v-if="transcription?.text" class="audio-toolbar transcript-actions"><button type="button" @click="copyTranscript">{{ copied ? '已复制' : '复制全文' }}</button><button type="button" @click="downloadTranscript">下载文本</button></div>
          </section>
        </div>
        <p v-if="!loading && !error && !rows.length" class="audio-empty">暂无已保存的原音频。开启语音采集后会自动保存；手动录入文字不产生录音。</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.audio-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:#0f172a66}
.audio-dialog{width:min(800px,100%);max-height:88dvh;display:flex;flex-direction:column;background:#fff;border:1px solid var(--border);border-radius:8px;box-shadow:0 20px 60px #0f172a33;overflow:hidden}
header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:18px 24px;border-bottom:1px solid var(--border)}h3{margin:0;font-size:17px}header p{margin:6px 0 0;color:var(--text-muted);font-size:12px}
button,select{border:1px solid var(--border);border-radius:6px;background:white;padding:7px 12px;color:#334155}button{cursor:pointer}button:disabled{opacity:.55;cursor:default}button:focus-visible,select:focus-visible{outline:2px solid #2563eb;outline-offset:2px}header button{font-size:22px;padding:0 8px}
.audio-body{padding:18px 24px;overflow-y:auto;min-height:0;overscroll-behavior:contain}.audio-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}.audio-note,.audio-notice{font-size:12px;line-height:1.7;color:#64748b}.audio-notice{background:#fffbeb;color:#92400e;padding:10px;border-radius:6px}.audio-error{color:#b91c1c;font-size:13px;overflow-wrap:anywhere}.audio-empty{padding:36px 8px;text-align:center;color:#64748b;line-height:1.8}
.audio-player{padding:16px 0;background:white}.field{display:flex;align-items:center;gap:10px;font-size:13px;margin:12px 0}.field select{flex:1;min-width:0}.speed{margin:0}audio{display:block;width:100%;margin:20px 0}
.transcription{border-top:1px solid var(--border);margin-top:20px;padding-top:16px}.transcription-progress{display:flex;align-items:center;gap:10px;color:#475569;font-size:13px}.transcription-progress progress{width:min(240px,60%);height:10px;accent-color:#0f766e}.transcription textarea{display:block;width:100%;min-height:180px;max-height:360px;resize:vertical;box-sizing:border-box;border:1px solid var(--border);border-radius:6px;padding:12px;color:#1e293b;font:inherit;line-height:1.7;white-space:pre-wrap}.transcript-actions{justify-content:flex-start;margin-top:10px}
@media(max-width:600px){.audio-overlay{padding:12px}.audio-dialog{max-height:calc(100dvh - 24px)}header,.audio-body{padding:14px 16px}.audio-toolbar{flex-wrap:wrap}.field{align-items:flex-start;flex-direction:column}.field select{width:100%}}
</style>
