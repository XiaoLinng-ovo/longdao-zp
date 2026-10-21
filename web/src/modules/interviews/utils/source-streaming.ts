import { createStreamingTranscriptBuffer } from './streaming-transcript'
import type { PendingInterviewAudio } from './pending-audio'

export type SourceStreamingState = 'idle' | 'connecting' | 'loading' | 'ready' | 'unavailable'

/** One recognizer connection, preview buffer and reconnect lifecycle per source. */
export function createSourceStreaming(options: {
  isRecording: () => boolean
  onState: (state: SourceStreamingState) => void
  onText: (text: string) => void
  onWarning: (warning: string) => void
}) {
  let disposed = false
  let inputStream: MediaStream | undefined
  let streamingVersion = 0
  let state: SourceStreamingState = 'idle'
  const streamingState = { get value() { return state }, set value(value: SourceStreamingState) { state = value; options.onState(value) } }
  const streamingWarning = { set value(value: string) { options.onWarning(value) } }
  const streamingTranscript = createStreamingTranscriptBuffer(options.onText, () => {
    failStreamingAudio(streamingVersion, '流式尾句确认超时，已保留本路全文和原始录音，将自动重连。')
  }, 20_000)
  let streamSocket: WebSocket | undefined
  let audioContext: AudioContext | undefined
  let audioSource: MediaStreamAudioSourceNode | undefined
  let audioProcessor: ScriptProcessorNode | undefined
  let audioWorklet: AudioWorkletNode | undefined
  let audioMuteGain: GainNode | undefined
  let streamAudioReady = false
  let paused = false
  let resolveStreamFinal: (() => void) | undefined
  let streamRetryTimer: ReturnType<typeof setTimeout> | undefined
  let streamReadyTimer: ReturnType<typeof setTimeout> | undefined
  let streamHeartbeatTimer: ReturnType<typeof setInterval> | undefined
  let cancelStreamHandshake: (() => void) | undefined
  let streamRetryAttempt = 0

function appendStreamingPcm(samples: Float32Array, inputRate: number): void {
  if (!streamAudioReady || streamSocket?.readyState !== WebSocket.OPEN) return
  const outputLength = Math.floor(samples.length * 16000 / inputRate)
  if (!outputLength) return
  const pcm = new Int16Array(outputLength)
  const ratio = inputRate / 16000
  for (let index = 0; index < outputLength; index++) {
    const position = index * ratio
    const left = Math.floor(position)
    const fraction = position - left
    const sample = (samples[left] ?? 0) * (1 - fraction) + (samples[Math.min(left + 1, samples.length - 1)] ?? 0) * fraction
    pcm[index] = Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)
  }
  if (streamSocket.bufferedAmount > 1_920_000) {
    failStreamingAudio(streamingVersion, '实时流式发送积压，录音及分段保存继续，将自动重连。')
    return
  }
  try { streamSocket.send(pcm.buffer) }
  catch { failStreamingAudio(streamingVersion, '实时流式发送失败，录音及分段保存继续，将自动重连。') }
}

function stopStreamingAudio(): void {
  streamingVersion++
  streamingTranscript.disconnect()
  streamAudioReady = false
  if (streamRetryTimer) clearTimeout(streamRetryTimer)
  streamRetryTimer = undefined
  if (streamReadyTimer) clearTimeout(streamReadyTimer)
  streamReadyTimer = undefined
  if (streamHeartbeatTimer) clearInterval(streamHeartbeatTimer)
  streamHeartbeatTimer = undefined
  cancelStreamHandshake?.(); cancelStreamHandshake = undefined
  resolveStreamFinal?.(); resolveStreamFinal = undefined
  if (audioWorklet) { audioWorklet.port.onmessage = null; audioWorklet.disconnect(); audioWorklet = undefined }
  if (audioProcessor) { audioProcessor.onaudioprocess = null; audioProcessor.disconnect(); audioProcessor = undefined }
  audioSource?.disconnect(); audioSource = undefined
  audioMuteGain?.disconnect(); audioMuteGain = undefined
  if (audioContext) { void audioContext.close().catch(() => undefined); audioContext = undefined }
  if (streamSocket) {
    streamSocket.onmessage = null; streamSocket.onerror = null; streamSocket.onclose = null
    if (streamSocket.readyState < WebSocket.CLOSING) streamSocket.close(1000, 'stream reset')
  }
  streamSocket = undefined
}

function failStreamingAudio(version: number, warning: string) {
  if (version !== streamingVersion || disposed) return
  stopStreamingAudio()
  streamingState.value = 'unavailable'
  streamingWarning.value = warning
  scheduleStreamingReconnect()
}

function restartStreamingAudio() {
  const stream = inputStream
  if (!stream || disposed || !options.isRecording()) return
  stopStreamingAudio()
  const version = streamingVersion
  void startStreamingAudio(stream).catch(() => {
    failStreamingAudio(version, '实时流式识别未连接，录音及分段保存继续，将自动重连。')
  })
}

async function startStreamingAudio(stream: MediaStream): Promise<void> {
  const version = streamingVersion
  const configuredUrl = (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_FUNASR_STREAM_URL?.trim()
  // Keep WebSocket traffic on the app origin, including tunneled deployments.
  const defaultUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/funasr-stream`
  const socket = new WebSocket(configuredUrl || defaultUrl)
  socket.binaryType = 'arraybuffer'
  streamSocket = socket
  streamingState.value = 'connecting'
  const current = () => version === streamingVersion && !disposed && streamSocket === socket
  let modelReady = false
  const fail = (reason: string) => failStreamingAudio(version, reason)
  let lastResponseAt = Date.now()
  socket.onmessage = (event: MessageEvent<string>) => {
    if (!current()) return
    try {
      const message = JSON.parse(event.data) as { type?: string; status?: string; text?: string; heartbeat?: boolean; commitId?: string }
      lastResponseAt = Date.now()
      if (message.type === 'status') {
        if (message.status === 'loading' && streamingState.value !== 'ready') streamingState.value = 'loading'
        if (message.status === 'ready') {
          modelReady = true
          // Audio captured before readiness still needs batch transcription.
          if (streamingState.value !== 'ready') streamingTranscript.disconnect()
          streamingState.value = 'ready'
          streamAudioReady = !paused && options.isRecording()
          streamingWarning.value = ''
          streamRetryAttempt = 0
          if (streamReadyTimer) clearTimeout(streamReadyTimer)
          streamReadyTimer = undefined
          if (message.heartbeat && !streamHeartbeatTimer) {
            streamHeartbeatTimer = setInterval(() => {
              if (!current()) return
              if (Date.now() - lastResponseAt >= 35_000) {
                fail('实时流式连接响应超时，录音及分段保存继续，将自动重连。')
                return
              }
              try { socket.send(JSON.stringify({ type: 'ping' })) }
              catch { fail('实时流式连接中断，录音及分段保存继续，将自动重连。') }
            }, 10_000)
          }
        }
      } else if (message.type === 'partial' && typeof message.text === 'string') {
        streamingTranscript.partial(message.text)
      } else if (message.type === 'final') {
        streamingTranscript.final(message.text || '', message.commitId)
        resolveStreamFinal?.()
        resolveStreamFinal = undefined
      } else if (message.type === 'error') {
        fail('实时流式服务异常，录音及分段保存继续，将自动重连。')
      }
    } catch { /* Ignore malformed frames; batch transcription remains available. */ }
  }
  socket.onerror = () => { if (current()) fail('实时流式连接中断，录音及分段保存继续，将自动重连。') }
  socket.onclose = () => { if (current()) fail('实时流式连接已断开，录音及分段保存继续，将自动重连。') }
  const opened = await new Promise<boolean>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onError)
      if (cancelStreamHandshake === cancel) cancelStreamHandshake = undefined
    }
    const onOpen = () => { cleanup(); resolve(true) }
    const onError = () => { cleanup(); reject(new Error('无法连接实时转写服务')) }
    const cancel = () => { cleanup(); resolve(false) }
    const timeout = setTimeout(() => { cleanup(); reject(new Error('连接实时转写服务超时')) }, 10_000)
    cancelStreamHandshake = cancel
    socket.addEventListener('open', onOpen, { once: true })
    socket.addEventListener('error', onError, { once: true })
    socket.addEventListener('close', onError, { once: true })
  })
  if (!opened || !current()) return
  if (!modelReady) {
    streamReadyTimer = setTimeout(() => fail('实时流式模型就绪超时，录音及分段保存继续，将自动重连。'), 120_000)
  }
  const context = new AudioContext()
  audioContext = context
  await context.resume()
  if (!current()) return
  audioSource = context.createMediaStreamSource(stream)
  audioMuteGain = context.createGain()
  audioMuteGain.gain.value = 0
  if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    await context.audioWorklet.addModule(`${import.meta.env.BASE_URL}interview-pcm-worklet.js`)
    if (!current()) return
    audioWorklet = new AudioWorkletNode(context, 'interview-pcm')
    audioWorklet.port.onmessage = event => { if (current()) appendStreamingPcm(event.data, context.sampleRate) }
    audioSource.connect(audioWorklet)
    audioWorklet.connect(audioMuteGain)
  } else {
    audioProcessor = context.createScriptProcessor(4096, 1, 1)
    audioProcessor.onaudioprocess = event => { if (current()) appendStreamingPcm(event.inputBuffer.getChannelData(0), context.sampleRate) }
    audioSource.connect(audioProcessor)
    audioProcessor.connect(audioMuteGain)
  }
  audioMuteGain.connect(context.destination)
}

function commitStreamingAudio(type: 'commit' | 'end', chunk?: PendingInterviewAudio): Promise<void> {
  const connected = streamingState.value === 'ready' && streamSocket?.readyState === WebSocket.OPEN
  const ready = chunk ? streamingTranscript.commit(chunk, connected) : Promise.resolve()
  if (connected) {
    try { streamSocket!.send(JSON.stringify({ type, ...(chunk ? { commitId: chunk.id } : {}) })) }
    catch { failStreamingAudio(streamingVersion, '实时流式分段确认失败，录音及分段保存继续，将自动重连。') }
  }
  return ready
}

function scheduleStreamingReconnect() {
  if (streamRetryTimer || disposed || !options.isRecording()) return
  const delay = Math.min(1000 * 2 ** Math.min(streamRetryAttempt++, 4), 15_000)
  streamRetryTimer = setTimeout(() => {
    streamRetryTimer = undefined
    restartStreamingAudio()
  }, delay)
}

  return {
    start(stream: MediaStream) { inputStream = stream; paused = false; streamRetryAttempt = 0; restartStreamingAudio() },
    reconnect() { streamRetryAttempt = 0; restartStreamingAudio() },
    pause() { paused = true; streamAudioReady = false },
    async resume() {
      paused = false
      if (audioContext && audioContext.state !== 'running') await audioContext.resume().catch(() => undefined)
      streamAudioReady = !paused && options.isRecording() && state === 'ready'
      if (state === 'unavailable') scheduleStreamingReconnect()
    },
    commit(chunk: PendingInterviewAudio) { return commitStreamingAudio('commit', chunk) },
    acknowledge(id: string) { streamingTranscript.acknowledge(id) },
    stop() { stopStreamingAudio(); inputStream = undefined; streamingState.value = 'idle' },
    dispose() { disposed = true; stopStreamingAudio() },
  }
}
