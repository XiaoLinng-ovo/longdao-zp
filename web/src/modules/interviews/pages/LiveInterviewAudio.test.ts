// @vitest-environment jsdom
import { COMMON_QUESTION_GROUPS } from '../utils/common-question-templates'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import LiveInterviewPage from './LiveInterviewPage.vue'
import { ApiNetworkError, ApiResponseError, apiClient } from '../../../shared/api'
import { createInterviewAudioCapture, InterviewAudioCaptureError, type InterviewAudioCapture } from '../utils/audio-capture'
import { createLiveInterviewSession, endLiveInterviewSession, findActiveLiveInterviewSession, getInterview, getInterviewQuestions, generateInterviewQuestions, analyzeLiveSegment, correctLiveSegmentRole, updateLiveInterviewQuestion, uploadLiveInterviewChunk, type LiveInterviewSegment } from '../api'
import { loadQuestionSheets } from '../api/question-sheets'
import { savePendingAudio, removePendingAudio, restorePendingAudio } from '../utils/pending-audio'
import { setWorkspaceContext } from '../../../shared/api/workspace-context'
import { listInterviewRecordings } from '../api/recordings'
import { saveLiveTranscriptRefinement } from '../api'
import { refineInterviewQuestionGroup } from '../api'

vi.mock('../../../shared/api', async original => ({ ...await original<typeof import('../../../shared/api')>(), apiClient: { getJson: vi.fn() } }))
vi.mock('../api', () => ({ getInterview: vi.fn(), refineInterviewQuestionGroup: vi.fn(), findActiveLiveInterviewSession: vi.fn(), getInterviewQuestions: vi.fn(), generateInterviewQuestions: vi.fn(), createLiveInterviewSession: vi.fn(), updateLiveInterviewQuestion: vi.fn(), uploadLiveInterviewChunk: vi.fn(), endLiveInterviewSession: vi.fn(), analyzeLiveSegment: vi.fn(), correctLiveSegmentRole: vi.fn(), addManualLiveSegment: vi.fn(), saveLiveTranscriptRefinement: vi.fn() }))
vi.mock('../api/question-sheets', () => ({ loadQuestionSheets: vi.fn(), stageOfRound: () => 'initial' }))
vi.mock('../api/recordings', () => ({ listInterviewRecordings: vi.fn(), loadInterviewRecording: vi.fn(), loadFullInterviewRecording: vi.fn() }))
vi.mock('../utils/audio-capture', async original => ({ ...await original<typeof import('../utils/audio-capture')>(), createInterviewAudioCapture: vi.fn() }))
vi.mock('../utils/pending-audio', async original => ({ ...await original<typeof import('../utils/pending-audio')>(), savePendingAudio: vi.fn(), removePendingAudio: vi.fn(), restorePendingAudio: vi.fn() }))
class Recorder {
  static instances: Recorder[] = []
  state = 'inactive'
  ondataavailable?: (event: { data: Blob }) => void
  onstop?: () => void
  constructor(public stream: MediaStream) { Recorder.instances.push(this) }
  start() { this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) }); this.onstop?.() })
  }
}
// Real microphone/system audio is not available in jsdom. Streaming deliberately
// fails; complete chunks must still use the existing batch transcription path.
class Socket extends EventTarget {
  static OPEN = 1; static CLOSING = 2
  readyState = 3
  binaryType = ''
  onmessage?: unknown
  onerror?: unknown
  constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('error'))) }
  close() { this.readyState = 3 }
  send() {}
}
class Reader {
  result = 'data:audio/webm;base64,YXVkaW8='
  onloadend?: () => void
  readAsDataURL() { this.onloadend?.() }
}
let app: App | undefined, root: HTMLDivElement | undefined
let capture: InterviewAudioCapture
let now = 0
async function flush() { for (let i = 0; i < 30; i++) { await Promise.resolve(); await nextTick() } }
const button = (text: string) => [...root!.querySelectorAll('button')].find(item => item.textContent?.trim() === text)!
async function selectMode(mode: string) { const select = root!.querySelector<HTMLSelectElement>('[aria-label="音频采集方式"]')!; select.value = mode; select.dispatchEvent(new Event('change')); await flush() }
async function consent() { root!.querySelector<HTMLInputElement>('.recording-consent input')!.click(); await flush() }
async function start() { await consent(); button('开始面试').click(); await flush() }
async function tick(ms: number) { now += ms; await vi.advanceTimersByTimeAsync(ms); await flush() }
async function mount(interviewId = 'interview-1') {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/interviews/:id/live', component: LiveInterviewPage },
    { path: '/interviews/:id', component: { template: '<div />' } },
  ] })
  await router.push(`/interviews/${interviewId}/live`); await router.isReady()
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp({ template: '<router-view />' }); app.use(router); app.mount(root); await flush()
  return router
}
beforeEach(() => {
  vi.useFakeTimers(); now = 0; Recorder.instances = []
  setWorkspaceContext(undefined)
  vi.mocked(savePendingAudio).mockResolvedValue()
  vi.mocked(removePendingAudio).mockResolvedValue()
  vi.mocked(restorePendingAudio).mockResolvedValue([])
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('MediaRecorder', Recorder); vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('FileReader', Reader)
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: vi.fn(async () => [{ kind: 'audioinput', deviceId: 'usb', label: 'USB microphone' }]), addEventListener: vi.fn(), removeEventListener: vi.fn() } })
  const track = { readyState: 'live' }
  capture = { stream: { getAudioTracks: () => [track] } as unknown as MediaStream, microphoneLabel: 'USB microphone', meetingLabel: 'meeting output', setPaused: vi.fn(), stop: vi.fn(() => { track.readyState = 'ended' }) }
  vi.mocked(createInterviewAudioCapture).mockResolvedValue(capture)
  vi.mocked(getInterview).mockResolvedValue({ id: 'interview-1', applicationId: 'app-1', round: 1, application: { candidateId: 'candidate-1', jobId: 'job-1' } } as never)
  vi.mocked(apiClient.getJson).mockImplementation(async path => ({ data: path === '/candidates' ? [{ id: 'candidate-1', fullName: '测试候选人' }] : path === '/jobs' ? [{ id: 'job-1', title: '测试岗位' }] : { checks: { externalServices: { funasr: 'ok', llm: 'ok' } } } }) as never)
  vi.mocked(findActiveLiveInterviewSession).mockResolvedValue(null)
  vi.mocked(getInterviewQuestions).mockResolvedValue({ questions: [], engine: 'llm' } as never)
  vi.mocked(generateInterviewQuestions).mockResolvedValue({ questions: [], engine: 'llm' } as never)
  vi.mocked(createLiveInterviewSession).mockResolvedValue({ id: 'session-1' } as never)
  vi.mocked(updateLiveInterviewQuestion).mockResolvedValue({ currentQuestion: '测试问题' } as never)
  vi.mocked(uploadLiveInterviewChunk).mockResolvedValue([])
  vi.mocked(endLiveInterviewSession).mockResolvedValue({ id: 'session-1', status: 'completed' } as never)
  vi.mocked(loadQuestionSheets).mockResolvedValue({ stages: [] } as never)
})
afterEach(async () => { app?.unmount(); await flush(); root?.remove(); app = undefined; root = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals() })

describe('live interview meeting audio', () => {
  it('restores separate recognition alternatives without duplicating them in the main dialogue', async () => {
    const text = '我负责平台开发。团队一共八个人。我还承担测试和上线工作。'
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', interviewId: 'interview-1', status: 'active', externalStatus: 'ready', startedAt: '2026-10-23T00:00:00Z', createdBy: 'u', currentQuestion: '' }, segments: [
      { id: 'alternative', sessionId: 'session-1', speakerId: 'chunk_15000:stream_15000', role: 'unknown', confidence: .35,
        text, startMs: 15000, endMs: 30000, status: 'transcribed', transcriptComparison: {
          streamingText: '我负责平台的开发。', offlineText: text, streamingComplete: false, selectedSource: 'offline', startMs: 15000, endMs: 30000,
        } },
    ] })
    await mount()
    const dialogue = root!.querySelector('.utterance')!
    const comparison = dialogue.querySelector<HTMLDetailsElement>('.transcript-comparison')!
    expect(comparison.open).toBe(false)
    expect(comparison.textContent).toContain('识别版本对照 · 00:15–00:30')
    expect(comparison.textContent).toContain('我负责平台的开发。')
    expect(comparison.textContent).toContain(text)
    expect(comparison.textContent).toContain('流式识别 · 未完成')
    expect(comparison.textContent).toContain('录音分段识别 · 当前采用')
    expect(dialogue.querySelector(':scope > p')?.textContent).toBe(text)
    expect(root!.querySelectorAll('.utterance')).toHaveLength(1)
    expect(analyzeLiveSegment).not.toHaveBeenCalled()
  })
  it('requires consent and lets users select microphone or meeting mode without binding a provider', async () => {
    await mount()
    expect(button('开始面试').disabled).toBe(true)
    expect(root!.querySelector('.audio-mode-badge')!.textContent).toBe('仅麦克风')
    await selectMode('meeting')
    expect(root!.querySelector('.audio-mode-badge')!.textContent).toBe('双路采集')
    await start()
    expect(createInterviewAudioCapture).toHaveBeenCalledWith('meeting', expect.any(Object))
    expect(root!.textContent).toContain('等待对方试音')
    const captureOptions = vi.mocked(createInterviewAudioCapture).mock.calls.at(-1)![1]!
    captureOptions.onSoundCheck?.({microphone:true,meeting:false}); await flush()
    expect(root!.textContent).toContain('等待对方试音')
    captureOptions.onSoundCheck?.({microphone:true,meeting:true}); await flush()
    expect(root!.textContent).not.toContain('等待对方试音')
    expect(root!.textContent).toContain('已检测到声音')
    expect(root!.querySelector<HTMLSelectElement>('[aria-label="音频采集方式"]')!.disabled).toBe(true)
    expect(Recorder.instances[0]!.stream).toBe(capture.stream)
  })
  it('keeps the audio controls compact without persistent instructions in either mode', async () => {
    await mount()
    const settings = root!.querySelector('[aria-label="面试音频采集设置"]')!
    expect(settings.classList.contains('audio-settings-toolbar')).toBe(true)
    expect(settings.querySelector('header')).toBeNull()
    expect(settings.querySelector('.audio-setting-row .audio-mode-badge')!.textContent).toBe('仅麦克风')
    expect(settings.compareDocumentPosition(root!.querySelector('.interview-room')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(root!.querySelector('.transcript-panel')).not.toBeNull()
    expect(root!.querySelector('.analysis-panel')).not.toBeNull()
    expect(settings.querySelectorAll('select')).toHaveLength(3)
    expect(settings.querySelector<HTMLSelectElement>('[aria-label="本机麦克风角色"]')!.value).toBe('unknown')
    expect(settings.querySelector('.recording-consent input')).not.toBeNull()
    expect(settings.querySelectorAll('.audio-source')).toHaveLength(1)
    expect(settings.querySelectorAll('p')).toHaveLength(0)
    await selectMode('meeting')
    expect(settings.querySelectorAll('.audio-source')).toHaveLength(2)
    expect(settings.querySelectorAll('meter')).toHaveLength(2)
    expect(settings.querySelectorAll('p')).toHaveLength(0)
    expect(settings.textContent).not.toContain('不需要绑定钉钉或腾讯会议')
    expect(settings.textContent).not.toContain('音轨接入不代表一定有声音')
    expect(button('开始面试').disabled).toBe(true)
  })
  it('uses the selected microphone and exposes separate input meters', async () => {
    await mount(); await selectMode('meeting')
    const device = root!.querySelector<HTMLSelectElement>('[aria-label="录音输入设备"]')!
    device.value = 'usb'; device.dispatchEvent(new Event('change')); await flush()
    await start()
    const options = vi.mocked(createInterviewAudioCapture).mock.calls[0]![1]!
    expect(options.microphoneDeviceId).toBe('usb')
    options.onLevels!({ microphone: 0.2, meeting: 0.7 }); await flush()
    expect(root!.querySelector<HTMLMeterElement>('[aria-label="麦克风输入音量"]')!.value).toBe(0.2)
    expect(root!.querySelector<HTMLMeterElement>('[aria-label="会议音频输入音量"]')!.value).toBe(0.7)
  })
  it('does not start a session or recorder when sharing has no audio', async () => {
    vi.mocked(createInterviewAudioCapture).mockRejectedValue(new InterviewAudioCaptureError('meeting', '未获取到会议音频'))
    await mount(); await selectMode('meeting'); await start()
    expect(root!.textContent).toContain('未接入会议音频')
    expect(root!.querySelector('[role="alert"]')!.textContent).toContain('未获取到会议音频')
    expect(createLiveInterviewSession).not.toHaveBeenCalled()
    expect(Recorder.instances).toHaveLength(0)
  })
  it('releases capture if creating a session fails', async () => {
    vi.mocked(createLiveInterviewSession).mockRejectedValue(new Error('network error'))
    await mount(); await start()
    expect(capture.stop).toHaveBeenCalledOnce()
    expect(Recorder.instances).toHaveLength(0)
    expect(button('开始面试')).toBeDefined()
  })
  it('commits on pause, freezes elapsed time, and continues without repeating sharing authorization', async () => {
    await mount(); await selectMode('meeting'); await start(); await tick(3000)
    button('暂停').click(); await flush()
    expect(capture.setPaused).toHaveBeenCalledWith(true)
    expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce()
    expect(root!.querySelector('.session-elapsed')!.textContent).toBe('00:03')
    await tick(60000)
    expect(root!.querySelector('.session-elapsed')!.textContent).toBe('00:03')
    button('继续').click(); await flush(); await tick(2000)
    expect(capture.setPaused).toHaveBeenCalledWith(false)
    expect(root!.querySelector('.session-elapsed')!.textContent).toBe('00:05')
    expect(createInterviewAudioCapture).toHaveBeenCalledOnce()
    expect(Recorder.instances).toHaveLength(2)
  })
  it.each([
    ['microphone', 'meeting'],
    ['meeting', 'microphone'],
  ])('changes %s to %s while paused and continues the same session', async (previous, next) => {
    await mount(); await selectMode(previous); await start(); await tick(3000)
    const oldCallbacks = vi.mocked(createInterviewAudioCapture).mock.calls[0]![1]!
    button('暂停').click(); await flush()
    expect(root!.querySelector<HTMLSelectElement>('[aria-label="音频采集方式"]')!.disabled).toBe(false)
    expect(root!.querySelector<HTMLSelectElement>('[aria-label="录音输入设备"]')!.disabled).toBe(false)
    expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce()
    await selectMode(next)
    expect(capture.stop).toHaveBeenCalledOnce()
    expect(createInterviewAudioCapture).toHaveBeenCalledOnce()
    oldCallbacks.onSourceEnded!('meeting'); oldCallbacks.onLevels!({ microphone: 1, meeting: 1 }); await flush()
    expect(root!.textContent).not.toContain('共享已停止')
    expect(root!.querySelector<HTMLMeterElement>('[aria-label="麦克风输入音量"]')!.value).toBe(0)
    await tick(60000)
    const replacement = { ...capture, stream: { getAudioTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream, stop: vi.fn() }
    vi.mocked(createInterviewAudioCapture).mockResolvedValue(replacement)
    button('继续').click()
    // Sharing must be requested in the click, before any pending upload is awaited.
    expect(createInterviewAudioCapture).toHaveBeenLastCalledWith(next, expect.any(Object))
    await flush(); await tick(2000)
    expect(createInterviewAudioCapture).toHaveBeenCalledTimes(2)
    expect(createLiveInterviewSession).toHaveBeenCalledOnce()
    expect(Recorder.instances).toHaveLength(2)
    expect(Recorder.instances[1]!.stream).toBe(replacement.stream)
    expect(root!.querySelector('.session-state')!.textContent).toContain('正在录音')
    expect(root!.querySelector('.session-elapsed')!.textContent).toBe('00:05')
    button('暂停').click(); await flush()
    expect(vi.mocked(uploadLiveInterviewChunk).mock.calls.map(call => [call[0], call[3]])).toEqual([
      ['session-1', 0], ['session-1', 3000],
    ])
  })
  it('reopens capture with a different microphone selected while paused', async () => {
    await mount(); await start(); button('暂停').click(); await flush()
    const device = root!.querySelector<HTMLSelectElement>('[aria-label="录音输入设备"]')!
    device.value = 'usb'; device.dispatchEvent(new Event('change')); await flush()
    expect(capture.stop).toHaveBeenCalledOnce()
    expect(createInterviewAudioCapture).toHaveBeenCalledOnce()
    const replacement = { ...capture, stream: { getAudioTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream, stop: vi.fn() }
    vi.mocked(createInterviewAudioCapture).mockResolvedValue(replacement)
    button('继续').click(); await flush()
    expect(createInterviewAudioCapture).toHaveBeenLastCalledWith('microphone', expect.objectContaining({ microphoneDeviceId: 'usb' }))
    expect(Recorder.instances[1]!.stream).toBe(replacement.stream)
    expect(createLiveInterviewSession).toHaveBeenCalledOnce()
  })
  it('stays paused if new sharing authorization is cancelled and allows retrying', async () => {
    await mount(); await start(); await tick(3000)
    button('暂停').click(); await flush(); await selectMode('meeting')
    vi.mocked(createInterviewAudioCapture).mockRejectedValueOnce(new InterviewAudioCaptureError('meeting', '取消了会议音频共享'))
    button('继续').click(); await flush()
    expect(root!.querySelector('.session-state')!.textContent).toContain('录音已暂停')
    expect(root!.querySelector('[role="alert"]')!.textContent).toContain('取消了会议音频共享')
    expect(root!.querySelector<HTMLSelectElement>('[aria-label="音频采集方式"]')!.disabled).toBe(false)
    expect(Recorder.instances).toHaveLength(1)
    expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce()
    const replacement = { ...capture, stream: { getAudioTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream, stop: vi.fn() }
    vi.mocked(createInterviewAudioCapture).mockResolvedValue(replacement)
    button('继续').click(); await flush()
    expect(createInterviewAudioCapture).toHaveBeenLastCalledWith('meeting', expect.any(Object))
    expect(root!.querySelector('.session-state')!.textContent).toContain('正在录音')
    expect(createLiveInterviewSession).toHaveBeenCalledOnce()
    expect(Recorder.instances[1]!.stream).toBe(replacement.stream)
    expect(root!.querySelector('.session-elapsed')!.textContent).toBe('00:03')
  })
  it('does not resume capture after consent is unchecked while paused', async () => {
    await mount(); await start(); button('暂停').click(); await flush()
    await consent()
    expect(button('继续').disabled).toBe(true)
    button('继续').click(); await flush()
    expect(capture.setPaused).not.toHaveBeenCalledWith(false)
    expect(Recorder.instances).toHaveLength(1)
  })
  it('locks settings until the paused recorder has flushed its final audio', async () => {
    await mount(); await start()
    const active = Recorder.instances[0]!
    vi.spyOn(active, 'stop').mockImplementation(() => { active.state = 'inactive' })
    button('暂停').click(); await flush()
    expect(root!.querySelector<HTMLSelectElement>('[aria-label="音频采集方式"]')!.disabled).toBe(true)
    expect(button('继续').disabled).toBe(true)
    active.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) }); active.onstop?.(); await flush()
    expect(root!.querySelector<HTMLSelectElement>('[aria-label="音频采集方式"]')!.disabled).toBe(false)
    expect(button('继续').disabled).toBe(false)
    expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce()
  })
  it('pauses and saves collected audio when sharing ends, without silent microphone fallback', async () => {
    await mount(); await selectMode('meeting'); await start(); await tick(3000)
    vi.mocked(createInterviewAudioCapture).mock.calls[0]![1]!.onSourceEnded!('meeting'); await flush()
    expect(root!.textContent).toContain('共享已停止')
    expect(root!.textContent).toContain('不会自动改为仅麦克风录音')
    expect(root!.textContent).toContain('录音已暂停')
    expect(capture.stop).toHaveBeenCalledOnce()
    expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce()
    await tick(30000)
    expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce()
    expect(createInterviewAudioCapture).toHaveBeenCalledOnce()
  })
  it('unlocks settings if sharing ends while paused and reauthorizes the same session on continue', async () => {
    await mount(); await selectMode('meeting'); await start()
    button('暂停').click(); await flush()
    expect(root!.querySelector<HTMLSelectElement>('[aria-label="音频采集方式"]')!.disabled).toBe(false)
    vi.mocked(createInterviewAudioCapture).mock.calls[0]![1]!.onSourceEnded!('meeting'); await flush()
    expect(root!.querySelector<HTMLSelectElement>('[aria-label="音频采集方式"]')!.disabled).toBe(false)
    const replacement = { ...capture, stream: { getAudioTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream, stop: vi.fn() }
    vi.mocked(createInterviewAudioCapture).mockResolvedValue(replacement)
    button('继续').click(); await flush()
    expect(createInterviewAudioCapture).toHaveBeenCalledTimes(2)
    expect(createLiveInterviewSession).toHaveBeenCalledOnce()
    expect(root!.textContent).toContain('正在录音')
    expect(Recorder.instances[1]!.stream).toBe(replacement.stream)
  })
  it('releases sources even if ending the session fails', async () => {
    vi.mocked(endLiveInterviewSession).mockRejectedValue(new Error('save failed'))
    await mount(); await start(); button('结束面试').click(); await flush()
    expect(capture.stop).toHaveBeenCalledOnce()
    expect(root!.querySelector('[role="alert"]')!.textContent).toContain('save failed')
    expect(loadQuestionSheets).not.toHaveBeenCalled()
  })
  it('retries a temporary empty proxy 500 with the same audio and keeps recording', async () => {
    vi.mocked(uploadLiveInterviewChunk).mockRejectedValueOnce(new ApiNetworkError('proxy unavailable', { status: 500 }))
    await mount(); await start(); await tick(15000)
    expect(root!.textContent).toContain('正在重试保存录音')
    expect(capture.stop).not.toHaveBeenCalled()
    await tick(1000)
    expect(uploadLiveInterviewChunk).toHaveBeenCalledTimes(2)
    expect(vi.mocked(uploadLiveInterviewChunk).mock.calls[1]).toEqual(vi.mocked(uploadLiveInterviewChunk).mock.calls[0])
    expect(root!.querySelector('.session-state')!.textContent).toContain('正在录音')
    expect(root!.textContent).not.toContain('正在重试保存录音')
    expect(capture.stop).not.toHaveBeenCalled()
  })
  it('keeps recording after retries are exhausted and replays the same chunk key on recovery', async () => {
    vi.mocked(uploadLiveInterviewChunk).mockRejectedValue(new ApiNetworkError('proxy unavailable', { status: 500 }))
    await mount(); await start(); await tick(18000)
    expect(uploadLiveInterviewChunk).toHaveBeenCalledTimes(3)
    expect(capture.stop).not.toHaveBeenCalled()
    expect(root!.querySelector('.session-state')!.textContent).toContain('正在录音')
    expect(root!.textContent).toContain('待处理音频已保留')
    const firstCall = vi.mocked(uploadLiveInterviewChunk).mock.calls[0]
    vi.mocked(uploadLiveInterviewChunk).mockResolvedValue([])
    window.dispatchEvent(new Event('online')); await flush()
    expect(vi.mocked(uploadLiveInterviewChunk).mock.calls[3]).toEqual(firstCall)
    expect(uploadLiveInterviewChunk).toHaveBeenCalledTimes(4)
    expect(createLiveInterviewSession).toHaveBeenCalledOnce()
    expect(root!.querySelector('.session-state')!.textContent).toContain('正在录音')
  })
  it('does not end the session or navigate when audio remains unsaved', async () => {
    vi.mocked(uploadLiveInterviewChunk).mockRejectedValue(new ApiNetworkError('proxy unavailable', { status: 500 }))
    const router = await mount(); await start(); await tick(18000)
    button('结束面试').click(); await flush(); await tick(3000)
    expect(endLiveInterviewSession).not.toHaveBeenCalled()
    expect(loadQuestionSheets).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/interviews/interview-1/live')
    expect(root!.querySelector('[role="alert"]')!.textContent).toContain('仍有录音未保存')
    expect(button('继续')).toBeDefined()
  })
  it.each([
    new ApiNetworkError('response lost'),
    new ApiNetworkError('gateway failure', { status: 502 }),
    new ApiNetworkError('service unavailable', { status: 503 }),
    new ApiNetworkError('gateway timeout', { status: 504 }),
    new ApiResponseError('forbidden', { status: 403, code: 'FORBIDDEN' }),
    new ApiResponseError('ASR unavailable', { status: 502, code: 'FUNASR_UPSTREAM' }),
  ])('retains audio and continues recording across network, gateway and permission failures: %s', async failure => {
    vi.mocked(uploadLiveInterviewChunk).mockRejectedValue(failure)
    await mount(); await start(); await tick(15000); await tick(3000)
    expect(uploadLiveInterviewChunk).toHaveBeenCalledTimes(failure.status === 403 ? 1 : 3)
    expect(root!.querySelector('.session-state')!.textContent).toContain('正在录音')
    expect(root!.textContent).toContain('待处理音频已保留')
    expect(button('重试保存')).toBeDefined()
    expect(capture.stop).not.toHaveBeenCalled()
    expect(savePendingAudio).toHaveBeenCalledOnce()
    const calls = vi.mocked(uploadLiveInterviewChunk).mock.calls
    expect(calls.every(call => call[4] === calls[0]![4])).toBe(true)
  })
  it('tells users manual mode does not capture either audio source when ASR is unavailable', async () => {
    vi.mocked(apiClient.getJson).mockImplementation(async path => ({ data: path === '/candidates' ? [] : path === '/jobs' ? [] : { checks: { externalServices: { funasr: 'unavailable' } } } }) as never)
    await mount(); await consent(); button('仅手动记录').click(); await flush()
    expect(root!.textContent).toContain('不会采集麦克风或会议音频')
    expect(createInterviewAudioCapture).not.toHaveBeenCalled()
    expect(root!.textContent).toContain('手动记录中')
  })
  it('records and caches audio when transcription is unavailable before starting', async () => {
    vi.mocked(apiClient.getJson).mockImplementation(async path => ({ data: path === '/candidates' ? [] : path === '/jobs' ? [] : { checks: { externalServices: { funasr: 'unavailable' } } } }) as never)
    vi.mocked(uploadLiveInterviewChunk).mockRejectedValue(new ApiResponseError('ASR unavailable', { status: 502, code: 'FUNASR_UPSTREAM' }))
    await mount(); await start(); await tick(18000)
    expect(root!.querySelector('.session-state')!.textContent).toContain('正在录音')
    expect(createInterviewAudioCapture).toHaveBeenCalledOnce()
    expect(savePendingAudio).toHaveBeenCalledOnce()
    expect(root!.textContent).toContain('待保存录音：1 段')
    button('暂停').click(); await flush(); await tick(2000)
    expect(root!.querySelector('.session-state')!.textContent).toContain('录音已暂停')
    expect(button('继续')).toBeDefined()
  })
  it('keeps a five-minute offline recording and uploads all complete chunks after reconnection', async () => {
    vi.mocked(uploadLiveInterviewChunk).mockRejectedValue(new ApiNetworkError('offline'))
    await mount(); await start()
    for (let i = 0; i < 21; i++) await tick(15000)
    expect(Recorder.instances).toHaveLength(22)
    expect(savePendingAudio).toHaveBeenCalledTimes(21)
    expect(root!.textContent).toContain('待保存录音：21 段')
    expect(capture.stop).not.toHaveBeenCalled()
    vi.mocked(uploadLiveInterviewChunk).mockResolvedValue([])
    window.dispatchEvent(new Event('online')); await flush(); await tick(3000)
    const offsets = new Set(vi.mocked(uploadLiveInterviewChunk).mock.calls.map(call => call[3]))
    expect(offsets.size).toBe(21)
    expect(root!.textContent).not.toContain('待保存录音：')
    expect(root!.querySelector('.session-state')!.textContent).toContain('正在录音')
  })
  it('restores only the pending chunks returned for the current session and reuses their keys', async () => {
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', status: 'active', currentQuestion: '介绍项目' }, segments: [] } as never)
    vi.mocked(restorePendingAudio).mockResolvedValue([{ id: 'audio-restored', scope: '', sessionId: 'session-1', audio: new Blob(['audio']), contentType: 'audio/webm', offsetMs: 15000, endMs: 30000 }])
    await mount()
    expect(restorePendingAudio).toHaveBeenCalledWith('', 'session-1')
    expect(uploadLiveInterviewChunk).toHaveBeenCalledWith('session-1', 'YXVkaW8=', 'audio/webm', 15000, 'audio-restored', undefined, undefined, 30000)
    expect(root!.textContent).not.toContain('待保存录音：')
  })
  it('does not navigate away or stop capture when the user accidentally leaves the room', async () => {
    const router = await mount(); await start()
    await router.push('/interviews/interview-1'); await flush()
    expect(router.currentRoute.value.path).toBe('/interviews/interview-1/live')
    expect(capture.stop).not.toHaveBeenCalled()
    expect(root!.textContent).toContain('请先结束面试并保存录音')
  })
  it('recovers audio after focus returns without creating a new session', async () => {
    capture.resume = vi.fn(async () => undefined)
    await mount(); await start()
    document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); await flush()
    expect(capture.resume).toHaveBeenCalledTimes(2)
    expect(capture.stop).not.toHaveBeenCalled()
    expect(createLiveInterviewSession).toHaveBeenCalledOnce()
  })
  it('does not score one-character fragments as complete candidate answers', async () => {
    vi.mocked(uploadLiveInterviewChunk).mockResolvedValue([{ id: 'fragment', sessionId: 'session-1', speakerId: 'role_candidate', role: 'candidate', confidence: .9, text: '我。', startMs: 0, endMs: 1000, status: 'transcribed' }])
    await mount(); await start(); await tick(30000)
    expect(analyzeLiveSegment).not.toHaveBeenCalled()
    expect(root!.textContent).toContain('本段仅识别到零散短字')
  })
  it('reconnects a streaming connection lost while paused when recording resumes', async () => {
    class ReadySocket extends EventTarget {
      static OPEN = 1; static CLOSING = 2
      static instances: ReadySocket[] = []
      readyState = 1
      onmessage?: (event: { data: string }) => void
      onclose?: () => void
      constructor() {
        super(); ReadySocket.instances.push(this)
        queueMicrotask(() => this.dispatchEvent(new Event('open')))
      }
      close() { this.readyState = 3; this.onclose?.() }
      send() {}
    }
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 0 } })
    vi.stubGlobal('WebSocket', ReadySocket)
    vi.stubGlobal('AudioContext', class {
      state = 'running'; sampleRate = 48000; destination = {}
      resume = vi.fn(async () => undefined)
      close = vi.fn(async () => undefined)
      createMediaStreamSource = node
      createGain = node
      createScriptProcessor = node
    })
    await mount(); await start()
    const socket = ReadySocket.instances[0]!
    socket.onmessage?.({ data: JSON.stringify({ type: 'status', status: 'ready' }) }); await flush()
    expect(root!.textContent).toContain('流式识别中')
    button('暂停').click(); await flush()
    socket.close(); await flush()
    expect(root!.textContent).toContain('流式不可用，使用分段识别')
    await tick(10000)
    expect(ReadySocket.instances).toHaveLength(1)
    button('继续').click(); await flush(); await tick(5000)
    expect(ReadySocket.instances).toHaveLength(2)
    expect(root!.querySelector('.session-state')!.textContent).toContain('正在录音')
    expect(createLiveInterviewSession).toHaveBeenCalledOnce()
  })
  it('keeps rotating independent audio files for more than five minutes and combines the complete answer', async () => {
    vi.mocked(uploadLiveInterviewChunk).mockImplementation(async (_id, _base64, _type, offset) => [{ id: `s-${offset}`, sessionId: 'session-1', role: 'candidate', confidence: 0.9, speakerId: 'voice_candidate', text: `回答${offset}。`, startMs: offset, endMs: offset + 14000, status: 'transcribed' }])
    await mount(); await selectMode('meeting'); await start()
    for (let i = 0; i < 21; i++) await tick(15000)
    expect(uploadLiveInterviewChunk).toHaveBeenCalledTimes(21)
    const offsets = vi.mocked(uploadLiveInterviewChunk).mock.calls.map(call => call[3])
    expect(offsets).toEqual(Array.from({ length: 21 }, (_, i) => i * 15000))
    expect(Recorder.instances).toHaveLength(22)
    expect(root!.querySelectorAll('.utterance')).toHaveLength(1)
    expect(root!.querySelector('.utterance')!.textContent).toContain('回答0。')
    expect(root!.querySelector('.utterance')!.textContent).toContain('回答300000。')
    expect(capture.stop).not.toHaveBeenCalled()
  })
  it('releases all sources and opens the summary without waiting for reference-sheet scores', async () => {
    const router = await mount(); await start(); await tick(1000)
    button('结束面试').click(); await flush()
    expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce()
    expect(capture.stop).toHaveBeenCalledOnce()
    expect(endLiveInterviewSession).toHaveBeenCalledWith('session-1')
    expect(loadQuestionSheets).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/interviews/interview-1')
    expect(router.currentRoute.value.query.openSummary).toBe('1')
  })
  it('cleans up a permission result returned after leaving the page', async () => {
    let resolveCapture!: (value: InterviewAudioCapture) => void
    vi.mocked(createInterviewAudioCapture).mockReturnValue(new Promise(resolve => { resolveCapture = resolve }))
    await mount(); await start(); app!.unmount(); app = undefined
    resolveCapture(capture); await flush()
    expect(capture.stop).toHaveBeenCalledOnce()
    expect(createLiveInterviewSession).not.toHaveBeenCalled()
  })
  it('stops capture if the page is left while paused', async () => {
    await mount(); await start(); button('暂停').click(); await flush()
    app!.unmount(); app = undefined; await flush()
    expect(capture.stop).toHaveBeenCalledOnce()
    await tick(30000)
    expect(Recorder.instances).toHaveLength(1)
  })
})

describe('live interview chronological transcript', () => {
  const speech = (id: string, text: string, startMs: number, role: 'candidate' | 'interviewer' | 'unknown' = 'unknown') => ({
    id, text, startMs, endMs: startMs + 1000, sessionId: 'session-1', speakerId: `voice_${role}`, role, confidence: .35, status: 'transcribed' as const,
  })
  const texts = () => [...root!.querySelectorAll('.utterance > p')].map(row => row.textContent)

  it('merges manually confirmed speakers, restores the merge and allows correcting just one original fragment', async () => {
    let saved: LiveInterviewSegment[] = [
      { ...speech('first', '第一段发言。', 0), speakerId: 'voice_a', audioSource: 'microphone' },
      { ...speech('second', '第二段发言。', 1500), speakerId: 'voice_b', audioSource: 'microphone' },
    ]
    vi.mocked(findActiveLiveInterviewSession).mockImplementation(async () => ({ session: { id: 'session-1', status: 'completed' }, segments: saved.map(row => ({ ...row })) }) as never)
    vi.mocked(correctLiveSegmentRole).mockImplementation(async (id, role, ids) => {
      const selected = ids?.length ? ids : [id]
      saved = saved.map(row => selected.includes(row.id) ? { ...row, role, confidence: 1, speakerConfirmed: true } : row)
      return saved.filter(row => selected.includes(row.id)).map(row => ({ ...row }))
    })
    await mount()
    expect(texts()).toEqual(['第一段发言。', '第二段发言。'])
    const first = root!.querySelectorAll<HTMLElement>('.utterance')[0]!
    ;[...first.querySelectorAll('button')].find(row => row.textContent === '面试官')!.click(); await flush()
    expect(texts()).toHaveLength(2)
    const second = root!.querySelectorAll<HTMLElement>('.utterance')[1]!
    ;[...second.querySelectorAll('button')].find(row => row.textContent === '面试官')!.click(); await flush()
    expect(texts()).toEqual(['第一段发言。第二段发言。'])
    expect(root!.querySelector('.utterance-identity')!.textContent).toContain('已合并 2 段')
    expect(root!.querySelectorAll('.utterance-fragment')).toHaveLength(2)
    expect(saved.map(row => row.speakerId)).toEqual(['voice_a', 'voice_b'])

    app!.unmount(); root!.remove(); app = undefined; root = undefined
    await mount()
    expect(texts()).toEqual(['第一段发言。第二段发言。'])
    const fragment = root!.querySelector<HTMLElement>('[data-segment-id="second"]')!
    ;[...fragment.querySelectorAll('button')].find(row => row.textContent === '候选人')!.click(); await flush()
    expect(correctLiveSegmentRole).toHaveBeenLastCalledWith('second', 'candidate', ['second'])
    expect(texts()).toEqual(['第一段发言。', '第二段发言。'])
    expect(root!.querySelectorAll('.utterance-fragment')).toHaveLength(0)
    expect(analyzeLiveSegment).not.toHaveBeenCalled()
  })

  it('sends every fragment when analyzing a manually merged candidate answer', async () => {
    vi.mocked(analyzeLiveSegment).mockReturnValue(deferred<never>().promise)
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', status: 'active' }, segments: [
      { ...speech('question', '请介绍你的项目经历。', 0, 'interviewer'), confidence: 1, speakerConfirmed: true },
      { ...speech('first', '我负责需求分析并完成了系统开发。', 2000, 'candidate'), speakerId: 'voice_a', confidence: 1, speakerConfirmed: true },
      { ...speech('second', '之后推进了上线验收和生产优化。', 3500, 'candidate'), speakerId: 'voice_b', confidence: 1, speakerConfirmed: true },
    ] } as never)
    await mount()
    expect(texts()).toEqual(['请介绍你的项目经历。', '我负责需求分析并完成了系统开发。之后推进了上线验收和生产优化。'])
    expect(analyzeLiveSegment).toHaveBeenCalledWith('first', '', ['first', 'second'])
  })

  it('refines the complete merged answer on analysis, keeps the raw text, and restores it without another request', async () => {
    const saved = [
      { ...speech('question', '请介绍你的项目经历。', 0, 'interviewer'), confidence: 1, speakerConfirmed: true },
      { ...speech('first', '我用微付务完成了系统开发，嗯完成了系统开发。', 2000, 'candidate'), speakerId: 'voice_a', confidence: 1, speakerConfirmed: true },
      { ...speech('second', '上线后做了性能优化，响应缩短到两秒。', 3500, 'candidate'), speakerId: 'voice_b', confidence: 1, speakerConfirmed: true },
    ]
    const result = {
      summary: '介绍开发和优化经历。', evidence: [], scores: [], concerns: [], confidence: .9, nextQuestion: '',
      transcriptRefinement: {
        text: '我用微服务完成了系统开发，上线后做了性能优化，响应缩短到两秒。',
        corrections: [{ original: '微付务', corrected: '微服务' }], uncertainties: ['“两秒”的测试条件需要核实。'],
      },
      sourceSegments: saved.slice(1).map(({ id, text, role, speakerId }) => ({ id, text, role, speakerId })),
    }
    const initial = deferred<typeof result>()
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', status: 'active' }, segments: saved } as never)
    vi.mocked(analyzeLiveSegment).mockReturnValueOnce(initial.promise as never).mockResolvedValue(result as never)
    await mount()
    expect(root!.querySelector('.refined-answer')).toBeNull()
    initial.resolve(result); await flush()
    expect(root!.querySelector('.refined-answer')!.textContent).toBe(result.transcriptRefinement.text)
    expect(root!.querySelector('.answer-original')!.textContent).toContain(saved[1]!.text)
    expect(root!.querySelector('.answer-original')!.textContent).toContain(saved[2]!.text)
    expect(root!.querySelector('.answer-corrections')!.textContent).toContain('微付务 → 微服务')
    expect(root!.querySelector('.answer-uncertainties')).toBeNull()
    expect(root!.textContent).not.toContain('测试条件需要核实')
    expect(root!.querySelectorAll('.utterance-fragment')).toHaveLength(2)
    const answer = root!.querySelectorAll('.utterance')[1]!
    ;[...answer.querySelectorAll('button')].find(row => row.textContent === '分析完整回答')!.click(); await flush()
    expect(analyzeLiveSegment).toHaveBeenLastCalledWith('first', '', ['first', 'second'])
    expect(analyzeLiveSegment).toHaveBeenCalledTimes(2)

    app!.unmount(); root!.remove(); app = undefined; root = undefined
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', status: 'active' }, segments: saved.map(row => row.id === 'first' ? { ...row, analysis: result } : row) } as never)
    await mount(); await tick(30000)
    expect(root!.querySelector('.refined-answer')!.textContent).toBe(result.transcriptRefinement.text)
    expect(analyzeLiveSegment).toHaveBeenCalledTimes(2)
  })

  it('manually refines merged interviewer speech and restores it without candidate scoring or automatic analysis', async () => {
    const saved = [
      { ...speech('first', '请介绍你使用微付务完成系统开发的经历。', 0, 'interviewer'), speakerId: 'voice_a', confidence: 1, speakerConfirmed: true },
      { ...speech('second', '还有上线验收时遇到的问题和解决方法。', 1500, 'interviewer'), speakerId: 'voice_b', confidence: 1, speakerConfirmed: true },
    ]
    const result = {
      summary: '面试官完整发言已整理。', evidence: [], scores: [], concerns: [], confidence: 1, nextQuestion: '',
      transcriptRefinement: {
        text: '请介绍你使用微服务完成系统开发的经历，以及上线验收时遇到的问题和解决方法。',
        corrections: [{ original: '微付务', corrected: '微服务' }], uncertainties: [],
      },
      sourceSegments: saved.map(({ id, text, role, speakerId }) => ({ id, text, role, speakerId })),
    }
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', status: 'active' }, segments: saved } as never)
    vi.mocked(analyzeLiveSegment).mockResolvedValue(result as never)
    await mount(); await tick(30000)
    expect(analyzeLiveSegment).not.toHaveBeenCalled()
    expect(button('分析完整回答').getAttribute('title')).toContain('不参与候选人评分')
    button('分析完整回答').click(); await flush()
    expect(analyzeLiveSegment).toHaveBeenCalledOnce()
    expect(analyzeLiveSegment).toHaveBeenCalledWith('first', '', ['first', 'second'])
    expect(root!.querySelector('.refined-answer-label')!.textContent).toBe('整理后的发言')
    expect(root!.querySelector('.refined-answer')!.textContent).toBe(result.transcriptRefinement.text)
    expect(root!.querySelector('.answer-original')!.textContent).toContain(saved[0]!.text)
    expect(root!.querySelector('.answer-original')!.textContent).toContain(saved[1]!.text)
    expect(root!.querySelector('.answer-corrections')!.textContent).toContain('微付务 → 微服务')
    expect(root!.querySelector('.analysis-panel')!.textContent).not.toContain(result.summary)

    button('编辑').click(); await flush()
    expect(button('分析完整回答').disabled).toBe(true)
    const draft = root!.querySelector('textarea.refinement-input')!
    ;(draft as HTMLTextAreaElement).value = '请介绍微服务项目的上线验收经历。'
    draft.dispatchEvent(new Event('input')); await flush()
    const updated = { ...result.transcriptRefinement, text: '请介绍微服务项目的上线验收经历。', editedAt: '2026-10-23T00:00:00Z', editedBy: 'u' }
    vi.mocked(saveLiveTranscriptRefinement).mockResolvedValue(updated)
    button('保存修改').click(); await flush()
    expect(saveLiveTranscriptRefinement).toHaveBeenCalledWith('first', updated.text, result.transcriptRefinement.text, result.sourceSegments)
    expect(root!.querySelector('.refined-answer')!.textContent).toBe(updated.text)
    expect(root!.querySelector('.answer-original')!.textContent).toContain(saved[0]!.text)
    result.transcriptRefinement = updated

    app!.unmount(); root!.remove(); app = undefined; root = undefined
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', status: 'completed' }, segments: saved.map(row => row.id === 'first' ? { ...row, analysis: result } : row) } as never)
    await mount(); await tick(30000)
    expect(root!.querySelector('.refined-answer')!.textContent).toBe(result.transcriptRefinement.text)
    expect(root!.querySelector('.analysis-panel')!.textContent).not.toContain(result.summary)
    expect(analyzeLiveSegment).toHaveBeenCalledOnce()
  })

  it('discards an in-flight refinement when another fragment joins the answer and analyzes the expanded group', async () => {
    const saved = [
      { ...speech('first', '我负责需求分析并完成了系统开发。', 0, 'candidate'), confidence: 1, speakerConfirmed: true },
      { ...speech('second', '上线后继续做了性能优化。', 2000), speakerId: 'voice_second', confidence: 1 },
    ]
    const initial = deferred<Awaited<ReturnType<typeof analyzeLiveSegment>>>()
    const expanded = deferred<Awaited<ReturnType<typeof analyzeLiveSegment>>>()
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', status: 'active' }, segments: saved } as never)
    vi.mocked(analyzeLiveSegment).mockReturnValueOnce(initial.promise).mockReturnValueOnce(expanded.promise)
    vi.mocked(correctLiveSegmentRole).mockResolvedValue([{ ...saved[1]!, role: 'candidate', speakerConfirmed: true }] as never)
    await mount()
    expect(analyzeLiveSegment).toHaveBeenCalledWith('first', '', ['first'])
    const second = root!.querySelectorAll('.utterance')[1]!
    ;[...second.querySelectorAll('button')].find(row => row.textContent === '候选人')!.click(); await flush()
    expect(root!.querySelectorAll('.utterance')).toHaveLength(1)
    initial.resolve({
      summary: '旧结果', evidence: [], scores: [], concerns: [], confidence: .9, nextQuestion: '',
      transcriptRefinement: { text: '只整理了第一段的旧结果。', corrections: [], uncertainties: [] },
      sourceSegments: saved.slice(0, 1).map(({ id, text, role, speakerId }) => ({ id, text, role, speakerId })),
    } as never)
    await flush()
    expect(root!.querySelector('.refined-answer')).toBeNull()
    expect(analyzeLiveSegment).toHaveBeenLastCalledWith('first', '', ['first', 'second'])
    expanded.resolve({
      summary: '新结果', evidence: [], scores: [], concerns: [], confidence: .9, nextQuestion: '',
      transcriptRefinement: { text: '我负责需求分析并完成了系统开发，上线后继续做了性能优化。', corrections: [], uncertainties: [] },
    } as never)
    await flush()
    expect(root!.querySelector('.refined-answer')!.textContent).toContain('上线后继续做了性能优化')
    const fragment = root!.querySelector('[data-segment-id="second"]')!
    vi.mocked(correctLiveSegmentRole).mockResolvedValue([{ ...saved[1]!, role: 'interviewer', speakerConfirmed: true }] as never)
    vi.mocked(analyzeLiveSegment).mockReturnValue(deferred<never>().promise)
    ;[...fragment.querySelectorAll('button')].find(row => row.textContent === '面试官')!.click(); await flush()
    expect(root!.querySelectorAll('.utterance')).toHaveLength(2)
    expect(root!.querySelector('.refined-answer')).toBeNull()
  })

  it('does not analyze old answers when reopening a completed interview', async () => {
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', status: 'completed' }, segments: [
      { ...speech('answer', '我负责需求分析并完成系统开发和验收。', 3000, 'candidate'), confidence: .9 },
    ] } as never)
    await mount(); await tick(30000)
    expect(analyzeLiveSegment).not.toHaveBeenCalled()
    expect(root!.querySelector('.analysis-panel')!.textContent).toContain('我负责需求分析并完成系统开发和验收。')
    expect(root!.querySelector('.analysis-panel')!.textContent).toContain('未配对与待确认发言')
  })

  it('manually analyzes the complete merged answer after completion without restarting recording', async () => {
    const saved = [
      { ...speech('first', '我用微付务完成系统开发。', 2000, 'candidate'), speakerId: 'voice_a', confidence: 1, speakerConfirmed: true },
      { ...speech('second', '然后完成上线验收和性能优化。', 3500, 'candidate'), speakerId: 'voice_b', confidence: 1, speakerConfirmed: true },
    ]
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', status: 'completed' }, segments: saved } as never)
    const pending = deferred<never>()
    vi.mocked(analyzeLiveSegment).mockReturnValue(pending.promise)
    await mount()
    expect(analyzeLiveSegment).not.toHaveBeenCalled()
    expect(button('分析完整回答').disabled).toBe(false)
    button('分析完整回答').click(); await flush()
    expect(analyzeLiveSegment).toHaveBeenCalledOnce()
    expect(analyzeLiveSegment).toHaveBeenCalledWith('first', '', ['first', 'second'])
    expect(button('分析中...').disabled).toBe(true)
    expect(button('分析中...').getAttribute('aria-busy')).toBe('true')
    expect(root!.querySelector('.utterance [role="status"]')!.textContent).toContain('正在整理并分析完整回答')
    button('分析中...').click(); await flush()
    expect(analyzeLiveSegment).toHaveBeenCalledOnce()
    pending.resolve({ summary: '完成开发和上线。', evidence: [], scores: [], concerns: [], confidence: .9, nextQuestion: '',
      transcriptRefinement: { text: '我用微服务完成系统开发，然后完成上线验收和性能优化。', corrections: [{ original: '微付务', corrected: '微服务' }], uncertainties: [] },
    } as never)
    await flush()
    expect(root!.querySelector('.refined-answer')!.textContent).toContain('微服务')
    expect(root!.querySelector('.answer-original')!.textContent).toContain('微付务')
    expect(root!.querySelector('.utterance [role="status"]')).toBeNull()
    await tick(30000)
    expect(analyzeLiveSegment).toHaveBeenCalledOnce()
    expect(createLiveInterviewSession).not.toHaveBeenCalled()
    expect(createInterviewAudioCapture).not.toHaveBeenCalled()
    expect(endLiveInterviewSession).not.toHaveBeenCalled()
  })

  it('shows completed-answer analysis failures next to the answer and allows manual retry', async () => {
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', status: 'completed' }, segments: [
      { ...speech('answer', '我负责需求分析并完成系统开发和验收。', 3000, 'candidate'), confidence: 1 },
    ] } as never)
    vi.mocked(analyzeLiveSegment).mockRejectedValueOnce(new Error('模型暂时不可用'))
    await mount()
    button('分析完整回答').click(); await flush()
    expect(root!.querySelector('.utterance [role="alert"]')!.textContent).toBeTruthy()
    expect(button('重新分析完整回答').disabled).toBe(false)
    await tick(30000)
    expect(analyzeLiveSegment).toHaveBeenCalledOnce()
    vi.mocked(analyzeLiveSegment).mockResolvedValue({ summary: '已完成分析', evidence: [], scores: [], concerns: [], confidence: .9, nextQuestion: '',
      transcriptRefinement: { text: '我负责需求分析、系统开发和验收。', corrections: [], uncertainties: [] },
    } as never)
    button('重新分析完整回答').click(); await flush()
    expect(analyzeLiveSegment).toHaveBeenCalledTimes(2)
    expect(root!.querySelector('.utterance [role="alert"]')).toBeNull()
    expect(root!.querySelector('.refined-answer')!.textContent).toContain('系统开发和验收')
  })

  it('shows a retry notice instead of accepting analysis of outdated completed-answer text', async () => {
    const saved = { ...speech('answer', '我负责需求分析并完成系统开发和验收。', 3000, 'candidate'), confidence: 1 }
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', status: 'completed' }, segments: [saved] } as never)
    vi.mocked(analyzeLiveSegment).mockResolvedValue({ summary: '旧结果', evidence: [], scores: [], concerns: [], confidence: .9, nextQuestion: '',
      transcriptRefinement: { text: '不应展示的旧回答。', corrections: [], uncertainties: [] },
      sourceSegments: [{ id: saved.id, text: '已经变更的原文', role: saved.role, speakerId: saved.speakerId }],
    } as never)
    await mount()
    button('分析完整回答').click(); await flush()
    expect(root!.querySelector('.refined-answer')).toBeNull()
    expect(root!.querySelector('.utterance [role="status"]')!.textContent).toContain('回答内容或说话人已变更')
    expect(button('重新分析完整回答').disabled).toBe(false)
    await tick(30000)
    expect(analyzeLiveSegment).toHaveBeenCalledOnce()
  })

  it('shows no score rather than zero or confidence when evidence is insufficient', async () => {
    vi.mocked(analyzeLiveSegment).mockResolvedValue({ summary: '无法确认实际提问，暂不评分。', scores: [], evidence: [], concerns: [], confidence: 0, nextQuestion: '' } as never)
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', status: 'active' }, segments: [
      { ...speech('answer', '我负责需求分析并完成系统开发和验收。', 3000, 'candidate'), confidence: .9 },
    ] } as never)
    await mount()
    const panel = root!.querySelector('.analysis-panel')!
    expect(panel.textContent).toContain('暂不评分')
    expect(panel.textContent).not.toContain('0/10')
    expect(panel.textContent).not.toContain('置信度')
    expect(panel.textContent).not.toContain('0%')
  })

  it('renders the actual question and candidate quote for every scored dimension', async () => {
    vi.mocked(analyzeLiveSegment).mockResolvedValue({ summary: '有实际项目证据', scores: [{ dimension: '项目交付', score: 7, rationale: '描述了实际工作', questionQuote: '请介绍项目', evidence: ['我负责需求分析'] }], evidence: [], concerns: [], confidence: .8, nextQuestion: '建议追问' } as never)
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', status: 'active' }, segments: [
      { ...speech('answer', '我负责需求分析并完成系统开发和验收。', 3000, 'candidate'), confidence: .9 },
    ] } as never)
    await mount()
    const scores = root!.querySelector('.score-list')!
    expect(scores.textContent).toContain('7/10')
    expect(scores.textContent).toContain('请介绍项目')
    expect(scores.textContent).toContain('我负责需求分析')
    expect(updateLiveInterviewQuestion).not.toHaveBeenCalled()
  })

  it('restores unordered records from beginning to end with project and school exchanges in order', async () => {
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', currentQuestion: '介绍项目', status: 'active' }, segments: [
      speech('school-answer', '毕业答辩时回学校。', 9000, 'candidate'),
      speech('project-answer', '我负责项目的开发。', 3000, 'candidate'),
      speech('school-question', '没毕业还要回学校吗？', 6000, 'interviewer'),
      speech('project-question', '请介绍你的项目。', 0, 'interviewer'),
    ] } as never)
    await mount()
    expect(texts()).toEqual(['请介绍你的项目。', '我负责项目的开发。', '没毕业还要回学校吗？', '毕业答辩时回学校。'])
    expect(root!.querySelector('.transcript-list')!.scrollTop).toBe(0)
  })

  it('inserts late earlier results by recording time rather than upload response order', async () => {
    vi.mocked(uploadLiveInterviewChunk).mockResolvedValueOnce([speech('later', '后面的话题。', 20000)])
      .mockResolvedValueOnce([speech('earlier', '前面的话题。', 0)])
    await mount(); await start(); await tick(15000); await tick(15000)
    expect(texts()).toEqual(['前面的话题。', '后面的话题。'])
  })

  it('leaves actual question and context resolution to the server instead of sending the selected reference', async () => {
    vi.mocked(analyzeLiveSegment).mockReturnValue(deferred<never>().promise)
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', currentQuestion: '介绍项目', status: 'active' }, segments: [
      speech('project-question', '请介绍项目。', 0, 'interviewer'),
      { ...speech('project-answer', '我负责需求分析并完成系统开发和验收。', 3000, 'candidate'), confidence: .9 },
      speech('school-question', '之后是否要回学校？', 6000, 'interviewer'),
      speech('school-answer', '答辩的时候需要回学校。', 9000, 'candidate'),
    ] } as never)
    await mount()
    expect(analyzeLiveSegment).toHaveBeenCalledWith('project-answer', '', ['project-answer'])
  })

  it('follows new speech at the bottom but does not jump while reading older records', async () => {
    let index = 0
    vi.mocked(uploadLiveInterviewChunk).mockImplementation(async () => [speech(String(++index), `发言${index}`, index * 20000)])
    await mount(); await start(); await tick(15000)
    const list = root!.querySelector<HTMLElement>('.transcript-list')!
    let height = 1000
    Object.defineProperties(list, { scrollHeight: { get: () => height }, clientHeight: { value: 300 } })
    list.scrollTop = 700; list.dispatchEvent(new Event('scroll'))
    height = 1200
    await tick(15000)
    expect(list.scrollTop).toBe(1200)
    list.scrollTop = 100; list.dispatchEvent(new Event('scroll'))
    height = 1500
    await tick(15000)
    expect(list.scrollTop).toBe(100)
    expect(texts()).toHaveLength(3)
  })

  class ReadySocket extends EventTarget {
      static OPEN = 1; static CLOSING = 2
      static instance: ReadySocket
      readyState = 1
      onmessage?: (event: { data: string }) => void
      onclose?: () => void
      constructor() { super(); ReadySocket.instance = this; queueMicrotask(() => { this.dispatchEvent(new Event('open')); this.onmessage?.({ data: JSON.stringify({ type: 'status', status: 'ready' }) }) }) }
      close() { this.readyState = 3 }
      send = vi.fn()
      message(type: string, text: string) { this.onmessage?.({ data: JSON.stringify({ type, text }) }) }
      disconnect() { this.readyState = 3; this.onclose?.() }
  }
  function readyStream() {
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 0 } })
    vi.stubGlobal('WebSocket', ReadySocket)
    vi.stubGlobal('AudioContext', class {
      sampleRate = 48000; destination = {}
      resume = vi.fn(async () => undefined); close = vi.fn(async () => undefined)
      createMediaStreamSource = node; createGain = node; createScriptProcessor = node
    })
  }

  it.each([true, false])('removes only persisted stream previews when final arrives before upload: %s', async finalBeforeUpload => {
    readyStream()
    const upload = deferred<Awaited<ReturnType<typeof uploadLiveInterviewChunk>>>()
    vi.mocked(uploadLiveInterviewChunk).mockReturnValueOnce(upload.promise)
    await mount(); await start()
    const socket = ReadySocket.instance
    socket.message('partial', '项目话题预览'); await flush(); await tick(15000)
    if (finalBeforeUpload) { socket.message('final', '项目话题预览'); await flush() }
    expect(root!.querySelector('.stream-preview')?.textContent).toContain('项目话题预览')
    upload.resolve([speech('project', '项目话题预览', 0)]); await flush()
    if (!finalBeforeUpload) { socket.message('final', '项目话题预览'); await flush() }
    expect(uploadLiveInterviewChunk).toHaveBeenCalledWith('session-1', 'YXVkaW8=', 'audio/webm', 0, expect.any(String),
      { text: '项目话题预览', audioSource: 'microphone', endMs: 15000, complete: expect.any(Boolean) }, { id: 'microphone', role: 'unknown', multipleSpeakers: true }, 15000)
    expect(root!.querySelector('.stream-preview')).toBeNull()
    socket.message('partial', '返校话题预览'); await flush()
    expect(root!.querySelector('.stream-preview')!.textContent).toContain('返校话题预览')
    expect(root!.querySelector('.stream-preview')!.textContent).not.toContain('项目话题预览')
    expect(root!.querySelector('.transcript-list')!.lastElementChild!.className).toBe('stream-preview')
    expect(texts()).toEqual(['项目话题预览'])
  })

  it('waits for the complete final, refreshes the local checkpoint, and never auto-scores a mixed-speaker fallback', async () => {
    readyStream()
    const partial = '请介绍你的项目。'
    const full = '请介绍你的项目。我负责招聘平台开发、数据库设计和完整测试。'
    vi.mocked(uploadLiveInterviewChunk).mockResolvedValue([{ ...speech('full', full, 0), speakerId: 'chunk_0:stream_0', endMs: 15000 }])
    await mount(); await start()
    ReadySocket.instance.message('partial', partial)
    await tick(15000)
    expect(uploadLiveInterviewChunk).not.toHaveBeenCalled()
    ReadySocket.instance.message('final', full); await flush()
    expect(uploadLiveInterviewChunk).toHaveBeenCalledWith('session-1', 'YXVkaW8=', 'audio/webm', 0, expect.any(String),
      { text: full, audioSource: 'microphone', endMs: 15000, complete: expect.any(Boolean) }, { id: 'microphone', role: 'unknown', multipleSpeakers: true }, 15000)
    expect(savePendingAudio).toHaveBeenCalledTimes(2)
    expect(vi.mocked(savePendingAudio).mock.lastCall![0].streamingTranscript?.text).toBe(full)
    expect(texts()).toEqual([full])
    expect(root!.textContent).toContain('流式全文保留 · 说话人待确认')
    expect(root!.querySelector('.stream-preview')).toBeNull()
    expect(analyzeLiveSegment).not.toHaveBeenCalled()
  })

  it.each(['暂停', '结束面试'])('flushes the full remaining stream on %s before proceeding', async action => {
    readyStream()
    const full = '这一段在结束录音前也必须完整保存，不能只保存最后一个字。'
    vi.mocked(uploadLiveInterviewChunk).mockImplementation(async (_session, _audio, _type, offset, _id, checkpoint) =>
      [{ ...speech('tail', checkpoint!.text, offset), speakerId: `chunk_${offset}:stream_${offset}`, endMs: checkpoint!.endMs }])
    const router = await mount(); await start(); await tick(2300)
    ReadySocket.instance.message('partial', full)
    button(action).click(); await flush()
    expect(uploadLiveInterviewChunk).not.toHaveBeenCalled()
    expect(endLiveInterviewSession).not.toHaveBeenCalled()
    ReadySocket.instance.message('final', full); await flush()
    expect(uploadLiveInterviewChunk).toHaveBeenCalledWith('session-1', 'YXVkaW8=', 'audio/webm', 0, expect.any(String),
      { text: full, audioSource: 'microphone', endMs: 2300, complete: expect.any(Boolean) }, { id: 'microphone', role: 'unknown', multipleSpeakers: true }, 2300)
    if (action === '结束面试') {
      await tick(2000)
      expect(endLiveInterviewSession).toHaveBeenCalledOnce()
      expect(router.currentRoute.value.path).toBe('/interviews/interview-1')
    } else {
      expect(texts()).toEqual([full])
      expect(button('继续')).toBeDefined()
    }
  })

  it('sends a disconnected partial with its audio instead of silently deleting the preview', async () => {
    readyStream()
    const full = '网络中断前已经识别出的内容也要保存。'
    await mount(); await start(); await tick(3000)
    ReadySocket.instance.message('partial', full)
    ReadySocket.instance.disconnect()
    button('暂停').click(); await flush()
    expect(uploadLiveInterviewChunk).toHaveBeenCalledWith('session-1', 'YXVkaW8=', 'audio/webm', 0, expect.any(String),
      { text: full, audioSource: 'microphone', endMs: 3000, complete: false }, { id: 'microphone', role: 'unknown', multipleSpeakers: true }, 3000)
  })

  it('keeps an immutable audio-plus-text checkpoint on upload failure and retries the same request', async () => {
    readyStream()
    const full = '不能因为保存失败就丢掉已经识别的完整内容。'
    const unavailable = new ApiResponseError('offline', { code: 'SERVICE_UNAVAILABLE', status: 503 })
    vi.mocked(uploadLiveInterviewChunk).mockRejectedValue(unavailable)
    await mount(); await start()
    ReadySocket.instance.message('partial', full); await tick(15000)
    ReadySocket.instance.message('final', full); await flush()
    await tick(3000)
    const first = vi.mocked(uploadLiveInterviewChunk).mock.calls[0]
    expect(uploadLiveInterviewChunk).toHaveBeenCalledTimes(3)
    expect(vi.mocked(uploadLiveInterviewChunk).mock.calls.every(args => JSON.stringify(args) === JSON.stringify(first))).toBe(true)
    expect(first[5]?.text).toBe(full)
    expect(root!.querySelector('.stream-preview')!.textContent).toContain(full)
    expect(removePendingAudio).not.toHaveBeenCalled()
  })
})

describe('streaming reconnection lifecycle', () => {
  class Connection extends EventTarget {
    static OPEN = 1; static CLOSING = 2
    static instances: Connection[] = []
    readyState = 0
    bufferedAmount = 0
    onmessage?: (event: { data: string }) => void
    onerror?: () => void
    onclose?: (event: { code: number }) => void
    send = vi.fn((_value: string | ArrayBuffer) => {})
    close = vi.fn(() => { this.readyState = 3; this.onclose?.({ code: 1000 }) })
    constructor() { super(); Connection.instances.push(this) }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
    message(value: object) { this.onmessage?.({ data: JSON.stringify(value) }) }
    ready(heartbeat = false) { this.message({ type: 'status', status: 'ready', heartbeat }) }
  }
  beforeEach(() => {
    Connection.instances = []
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 0 } })
    vi.stubGlobal('WebSocket', Connection)
    vi.stubGlobal('AudioContext', class {
      state = 'running'; sampleRate = 48000; destination = {}
      resume = vi.fn(async () => undefined); close = vi.fn(async () => undefined)
      createMediaStreamSource = node; createGain = node; createScriptProcessor = node
    })
  })
  async function dualSources() {
    const meetingStream = { getAudioTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream
    capture.sources = [{ source: 'microphone', stream: capture.stream }, { source: 'meeting', stream: meetingStream }]
    await mount(); await selectMode('meeting'); await start()
    const [mic, meeting] = Connection.instances
    mic!.open(); mic!.ready(); meeting!.open(); meeting!.ready(); await flush()
    return { mic: mic!, meeting: meeting!, meetingStream }
  }
  it('records and commits two independent sources, sorting reversed responses by overlapping audio time', async () => {
    const uploads = { microphone: deferred<Awaited<ReturnType<typeof uploadLiveInterviewChunk>>>(), meeting: deferred<Awaited<ReturnType<typeof uploadLiveInterviewChunk>>>() }
    vi.mocked(uploadLiveInterviewChunk).mockImplementation((_session, _audio, _type, _offset, _id, _checkpoint, source) => uploads[source!.id].promise)
    const { mic, meeting, meetingStream } = await dualSources()
    expect(Recorder.instances.map(row => row.stream)).toEqual([capture.stream, meetingStream])
    mic.message({ type: 'partial', text: '本机的完整回答' }); meeting.message({ type: 'partial', text: '会议的插话提问' })
    await tick(15000)
    expect(mic.send).toHaveBeenCalledWith(expect.stringContaining('commitId'))
    expect(meeting.send).toHaveBeenCalledWith(expect.stringContaining('commitId'))
    meeting.message({ type: 'final', text: '会议的插话提问' }); await flush()
    expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce()
    expect(vi.mocked(uploadLiveInterviewChunk).mock.calls[0]![6]?.id).toBe('meeting')
    mic.message({ type: 'final', text: '本机的完整回答' }); await flush()
    for (const call of vi.mocked(uploadLiveInterviewChunk).mock.calls) {
      expect(call[5]?.audioSource).toBe(call[6]?.id); expect(call[6]?.role).toBe('unknown'); expect(call[7]).toBe(15000)
    }
    const row = (id: string, audioSource: 'microphone' | 'meeting', startMs: number, endMs: number, text: string) => ({ id, sessionId: 'session-1', speakerId: audioSource + ':one', audioSource, startMs, endMs, text, role: 'unknown' as const, confidence: .35, status: 'transcribed' })
    uploads.meeting.resolve([row('meeting-row', 'meeting', 250, 3000, '会议的插话提问')]); await flush()
    uploads.microphone.resolve([row('mic-row', 'microphone', 100, 5000, '本机的完整回答')]); await flush()
    expect([...root!.querySelectorAll('.utterance p')].map(el => el.textContent)).toEqual(['本机的完整回答', '会议的插话提问'])
    expect([...root!.querySelectorAll('.utterance-source')].map(el => el.textContent)).toEqual(['本机麦克风', '会议音频'])
    expect(root!.querySelectorAll('.stream-preview')).toHaveLength(0)
  })
  it('reconnects a failed source without resetting the other source or erasing either preview', async () => {
    const { mic, meeting } = await dualSources()
    mic.message({ type: 'partial', text: '断线前的本机全文' }); meeting.message({ type: 'partial', text: '未中断的会议全文' })
    mic.readyState = 3; mic.onclose?.({ code: 1006 }); await flush(); await tick(1000)
    expect(Connection.instances).toHaveLength(3); expect(meeting.close).not.toHaveBeenCalled()
    const replacement = Connection.instances[2]!; replacement.open(); replacement.ready(); await flush()
    expect(root!.querySelector('[data-source="microphone"]')?.textContent).toContain('断线前的本机全文')
    expect(root!.querySelector('[data-source="meeting"]')?.textContent).toContain('未中断的会议全文')
    button('暂停').click(); await flush()
    replacement.message({ type: 'final', text: '' }); meeting.message({ type: 'final', text: '未中断的会议全文' }); await flush()
    const checkpoints = vi.mocked(uploadLiveInterviewChunk).mock.calls.map(call => call[5])
    expect(checkpoints).toContainEqual(expect.objectContaining({ text: '断线前的本机全文', audioSource: 'microphone', complete: false }))
    expect(checkpoints).toContainEqual(expect.objectContaining({ text: '未中断的会议全文', audioSource: 'meeting' }))
  })
  it('snapshots explicit role mappings per chunk and allows changing them only while paused', async () => {
    const { mic, meeting } = await dualSources()
    const role = root!.querySelector<HTMLSelectElement>('[aria-label="本机麦克风角色"]')!
    expect(role.value).toBe('unknown'); expect(role.disabled).toBe(true)
    await tick(1000); button('暂停').click(); await flush()
    mic.message({ type: 'final', text: '' }); meeting.message({ type: 'final', text: '' }); await flush()
    expect(role.disabled).toBe(false)
    role.value = 'candidate'; role.dispatchEvent(new Event('change'))
    root!.querySelector<HTMLInputElement>('[aria-label="本机麦克风包含多人"]')!.click(); await flush()
    button('继续').click(); await flush(); await tick(1000); button('暂停').click(); await flush()
    mic.message({ type: 'final', text: '' }); meeting.message({ type: 'final', text: '' }); await flush()
    const micCalls = vi.mocked(uploadLiveInterviewChunk).mock.calls.filter(call => call[6]?.id === 'microphone')
    expect(micCalls.map(call => call[6])).toEqual([{ id: 'microphone', role: 'unknown', multipleSpeakers: true }, { id: 'microphone', role: 'candidate', multipleSpeakers: false }])
    expect(micCalls.map(call => [call[3], call[7]])).toEqual([[0, 1000], [1000, 2000]])
  })
  it('continues saving new meeting chunks while the microphone upload is awaiting manual retry', async () => {
    vi.mocked(uploadLiveInterviewChunk).mockImplementation(async (_session, _audio, _type, _offset, _id, _checkpoint, source) => {
      if (source?.id === 'microphone') throw new ApiResponseError('denied', { code: 'FORBIDDEN', status: 403 })
      return []
    })
    const { mic, meeting } = await dualSources()
    for (let index = 0; index < 2; index++) {
      await tick(15000); mic.message({ type: 'final', text: '' }); meeting.message({ type: 'final', text: '' }); await flush()
    }
    const calls = vi.mocked(uploadLiveInterviewChunk).mock.calls
    expect(calls.filter(call => call[6]?.id === 'microphone')).toHaveLength(1)
    expect(calls.filter(call => call[6]?.id === 'meeting').map(call => call[3])).toEqual([0, 15000])
    expect(root!.querySelector('.session-state')?.textContent).toContain('正在录音')
    expect(root!.textContent).toContain('待保存录音：2 段')
  })
  async function connected() { await mount(); await start(); const socket = Connection.instances[0]!; socket.open(); await flush(); return socket }

  it('immediately replaces a stalled connection on manual recovery without restarting capture', async () => {
    await mount(); await start(); await tick(11000)
    const previous = Connection.instances.at(-1)!
    const count = Connection.instances.length
    const recover = button('重新连接') || button('恢复音频')
    recover.click(); await flush()
    expect(Connection.instances).toHaveLength(count + 1)
    expect(previous.close).toHaveBeenCalled()
    expect(Recorder.instances).toHaveLength(1)
    expect(createLiveInterviewSession).toHaveBeenCalledOnce()
    expect(capture.stop).not.toHaveBeenCalled()
  })
  it('saves audio during model loading without sending premature commits or reconnecting every five seconds', async () => {
    const socket = await connected()
    socket.message({ type: 'status', status: 'loading' }); await tick(21000)
    expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce()
    expect(socket.send).not.toHaveBeenCalled()
    expect(socket.close).not.toHaveBeenCalled()
    expect(Connection.instances).toHaveLength(1)
  })
  it('times out a handshake that never becomes ready and retries', async () => {
    const socket = await connected()
    await tick(125000)
    expect(socket.send).not.toHaveBeenCalled()
    expect(socket.close).toHaveBeenCalled()
    expect(Connection.instances.length).toBeGreaterThan(1)
    expect(root!.querySelector('.session-state')!.textContent).toContain('正在录音')
  })
  it('retries on an error event even when the peer never sends close', async () => {
    const socket = await connected(); socket.ready(); await flush()
    socket.onerror?.(); await flush(); await tick(5000)
    expect(socket.close).toHaveBeenCalled()
    expect(Connection.instances.length).toBeGreaterThan(1)
  })
  it('detects a half-open connection with negotiated heartbeat and clears the warning after recovery', async () => {
    // No recorder payload: only heartbeat can discover this half-open socket.
    vi.spyOn(Recorder.prototype, 'stop').mockImplementation(function (this: Recorder) {
      this.state = 'inactive'; this.onstop?.()
    })
    const socket = await connected(); socket.ready(true); await flush(); await tick(41000)
    expect(socket.close).toHaveBeenCalled()
    expect(socket.send.mock.calls.some(([value]) => typeof value === 'string' && JSON.parse(value).type === 'ping')).toBe(true)
    const replacement = Connection.instances.at(-1)!
    replacement.open(); replacement.ready(true); await flush()
    expect(root!.textContent).toContain('流式识别中')
    expect(root!.textContent).not.toContain('实时流式连接中断')
  })
  it('does not disconnect silent but responsive streams', async () => {
    const socket = await connected(); socket.ready(true); await flush()
    socket.send.mockImplementation(value => {
      const command = JSON.parse(String(value))
      if (command.type === 'ping') socket.message({ type: 'pong' })
      if (command.type === 'commit') socket.message({ type: 'final', text: '', commitId: command.commitId })
    })
    await tick(65000)
    expect(socket.close).not.toHaveBeenCalled()
    expect(Connection.instances).toHaveLength(1)
  })
  it('ignores late close and ready events from a retired connection', async () => {
    const socket = await connected(); socket.ready(); await flush()
    const lateMessage = socket.onmessage, lateClose = socket.onclose
    socket.onerror?.(); await flush(); await tick(5000)
    const replacement = Connection.instances.at(-1)!
    replacement.open(); replacement.ready(); await flush()
    lateClose?.({ code: 1006 }); lateMessage?.({ data: JSON.stringify({ type: 'status', status: 'loading' }) }); await flush()
    expect(root!.textContent).toContain('流式识别中')
    expect(replacement.close).not.toHaveBeenCalled()
  })
  it('keeps a legacy service connected without negotiating heartbeat', async () => {
    const socket = await connected(); socket.ready(); await flush()
    socket.send.mockImplementation(value => {
      const command = JSON.parse(String(value))
      if (command.type === 'commit') socket.message({ type: 'final', text: '', commitId: command.commitId })
    })
    await tick(65000)
    expect(socket.send.mock.calls.some(([value]) => typeof value === 'string' && JSON.parse(value).type === 'ping')).toBe(false)
    expect(socket.close).not.toHaveBeenCalled()
  })
  it('preserves device warnings when streaming recovers', async () => {
    const socket = await connected(); socket.ready(); await flush()
    vi.mocked(createInterviewAudioCapture).mock.calls[0]![1]!.onWarning!('会议音量过低，请检查共享音频。')
    socket.onerror?.(); await flush(); await tick(1000)
    const replacement = Connection.instances.at(-1)!
    replacement.open(); replacement.ready(); await flush()
    expect(root!.textContent).toContain('会议音量过低，请检查共享音频。')
    expect(root!.textContent).not.toContain('实时流式连接中断')
  })
  it('retries a failed commit without losing the partial transcript or restarting capture', async () => {
    const socket = await connected(); socket.ready(); await flush()
    socket.message({ type: 'partial', text: '这段文字必须连同录音保留。' })
    socket.send.mockImplementation(() => { throw new Error('socket send failed') })
    await tick(15000)
    expect(uploadLiveInterviewChunk).toHaveBeenCalledWith('session-1', 'YXVkaW8=', 'audio/webm', 0, expect.any(String),
      { text: '这段文字必须连同录音保留。', audioSource: 'microphone', endMs: 15000, complete: false }, { id: 'microphone', role: 'unknown', multipleSpeakers: true }, 15000)
    expect(capture.stop).not.toHaveBeenCalled()
    await tick(1000)
    expect(Connection.instances).toHaveLength(2)
  })
  it('does not reconnect while paused and resumes retries on continue', async () => {
    const socket = await connected(); socket.ready(); await flush()
    socket.onerror?.(); await flush()
    button('暂停').click(); await flush(); await tick(30000)
    expect(Connection.instances).toHaveLength(1)
    button('继续').click(); await flush(); await tick(2000)
    expect(Connection.instances).toHaveLength(2)
    expect(createInterviewAudioCapture).toHaveBeenCalledOnce()
  })
  it('cancels pending handshakes and retries when the component unmounts', async () => {
    await mount(); await start()
    const socket = Connection.instances[0]!
    app!.unmount(); app = undefined
    await tick(130000)
    expect(socket.close).toHaveBeenCalled()
    expect(Connection.instances).toHaveLength(1)
  })
  it('ignores a stale audio context failure after a manual reconnect', async () => {
    let rejectResume!: (error: Error) => void
    const resumed = new Promise<void>((_resolve, reject) => { rejectResume = reject })
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 0 } })
    let contexts = 0
    vi.stubGlobal('AudioContext', class {
      state = 'running'; sampleRate = 48000; destination = {}; first = ++contexts === 1
      resume = () => this.first ? resumed : Promise.resolve()
      close = vi.fn(async () => undefined)
      createMediaStreamSource = node; createGain = node; createScriptProcessor = node
    })
    const socket = await connected()
    button('重新连接').click(); await flush()
    const replacement = Connection.instances.at(-1)!
    replacement.open(); replacement.ready(); await flush()
    // A rejected old resume must not tear down the replacement connection.
    rejectResume(new Error('retired audio context')); await flush()
    expect(socket.close).toHaveBeenCalled()
    expect(replacement.close).not.toHaveBeenCalled()
    expect(root!.textContent).toContain('流式识别中')
  })
})

const navigationQuestions = ['请介绍你的招聘项目。', '如何制定招聘计划？', '如何处理候选人反馈？'].map(question => ({ question, category: 'experience', difficulty: 'medium', rationale: '', groundedIn: [], scoringRubric: [] }))
function questionSet() { vi.mocked(getInterviewQuestions).mockResolvedValue({ questions: navigationQuestions, engine: 'llm' } as never) }
function questionText() { return root!.querySelector('.question-select[aria-pressed="true"]')?.textContent ?? '' }
async function openReference(group: 'ai' | 'hr' | 'department' | 'boss') {
  root!.querySelector<HTMLButtonElement>('[aria-label="关闭参考表"]')?.click(); await flush()
  root!.querySelector<HTMLButtonElement>(`[data-reference="${group}"]`)!.click(); await flush()
}
async function mountReference(interviewId = 'interview-1') { await mount(interviewId); await openReference(root!.querySelector('[data-reference="ai"]') ? 'ai' : 'department') }
function selectResume(index: number) { root!.querySelectorAll<HTMLButtonElement>('[data-group="ai"] .question-item:not(.current-custom-question):not(.follow-up) .question-select')[index].click() }
function regenerationButton() { return root!.querySelector<HTMLButtonElement>('.regenerate-question-bank')! }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

describe('live interview question navigation', () => {
  it('places three independent reference entries between the room title and session controls without an inline bank', async () => {
    questionSet(); await mount()
    const header = root!.querySelector('.live-page-header')!
    expect([...header.children].map(element => element.className)).toEqual(['', 'reference-actions', 'live-header-actions'])
    expect([...header.querySelectorAll('[data-reference]')].map(element => element.textContent)).toEqual(['AI简历题', 'HR面试表', '用人部门面试表'])
    expect([...header.querySelectorAll('.reference-actions button')].map(element => element.textContent)).toEqual(['查看原音频', 'AI简历题', 'HR面试表', '用人部门面试表'])
    expect(root!.querySelector('.question-panel')).toBeNull()
    expect(root!.querySelector('[role="dialog"]')).toBeNull()
    expect(root!.querySelectorAll('.interview-room > section')).toHaveLength(2)
  })
  it('opening and closing all reference sheets does not change the question, generate new content, start audio or score', async () => {
    vi.mocked(getInterviewQuestions).mockResolvedValue({ questions: completeBank().map(question => ({ ...question, rationale: '核实实际经历', groundedIn: ['简历项目经历'] })), engine: 'llm' } as never)
    await mount()
    const original = questionText()
    for (const group of ['ai', 'hr', 'department'] as const) {
      await openReference(group)
      expect(root!.querySelectorAll('[data-group]')).toHaveLength(1)
      expect(root!.querySelector('[data-group]')!.getAttribute('data-group')).toBe(group)
      expect(root!.querySelectorAll('details[open]').length).toBeGreaterThan(0)
      expect(questionText()).toBe(original)
    }
    root!.querySelector<HTMLButtonElement>('[aria-label="关闭参考表"]')!.click(); await flush()
    expect(root!.querySelector('[role="dialog"]')).toBeNull()
    expect(updateLiveInterviewQuestion).not.toHaveBeenCalled()
    expect(generateInterviewQuestions).not.toHaveBeenCalled()
    expect(createInterviewAudioCapture).not.toHaveBeenCalled()
    expect(analyzeLiveSegment).not.toHaveBeenCalled()
  })
  it('opens saved original audio without starting a session, capture or scoring', async () => {
    vi.mocked(listInterviewRecordings).mockResolvedValue([])
    questionSet(); await mount()
    root!.querySelector<HTMLButtonElement>('.audio-recordings-button')!.click(); await flush()
    expect(root!.querySelector('[role="dialog"]')?.textContent).toContain('面试整场录音')
    expect(listInterviewRecordings).toHaveBeenCalledWith('interview-1', expect.any(AbortSignal))
    expect(createLiveInterviewSession).not.toHaveBeenCalled()
    expect(createInterviewAudioCapture).not.toHaveBeenCalled()
    expect(analyzeLiveSegment).not.toHaveBeenCalled()
    root!.querySelector<HTMLButtonElement>('[aria-label="关闭原音频"]')!.click(); await flush()
    expect(root!.querySelector('[role="dialog"]')).toBeNull()
  })
  it('keeps recording active while the reference sheet is open and after Escape closes it', async () => {
    questionSet(); await mount(); await start()
    await openReference('hr')
    expect(button('暂停')).toBeDefined()
    expect(Recorder.instances[0]!.state).toBe('recording')
    root!.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush()
    expect(root!.querySelector('[role="dialog"]')).toBeNull()
    expect(Recorder.instances[0]!.state).toBe('recording')
    expect(capture.stop).not.toHaveBeenCalled()
    expect(analyzeLiveSegment).not.toHaveBeenCalled()
  })
  it('selects a question only for editing, toggles it off and never writes a live question event', async () => {
    questionSet()
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', currentQuestion: navigationQuestions[0].question, status: 'active' }, segments: [] } as never)
    await mountReference()
    expect(questionText()).toBe('')
    selectResume(1); await flush()
    expect(questionText()).toBe(navigationQuestions[1].question)
    expect(root!.querySelector('.conversation-header')!.textContent).toContain('仅修改 1 题')
    selectResume(1); await flush()
    expect(questionText()).toBe('')
    expect(root!.querySelector('.conversation-header')!.textContent).toContain('全部题目')
    expect(root!.querySelector('.current-question-strip')).toBeNull()
    expect(updateLiveInterviewQuestion).not.toHaveBeenCalled()
  })
  it('retains independent edit selections when switching reference sheets', async () => {
    questionSet(); await mountReference(); selectResume(1); await flush()
    await openReference('hr')
    expect(questionText()).toBe('')
    const hr = root!.querySelector<HTMLButtonElement>('[data-group="hr"] .question-select')!
    hr.click(); await flush(); expect(questionText()).toBe(hr.textContent)
    await openReference('ai'); expect(questionText()).toBe(navigationQuestions[1].question)
    expect(updateLiveInterviewQuestion).not.toHaveBeenCalled()
  })
  it('keeps final-round boss selection independent and editable without adopting a live question', async () => {
    questionSet(); vi.mocked(getInterview).mockResolvedValue({ id: 'interview-1', applicationId: 'app-1', round: 2, application: { candidateId: 'candidate-1', jobId: 'job-1' } } as never)
    await mountReference(); await openReference('boss')
    expect(root!.querySelectorAll('[data-group="boss"] .question-select')).toHaveLength(5)
    expect(root!.querySelector('[data-reference="ai"]')).toBeNull()
    root!.querySelector<HTMLButtonElement>('[data-group="boss"] .question-select')!.click(); await flush()
    expect(root!.querySelector('.question-meta b')!.textContent).toBe('待修改')
    expect(updateLiveInterviewQuestion).not.toHaveBeenCalled()
  })
  it('allows completed interviews to be browsed without enabling edit selection or model requests', async () => {
    questionSet(); vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', currentQuestion: navigationQuestions[0].question, status: 'completed' }, segments: [] } as never)
    await mountReference(); selectResume(1); await flush()
    expect(questionText()).toBe('')
    expect(root!.querySelector<HTMLButtonElement>('.question-select')!.disabled).toBe(true)
    expect(updateLiveInterviewQuestion).not.toHaveBeenCalled()
    expect(generateInterviewQuestions).not.toHaveBeenCalled()
  })
  it('does not preselect a generated question when loading finishes', async () => {
    const pending = deferred<never>(); vi.mocked(generateInterviewQuestions).mockReturnValue(pending.promise)
    await mountReference(); expect(regenerationButton().disabled).toBe(true)
    pending.resolve({ questions: completeBank(), engine: 'llm' } as never); await flush()
    expect(questionText()).toBe('')
    expect(root!.querySelectorAll('[data-group="ai"] .question-select')).toHaveLength(10)
    expect(regenerationButton().disabled).toBe(false)
  })
  it('allows regeneration retry after a failed initial load without selecting a question', async () => {
    vi.mocked(getInterviewQuestions).mockRejectedValueOnce(new Error('题目加载失败'))
    vi.mocked(generateInterviewQuestions).mockResolvedValue({ questions: completeBank(), engine: 'llm' } as never)
    await mountReference(); expect(root!.textContent).toContain('题目加载失败')
    regenerationButton().click(); await flush()
    expect(root!.textContent).not.toContain('题目加载失败')
    expect(questionText()).toBe('')
    expect(updateLiveInterviewQuestion).not.toHaveBeenCalled()
  })
})


function completeBank(final = false) {
  return [
    ...Array.from({ length: 10 }, (_, i) => ({ ...navigationQuestions[0], group: 'ai', question: `针对性题 ${i + 1}` })),
    ...COMMON_QUESTION_GROUPS.filter(group => group.id !== 'boss' || final).flatMap(group => group.dimensions.map(dimension => ({ ...navigationQuestions[0], group: group.id, dimension: dimension.id, question: `生成能力题 ${group.id}/${dimension.id}` }))),
  ]
}
describe('AI generated capability bank lifecycle', () => {
  it('requests 10 resume questions and common capability questions, then saves HR / department selections as adopted', async () => {
    const bank = completeBank(); vi.mocked(generateInterviewQuestions).mockResolvedValue({ questions: bank, engine: 'llm' } as never)
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', currentQuestion: bank[0].question, status: 'active' }, segments: [] } as never)
    await mountReference(); expect(generateInterviewQuestions).toHaveBeenCalledWith('interview-1', 10, true, expect.any(AbortSignal))
    expect(root!.querySelectorAll('[data-group="ai"] .question-select')).toHaveLength(10)
    await openReference('hr')
    expect(root!.querySelectorAll('[data-group="hr"] .question-select')).toHaveLength(5)
    root!.querySelector<HTMLButtonElement>('[data-group="hr"] .question-select')!.click(); await flush()
    expect(updateLiveInterviewQuestion).not.toHaveBeenCalled()
    expect(root!.querySelector('[data-group="hr"] .question-select[aria-pressed="true"]')).not.toBeNull()
    await openReference('department')
    root!.querySelector<HTMLButtonElement>('[data-group="department"] .question-select')!.click(); await flush()
    expect(updateLiveInterviewQuestion).not.toHaveBeenCalled()
    await openReference('ai'); selectResume(0); await flush(); expect(questionText()).toBe(bank[0].question)
    expect(root!.querySelector('.question-progress')).toBeNull()
  })
  it('reuses the saved generated bank without invoking a model on refresh', async () => {
    const bank = completeBank(); vi.mocked(getInterviewQuestions).mockResolvedValue({ questions: bank, engine: 'llm' } as never)
    await mountReference(); expect(generateInterviewQuestions).not.toHaveBeenCalled(); expect(root!.textContent).not.toContain('这是旧版题库')
  })
  it('keeps a legacy bank until explicit regeneration and protects the current question while generation is pending', async () => {
    questionSet(); const pending = deferred<never>(); vi.mocked(generateInterviewQuestions).mockReturnValue(pending.promise)
    await mountReference(); expect(generateInterviewQuestions).not.toHaveBeenCalled(); expect(root!.textContent).toContain('这是旧版题库')
    button('重新生成当前表').click(); await flush(); await openReference('hr'); root!.querySelector<HTMLButtonElement>('[data-group="hr"] .question-select')!.click(); await flush()
    const current = questionText(); pending.resolve({ questions: completeBank(), engine: 'llm' } as never); await flush()
    expect(questionText()).toBe(current); await openReference('ai'); expect(root!.querySelectorAll('[data-group="ai"] .question-select')).toHaveLength(10)
    expect(root!.textContent).not.toContain('这是旧版题库')
  })
  it('does not auto-replace an AI-generated capability question with an answer-analysis follow-up', async () => {
    const bank = completeBank(); const pending = deferred<never>(); vi.mocked(analyzeLiveSegment).mockReturnValue(pending.promise)
    vi.mocked(getInterviewQuestions).mockResolvedValue({ questions: bank, engine: 'llm' } as never)
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', currentQuestion: bank[10].question, status: 'active' }, segments: [{ id: 'segment-1', sessionId: 'session-1', role: 'candidate', confidence: 0.9, text: '我会先澄清目标再提出方案。', startMs: 0, endMs: 1000, status: 'transcribed' }] } as never)
    await mountReference(); pending.resolve({ nextQuestion: '请补充行动证据。', summary: '已分析', scores: [], evidence: [], concerns: [], confidence: 0.9 } as never); await flush()
    expect(questionText()).toBe(''); expect(updateLiveInterviewQuestion).not.toHaveBeenCalled()
    expect(root!.querySelector('.reference-bank-panel')!.textContent).not.toContain('请补充行动证据。')
  })
  it('does not generate or overwrite a completed interview bank', async () => {
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-1', currentQuestion: '已完成的问题', status: 'completed' }, segments: [] } as never)
    await mountReference(); expect(generateInterviewQuestions).not.toHaveBeenCalled(); expect(button('重新生成当前表').disabled).toBe(true)
  })
})

describe('regeneration feedback and safeguards', () => {
  it('only regenerates the open department sheet and preserves every other sheet', async () => {
    const original = completeBank(true)
    vi.mocked(getInterview).mockResolvedValue({ id: 'interview-2', applicationId: 'app-1', round: 2, stage: 'final', application: { candidateId: 'candidate-1', jobId: 'job-1' } } as never)
    vi.mocked(getInterviewQuestions).mockResolvedValue({ questions: original, engine: 'llm' } as never)
    const changed = original.map(question => ({ ...question, question: '新生成：' + question.question }))
    vi.mocked(generateInterviewQuestions).mockResolvedValue({ questions: changed, engine: 'llm' } as never)
    await mountReference('interview-2'); await openReference('department'); regenerationButton().click(); await flush()
    expect(generateInterviewQuestions).toHaveBeenCalledWith('interview-2', 10, true, expect.any(AbortSignal), 'department')
    expect(root!.querySelector('[data-group="department"]')!.textContent).toContain(changed[15].question)
    await openReference('boss')
    expect(root!.querySelector('[data-group="boss"]')!.textContent).toContain(original[20].question)
    expect(root!.querySelector('[data-group="boss"]')!.textContent).not.toContain(changed[20].question)
    await openReference('hr')
    expect(root!.querySelector('[data-group="hr"]')!.textContent).toContain(original[10].question)
  })
  it('rejects missing capability dimensions without replacing the open sheet', async () => {
    const original = completeBank()
    vi.mocked(getInterviewQuestions).mockResolvedValue({ questions: original, engine: 'llm' } as never)
    vi.mocked(generateInterviewQuestions).mockResolvedValue({ questions: original.map((question, index) => index === 19 ? { ...question, dimension: 'unknown_dimension' } : question), engine: 'llm' } as never)
    await mountReference(); await openReference('department'); regenerationButton().click(); await flush()
    expect(root!.querySelector('.generation-error')!.textContent).toContain('不完整')
    expect(root!.querySelectorAll('[data-group="department"] .question-select')).toHaveLength(5)
    expect(root!.querySelector('[data-group="department"]')!.textContent).toContain(original[19].question)
  })
  it('accepts AI success for the current sheet even when other sheets remain local', async () => {
    const original = completeBank().map(question => ({ ...question, sourceEngine: 'local_fallback' as const }))
    vi.mocked(getInterviewQuestions).mockResolvedValue({ questions: original, engine: 'local_fallback' } as never)
    const changed = original.map(question => question.group === 'department' ? { ...question, question: 'AI新题：' + question.question, sourceEngine: 'llm' as const } : question)
    vi.mocked(generateInterviewQuestions).mockResolvedValue({ questions: changed, engine: 'local_fallback' } as never)
    await mountReference(); await openReference('department'); regenerationButton().click(); await flush()
    expect(root!.querySelector('.generation-success')!.textContent).toContain('其他表保持不变')
    expect(root!.querySelector('[data-group="department"]')!.textContent).toContain('AI 生成 · 5 题')
    expect(root!.querySelector('[data-group="department"] .fallback-note')).toBeNull()
  })
  it('keeps one button, shows pending feedback, rejects duplicate clicks and reports success', async () => {
    vi.mocked(getInterviewQuestions).mockResolvedValue({ questions: completeBank(), engine: 'llm' } as never); const pending = deferred<never>(); vi.mocked(generateInterviewQuestions).mockReturnValue(pending.promise)
    await mountReference(); regenerationButton().click(); await flush()
    expect(regenerationButton().disabled).toBe(true)
    expect(root!.querySelector('.question-bank-toolbar')!.getAttribute('aria-busy')).toBe('true')
    expect(root!.querySelector('[role="status"]')!.textContent).toContain('正在生成当前面试表')
    regenerationButton().click(); await flush(); expect(generateInterviewQuestions).toHaveBeenCalledOnce()
    await tick(15000); expect(root!.textContent).toContain('模型仍在生成')
    pending.resolve({ questions: completeBank(), engine: 'llm' } as never); await flush()
    expect(root!.querySelector('.generation-success')!.textContent).toContain('当前面试表已重新生成')
    expect(regenerationButton().disabled).toBe(false)
    expect(root!.querySelectorAll('[data-group="ai"] .question-select')).toHaveLength(10)
    await openReference('hr')
    expect(root!.querySelectorAll('[data-group="hr"] .question-select')).toHaveLength(5)
    await openReference('department')
    expect(root!.querySelectorAll('[data-group="department"] .question-select')).toHaveLength(5)
  })
  it('keeps the old bank and exposes a red error when regeneration fails, then allows retry', async () => {
    questionSet(); vi.mocked(generateInterviewQuestions).mockRejectedValueOnce(new Error('生成连接失败')).mockResolvedValue({ questions: completeBank(), engine: 'llm' } as never)
    await mountReference(); regenerationButton().click(); await flush()
    expect(root!.querySelector('.generation-error[role="alert"]')!.textContent).toContain('生成连接失败')
    expect(root!.querySelectorAll('[data-group="ai"] .question-select')).toHaveLength(3)
    expect(questionText()).toBe('')
    expect(regenerationButton().disabled).toBe(false)
    regenerationButton().click(); await flush()
    expect(root!.querySelector('.generation-error')).toBeNull()
    expect(root!.querySelector('.generation-success')).not.toBeNull()
  })
  it.each([
    { questions: [], engine: 'llm', message: '服务未返回可用题目' },
    { questions: navigationQuestions, engine: 'llm', message: '新版 API 已重启' },
{ questions: completeBank().filter((_, index) => index !== 9), engine: 'llm', message: '新版 API 已重启' },
  ])('does not replace the bank or claim success on an empty or incomplete response: $message', async result => {
    questionSet(); vi.mocked(generateInterviewQuestions).mockResolvedValue(result as never)
    await mountReference(); regenerationButton().click(); await flush()
    expect(root!.querySelector('.generation-error')!.textContent).toContain(result.message)
    expect(root!.querySelector('.generation-success')).toBeNull()
    expect(root!.querySelectorAll('[data-group="ai"] .question-select')).toHaveLength(3)
    expect(regenerationButton().disabled).toBe(false)
  })
  it('retains original questions and reports failure if regeneration returns local fallback', async () => {
    questionSet(); vi.mocked(generateInterviewQuestions).mockResolvedValue({ questions: completeBank(), engine: 'local_fallback' } as never)
    await mountReference(); regenerationButton().click(); await flush()
    expect(root!.querySelector('.generation-error[role="alert"]')!.textContent).toContain('模型生成未成功')
    expect(root!.querySelector('.generation-success')).toBeNull()
    expect(root!.querySelectorAll('[data-group="ai"] .question-select')).toHaveLength(3)
  })
})

describe('第二轮面试题库', () => {
  it('第二轮BOSS能力题不会被自动追问替换', async () => {
    vi.mocked(getInterview).mockResolvedValue({ id: 'interview-2', applicationId: 'app-1', round: 2, stage: 'final', application: { candidateId: 'candidate-1', jobId: 'job-1' } } as never)
    const bank = completeBank(true), pending = deferred<never>()
    vi.mocked(analyzeLiveSegment).mockReturnValue(pending.promise)
    vi.mocked(getInterviewQuestions).mockResolvedValue({ questions: bank, engine: 'llm' } as never)
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-2', currentQuestion: bank[20].question, status: 'active' }, segments: [{ id: 'segment-2', sessionId: 'session-2', role: 'candidate', confidence: 0.9, text: '我会拆分目标，明确关键风险和资源分配。', startMs: 0, endMs: 1000, status: 'transcribed' }] } as never)
    await mountReference('interview-2')
    await openReference('boss')
    pending.resolve({ nextQuestion: '请补充业务结果。', summary: '已分析', scores: [], evidence: [], concerns: [], confidence: 0.9 } as never); await flush()
    expect(analyzeLiveSegment).toHaveBeenCalled()
    expect(questionText()).toBe('')
    expect(updateLiveInterviewQuestion).not.toHaveBeenCalled()
    expect(root!.querySelector('.question-select[aria-pressed="true"]')).toBeNull()
  })
  it('第二轮展示25道生成题，BOSS题可选并记录来源', async () => {
    vi.mocked(getInterview).mockResolvedValue({ id: 'interview-2', applicationId: 'app-1', round: 2, stage: 'final', title: '复试', application: { candidateId: 'candidate-1', jobId: 'job-1' } } as never)
    const bank = completeBank(true)
    vi.mocked(generateInterviewQuestions).mockResolvedValue({ questions: bank, engine: 'llm' } as never)
    vi.mocked(findActiveLiveInterviewSession).mockResolvedValue({ session: { id: 'session-2', currentQuestion: bank[0].question, status: 'active' }, segments: [] } as never)
    await mountReference('interview-2')
    expect(generateInterviewQuestions).toHaveBeenCalledWith('interview-2', 10, true, expect.any(AbortSignal))
    expect(root!.querySelector('[data-reference="ai"]')).toBeNull()
    expect(bank).toHaveLength(25)
    await openReference('hr'); expect(root!.querySelectorAll('[data-group="hr"] .question-select')).toHaveLength(5)
    await openReference('department'); expect(root!.querySelectorAll('[data-group="department"] .question-select')).toHaveLength(5)
    expect(root!.querySelector('[data-group="boss"]')).toBeNull()
    await openReference('boss'); expect(root!.querySelectorAll('[data-group="boss"] .question-select')).toHaveLength(5)
expect(regenerationButton().textContent).toContain('重新生成当前表')
    root!.querySelector<HTMLButtonElement>('[data-group="boss"] .question-select')!.click(); await flush()
    expect(questionText()).toBe(bank[20].question)
    expect(updateLiveInterviewQuestion).not.toHaveBeenCalled()
  })
  it('第二轮不能用第一轮20题的重新生成响应替换现有25题', async () => {
    vi.mocked(getInterview).mockResolvedValue({ id: 'interview-2', applicationId: 'app-1', round: 2, stage: 'final', title: '复试', application: { candidateId: 'candidate-1', jobId: 'job-1' } } as never)
    const bank = completeBank(true)
    vi.mocked(getInterviewQuestions).mockResolvedValue({ questions: bank, engine: 'llm' } as never)
    vi.mocked(generateInterviewQuestions).mockResolvedValue({ questions: completeBank(), engine: 'llm' } as never)
await mountReference('interview-2'); await openReference('boss'); regenerationButton().click(); await flush()
    expect(root!.querySelector('.generation-error')?.textContent).toContain('不完整')
    await openReference('boss')
    expect(root!.querySelectorAll('[data-group="boss"] .question-select')).toHaveLength(5)
    expect(root!.querySelector('[data-group="boss"]')?.textContent).toContain(bank[20].question)
  })
})


describe('题库等待与取消', () => {
  it('当前简历表255秒后停止等待，显示红色错误并保留原题库', async () => {
    questionSet(); const pending = deferred<never>()
    vi.mocked(generateInterviewQuestions).mockReturnValue(pending.promise)
    await mountReference(); regenerationButton().click(); await flush()
    const signal = vi.mocked(generateInterviewQuestions).mock.calls[0]![3]!
    await tick(15000)
    expect(root!.textContent).toContain('15 秒')
    await tick(120000)
    expect(signal.aborted).toBe(false)
await tick(119999)
    expect(signal.aborted).toBe(false)
    await tick(1)
    expect(signal.aborted).toBe(true)
    expect(root!.querySelector('.generation-error[role="alert"]')?.textContent).toContain('等待超时')
    expect(regenerationButton().disabled).toBe(false)
    expect(root!.querySelectorAll('[data-group="ai"] .question-select')).toHaveLength(3)
    expect(root!.querySelector('.question-bank-toolbar')!.getAttribute('aria-busy')).toBe('false')
  })
  it('取消后可重试，旧请求迟到响应不能覆盖新题库', async () => {
    questionSet(); const pending = deferred<never>()
    const newBank = completeBank().map(q => ({ ...q, question: '新题库：' + q.question }))
    vi.mocked(generateInterviewQuestions).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ questions: newBank, engine: 'llm' } as never)
    await mountReference(); regenerationButton().click(); await flush()
    const signal = vi.mocked(generateInterviewQuestions).mock.calls[0]![3]!
    button('取消生成').click(); await flush()
    expect(signal.aborted).toBe(true)
    expect(root!.querySelector('.generation-error')?.textContent).toContain('已取消')
    expect(regenerationButton().disabled).toBe(false)
    regenerationButton().click(); await flush()
    expect(root!.querySelector('[data-group="ai"]')?.textContent).toContain(newBank[0]!.question)
    pending.resolve({ questions: completeBank(), engine: 'llm' } as never); await flush()
    expect(root!.querySelector('[data-group="ai"]')?.textContent).toContain(newBank[0]!.question)
    expect(root!.querySelector('.generation-success')).not.toBeNull()
  })
  it('离开页面时取消尚未完成的生成请求', async () => {
    questionSet(); vi.mocked(generateInterviewQuestions).mockReturnValue(deferred<never>().promise)
    await mountReference(); regenerationButton().click(); await flush()
    const signal = vi.mocked(generateInterviewQuestions).mock.calls[0]![3]!
    app!.unmount(); app = undefined; await flush()
    expect(signal.aborted).toBe(true)
  })
  it('降级为参考题时展示后端返回的具体失败原因', async () => {
    questionSet(); vi.mocked(generateInterviewQuestions).mockResolvedValue({ questions: completeBank(), engine: 'local_fallback', generationWarning: '模型服务返回 HTTP 429，请稍后重试。' } as never)
    await mountReference(); regenerationButton().click(); await flush()
    expect(root!.querySelector('.generation-error[role="alert"]')?.textContent).toContain('HTTP 429')
    expect(root!.querySelector('.generation-success')).toBeNull()
  })
  it('复试等待提示正确显示四组问题，并显示已等待时间', async () => {
    vi.mocked(getInterview).mockResolvedValue({ id: 'interview-2', applicationId: 'app-1', round: 2, stage: 'final', application: { candidateId: 'candidate-1', jobId: 'job-1' } } as never)
    vi.mocked(generateInterviewQuestions).mockReturnValue(deferred<never>().promise)
    await mountReference('interview-2'); await tick(3000)
expect(root!.textContent).toContain('简历题分批生成')
    expect(root!.textContent).toContain('3 秒')
    expect(button('取消生成')).toBeDefined()
  })
})

describe('面试题对话恢复', () => {
  it('单题连续改写始终传递所选位置和最新题文，取消后恢复整表模式', async () => {
    const original = completeBank()
    const first = original.map((q, i) => i === 0 ? { ...q, question: '创新能力问题' } : q)
    const second = first.map((q, i) => i === 0 ? { ...q, question: '再次改写后的创新能力问题' } : q)
    vi.mocked(refineInterviewQuestionGroup)
      .mockResolvedValueOnce({ questions: first, engine: 'llm', assistantMessage: '只改选中题' } as never)
      .mockResolvedValueOnce({ questions: second, engine: 'llm', assistantMessage: '再次改写' } as never)
      .mockResolvedValueOnce({ questions: second, engine: 'llm', assistantMessage: '整表调整' } as never)
    await open(); selectResume(0); await flush(); await send('改为创新能力')
    expect(vi.mocked(refineInterviewQuestionGroup).mock.calls[0]![4]).toEqual({ index: 0, question: original[0].question })
    expect(questionText()).toBe(first[0].question)
    await send('再换一个')
    expect(vi.mocked(refineInterviewQuestionGroup).mock.calls[1]![4]).toEqual({ index: 0, question: first[0].question })
    expect(questionText()).toBe(second[0].question)
    selectResume(0); await flush(); await send('整表更换情境')
    expect(vi.mocked(refineInterviewQuestionGroup).mock.calls[2]![4]).toBeUndefined()
    expect(updateLiveInterviewQuestion).not.toHaveBeenCalled()
  })
  it('未选题默认整表修改，模型生成期间锁定选择且不会切换目标题', async () => {
    const pending = deferred<never>()
    vi.mocked(refineInterviewQuestionGroup).mockReturnValue(pending.promise)
    await open(); await send()
    expect(vi.mocked(refineInterviewQuestionGroup).mock.calls[0]![4]).toBeUndefined()
    expect(root!.querySelector<HTMLButtonElement>('.question-select')!.disabled).toBe(true)
    selectResume(1); await flush(); expect(questionText()).toBe('')
    pending.resolve({ questions: completeBank(), engine: 'llm', assistantMessage: '已完成' } as never); await flush()
    expect(root!.querySelector<HTMLButtonElement>('.question-select')!.disabled).toBe(false)
    expect(updateLiveInterviewQuestion).not.toHaveBeenCalled()
  })
  it('重新生成题库清除旧编辑选择，不让旧题文误指向新题', async () => {
    vi.mocked(generateInterviewQuestions).mockResolvedValue({ questions: completeBank(), engine: 'llm' } as never)
    await open(); selectResume(0); await flush(); expect(questionText()).not.toBe('')
    regenerationButton().click(); await flush()
    expect(questionText()).toBe('')
    expect(root!.querySelector('.conversation-header')!.textContent).toContain('全部题目')
  })
  async function send(content = '请调整为应届生情境题') {
    const input = root!.querySelector<HTMLTextAreaElement>('#question-conversation-input')!
    input.value = content; input.dispatchEvent(new Event('input')); await flush()
    root!.querySelector('form.conversation-composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush()
  }
  async function open() {
    vi.mocked(getInterviewQuestions).mockResolvedValue({ questions: completeBank(), engine: 'llm' } as never)
    await mountReference()
  }
  it('调整成功展示回复并保存新题，生成期间禁止同时整套重新生成', async () => {
    const pending = deferred<never>()
    vi.mocked(refineInterviewQuestionGroup).mockReturnValue(pending.promise)
    await open(); await send()
    expect(regenerationButton().disabled).toBe(true)
    const bank = completeBank().map(q => q.group === 'ai' ? { ...q, question: '已调整：' + q.question } : q)
    pending.resolve({ questions: bank, engine: 'llm', assistantMessage: '已改为适合应届生的情境题。' } as never); await flush()
    expect(root!.querySelector('.conversation-messages')!.textContent).toContain('已改为适合应届生')
    expect(root!.querySelector('[data-group="ai"]')!.textContent).toContain('已调整：')
    expect(regenerationButton().disabled).toBe(false)
  })
  it('失败保留原题库，一键重试不重复加入用户消息', async () => {
    vi.mocked(refineInterviewQuestionGroup).mockRejectedValueOnce(new Error('模型输出被截断')).mockResolvedValueOnce({ questions: completeBank(), engine: 'llm', assistantMessage: '已调整' } as never)
    await open(); await send()
    expect(root!.querySelector('.conversation-error')!.textContent).toContain('模型输出被截断')
    expect(root!.querySelectorAll('[data-group="ai"] .question-select')).toHaveLength(10)
    root!.querySelector<HTMLButtonElement>('.conversation-retry')!.click(); await flush()
    expect(refineInterviewQuestionGroup).toHaveBeenCalledTimes(2)
    expect(vi.mocked(refineInterviewQuestionGroup).mock.calls[1]![2]).toHaveLength(1)
    expect(root!.querySelector('.conversation-error')).toBeNull()
  })
  it('取消后立即解锁，即使网络忽略取消也不会覆盖后续成功结果', async () => {
    const pending = deferred<never>()
    const bank = completeBank().map(q => ({ ...q, question: '新题：' + q.question }))
    vi.mocked(refineInterviewQuestionGroup).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ questions: bank, engine: 'llm', assistantMessage: '新回复' } as never)
    await open(); await send()
    const signal = vi.mocked(refineInterviewQuestionGroup).mock.calls[0]![3]!
    button('取消生成').click(); await flush()
    expect(signal.aborted).toBe(true)
    expect(regenerationButton().disabled).toBe(false)
    root!.querySelector<HTMLButtonElement>('.conversation-retry')!.click(); await flush()
    pending.resolve({ questions: completeBank(), engine: 'local_fallback', assistantMessage: '旧回复' } as never); await flush()
    expect(root!.querySelector('[data-group="ai"]')!.textContent).toContain('新题：')
    expect(root!.querySelector('.conversation-messages')!.textContent).not.toContain('旧回复')
  })
  it('对话135秒无响应后结束等待、保留原题并允许重试', async () => {
    vi.mocked(refineInterviewQuestionGroup).mockReturnValue(deferred<never>().promise)
    await open(); await send(); await tick(135000)
    expect(root!.querySelector('.conversation-error')!.textContent).toContain('等待超时')
    expect(root!.querySelector('#question-conversation-input')!.hasAttribute('disabled')).toBe(false)
    expect(root!.querySelector('.conversation-retry')).not.toBeNull()
    expect(root!.querySelectorAll('[data-group="ai"] .question-select')).toHaveLength(10)
  })
  it('连续多轮对话只发送有效限额内的近期历史，不中断后续调整', async () => {
    vi.mocked(refineInterviewQuestionGroup).mockResolvedValue({ questions: completeBank(), engine: 'llm', assistantMessage: '回复'.repeat(250) } as never)
    await open()
    for (let i = 0; i < 15; i++) await send(i + '要求'.repeat(250))
    expect(refineInterviewQuestionGroup).toHaveBeenCalledTimes(15)
    const messages = vi.mocked(refineInterviewQuestionGroup).mock.calls.at(-1)![2]
    expect(messages.length).toBeLessThanOrEqual(12)
    expect(messages.reduce((size, message) => size + message.content.length, 0)).toBeLessThanOrEqual(6000)
    expect(messages.at(-1)?.content).toContain('14')
    expect(root!.querySelectorAll('.conversation-message.user')).toHaveLength(15)
  })
})


describe('transcription fallback status', () => {
  it('does not advertise the disabled faster-whisper fallback', async () => {
    vi.mocked(apiClient.getJson).mockImplementation(async path => ({ data: path === '/candidates' ? [] : path === '/jobs' ? [] : { checks: { externalServices: { funasr: 'unavailable', fasterWhisper: 'ok' } } } }) as never)
    await mount()
    expect(root!.textContent).not.toContain('正在使用后备分段转写')
    expect(root!.textContent).toContain('转写服务暂不可用')
    await start()
    expect(createInterviewAudioCapture).toHaveBeenCalled()
  })
  it('does not warn about an optional fallback that is not configured', async () => {
    vi.mocked(apiClient.getJson).mockImplementation(async path => ({ data: path === '/candidates' ? [] : path === '/jobs' ? [] : { checks: { externalServices: { funasr: 'ok', fasterWhisper: 'not_configured' } } } }) as never)
    await mount()
    expect(root!.textContent).not.toContain('后备语音转写不可用')
    expect(root!.textContent).not.toContain('fasterWhisper')
  })
})
