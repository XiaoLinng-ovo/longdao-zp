import { createSourceSoundCheck } from './source-sound-check'
export type InterviewAudioMode = 'microphone' | 'meeting'
export type InterviewAudioSource = 'microphone' | 'meeting'
export interface InterviewAudioSourceConfig { id: InterviewAudioSource; role: 'interviewer' | 'candidate' | 'unknown'; multipleSpeakers: boolean }
export interface InterviewAudioTrack { source: InterviewAudioSource; stream: MediaStream }
export interface InterviewAudioLevels { microphone: number; meeting: number }
export interface InterviewAudioCapture {
  sources?: InterviewAudioTrack[]
  stream: MediaStream
  microphoneLabel: string
  meetingLabel: string
  setPaused: (paused: boolean) => void
  resume?: () => Promise<void>
  stop: () => void
}
export class InterviewAudioCaptureError extends Error {
  constructor(public readonly source: InterviewAudioSource, message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'InterviewAudioCaptureError'
  }
}

function permissionError(source: InterviewAudioSource, cause: unknown): InterviewAudioCaptureError {
  const name = (cause as { name?: string })?.name
  const label = source === 'meeting' ? '会议音频共享' : '麦克风'
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return new InterviewAudioCaptureError(source, source === 'meeting'
      ? '会议音频共享被取消或拒绝。请重新开始，选择包含会议声音的共享来源并勾选共享音频；不会自动退回仅麦克风录音。'
      : '麦克风权限被拒绝：请在浏览器地址栏允许麦克风权限后重试。', cause)
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return new InterviewAudioCaptureError(source, `未找到可用的${label}，请检查设备或重新选择音频来源。`, cause)
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return new InterviewAudioCaptureError(source, `${label}无法读取，请检查设备是否被占用及系统录音权限后重试。`, cause)
  }
  return new InterviewAudioCaptureError(source, `${label}启动失败：${cause instanceof Error ? cause.message : '请重新授权后重试'}`, cause)
}

/** Display capture must be requested before any await to preserve click activation.
 * Audio sources stay separate. Display video remains local and is stopped with
 * the session; no microphone or meeting audio is connected to the loudspeaker.
 */
export async function createInterviewAudioCapture(mode: InterviewAudioMode, options: {
  microphoneDeviceId?: string
  onLevels?: (levels: InterviewAudioLevels) => void
  onSoundCheck?: (detected: Record<InterviewAudioSource, boolean>) => void
  onSourceEnded?: (source: InterviewAudioSource) => void
  onWarning?: (message: string) => void
} = {}): Promise<InterviewAudioCapture> {
  const devices = navigator.mediaDevices
  if (!devices?.getUserMedia) throw new InterviewAudioCaptureError('microphone', '当前浏览器不支持麦克风录音，请使用支持音频采集的浏览器并通过 HTTPS 或本机地址访问。')
  if (mode === 'meeting' && !devices.getDisplayMedia) throw new InterviewAudioCaptureError('meeting', '当前浏览器或访问环境不支持会议音频共享。请更换支持共享音频的浏览器，或明确选择「仅麦克风」模式。')

  let microphone: MediaStream | undefined
  let display: MediaStream | undefined
  let output: MediaStream | undefined
  let context: AudioContext | undefined
  let meterTimer: ReturnType<typeof setInterval> | undefined
  let stopped = false
  let paused = false
  let endedSource: InterviewAudioSource | undefined
  const nodes: AudioNode[] = []
  const listeners: Array<{ track: MediaStreamTrack; listener: () => void }> = []
  let recovering = false
  const soundCheck = createSourceSoundCheck(mode === 'meeting' ? ['microphone', 'meeting'] : ['microphone'])
  let previousWarning = ''
  const resume = async () => {
    if (stopped || paused || !context || context.state === 'running' || recovering) return
    recovering = true
    try {
      await context.resume()
      if (!stopped && (context.state as string) !== 'running') options.onWarning?.('音频处理被浏览器挂起，请返回面试页并点击「恢复音频」。')
    } catch { if (!stopped) options.onWarning?.('音频处理恢复失败，请返回面试页并点击「恢复音频」。') }
    finally { recovering = false }
  }
  const contextChanged = () => { void resume() }
  const stop = () => {
    if (stopped) return
    stopped = true
    if (meterTimer) clearInterval(meterTimer)
    context?.removeEventListener?.('statechange', contextChanged)
    listeners.forEach(({ track, listener }) => track.removeEventListener('ended', listener))
    new Set([...(microphone?.getTracks() ?? []), ...(display?.getTracks() ?? []), ...(output?.getTracks() ?? [])]).forEach(track => track.stop())
    nodes.forEach(node => node.disconnect())
    if (context) void context.close().catch(() => undefined)
    options.onLevels?.({ microphone: 0, meeting: 0 })
  }
  const watchTrack = (track: MediaStreamTrack, source: InterviewAudioSource) => {
    const listener = () => {
      if (stopped) return
      endedSource = source
      stop()
      options.onSourceEnded?.(source)
    }
    listeners.push({ track, listener })
    track.addEventListener('ended', listener)
  }
  try {
    if (mode === 'meeting') {
      try {
        // systemAudio is a browser hint, not a guarantee. Inspect returned tracks.
        const constraints: DisplayMediaStreamOptions & { systemAudio: 'include' } = {
          video: true, audio: true, systemAudio: 'include',
        }
        display = await devices.getDisplayMedia(constraints)
      } catch (cause) { throw permissionError('meeting', cause) }
      if (!display.getAudioTracks().some(track => track.readyState === 'live')) {
        throw new InterviewAudioCaptureError('meeting', '未获取到会议音频。请重新选择共享来源并勾选「共享音频」；桌面会议可尝试共享整个屏幕及系统音频，网页会议可尝试共享对应标签页音频。仅共享窗口可能没有声音。')
      }
      display.getTracks().forEach(track => watchTrack(track, 'meeting'))
    }
    try {
      microphone = await devices.getUserMedia({ audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        ...(options.microphoneDeviceId ? { deviceId: { exact: options.microphoneDeviceId } } : {}),
      } })
    } catch (cause) { throw permissionError('microphone', cause) }
    if (stopped) microphone.getTracks().forEach(track => track.stop())
    if (stopped || !microphone.getAudioTracks().some(track => track.readyState === 'live')) {
      throw new InterviewAudioCaptureError(endedSource ?? 'microphone', '音频来源已断开，请重新授权后继续面试。')
    }
    microphone.getTracks().forEach(track => watchTrack(track, 'microphone'))
    context = new AudioContext()
    await context.resume()
    if (stopped) throw new InterviewAudioCaptureError(endedSource ?? 'microphone', '音频来源已断开，请重新授权后继续面试。')
    if (context.state !== 'running') throw new InterviewAudioCaptureError(mode === 'meeting' ? 'meeting' : 'microphone', '音频处理未启动，请检查浏览器音频权限后重新开始。')
    context.addEventListener?.('statechange', contextChanged)
    // Native source tracks are recorded independently of the metering context.
    output = microphone
    const sources: InterviewAudioTrack[] = [{ source: 'microphone', stream: microphone }]
    if (display) sources.push({ source: 'meeting', stream: new MediaStream(display.getAudioTracks()) })
    const connect = (stream: MediaStream) => {
      const source = context!.createMediaStreamSource(stream)
      nodes.push(source)
      const analyser = context!.createAnalyser()
      nodes.push(analyser)
      analyser.fftSize = 256
      source.connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      return () => {
        analyser.getFloatTimeDomainData(samples)
        return Math.min(1, Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length) * 4)
      }
    }
    const microphoneLevel = connect(microphone)
    const meetingTrack = sources.find(row => row.source === 'meeting')
    const meetingLevel = meetingTrack ? connect(meetingTrack.stream) : () => 0
    meterTimer = setInterval(() => {
      void resume()
      const levels = paused ? { microphone: 0, meeting: 0 } : { microphone: microphoneLevel(), meeting: meetingLevel() }
      options.onLevels?.(levels)
      const check = soundCheck.update(levels, Date.now(), paused)
      options.onSoundCheck?.(check.detected)
      let warning = check.missing.length ? check.missing.map(source => source === 'microphone' ? '本机麦克风' : '会议音频').join('、') + '尚未检测到声音，请双方依次试音，并检查设备静音及共享音频设置。' : ''
      if (!paused && (microphone!.getAudioTracks().some(track => track.muted) || display?.getAudioTracks().some(track => track.muted))) {
        warning = '音频来源被系统暂时静音，正在等待恢复；请检查麦克风或会议共享。'
      }
      if (warning !== previousWarning) { previousWarning = warning; options.onWarning?.(warning) }
    }, 150)
    return {
      stream: output,
      sources,
      microphoneLabel: microphone.getAudioTracks()[0]?.label || '默认麦克风',
      meetingLabel: display?.getAudioTracks()[0]?.label || '',
      setPaused(value) { paused = value; sources.forEach(row => row.stream.getAudioTracks().forEach(track => { track.enabled = !value })) },
      resume,
      stop,
    }
  } catch (cause) {
    stop()
    if (cause instanceof InterviewAudioCaptureError) throw cause
    throw new InterviewAudioCaptureError(mode === 'meeting' ? 'meeting' : 'microphone', `音频处理启动失败：${cause instanceof Error ? cause.message : '未知错误'}`, cause)
  }
}
