import type { LiveInterviewSegment } from '../api'
import { simplifyTranscript } from './transcript-text'

export interface LiveUtterance extends LiveInterviewSegment {
  sourceIds: string[]
  final: boolean
  overlapping?: boolean
}

export function buildUtterances(
  segments: LiveInterviewSegment[],
  nowMs: number,
  silenceMs: number,
): LiveUtterance[] {
  const result: LiveUtterance[] = []
  const ordered = [...segments].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id))
  for (const segment of ordered) {
    const current = result.at(-1)
    const sameSpeaker = current && current.sessionId === segment.sessionId && current.role === segment.role
      && current.audioSource === segment.audioSource && !!current.speakerId && current.speakerId === segment.speakerId
    if (current && sameSpeaker && current.role !== 'unknown'
      && current.confidence >= 0.6 && segment.confidence >= 0.6
      && segment.startMs >= current.endMs && segment.startMs - current.endMs <= silenceMs) {
      current.text = `${current.text}${segment.text}`
      current.endMs = Math.max(current.endMs, segment.endMs)
      current.confidence = Math.min(current.confidence, segment.confidence)
      current.sourceIds.push(segment.id)
      continue
    }
    if (current) current.final = true
    result.push({ ...segment, sourceIds: [segment.id], final: false })
  }
  const latest = result.at(-1)
  if (latest && nowMs - latest.endMs >= silenceMs) latest.final = true
  // Preserve simultaneous speech as separate turns; never force it into Q&A order.
  let active: LiveUtterance[] = []
  for (const row of result) {
    active = active.filter(previous => previous.endMs > row.startMs)
    for (const previous of active) if (previous.sessionId === row.sessionId && row.endMs > previous.startMs
      && (previous.audioSource !== row.audioSource || previous.speakerId !== row.speakerId || previous.role !== row.role)) {
      previous.overlapping = true; row.overlapping = true
    }
    active.push(row)
  }
  return result.map(row => ({ ...row, text: simplifyTranscript(row.text) }))
}

export function priorUtteranceContext(utterances: LiveUtterance[], segmentId: string): string[] {
  const index = utterances.findIndex(row => row.sourceIds.includes(segmentId))
  const target = utterances[index]
  if (!target) return []
  return utterances.slice(0, index)
    .filter(row => row.final && row.endMs <= target.startMs && row.text.trim())
    .slice(-8)
    .map(row => `${row.role === 'candidate' ? '候选人' : row.role === 'interviewer' ? '面试官' : '待确认'}：${row.text.trim()}`)
}
