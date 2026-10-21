import type { SpeakerSegment } from './role-mapper.js'
import { simplifyTranscript } from './transcript-text.js'

export interface TranscriptCheckpoint { text: string; endMs: number; complete: boolean }

const content = (text: string) => text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '').toLowerCase()

function missingText(text: string, from: number, to: number): string {
  let position = 0, left = -1, right = text.length, offset = 0
  for (const character of text) {
    const length = content(character).length
    if (left < 0 && position + length > from) left = offset
    if (length && position >= to) { right = offset; break }
    position += length
    offset += character.length
  }
  return left < 0 ? '' : text.slice(left, right).trim()
}

/** Keep one coherent transcript; acoustic turns are retained only when text and order align. */
export function reconcileTranscript(segments: SpeakerSegment[], checkpoint: TranscriptCheckpoint | undefined, offsetMs: number): SpeakerSegment[] {
  const simplified = segments.map(row => {
    const text = simplifyTranscript(row.text)
    return text === row.text ? row : { ...row, text }
  })
  if (simplified.some((row, index) => row !== segments[index])) segments = simplified
  if (checkpoint) checkpoint = { ...checkpoint, text: simplifyTranscript(checkpoint.text) }
  if (!checkpoint?.text.trim()) return segments
  const streamed = content(checkpoint.text)
  if (!streamed) return segments
  const duration = Math.max(0, checkpoint.endMs - offsetMs)
  const ordered = [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const offline = content(ordered.map(row => row.text).join(''))
  const recovery = (text: string, startMs: number, endMs: number, index = 0): SpeakerSegment => ({
    id: `stream:${offsetMs}:${index}`, speakerId: `stream_${offsetMs}`, text,
    // Bounds come from the audio chunk or adjacent acoustic turns, never guessed word times.
    startMs, endMs, speakerVerified: false, speakerMixed: true,
  })
  const whole = () => [recovery(checkpoint.text.trim(), 0, duration)]
  const chronological = ordered.every((row, index) => row.startMs >= 0 && row.endMs <= duration
    && row.endMs >= row.startMs && (!index || row.startMs >= ordered[index - 1]!.endMs))
  // A longer result is useful only if it actually contains the preview. Length alone
  // cannot prove that an unfinished stream's words survived offline recognition.
  if (chronological && offline.includes(streamed)) {
    return ordered.every((row, index) => row === segments[index]) ? segments : ordered
  }
  if (!chronological || !offline) return whole()

  const result: SpeakerSegment[] = []
  let cursor = 0, priorEnd = 0, gapIndex = 0
  for (const row of ordered) {
    const words = content(row.text)
    const position = words ? streamed.indexOf(words, cursor) : -1
    // Divergent recognizers must not produce two overlapping versions of the same
    // conversation. Preserve the observed stream intact and leave its speaker unknown.
    if (position < 0) return whole()
    if (position > cursor) {
      if (row.startMs <= priorEnd) return whole()
      result.push(recovery(missingText(checkpoint.text, cursor, position), priorEnd, row.startMs, gapIndex++))
    }
    result.push(row)
    cursor = position + words.length
    priorEnd = row.endMs
  }
  if (cursor < streamed.length) {
    if (duration <= priorEnd) return whole()
    result.push(recovery(missingText(checkpoint.text, cursor, streamed.length), priorEnd, duration, gapIndex))
  }
  return result
}
