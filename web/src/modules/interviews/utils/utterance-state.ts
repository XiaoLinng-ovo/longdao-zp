import type { LiveInterviewSegment } from '../api'

export interface LiveUtterance extends LiveInterviewSegment {
  sourceIds: string[]
  final: boolean
}

export function buildUtterances(
  segments: LiveInterviewSegment[],
  nowMs: number,
  silenceMs: number,
): LiveUtterance[] {
  const result: LiveUtterance[] = []
  const ordered = [...segments].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
  for (const segment of ordered) {
    const current = result.at(-1)
    if (current && current.speakerId === segment.speakerId && segment.startMs - current.endMs <= silenceMs) {
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
  return result
}
