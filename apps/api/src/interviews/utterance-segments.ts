import type { LiveSegment } from './live-session-repository.js'

export function selectUtteranceSegments(segments: LiveSegment[], primaryId: string, segmentIds: string[]): LiveSegment[] {
  const ids = new Set(segmentIds.length ? segmentIds : [primaryId])
  const primary = segments.find(segment => segment.id === primaryId)
  const invalid = () => Object.assign(new Error('只能合并同一会话中连续、无重叠且说话人已确认的发言。'), { code: 'INVALID_UTTERANCE_SEGMENTS', status: 400 })
  if (!primary || !ids.has(primaryId) || ids.size > 100) throw invalid()
  const ordered = segments.filter(segment => segment.sessionId === primary.sessionId)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id))
  const selected = ordered.filter(segment => ids.has(segment.id))
  if (selected.length !== ids.size) throw invalid()
  if (selected.length === 1) return selected
  const first = selected[0]!
  const offset = ordered.indexOf(first)
  const sameIdentity = !!first.speakerId && selected.every(segment => segment.speakerId === first.speakerId)
  const manuallyConfirmed = selected.every(segment => segment.speakerConfirmed === true)
  if ((!sameIdentity && !manuallyConfirmed) || first.role === 'unknown'
    || selected.some((segment, index) => segment !== ordered[offset + index]
      || segment.role !== first.role || segment.confidence < .6 || segment.audioSource !== first.audioSource
      || (index > 0 && (segment.startMs < selected[index - 1]!.endMs
        || segment.startMs - selected[index - 1]!.endMs > 15_000)))) throw invalid()
  return selected
}
