import type { SpeakerSegment } from './role-mapper.js'

export interface InterviewUtterance extends SpeakerSegment { sourceSegmentIds: string[]; final: boolean }

function joinText(left: string, right: string): string {
  if (!left) return right.trim()
  if (!right) return left.trim()
  const noSpace = /[\u3400-\u9fff，。！？、；：]$/u.test(left) || /^[\u3400-\u9fff，。！？、；：]/u.test(right)
  return `${left.trimEnd()}${noSpace ? '' : ' '}${right.trimStart()}`
}

export function assembleUtterances(segments: SpeakerSegment[], silenceMs: number): InterviewUtterance[] {
  if (!Number.isFinite(silenceMs) || silenceMs < 0) throw new Error('silenceMs must be non-negative')
  const ordered = [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const result: InterviewUtterance[] = []
  for (const segment of ordered) {
    const current = result.at(-1)
    if (current && current.speakerId === segment.speakerId && segment.startMs - current.endMs <= silenceMs) {
      current.text = joinText(current.text, segment.text)
      current.endMs = Math.max(current.endMs, segment.endMs)
      current.sourceSegmentIds.push(segment.id)
      continue
    }
    if (current) current.final = true
    result.push({ ...segment, sourceSegmentIds: [segment.id], final: false })
  }
  return result
}
