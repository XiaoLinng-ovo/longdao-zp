import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSourceRecorderGroup, type SourceAudioBoundary, type SourceAudioChunk } from './source-recorder'
import type { InterviewAudioTrack } from './audio-capture'

class Recorder {
  static instances: Recorder[] = []
  static failAt = -1
  state = 'inactive'
  ondataavailable?: (event: { data: Blob }) => void
  onstop?: () => void
  constructor(public stream: MediaStream) {
    if (Recorder.instances.length === Recorder.failAt) throw new Error('recorder unavailable')
    Recorder.instances.push(this)
  }
  start() { this.state = 'recording' }
  stop() { this.state = 'inactive' }
  deliver() { this.ondataavailable?.({ data: new Blob(['audio']) }); this.onstop?.() }
}
const tracks: InterviewAudioTrack[] = [{ source: 'microphone', stream: {} as MediaStream }, { source: 'meeting', stream: {} as MediaStream }]
afterEach(() => { Recorder.instances = []; Recorder.failAt = -1; vi.unstubAllGlobals() })

describe('source recording clock', () => {
  it('snapshots a common stop boundary before delayed, reversed data events', async () => {
    vi.stubGlobal('MediaRecorder', Recorder)
    let now = 500
    const chunks: SourceAudioChunk[] = [], boundaries: SourceAudioBoundary[] = [], stopped = vi.fn()
    const group = createSourceRecorderGroup(tracks, { now: () => now, onBoundary: row => boundaries.push(row), onChunk: row => chunks.push(row), onStopped: stopped, onError: vi.fn() })
    expect(Recorder.instances.map(row => row.stream)).toEqual(tracks.map(row => row.stream))
    now = 3500; group.stop()
    expect(boundaries).toEqual(tracks.map(row => ({ source: row.source, offsetMs: 500, endMs: 3500 })))
    expect(chunks).toHaveLength(0)
    now = 9000; Recorder.instances[1]!.deliver()
    expect(stopped).not.toHaveBeenCalled()
    now = 15000; Recorder.instances[0]!.deliver(); await group.done
    expect(chunks.map(({ source, offsetMs, endMs }) => ({ source, offsetMs, endMs }))).toEqual([...boundaries].reverse())
    expect(stopped).toHaveBeenCalledOnce()
    group.stop(); expect(boundaries).toHaveLength(2)
  })
  it('finishes the other source if one recorder stops spontaneously', async () => {
    vi.stubGlobal('MediaRecorder', Recorder)
    const boundary = vi.fn(), stopped = vi.fn()
    const group = createSourceRecorderGroup(tracks, { now: () => 1000, onBoundary: boundary, onChunk: vi.fn(), onStopped: stopped, onError: vi.fn() })
    Recorder.instances[0]!.state = 'inactive'; Recorder.instances[0]!.deliver()
    expect(group.state).toBe('inactive'); expect(Recorder.instances[1]!.state).toBe('inactive')
    Recorder.instances[1]!.deliver(); await group.done
    expect(boundary).toHaveBeenCalledTimes(2); expect(stopped).toHaveBeenCalledOnce()
  })
  it('stops already started sources when another recorder cannot start', () => {
    vi.stubGlobal('MediaRecorder', Recorder); Recorder.failAt = 1
    expect(() => createSourceRecorderGroup(tracks, { now: () => 0, onChunk: vi.fn(), onStopped: vi.fn(), onError: vi.fn() })).toThrow('recorder unavailable')
    expect(Recorder.instances[0]!.state).toBe('inactive')
  })
  it('rejects duplicate sources instead of conflating their text', () => {
    expect(() => createSourceRecorderGroup([tracks[0]!, tracks[0]!], { now: () => 0, onChunk: vi.fn(), onStopped: vi.fn(), onError: vi.fn() })).toThrow('重复')
  })
})

