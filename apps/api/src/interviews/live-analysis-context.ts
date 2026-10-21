import { InterviewAnswerAnalysisError } from './answer-analyzer.js'
import { buildActualDialogue, reliableCandidateTurns } from './interview-summary.js'
import type { LiveSegment } from './live-session-repository.js'

/** Reference selections and client-supplied context are never proof of a spoken question. */
export function buildLiveAnalysisContext(segments: LiveSegment[], primaryId: string, segmentIds: string[]) {
  const ids = [...new Set(segmentIds.length ? segmentIds : [primaryId])]
  const selected = segments.filter(segment => ids.includes(segment.id))
  if (!ids.includes(primaryId) || ids.length > 100 || selected.length !== ids.length
    || selected.some(segment => segment.role !== 'candidate' || segment.confidence < .6
      || segment.sessionId !== selected[0]!.sessionId || segment.speakerId !== selected[0]!.speakerId)) {
    throw new InterviewAnswerAnalysisError('INVALID_INPUT', '只能分析同一会话内已确认的候选人发言。')
  }
  const startMs = Math.min(...selected.map(segment => segment.startMs))
  const endMs = Math.max(...selected.map(segment => segment.endMs))
  const eligible = segments.filter(segment => segment.endMs <= endMs)
  const { transcript, pairs } = buildActualDialogue(eligible)
  if (segments.some(segment => (segment.role !== 'candidate' || segment.confidence < .6) && segment.startMs < endMs && segment.endMs > startMs)) {
    throw new InterviewAnswerAnalysisError('INVALID_INPUT', '发言存在重叠或说话人待确认，请核实后再分析。')
  }
  const candidateTurns = reliableCandidateTurns(transcript)
  if (selected.some(segment => !candidateTurns.some(turn => turn.segmentIds.includes(segment.id)))) {
    throw new InterviewAnswerAnalysisError('INVALID_INPUT', '发言存在重叠或说话人待确认，请核实后再分析。')
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
