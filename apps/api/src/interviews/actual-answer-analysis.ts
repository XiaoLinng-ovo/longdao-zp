import type { InterviewAnswerAnalysis, InterviewAnswerAnalysisInput } from './answer-analyzer.js'
import type { LiveSegment } from './live-session-repository.js'
import { buildInterviewerRefinementContext, buildLiveAnalysisContext } from './live-analysis-context.js'
import { selectUtteranceSegments } from './utterance-segments.js'

export const ACTUAL_ANSWER_PROMPT_VERSION = 'whole-dialogue-v3'

/** Selected reference questions never establish what was actually spoken. */
export async function analyzeActualAnswer(
  segments: LiveSegment[], segmentIds: string[],
  job: Pick<InterviewAnswerAnalysisInput, 'jobTitle' | 'jobRequirements' | 'resumeContext'>,
  analyze: (input: InterviewAnswerAnalysisInput) => Promise<InterviewAnswerAnalysis>,
): Promise<{ question: string; analysis: InterviewAnswerAnalysis }> {
  const interviewer = segments.find(segment => segment.id === segmentIds[0])?.role === 'interviewer'
  const context = (interviewer ? buildInterviewerRefinementContext : buildLiveAnalysisContext)(segments, segmentIds[0] ?? '', segmentIds)
  const sourceSegments = selectUtteranceSegments(segments, segmentIds[0] ?? '', segmentIds)
    .map(({ id, text, role, speakerId }) => ({ id, text, role, speakerId }))
  const analysis = await analyze({ ...job, ...context, refineTranscript: true })
  return { question: context.question, analysis: { ...analysis,
    ...(interviewer ? { summary: '面试官完整发言已整理。', evidence: [], scores: [], concerns: [], nextQuestion: '' } : {}),
    sourceSegments } }
}
