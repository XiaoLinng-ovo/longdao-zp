import type { PendingInterviewAudio } from './pending-audio'
import { simplifyTranscript } from './transcript-text'

interface Commit {
  chunk: PendingInterviewAudio
  prefix: string
  text: string
  interrupted: boolean
  finish: () => void
}

/** A preview is removed only after its own audio and transcript are acknowledged. */
export function createStreamingTranscriptBuffer(changed: (text: string) => void, timedOut: () => void, timeoutMs = 5000) {
  let active = ''
  let prefix = ''
  let interrupted = false
  const waiting: Commit[] = []
  const retained = new Map<string, Commit>()
  const preservePreview = (previous: string, next: string) => {
    const before = previous.trim(), after = next.trim()
    const words = (value: string) => value.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '').toLowerCase()
    const beforeWords = words(before), afterWords = words(after)
    // Partial/final messages are cumulative. A shorter contained result must
    // never erase words which have already appeared in the live preview.
    return !after || beforeWords.length > afterWords.length && beforeWords.includes(afterWords) ? before : after
  }
  const update = () => changed([...retained.values()].map(row => row.text).concat(prefix + active).filter(Boolean).join(' '))
  const snapshot = (row: Commit, complete: boolean) => {
    if (row.text) row.chunk.streamingTranscript = { text: row.text, endMs: row.chunk.endMs, complete,
      ...(row.chunk.audioSource ? { audioSource: row.chunk.audioSource.id } : {}) }
  }
  return {
    partial(text: string) {
      text = simplifyTranscript(text)
      const row = waiting[0]
      if (row) { row.text = preservePreview(row.text, row.prefix + text.trim()); snapshot(row, false) }
      else active = preservePreview(active, text)
      update()
    },
    commit(chunk: PendingInterviewAudio, connected: boolean): Promise<void> {
      let finish!: () => void
      const done = new Promise<void>(resolve => { finish = resolve })
      const row: Commit = { chunk, prefix, text: prefix + active, interrupted: interrupted || Boolean(prefix), finish }
      retained.set(chunk.id, row)
      prefix = ''; active = ''
      interrupted = false
      snapshot(row, false)
      if (connected) {
        const timer = setTimeout(() => { if (waiting.includes(row)) timedOut() }, timeoutMs)
        row.finish = () => { clearTimeout(timer); finish() }
        waiting.push(row)
      } else finish()
      update()
      return done
    },
    final(text: string, commitId?: string) {
      text = simplifyTranscript(text)
      const row = waiting[0]
      // A late frame from a previous connection must never finalize another chunk.
      if (!row || commitId && row.chunk.id !== commitId) return
      waiting.shift()
      const finalText = row.prefix + text.trim()
      row.text = preservePreview(row.text, finalText)
      snapshot(row, Boolean(text.trim()) && row.text === finalText && !row.interrupted)
      row.finish()
      update()
    },
    disconnect() {
      for (const row of waiting.splice(0)) { snapshot(row, false); row.finish() }
      prefix += active; active = ''
      interrupted = true
      update()
    },
    acknowledge(chunkId: string) { retained.delete(chunkId); update() },
  }
}
