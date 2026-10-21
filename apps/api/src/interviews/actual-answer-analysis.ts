import type { InterviewAnswerAnalysis, InterviewAnswerAnalysisInput } from './answer-analyzer.js'
import type { LiveSegment } from './live-session-repository.js'
import { buildLiveAnalysisContext } from './live-analysis-context.js'

export const ACTUAL_ANSWER_PROMPT_VERSION = 'whole-dialogue-v3'

/** Selected reference questions never establish what was actually spoken. */
export async function analyzeActualAnswer(
  segments: LiveSegment[], segmentIds: string[],
  job: Pick<InterviewAnswerAnalysisInput, 'jobTitle' | 'jobRequirements' | 'resumeContext'>,
  analyze: (input: InterviewAnswerAnalysisInput) => Promise<InterviewAnswerAnalysis>,
): Promise<{ question: string; analysis: InterviewAnswerAnalysis }> {
  const context = buildLiveAnalysisContext(segments, segmentIds[0] ?? '', segmentIds)
  return { question: context.question, analysis: await analyze({ ...job, ...context }) }
}
