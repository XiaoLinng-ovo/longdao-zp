import type { InterviewAudioSource, InterviewAudioTrack } from './audio-capture'

export interface SourceAudioBoundary { source: InterviewAudioSource; offsetMs: number; endMs: number }
export interface SourceAudioChunk extends SourceAudioBoundary { audio: Blob }
export interface SourceRecorderGroup { readonly state: 'recording' | 'inactive'; readonly done: Promise<void>; stop: () => void }

/** Every track uses the same interview clock; event delivery order is irrelevant. */
export function createSourceRecorderGroup(tracks: InterviewAudioTrack[], options: {
  now: () => number
  onBoundary?: (boundary: SourceAudioBoundary) => void
  onChunk: (chunk: SourceAudioChunk) => void
  onStopped: () => void
  onError: () => void
}): SourceRecorderGroup {
  if (!tracks.length || new Set(tracks.map(row => row.source)).size !== tracks.length) throw new Error('音轨来源为空或重复')
  let remaining = 0, stopping = false, started = false
  let resolveDone!: () => void
  const done = new Promise<void>(resolve => { resolveDone = resolve })
  const rows: Array<{ source: InterviewAudioSource; recorder: MediaRecorder; start: number; end?: number }> = []
  const boundary = (row: typeof rows[number], end: number) => {
    if (row.end !== undefined) return
    row.end = Math.max(row.start, end)
    options.onBoundary?.({ source: row.source, offsetMs: row.start, endMs: row.end })
  }
  const group: SourceRecorderGroup = {
    get state() { return stopping ? 'inactive' : 'recording' },
    done,
    stop() {
      if (stopping) return
      stopping = true
      const end = Math.round(options.now())
      for (const row of rows) boundary(row, end)
      for (const row of rows) if (row.recorder.state !== 'inactive') row.recorder.stop()
    },
  }
  try {
    for (const track of tracks) {
      const recorder = new MediaRecorder(track.stream)
      const row = { source: track.source, recorder, start: Math.round(options.now()), end: undefined as number | undefined }
      recorder.ondataavailable = event => {
        if (!stopping) group.stop()
        boundary(row, Math.round(options.now()))
        options.onChunk({ source: track.source, audio: event.data, offsetMs: row.start, endMs: row.end! })
      }
      recorder.onstop = () => {
        if (!stopping) group.stop()
        if (--remaining) return
        resolveDone()
        if (started) options.onStopped()
      }
      recorder.onerror = () => options.onError()
      recorder.start()
      remaining++
      rows.push(row)
    }
    started = true
  } catch (error) {
    group.stop()
    if (!remaining) resolveDone()
    throw error
  }
  return group
}
