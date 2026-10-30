import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInterviewAudioCapture, InterviewAudioCaptureError } from './audio-capture'

class Track extends EventTarget {
  readyState = 'live'
  enabled = true
  stop = vi.fn(() => { this.readyState = 'ended' })
  constructor(public kind: string, public label: string) { super() }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')) }
}
class Stream {
  constructor(public tracks: Track[]) {}
  getTracks() { return this.tracks }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio') }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video') }
}
class Node {
  gain = { value: 1 }
  fftSize = 256
  channelCount = 2
  stream = new Stream([new Track('audio', 'mixed')])
  connect = vi.fn()
  disconnect = vi.fn()
  getFloatTimeDomainData = vi.fn((samples: Float32Array) => samples.fill(0.1))
}
const contexts: Context[] = []
class Context {
  state = 'running'
  destination = new Node()
  mixedDestination = new Node()
  sources: Array<{ node: Node; stream: Stream }> = []
  gains: Node[] = []
  resume = vi.fn(async () => undefined)
  close = vi.fn(async () => { this.state = 'closed' })
  constructor() { contexts.push(this) }
  createMediaStreamDestination() { return this.mixedDestination }
  createMediaStreamSource(stream: Stream) { const node = new Node(); this.sources.push({ node, stream }); return node }
  createGain() { const node = new Node(); this.gains.push(node); return node }
  createAnalyser() { return new Node() }
}
let mic: Stream, display: Stream
const getUserMedia = vi.fn()
const getDisplayMedia = vi.fn()
beforeEach(() => {
  vi.useFakeTimers(); contexts.length = 0
  mic = new Stream([new Track('audio', 'test microphone')])
  display = new Stream([new Track('audio', 'meeting audio'), new Track('video', 'screen')])
  getUserMedia.mockResolvedValue(mic); getDisplayMedia.mockResolvedValue(display)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, getDisplayMedia } })
  vi.stubGlobal('MediaStream', Stream); vi.stubGlobal('AudioContext', Context)
})
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('interview audio capture', () => {
  it('requests sharing synchronously before microphone permissions to preserve user activation', async () => {
    const promise = createInterviewAudioCapture('meeting')
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true, systemAudio: 'include' })
    expect(getUserMedia).not.toHaveBeenCalled()
    const capture = await promise
    expect(getUserMedia).toHaveBeenCalledOnce()
    capture.stop()
  })
  it('keeps both sources separate, excludes screen video, and never plays audio locally', async () => {
    const levels = vi.fn()
    const capture = await createInterviewAudioCapture('meeting', { onLevels: levels })
    const context = contexts[0]!
    expect(context.sources).toHaveLength(2)
    expect(context.sources[1]!.stream.getVideoTracks()).toHaveLength(0)
    expect(capture.stream.getVideoTracks()).toHaveLength(0)
    expect(capture.sources?.map(row => row.source)).toEqual(['microphone', 'meeting'])
    expect(capture.sources?.[0]?.stream).toBe(mic)
    expect(capture.sources?.[1]?.stream.getAudioTracks()).toEqual(display.getAudioTracks())
    expect(capture.sources?.[1]?.stream).not.toBe(capture.stream)
    expect(context.gains).toHaveLength(0)
    expect(context.sources.flatMap(source => source.node.connect.mock.calls).some(call => call[0] === context.destination)).toBe(false)
    expect(context.gains.flatMap(gain => gain.connect.mock.calls).some(call => call[0] === context.destination)).toBe(false)
    await vi.advanceTimersByTimeAsync(150)
    expect(levels).toHaveBeenCalledWith({ microphone: expect.any(Number), meeting: expect.any(Number) })
    expect(levels.mock.lastCall![0].meeting).toBeGreaterThan(0)
    expect(capture.meetingLabel).toBe('meeting audio')
    capture.stop()
  })
  it('only captures a selected microphone in microphone mode', async () => {
    const capture = await createInterviewAudioCapture('microphone', { microphoneDeviceId: 'usb-mic' })
    expect(getDisplayMedia).not.toHaveBeenCalled()
    expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ deviceId: { exact: 'usb-mic' }, echoCancellation: true }) })
    expect(contexts[0]!.sources).toHaveLength(1)
    expect(contexts[0]!.gains).toHaveLength(0)
    expect(capture.sources).toEqual([{ source: 'microphone', stream: mic }])
    expect(capture.microphoneLabel).toBe('test microphone')
    expect(capture.stream).toBe(mic)
    capture.stop()
  })
  it('recovers a suspended mixer without stopping either source', async () => {
    const capture = await createInterviewAudioCapture('meeting')
    const context = contexts[0]!
    context.state = 'suspended'
    context.resume.mockImplementation(async () => { context.state = 'running' })
    await capture.resume!()
    expect(context.state).toBe('running')
    expect(mic.tracks[0]!.stop).not.toHaveBeenCalled()
    expect(display.tracks[0]!.stop).not.toHaveBeenCalled()
    capture.stop()
  })
  it('reports a browser-suspended mixer instead of silently recording silence', async () => {
    const warning = vi.fn()
    const capture = await createInterviewAudioCapture('meeting', { onWarning: warning })
    contexts[0]!.state = 'suspended'
    await capture.resume!()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('音频处理被浏览器挂起'))
    capture.stop()
  })
  it('warns on prolonged silence and clears the warning when speech returns', async () => {
    const warning = vi.fn()
    let speaking = false
    vi.spyOn(Context.prototype, 'createAnalyser').mockImplementation(() => {
      const node = new Node()
      node.getFloatTimeDomainData.mockImplementation(samples => samples.fill(speaking ? 0.1 : 0))
      return node
    })
    const capture = await createInterviewAudioCapture('microphone', { onWarning: warning })
    await vi.advanceTimersByTimeAsync(21000)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('本机麦克风尚未检测到声音'))
    speaking = true
    await vi.advanceTimersByTimeAsync(450)
    expect(warning).toHaveBeenLastCalledWith('')
    capture.stop()
  })
  it('rejects a share with no live audio, stops screen sharing, and does not silently fall back', async () => {
    display = new Stream([new Track('video', 'silent-window')]); getDisplayMedia.mockResolvedValue(display)
    await expect(createInterviewAudioCapture('meeting')).rejects.toMatchObject({ source: 'meeting', message: expect.stringContaining('未获取到会议音频') })
    expect(display.tracks[0]!.stop).toHaveBeenCalledOnce()
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(contexts).toHaveLength(0)
  })
  it('explains cancelled sharing without requesting the microphone', async () => {
    getDisplayMedia.mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }))
    await expect(createInterviewAudioCapture('meeting')).rejects.toMatchObject({ source: 'meeting', message: expect.stringContaining('被取消或拒绝') })
    expect(getUserMedia).not.toHaveBeenCalled()
  })
  it('stops the successful share if microphone permission fails', async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
    await expect(createInterviewAudioCapture('meeting')).rejects.toMatchObject({ source: 'microphone' })
    display.tracks.forEach(track => expect(track.stop).toHaveBeenCalledOnce())
  })
  it.each(['audio', 'video'])('stops all sources when the shared %s track ends, once only', async kind => {
    const ended = vi.fn()
    const capture = await createInterviewAudioCapture('meeting', { onSourceEnded: ended })
    display.tracks.find(track => track.kind === kind)!.end()
    expect(ended).toHaveBeenCalledOnce(); expect(ended).toHaveBeenCalledWith('meeting')
    mic.tracks.forEach(track => expect(track.stop).toHaveBeenCalledOnce())
    display.tracks.forEach(track => expect(track.stop).toHaveBeenCalledOnce())
    expect(contexts[0]!.close).toHaveBeenCalledOnce()
    capture.stop()
    expect(ended).toHaveBeenCalledOnce()
    expect(contexts[0]!.close).toHaveBeenCalledOnce()
  })
  it('reports microphone disconnection and tears down the share', async () => {
    const ended = vi.fn()
    await createInterviewAudioCapture('meeting', { onSourceEnded: ended })
    mic.tracks[0]!.end()
    expect(ended).toHaveBeenCalledOnce(); expect(ended).toHaveBeenCalledWith('microphone')
    display.tracks.forEach(track => expect(track.stop).toHaveBeenCalledOnce())
  })
  it('cleans up a late microphone permission result after sharing already ended', async () => {
    let resolveMic!: (stream: Stream) => void
    getUserMedia.mockReturnValue(new Promise(resolve => { resolveMic = resolve }))
    const capture = createInterviewAudioCapture('meeting')
    await Promise.resolve()
    display.tracks[1]!.end()
    resolveMic(mic)
    await expect(capture).rejects.toBeInstanceOf(InterviewAudioCaptureError)
    mic.tracks.forEach(track => expect(track.stop).toHaveBeenCalledOnce())
    expect(contexts).toHaveLength(0)
  })
  it('mutes output and meters while paused and restores them on resume', async () => {
    const levels = vi.fn()
    const capture = await createInterviewAudioCapture('meeting', { onLevels: levels })
    capture.setPaused(true)
    expect(capture.sources?.every(row => row.stream.getAudioTracks().every(track => !track.enabled))).toBe(true)
    await vi.advanceTimersByTimeAsync(150)
    expect(levels).toHaveBeenLastCalledWith({ microphone: 0, meeting: 0 })
    capture.setPaused(false)
    expect(capture.sources?.every(row => row.stream.getAudioTracks().every(track => track.enabled))).toBe(true)
    capture.stop()
    const calls = levels.mock.calls.length
    await vi.advanceTimersByTimeAsync(500)
    expect(levels).toHaveBeenCalledTimes(calls)
  })
  it('gives an explicit compatibility error when sharing is unsupported', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    await expect(createInterviewAudioCapture('meeting')).rejects.toMatchObject({ source: 'meeting', message: expect.stringContaining('不支持会议音频共享') })
    expect(getUserMedia).not.toHaveBeenCalled()
  })
  it('cleans up native tracks and partially connected nodes when metering fails', async () => {
    vi.spyOn(Context.prototype, 'createMediaStreamSource').mockImplementation(function (this: Context, stream: Stream) {
      const node = new Node()
      node.connect.mockImplementation(() => { throw new Error('cannot connect') })
      this.sources.push({ node, stream })
      return node
    })
    await expect(createInterviewAudioCapture('meeting')).rejects.toThrow('cannot connect')
    const context = contexts[0]!
    expect(context.sources[0]!.node.disconnect).toHaveBeenCalledOnce()
    expect(context.close).toHaveBeenCalledOnce()
    ;[...mic.tracks, ...display.tracks].forEach(track => expect(track.stop).toHaveBeenCalledOnce())
  })
  it('reports the microphone source when it disconnects while the audio context is resuming', async () => {
    let resolveResume!: () => void
    vi.spyOn(Context.prototype, 'createMediaStreamDestination')
    vi.stubGlobal('AudioContext', class extends Context {
      resume = vi.fn(() => new Promise<void>(resolve => { resolveResume = resolve }))
    })
    const capture = createInterviewAudioCapture('microphone')
    await Promise.resolve()
    expect(contexts).toHaveLength(1)
    mic.tracks[0]!.end()
    resolveResume()
    await expect(capture).rejects.toMatchObject({ source: 'microphone', message: expect.stringContaining('音频来源已断开') })
    expect(contexts[0]!.createMediaStreamDestination).not.toHaveBeenCalled()
    expect(contexts[0]!.close).toHaveBeenCalledOnce()
  })
  it('tears down acquired streams when audio processing fails', async () => {
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('audio unavailable') } })
    await expect(createInterviewAudioCapture('meeting')).rejects.toThrow('音频处理启动失败')
    ;[...mic.tracks, ...display.tracks].forEach(track => expect(track.stop).toHaveBeenCalledOnce())
  })
})
