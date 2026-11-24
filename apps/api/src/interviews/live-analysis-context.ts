import { InterviewAnswerAnalysisError } from './answer-analyzer.js'
import { buildActualDialogue, reliableCandidateTurns } from './interview-summary.js'
import type { LiveSegment } from './live-session-repository.js'
import { selectUtteranceSegments } from './utterance-segments.js'
import { semanticRolePending } from './semantic-role-review.js'

export function buildInterviewerRefinementContext(segments: LiveSegment[], primaryId: string, segmentIds: string[]) {
  const sessionId = segments.find(segment => segment.id === primaryId)?.sessionId
  segments = segments.filter(segment => segment.sessionId === sessionId)
  let selected: LiveSegment[]
  try { selected = selectUtteranceSegments(segments, primaryId, segmentIds) }
  catch { throw new InterviewAnswerAnalysisError('ANALYSIS_SEGMENTS_INVALID', '发言分段不连续、重叠或说话人待确认，请核实后再整理。') }
  if (selected.some(segment => segment.role !== 'interviewer' || segment.confidence < .6 || semanticRolePending(segment))) {
    throw new InterviewAnswerAnalysisError('ANALYSIS_SPEAKER_UNCONFIRMED', '只能整理已确认的同一面试官发言，请先核实说话人。')
  }
  const startMs = Math.min(...selected.map(segment => segment.startMs))
  const endMs = Math.max(...selected.map(segment => segment.endMs))
  const ids = new Set(selected.map(segment => segment.id))
  if (segments.some(segment => segment.sessionId === selected[0]!.sessionId && !ids.has(segment.id)
    && segment.startMs < endMs && segment.endMs > startMs)) {
    throw new InterviewAnswerAnalysisError('ANALYSIS_OVERLAPPING_SPEECH', '发言存在重叠或说话人待确认，请核实后再整理。')
  }
  const { transcript } = buildActualDialogue(segments.filter(segment => segment.endMs <= endMs))
  return {
    question: '', speechRole: 'interviewer' as const,
    candidateAnswer: selected.map(segment => segment.text).join('\n'), transcript,
    priorContext: transcript.filter(turn => turn.endMs <= startMs && !turn.segmentIds.some(id => ids.has(id)))
      .map(turn => (turn.role === 'candidate' ? '候选人' : turn.role === 'interviewer' ? '面试官' : '待确认') + '：' + turn.text),
  }
}

/** Reference selections and client-supplied context are never proof of a spoken question. */
export function buildLiveAnalysisContext(segments: LiveSegment[], primaryId: string, segmentIds: string[]) {
  const sessionId = segments.find(segment => segment.id === primaryId)?.sessionId
  segments = segments.filter(segment => segment.sessionId === sessionId)
  const ids = [...new Set(segmentIds.length ? segmentIds : [primaryId])]
  let selected: LiveSegment[]
  try {
    selected = selectUtteranceSegments(segments, primaryId, ids)
  } catch {
    throw new InterviewAnswerAnalysisError('ANALYSIS_SEGMENTS_INVALID', '发言分段不连续、重叠或说话人待确认，请核实后再分析。')
  }
  if (selected.some(segment => segment.role !== 'candidate' || segment.confidence < .6 || semanticRolePending(segment))) {
    throw new InterviewAnswerAnalysisError('ANALYSIS_SPEAKER_UNCONFIRMED', '只能分析同一会话内已确认的候选人发言。')
  }
  const startMs = Math.min(...selected.map(segment => segment.startMs))
  const endMs = Math.max(...selected.map(segment => segment.endMs))
  const eligible = segments.filter(segment => segment.endMs <= endMs)
  const { transcript, pairs } = buildActualDialogue(eligible)
  if (segments.some(segment => (segment.role !== 'candidate' || segment.confidence < .6 || semanticRolePending(segment)) && segment.startMs < endMs && segment.endMs > startMs)) {
    throw new InterviewAnswerAnalysisError('ANALYSIS_OVERLAPPING_SPEECH', '发言存在重叠或说话人待确认，请核实后再分析。')
  }
  const candidateTurns = reliableCandidateTurns(transcript)
  if (selected.some(segment => !candidateTurns.some(turn => turn.segmentIds.includes(segment.id)))) {
    throw new InterviewAnswerAnalysisError('ANALYSIS_CONTEXT_UNCONFIRMED', '关联回答存在重叠或说话人待确认，请核实后再分析。')
  }
  const pair = pairs.find(pair => pair.answerSegmentIds.includes(primaryId))
  return {
    question: pair?.question ?? '',
    candidateAnswer: [...selected].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id)).map(segment => segment.text).join('\n'),
    transcript,
    priorContext: transcript.filter(turn => turn.endMs <= startMs && !turn.segmentIds.some(id => ids.includes(id)))
      .map(turn => (turn.role === 'candidate' ? '候选人' : turn.role === 'interviewer' ? '面试官' : '待确认') + '：' + turn.text),
  }
}
