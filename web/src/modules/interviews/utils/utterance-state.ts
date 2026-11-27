import type { AnalysisSourceSegment, LiveAnswerAnalysis, LiveInterviewSegment } from '../api'
import { simplifyTranscript } from './transcript-text'

export interface LiveUtterance extends LiveInterviewSegment {
  sourceIds: string[]
  sourceSegments: LiveInterviewSegment[]
  final: boolean
  overlapping?: boolean
}

export function mergePolledLiveSegments(current: LiveInterviewSegment[], incoming: LiveInterviewSegment[]): LiveInterviewSegment[] {
  const key = (row: LiveInterviewSegment) => `${row.sessionId}:${row.id}`
  const updates = new Map(incoming.map(row => [key(row), row]))
  const merged = current.map(row => {
    const updated = updates.get(key(row))
    updates.delete(key(row))
    if (!updated || row.speakerConfirmed === true || row.speakerId.startsWith('manual_')) return row
    return { ...row, ...updated }
  })
  return [...merged, ...updates.values()]
}

function semanticRolePending(row: LiveInterviewSegment): boolean {
  return row.speakerConfirmed !== true && !!row.roleReview
    && (!!row.roleReview.failure || row.roleReview.status !== 'inferred' || row.roleReview.confidence < .85 || row.confidence < .85)
}

export function speakerRoleReviewLabel(row: LiveInterviewSegment): string {
  if (!row.roleReview || row.speakerConfirmed) return ''
  const review = row.roleReview
  if (review.failure || review.reason === '语义模型未完成复核') return 'AI 识别未完成'
  if (review.status === 'mixed') return '混合发言，待复核'
  return semanticRolePending(row) || row.role === 'unknown' ? '上下文不足，角色待确认' : 'AI 已识别'
}

export function speakerRoleReviewReason(row: LiveInterviewSegment): string {
  if (!row.roleReview || row.speakerConfirmed || !semanticRolePending(row) && row.role !== 'unknown') return ''
  return row.roleReview.reason === '语义模型未完成复核'
    ? '此前 AI 识别调用未完成，尚未得到角色判断。' : row.roleReview.reason
}

export function analysisSourceSegments(row: LiveUtterance): AnalysisSourceSegment[] {
  return row.sourceSegments.map(({ id, text, role, speakerId }) => ({ id, text, role, speakerId }))
}

export function analysisSourceKey(sources: AnalysisSourceSegment[]): string {
  return JSON.stringify(sources.map(({ id, text, role, speakerId }) => [id, text, role, speakerId]))
}

export function analysisMatchesUtterance(analysis: LiveAnswerAnalysis, row: LiveUtterance): boolean {
  if (row.role === 'unknown' || row.confidence < .6 || row.overlapping
    || row.sourceSegments.some(semanticRolePending)) return false
  if (row.role === 'interviewer' && (!analysis.sourceSegments?.length || !analysis.transcriptRefinement
    || analysis.scores.length || analysis.evidence.length || analysis.concerns.length || analysis.nextQuestion.trim())) return false
  // Legacy analyses lack membership metadata and are only safe for a single original turn.
  if (!analysis.sourceSegments?.length) return row.sourceIds.length === 1 && !analysis.transcriptRefinement
  return analysisSourceKey(analysis.sourceSegments) === analysisSourceKey(analysisSourceSegments(row))
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
    const sameIdentity = !!segment.speakerId && current?.sourceSegments.every(source => source.speakerId === segment.speakerId)
    const manuallyConfirmed = segment.speakerConfirmed === true && current?.sourceSegments.every(source => source.speakerConfirmed === true)
    const sameSpeaker = current && current.sessionId === segment.sessionId && current.role === segment.role
      && current.audioSource === segment.audioSource && (sameIdentity || manuallyConfirmed)
    if (current && sameSpeaker && current.role !== 'unknown'
      && current.sourceIds.length < 100
      && current.confidence >= 0.6 && segment.confidence >= 0.6
      && !current.sourceSegments.some(semanticRolePending) && !semanticRolePending(segment)
      && segment.startMs >= current.endMs && segment.startMs - current.endMs <= silenceMs) {
      current.text = `${current.text}${segment.text}`
      current.endMs = Math.max(current.endMs, segment.endMs)
      current.confidence = Math.min(current.confidence, segment.confidence)
      current.sourceIds.push(segment.id)
      current.sourceSegments.push({ ...segment })
      current.speakerConfirmed = current.sourceSegments.every(source => source.speakerConfirmed === true)
      const reviews = current.sourceSegments.flatMap(source => source.roleReview ? [source.roleReview] : [])
      if (reviews.length) {
        const weakest = reviews.reduce((a, b) => a.confidence <= b.confidence ? a : b)
        current.roleReview = { ...weakest, reason: [...new Set(reviews.map(review => review.reason))].join('；'),
          status: reviews.some(review => review.status === 'mixed') ? 'mixed'
            : reviews.some(review => review.status === 'uncertain') ? 'uncertain' : 'inferred' }
      }
      continue
    }
    if (current) current.final = true
    result.push({ ...segment, sourceIds: [segment.id], sourceSegments: [{ ...segment }], final: false })
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
    .map(row => (semanticRolePending(row) ? '待确认' : row.role === 'candidate' ? '候选人'
      : row.role === 'interviewer' ? '面试官' : '待确认') + '：' + row.text.trim())
}
