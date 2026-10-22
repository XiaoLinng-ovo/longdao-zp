import { apiClient } from '../../../shared/api'

export type InterviewStage = 'initial' | 'final'
export type QuestionSheetType = 'hr_screen' | 'hiring_department' | 'business' | 'hr' | 'boss'
export type QuestionSheetStatus = 'draft' | 'generating' | 'scoring' | 'submitted' | 'locked'
export type QuestionTierName = 'excellent' | 'pass' | 'below'
export type StageDecision = 'advanced' | 'rejected' | 'hired' | 'hold'
export type StageRecommendation = 'strong_yes' | 'yes' | 'mixed' | 'no'

export interface QuestionTier { tier: QuestionTierName; min: number; max: number; description: string }

export interface ApiInterviewQuestion {
  id: string
  seq: number
  question: string
  dimension: string | null
  category: string | null
  assessmentFocus?: string | null
  difficulty: string | null
  source: 'live_question' | 'ai_generated' | 'manual'
  questionEventId: string | null
  answerSegmentIds: string[]
  answerText: string | null
  tiers: QuestionTier[]
  aiTier: QuestionTierName | null
  aiScore: number | null
  aiRationale: string | null
  aiEvidence: string[]
  finalTier: QuestionTierName | null
  finalScore: number | null
  comment: string | null
  scoredBy: string | null
  scoredAt: string | null
}

export interface QuestionSheetAggregate { score: number | null; ratings: Record<string, number>; scoredCount: number; totalCount: number }

export interface ApiQuestionSheet {
  id: string
  applicationId: string
  stage: InterviewStage
  sheetType: QuestionSheetType
  status: QuestionSheetStatus
  source: 'ai' | 'manual'
  generationModel: string | null
  generationError: string | null
  generationNotice: string | null
  generatedAt: string | null
  submittedAt: string | null
  lockedAt: string | null
  questions: ApiInterviewQuestion[]
  aggregate: QuestionSheetAggregate
}

export interface StageWeights { sheets: Record<string, number>; recording: number }

export interface StageScoreItem { key: string; label: string; score: number | null; weight: number; effectiveWeight: number; contribution: number | null }
export interface StageScoreBreakdown { formula: string; items: StageScoreItem[]; score: number | null; notes: string[] }

export interface NextRoundInterview { id: string; round: number; stage: 'final'; status: 'scheduled' | 'completed' | 'cancelled' }

export interface ApiStageReview {
  nextInterview?: NextRoundInterview | null
  id: string
  applicationId: string
  stage: InterviewStage
  sheetScores: Record<string, number>
  weights: StageWeights
  weightsHistory: Array<{ actorId: string; at: string; from: StageWeights; to: StageWeights }>
  recordingScore: number | null
  aiScore: number | null
  aiRecommendation: StageRecommendation | null
  aiRationale: string | null
  aiEvidence: string[]
  decision: StageDecision | null
  decidedBy: string | null
  decidedAt: string | null
}

export interface ApiApplicationQuestionSheets {
  applicationId: string
  nextInterview?: NextRoundInterview | null
  sheets: ApiQuestionSheet[]
  reviews: ApiStageReview[]
  stages: Array<{ stage: InterviewStage; weights: StageWeights; breakdown: StageScoreBreakdown }>
}

/** 两个阶段各自的表：初试 2 张，复试 3 张（与后端 STAGE_SHEET_TYPES 一致）。 */
export const STAGE_SHEET_TYPES: Record<InterviewStage, QuestionSheetType[]> = {
  initial: ['hr_screen', 'hiring_department'],
  final: ['business', 'hr', 'boss'],
}

export const STAGE_LABEL: Record<InterviewStage, string> = { initial: '初试', final: '复试' }

export const SHEET_TYPE_LABEL: Record<QuestionSheetType, string> = {
  hr_screen: '人事面试表',
  hiring_department: '用人部门面试表',
  business: '业务面试表',
  hr: 'HR 面试表',
  boss: 'BOSS 面试表',
}

export const SHEET_STATUS_LABEL: Record<QuestionSheetStatus, string> = {
  draft: '待生成',
  generating: '载入中',
  scoring: '待打分',
  submitted: '已提交',
  locked: '已锁定',
}

export const TIER_LABEL: Record<QuestionTierName, string> = { excellent: '优秀', pass: '合格', below: '待改进' }

export const STAGE_RECOMMENDATION_LABEL: Record<StageRecommendation, string> = {
  strong_yes: '强烈建议录用',
  yes: '建议录用',
  mixed: '待定',
  no: '不建议录用',
}

export const STAGE_DECISION_LABEL: Record<StageDecision, string> = {
  advanced: '进入复试',
  rejected: '淘汰',
  hired: '录用',
  hold: '待定',
}

/** 阶段可选的结论按钮：初试决定是否进复试，复试决定是否录用。 */
export const STAGE_DECISIONS: Record<InterviewStage, StageDecision[]> = {
  initial: ['advanced', 'hold', 'rejected'],
  final: ['hired', 'hold', 'rejected'],
}

/** 面试轮次到阶段的映射，与迁移 0021 的默认口径一致（第 1 轮=初试，第 2 轮及以后=复试）。 */
export function stageOfRound(round: number): InterviewStage {
  return round >= 2 ? 'final' : 'initial'
}

export async function loadQuestionSheets(applicationId: string): Promise<ApiApplicationQuestionSheets> {
  return (await apiClient.getJson<ApiApplicationQuestionSheets>(`/applications/${applicationId}/question-sheets`)).data
}

export async function generateQuestionSheet(applicationId: string, stage: InterviewStage, sheetType: QuestionSheetType): Promise<ApiApplicationQuestionSheets> {
  return (await apiClient.postJson<ApiApplicationQuestionSheets>(`/applications/${applicationId}/question-sheets/${stage}/${sheetType}`, {})).data
}

export interface QuestionScorePatch { finalTier?: QuestionTierName | null; finalScore?: number | null; comment?: string | null }

export async function scoreQuestion(applicationId: string, stage: InterviewStage, sheetType: QuestionSheetType, questionId: string, patch: QuestionScorePatch): Promise<ApiInterviewQuestion> {
  return (await apiClient.patchJson<ApiInterviewQuestion>(`/applications/${applicationId}/question-sheets/${stage}/${sheetType}/questions/${questionId}`, patch)).data
}

export async function addSheetQuestion(applicationId: string, stage: InterviewStage, sheetType: QuestionSheetType, body: { question: string; dimension?: string; answerText?: string }): Promise<ApiInterviewQuestion> {
  return (await apiClient.postJson<ApiInterviewQuestion>(`/applications/${applicationId}/question-sheets/${stage}/${sheetType}/questions`, body)).data
}

export async function deleteSheetQuestion(applicationId: string, stage: InterviewStage, sheetType: QuestionSheetType, questionId: string): Promise<void> {
  await apiClient.deleteJson(`/applications/${applicationId}/question-sheets/${stage}/${sheetType}/questions/${questionId}`)
}

export async function submitSheet(applicationId: string, stage: InterviewStage, sheetType: QuestionSheetType): Promise<{ sheet: ApiQuestionSheet; stageReview: ApiStageReview | null }> {
  return (await apiClient.postJson<{ sheet: ApiQuestionSheet; stageReview: ApiStageReview | null }>(`/applications/${applicationId}/question-sheets/${stage}/${sheetType}/submit`, {})).data
}

export async function lockSheet(applicationId: string, stage: InterviewStage, sheetType: QuestionSheetType): Promise<{ sheet: ApiQuestionSheet }> {
  return (await apiClient.postJson<{ sheet: ApiQuestionSheet }>(`/applications/${applicationId}/question-sheets/${stage}/${sheetType}/lock`, {})).data
}

export async function unlockSheet(applicationId: string, stage: InterviewStage, sheetType: QuestionSheetType): Promise<{ sheet: ApiQuestionSheet }> {
  return (await apiClient.postJson<{ sheet: ApiQuestionSheet }>(`/applications/${applicationId}/question-sheets/${stage}/${sheetType}/unlock`, {})).data
}

export async function updateStageWeights(applicationId: string, stage: InterviewStage, weights: StageWeights): Promise<{ review: ApiStageReview; breakdown: StageScoreBreakdown }> {
  return (await apiClient.patchJson<{ review: ApiStageReview; breakdown: StageScoreBreakdown }>(`/applications/${applicationId}/stages/${stage}/weights`, weights)).data
}

export async function recordStageDecision(applicationId: string, stage: InterviewStage, decision: StageDecision): Promise<ApiStageReview> {
  return (await apiClient.postJson<ApiStageReview>(`/applications/${applicationId}/stages/${stage}/decision`, { decision })).data
}
