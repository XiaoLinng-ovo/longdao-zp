import { ApiClientError, ApiNetworkError } from '../../../shared/api/errors'
import type { LiveInterviewSegment } from '../api'
import type { LiveUtterance } from './utterance-state'

const overlapMessage = '与其他发言重叠，暂不自动分析，请回听并核实相关发言。'

// Mirror selection and reliable-turn checks on the server. It remains authoritative
// if another upload or correction arrives after this snapshot.
export function analysisEligibility(row: LiveUtterance, segments: LiveInterviewSegment[]) {
  const ordered = segments.filter(segment => segment.sessionId === row.sessionId)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id))
  const ids = new Set(row.sourceIds)
  const selected = ordered.filter(segment => ids.has(segment.id))
  const revision = JSON.stringify(ordered.filter(segment => segment.startMs <= row.endMs || ids.has(segment.id))
    .map(segment => [segment.id, segment.text, segment.role, segment.confidence, segment.speakerId,
      segment.speakerConfirmed, segment.audioSource, segment.startMs, segment.endMs]))
  const blocked = (reason: string) => ({ reason, revision })
  if (row.role === 'unknown' || row.confidence < .6) return blocked('说话人待确认，暂不自动分析。')
  if (!row.final) return blocked('发言尚未结束。')
  if (!selected.length || selected.length !== ids.size || selected.length > 100) return blocked('发言分段已变化，请核实后再分析。')
  const first = selected[0]!, offset = ordered.indexOf(first)
  if (selected.length > 1 && (
    !(first.speakerId && selected.every(segment => segment.speakerId === first.speakerId))
      && !selected.every(segment => segment.speakerConfirmed === true)
    || selected.some((segment, index) => segment !== ordered[offset + index]
      || segment.role !== first.role || segment.confidence < .6 || segment.audioSource !== first.audioSource
      || (index > 0 && (segment.startMs < selected[index - 1]!.endMs || segment.startMs - selected[index - 1]!.endMs > 15_000))))) {
    return blocked('发言分段不连续或说话人不一致，请核实后再分析。')
  }
  const startMs = Math.min(...selected.map(segment => segment.startMs))
  const endMs = Math.max(...selected.map(segment => segment.endMs))
  if (ordered.some(segment => !ids.has(segment.id) && segment.startMs < endMs && segment.endMs > startMs)) {
    return blocked(overlapMessage)
  }
  if (row.role === 'candidate') {
    // The server groups adjacent candidate turns before checking reliability.
    // An overlap earlier in that full turn can also block this selected suffix.
    const turns: Array<{ role: string; ids: string[]; startMs: number; endMs: number }> = []
    for (const segment of ordered.filter(segment => segment.text.trim() && segment.endMs <= endMs)) {
      const role = segment.confidence >= .6 ? segment.role : 'unknown'
      const previous = turns.at(-1)
      if (previous && role !== 'unknown' && previous.role === role && segment.startMs >= previous.endMs
        && segment.startMs - previous.endMs <= 2000) {
        previous.endMs = Math.max(previous.endMs, segment.endMs)
        previous.ids.push(segment.id)
      } else turns.push({ role, ids: [segment.id], startMs: segment.startMs, endMs: segment.endMs })
    }
    if (selected.some(segment => !turns.some(turn => turn.role === 'candidate' && turn.ids.includes(segment.id)
      && !turns.some(other => other.role !== 'candidate' && other.startMs < turn.endMs && other.endMs > turn.startMs)))) {
      return blocked('关联回答中有重叠或说话人待确认的发言，请核实后再分析。')
    }
  }
  return { reason: '', revision }
}

export function retryableAnalysisError(error: unknown): boolean {
  if (!(error instanceof ApiClientError) || error.retryable === false) return false
  if (error.code?.startsWith('ANALYSIS_') || error.code === 'AI_NOT_CONFIGURED') return false
  return error instanceof ApiNetworkError || error.status === 429 || (error.status ?? 0) >= 500
}

export function analysisNeedsReview(error: unknown): boolean {
  return error instanceof ApiClientError && (error.code?.startsWith('ANALYSIS_') === true
    || ['INVALID_INPUT', 'INVALID_UTTERANCE_SEGMENTS', 'CANDIDATE_ROLE_UNCONFIRMED'].includes(error.code ?? ''))
}
