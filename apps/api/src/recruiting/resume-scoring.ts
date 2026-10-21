import { RecruitingWorkflowError } from './workflow.js'

export interface ResumeReviewInput {
  humanScore?: number
  comment?: string
  decision?: 'passed' | 'eliminated'
  talentPool?: boolean
}
export interface ResumeScoreSummary {
  analysisEngine?: string
  modelName?: string
  scoringSkill?: { id: string; name: string; content: string; updatedAt: string }
  scoringExplanation?: string
  resultId: string
  aiScore?: number
  humanScore?: number
  finalScore?: number
  comment?: string
  decision?: 'passed' | 'eliminated'
  talentPool: boolean
  history: Array<{ humanScore: number; finalScore: number; comment: string; actorId: string; updatedAt: string }>
  evidence: Array<{ label: string; rationale: string; sourceTexts: string[]; score?: number; outcome: 'matched' | 'partial' | 'conflict' | 'missing' }>
  strengths: string[]
  risks: string[]
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v.trim()) : []
}
function validScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
}
export function weightedResumeScore(ai: number, human: number): number {
  return Math.round((ai * 0.4 + human * 0.6) * 100) / 100
}
export function resumeScoreSummary(id: string, result: Record<string, unknown>): ResumeScoreSummary {
  const report = Object.keys(object(object(result.analysis).report)).length ? object(object(result.analysis).report) : result
  const assessment = object(result.assessment ?? report.assessment)
  const scoring = object(result.scoring)
  const aiScore = validScore(scoring.aiScore) ? scoring.aiScore : validScore(assessment.score) ? assessment.score : undefined
  const humanScore = validScore(scoring.humanScore) ? scoring.humanScore : undefined
  const finalScore = aiScore // 当前简历筛选仅使用 AI 分；历史人工评分保留但不参与计算。
  const evidence: ResumeScoreSummary['evidence'] = []
  for (const [key, outcome] of [['matchedRequirements', 'matched'], ['conflicts', 'conflict'], ['missingRequirements', 'missing']] as const) {
    for (const raw of Array.isArray(assessment[key]) ? assessment[key] as unknown[] : []) {
      const row = object(raw)
      evidence.push({
        label: typeof row.label === 'string' ? row.label : '岗位要求',
        rationale: typeof row.rationale === 'string' ? row.rationale : '',
        sourceTexts: Array.isArray(row.evidence) ? [...new Set(row.evidence.flatMap((item) => strings([object(item).sourceText])))] : [],
        outcome: row.status === 'partial' ? 'partial' : outcome,
        ...(typeof row.score === 'number' ? { score: row.score } : {}),
      })
    }
  }
  const decision = object(result.humanDecision).status
  const skill = object(object(report.provenance).scoringSkill)
  const explanation = object(object(result.analysis).suggestion).summary
  return {
    resultId: id,
    ...(typeof object(report.provenance).engine === 'string' ? { analysisEngine: object(report.provenance).engine as string } : {}),
    ...(typeof object(report.provenance).modelName === 'string' ? { modelName: object(report.provenance).modelName as string } : {}),
    ...(typeof skill.id === 'string' && typeof skill.name === 'string' && typeof skill.content === 'string' && typeof skill.updatedAt === 'string'
      ? { scoringSkill: { id: skill.id, name: skill.name, content: skill.content, updatedAt: skill.updatedAt } } : {}),
    ...(typeof explanation === 'string' ? { scoringExplanation: explanation } : {}),
    ...(aiScore !== undefined ? { aiScore } : {}),
    ...(humanScore !== undefined ? { humanScore } : {}),
    ...(finalScore !== undefined ? { finalScore } : {}),
    ...(typeof scoring.comment === 'string' ? { comment: scoring.comment } : {}),
    ...(decision === 'passed' || decision === 'eliminated' ? { decision } : {}),
    talentPool: object(result.talentPool).included === true,
    history: Array.isArray(scoring.history) ? scoring.history as ResumeScoreSummary['history'] : [],
    evidence,
    strengths: strings(assessment.strengths),
    risks: strings(assessment.risks),
  }
}

/** Pure calculation: the caller persists the report, application and audit events atomically. */
export function applyResumeReview(id: string, source: Record<string, unknown>, applicationStatus: string, input: ResumeReviewInput, actorId: string) {
  const fail = (message: string, code = 'VALIDATION_ERROR', status = 400): never => { throw new RecruitingWorkflowError(code, message, status) }
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('评分请求格式不正确')
  if (input.humanScore !== undefined) fail('简历筛选仅使用 AI 评分，不再接受人工评分', 'HUMAN_SCORING_DISABLED', 409)
  if (input.decision === undefined && input.talentPool === undefined) fail('请选择通过、淘汰或人才库操作')
  if (input.comment !== undefined && typeof input.comment !== 'string') fail('处理说明必须是文字')
  if (input.decision !== undefined && !['passed', 'eliminated'].includes(input.decision)) fail('处理结果必须是通过或淘汰')
  if (input.talentPool !== undefined && typeof input.talentPool !== 'boolean') fail('人才库选项必须是布尔值')
  const report = structuredClone(source)
  const current = resumeScoreSummary(id, report)
  if (current.aiScore === undefined) fail('请先完成简历 AI 评分', 'AI_SCORE_REQUIRED', 409)
  const aiScore = current.aiScore!
  const now = new Date().toISOString()
  let nextStatus = applicationStatus
  if (input.decision !== undefined) {
    if (!['pending_analysis', 'analysis_queued', 'human_review'].includes(applicationStatus)) fail('该申请已结束简历筛选，不能重复通过或淘汰', 'APPLICATION_REVIEW_CLOSED', 409)
    nextStatus = input.decision === 'passed' ? 'interviewing' : 'rejected'
    const defaultReason = input.decision === 'passed'
      ? (aiScore < 80 ? 'AI 建议淘汰，人工确认通过并进入初试' : '人工确认简历筛选通过，进入初试')
      : (aiScore >= 80 ? 'AI 建议通过，人工确认淘汰' : 'AI 评分低于 80 分，人工确认简历筛选淘汰')
    report.humanDecision = { status: input.decision, stage: input.decision === 'passed' ? 'initial_interview' : 'rejected', reason: input.comment?.trim() || defaultReason, decidedBy: actorId, decidedAt: now }
  }
  if (input.talentPool !== undefined) {
    if (input.talentPool && aiScore >= 80) fail('仅 AI 评分低于 80 分的候选人可选择加入人才库')
    report.talentPool = { included: input.talentPool, updatedBy: actorId, updatedAt: now }
  }
  // A rescore above the cutoff no longer belongs to the rejected-resume talent pool.
  if (aiScore >= 80 && current.talentPool) report.talentPool = { included: false, updatedBy: actorId, updatedAt: now }
  return { report, nextStatus, summary: resumeScoreSummary(id, report) }
}
