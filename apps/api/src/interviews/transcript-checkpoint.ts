import type { SpeakerSegment } from './role-mapper.js'
import { simplifyTranscript } from './transcript-text.js'

export interface TranscriptCheckpoint { text: string; endMs: number; complete: boolean }

const content = (text: string) => text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '').toLowerCase()

// Only tolerate a couple of particles. Never fuzzy-match names, numbers,
// negations or reordered clauses just because one recognizer returned more text.
function coversWithParticles(offline: string, streamed: string): boolean {
  const particle = /[的啊呀嗯呃]/u
  const letters: string[] = [], positions: number[] = []
  for (let index = 0; index < offline.length; index++) {
    if (!particle.test(offline[index]!)) { letters.push(offline[index]!); positions.push(index) }
  }
  const anchor = streamed.replace(/[的啊呀嗯呃]/gu, '')
  if (anchor.length < 6 || offline.length < streamed.length + 6) return false
  const index = letters.join('').indexOf(anchor)
  if (index < 0) return false
  const span = positions[index + anchor.length - 1]! - positions[index]! + 1
  return span - anchor.length + streamed.length - anchor.length <= 2
}

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
  const orderedAll = [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  // Overlapping capture turns repeat words instead of adding speech: drop a turn whose
  // words are already contained in a longer turn of the same speaker before using bounds.
  const ordered = orderedAll.filter((row, index) => {
    const words = content(row.text)
    if (!words) return true
    return !orderedAll.some((other, otherIndex) => otherIndex !== index
      && content(other.text).length > words.length && content(other.text).includes(words)
      && (other.speakerId === row.speakerId || other.speakerVerified !== true || row.speakerVerified !== true))
  })
  const offline = content(ordered.map(row => row.text).join(''))
  const offlineMatchesPreview = offline.length >= 4 && Math.abs(offline.length - streamed.length) <= 2
    && offline.replace(/[的啊呀嗯呃]/gu, '') === streamed.replace(/[的啊呀嗯呃]/gu, '')
  const recovery = (text: string, startMs: number, endMs: number, index = 0): SpeakerSegment => ({
    id: `stream:${offsetMs}:${index}`, speakerId: `stream_${offsetMs}`, text,
    // Bounds come from the audio chunk or adjacent acoustic turns, never guessed word times.
    startMs, endMs, speakerVerified: false, speakerMixed: true,
  })
  const withComparison = (rows: SpeakerSegment[], selectedSource: 'streaming' | 'offline') => {
    if (!offline || offline === streamed || !rows.length) return rows
    // Only a streaming selection needs a copy of the offline turns for review;
    // an offline selection already stores exactly those turns.
    const offlineSegments = selectedSource === 'offline' ? undefined : ordered.map(row => ({
      id: row.id, speakerId: row.speakerId, text: row.text, startMs: row.startMs, endMs: row.endMs,
      ...(row.speakerVerified !== undefined ? { speakerVerified: row.speakerVerified } : {}),
      ...(row.speakerMixed !== undefined ? { speakerMixed: row.speakerMixed } : {}),
    }))
    return [{ ...rows[0]!, transcriptComparison: {
      streamingText: checkpoint.text.trim(), offlineText: ordered.map(row => row.text).join('\n'),
      ...(offlineSegments ? { offlineSegments } : {}),
      streamingComplete: checkpoint.complete, selectedSource, startMs: offsetMs, endMs: checkpoint.endMs,
    } }, ...rows.slice(1)]
  }
  // FunASR offline recognition of the whole chunk is the accurate engine; the live
  // streaming preview is a lower-quality draft used for live display only. When the two
  // disagree, persistence keeps the offline words and stores the preview as an alternative.
  // Acoustic roles survive only when the two agree, because comparable length cannot
  // resolve conflicting names, numbers, negations or missing clauses.
  const offlineCredible = offline.length >= 4 && offline.length * 3 >= streamed.length
  const whole = (): SpeakerSegment[] => {
    const preview = () => withComparison([recovery(checkpoint.text.trim(), 0, duration)], 'streaming')
    // An almost empty offline result means that pass failed, not that nobody spoke.
    if (!offline || !offlineCredible) return preview()
    if (chronological && ordered.length) return withComparison(ordered, 'offline')
    // Untrustworthy offline bounds: only a preview that already holds every offline
    // word can be kept without repeating speech twice.
    if (streamed.includes(offline)) return preview()
    return withComparison([recovery(ordered.map(row => row.text).join('\n'), 0, duration)], 'offline')
  }
  const chronological = ordered.every((row, index) => row.startMs >= 0 && row.endMs <= duration
    && row.endMs >= row.startMs && (!index || row.startMs >= ordered[index - 1]!.endMs))
  // Offline already contains every preview word: keep the acoustic turns as-is.
  if (chronological && offline.includes(streamed)) {
    return ordered.every((row, index) => row === segments[index]) ? segments : ordered
  }
  if (chronological && coversWithParticles(offline, streamed)) return withComparison(ordered, 'offline')
  if (!chronological || !offline) return whole()
  // A preview missing whole offline sentences cannot describe this audio.
  if (!checkpoint.complete) return whole()
  // Both recognizers are credible and the preview follows the offline turns:
  // keep the acoustic turns and append only the words offline did not hear.
  const result: SpeakerSegment[] = []
  let cursor = 0, priorEnd = 0, gapIndex = 0
  for (const row of ordered) {
    const words = content(row.text)
    const position = words ? streamed.indexOf(words, cursor) : -1
    // Diverging recognizers must not produce two overlapping versions of one
    // conversation, so the offline transcript wins and the preview stays reviewable.
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