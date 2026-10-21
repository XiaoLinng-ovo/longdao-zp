import { apiClient } from '../../../shared/api'
import type { Candidate, ResumeScoreSummary } from '../../../shared/types/recruiting'

export { loadJobs } from '../../jobs/api'

interface ApiJob { id: string; title: string }
export interface ApiApplication { interviewProgress?: Candidate['interviewProgress']; analysisStatus?: string; analysisProgress?: number; analysisAttempts?: number; analysisError?: string; resumeReview?: ResumeScoreSummary; id: string; code?: string; candidateId: string; jobId: string; status: string; source?: string; score?: number; aiStatus: string; updatedAt: string; rejectionReason?: string }
export interface ApiCandidate { id: string; code: string; fullName: string; email?: string; phone?: string; source?: string; company?: string; skills?: string[]; tags?: string[]; status: string; updatedAt: string; aiStatus?: string; score?: number | null; analysisStatus?: string; analysisProgress?: number; analysisAttempts?: number; analysisError?: string; applications: ApiApplication[] }
export interface ApiResume { id: string; candidateId: string; applicationId?: string; originalFilename: string; mimeType: string; sizeBytes: number; contentHash: string; scanStatus: string; createdAt: string }
export interface ApiResumeDocument { originalFilename: string; mimeType: string; content: string; previewHtml?: string }
export async function getResumeDocument(candidateId: string, resumeId: string): Promise<ApiResumeDocument> {
  return (await apiClient.getJson<ApiResumeDocument>('/candidates/' + encodeURIComponent(candidateId) + '/resumes/' + encodeURIComponent(resumeId) + '/original')).data
}
export interface ApiAnalysisTask { id: string; resumeId: string; applicationId?: string; status: string; attempts: number; availableAt?: string; createdAt?: string; completedAt?: string; lastError?: string }

export interface ApiResumeExtraction {
  candidate?: { fullName?: string; email?: string; phone?: string; headline?: string }
  profile?: { headline?: string; summary?: string; totalExperienceYears?: number }
  education?: Array<{ institution?: string; degree?: string; fieldOfStudy?: string; evidence?: string }>
  experience?: Array<{ employer?: string; title?: string; startDate?: string; endDate?: string; description?: string; evidence?: string }>
  skills?: Array<{ value?: string; canonical?: string }>
  languages?: string[]
  certifications?: string[]
}

export interface ApiRequirementAssessment {
  status?: 'met' | 'partial' | 'not_mentioned' | 'contradicted'
  requirementId?: string
  label?: string
  matched?: boolean
  score?: number
  rationale?: string
  evidence?: Array<{ sourceText?: string; normalizedValue?: string }>
}

export interface ApiMatchAssessment {
  score?: number | null
  recommendation?: string
  dimensions?: { hardRequirement?: number; experience?: number; skills?: number; education?: number; potential?: number }
  matchedRequirements?: ApiRequirementAssessment[]
  conflicts?: ApiRequirementAssessment[]
  missingRequirements?: ApiRequirementAssessment[]
  strengths?: string[]
  risks?: string[]
  interviewQuestions?: string[]
  confidence?: number
}

export interface ApiAnalysisEditRecord {
  action?: string
  editedBy?: string
  editedAt?: string
  comment?: string
  before?: { score?: number; recommendation?: string; strengths?: string[]; risks?: string[] }
  after?: { score?: number; recommendation?: string; strengths?: string[]; risks?: string[] }
}

export interface ApiAnalysisResult {
  id: string
  analysisTaskId: string
  resumeId: string
  applicationId?: string
  result: {
    scoring?: { aiScore: number; humanScore: number; finalScore: number; comment?: string; history?: ResumeScoreSummary['history'] }
    humanDecision?: { status?: 'passed' | 'eliminated' }
    talentPool?: { included?: boolean }
    provenance?: { engine?: string; modelName?: string; scoringSkill?: ResumeScoreSummary['scoringSkill'] }
    assessment?: ApiMatchAssessment
    humanReview?: { status?: string; comment?: string; reviewedBy?: string; reviewedAt?: string; history?: ApiAnalysisEditRecord[] }
    extraction?: ApiResumeExtraction
    analysis?: {
      suggestion?: { summary?: string }
      report?: {
        provenance?: { engine?: string; modelName?: string; scoringSkill?: ResumeScoreSummary['scoringSkill'] }
        assessment?: ApiMatchAssessment
        extraction?: ApiResumeExtraction
        humanReview?: { status?: string; comment?: string; reviewedBy?: string; reviewedAt?: string; history?: ApiAnalysisEditRecord[] }
      }
    }
  }
  analyzerVersion: string
  inputHash: string
  humanReviewStatus: 'pending' | 'accepted' | 'needs_correction'
  createdAt: string
}

export function getAnalysisAssessment(result: ApiAnalysisResult | undefined): ApiMatchAssessment | undefined {
  return result?.result.assessment ?? result?.result.analysis?.report?.assessment
}

export function getAnalysisExtraction(result: ApiAnalysisResult | undefined): ApiResumeExtraction | undefined {
  return result?.result.extraction ?? result?.result.analysis?.report?.extraction
}

export interface ApiCandidateJob { id: string; code: string; title: string }
export interface ApiCandidateDetail {
  id: string
  code: string
  fullName: string
  email?: string
  phone?: string
  source?: string
  tags?: string[]
  status: string
  createdAt: string
  updatedAt: string
  applications: ApiApplication[]
  resumes: ApiResume[]
  analysisTasks: ApiAnalysisTask[]
  analysisResults: ApiAnalysisResult[]
  jobs: ApiCandidateJob[]
}

function toViewModel(row: ApiCandidate, jobs: Map<string, string>): Candidate {
  const application = row.applications[0]
  if (row.applications.length > 1) {
    const applicationRows = row.applications.map((application): Candidate => ({
      id: row.code || row.id, entityId: row.id, name: row.fullName, email: row.email, phone: row.phone,
      applicationId: application.id, rawApplicationStatus: application.status, resumeReview: application.resumeReview, interviewProgress: application.interviewProgress,
      job: jobs.get(application.jobId) || application.jobId,
      score: application.resumeReview?.aiScore ?? application.score ?? 0,
      scoreAvailable: typeof (application.resumeReview?.aiScore ?? application.score) === 'number',
      aiStatus: application.aiStatus === 'completed' ? 'completed' : 'pending',
      analysisStatus: application.analysisStatus, analysisProgress: application.analysisProgress,
      analysisAttempts: application.analysisAttempts, analysisError: application.analysisError,
      applicationStatus: (application.status === 'interviewing' ? 'scheduled' : application.status) as Candidate['applicationStatus'],
      source: application.source || row.source || '未标注', company: row.company, skills: row.skills, tags: row.tags,
      updatedAt: (application.updatedAt || row.updatedAt).slice(0, 10),
      updatedAtTimestamp: application.updatedAt || row.updatedAt,
    }))
    return { ...applicationRows[0], applicationRows }
  }
  // Candidate score is the latest analysis; application may still carry an older result.
  const latestScore = row.score !== undefined ? row.score : application?.score
  return {
    id: row.code || row.id,
    entityId: row.id,
    email: row.email,
    phone: row.phone,
    applicationId: application?.id,
    rawApplicationStatus: application?.status,
    resumeReview: application?.resumeReview,
    interviewProgress: application?.interviewProgress,
    name: row.fullName,
    job: application ? jobs.get(application.jobId) || application.jobId : '未关联岗位',
    score: typeof latestScore === 'number' ? latestScore : 0,
    scoreAvailable: typeof latestScore === 'number',
    source: application?.source || row.source || '未标注',
    company: row.company,
    skills: row.skills,
    aiStatus: application?.aiStatus === 'completed' || row.aiStatus === 'completed' ? 'completed' : 'pending',
    analysisStatus: row.analysisStatus,
    analysisProgress: row.analysisProgress,
    analysisAttempts: row.analysisAttempts,
    analysisError: row.analysisError,
    applicationStatus: (application?.status === 'interviewing' ? 'scheduled' : application?.status || 'pending') as Candidate['applicationStatus'],
    updatedAt: (application?.updatedAt || row.updatedAt).slice(0, 10),
    updatedAtTimestamp: application?.updatedAt || row.updatedAt,
    tags: row.tags,
  }
}

/** 确认后端没有演示数据回退；真实运行环境必须以数据库为准。 */
export async function loadCandidates(): Promise<Candidate[]> {
  const [candidateResponse, jobsResponse] = await Promise.all([
    apiClient.getJson<ApiCandidate[]>('/candidates'),
    apiClient.getJson<ApiJob[]>('/jobs'),
  ])
  const jobs = new Map(jobsResponse.data.map((job) => [job.id, job.title]))
  return candidateResponse.data.map((candidate) => toViewModel(candidate, jobs))
}

export interface ResumeReviewInput { humanScore?: number; comment?: string; decision?: 'passed' | 'eliminated'; talentPool?: boolean }
export async function updateResumeReview(resultId: string, input: ResumeReviewInput): Promise<ApiAnalysisResult> {
  return (await apiClient.patchJson<ApiAnalysisResult>(`/analysis-results/${encodeURIComponent(resultId)}/scoring`, input)).data
}

export function getResumeScoreSummary(result: ApiAnalysisResult | undefined): ResumeScoreSummary | undefined {
  if (!result) return undefined
  const assessment = getAnalysisAssessment(result)
  const scoring = result.result.scoring
  const validScore = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
  const aiScore = validScore(scoring?.aiScore) ? scoring.aiScore : validScore(assessment?.score) ? assessment.score : undefined
  const humanScore = scoring?.humanScore
  const finalScore = aiScore
  return {
    analysisEngine: result.result.provenance?.engine ?? result.result.analysis?.report?.provenance?.engine,
    modelName: result.result.provenance?.modelName ?? result.result.analysis?.report?.provenance?.modelName,
    resultId: result.id, ...(aiScore === undefined ? {} : { aiScore }), ...(humanScore === undefined ? {} : { humanScore }), ...(finalScore === undefined ? {} : { finalScore }),
    scoringSkill: result.result.provenance?.scoringSkill ?? result.result.analysis?.report?.provenance?.scoringSkill,
    scoringExplanation: result.result.analysis?.suggestion?.summary,
    comment: scoring?.comment,
    decision: result.result.humanDecision?.status,
    talentPool: result.result.talentPool?.included === true,
    history: scoring?.history ?? [],
    strengths: assessment?.strengths ?? [], risks: assessment?.risks ?? [],
    evidence: ([['matchedRequirements', 'matched'], ['conflicts', 'conflict'], ['missingRequirements', 'missing']] as const).flatMap(([key, outcome]) =>
      (assessment?.[key] ?? []).map((item) => ({ label: item.label || '岗位要求', rationale: item.rationale || '', sourceTexts: [...new Set((item.evidence ?? []).map((e) => e.sourceText).filter((v): v is string => !!v))], ...(typeof item.score === 'number' ? { score: item.score } : {}), outcome: item.status === 'partial' ? 'partial' as const : outcome }))),
  }
}

export async function loadCandidateTags(): Promise<string[]> {
  return (await apiClient.getJson<string[]>('/candidate-tags')).data
}

export async function deleteCandidate(id: string): Promise<void> {
  await apiClient.deleteJson<{ deleted: boolean }>(`/candidates/${encodeURIComponent(id)}`)
}

export async function getCandidate(id: string): Promise<ApiCandidateDetail> {
  return (await apiClient.getJson<ApiCandidateDetail>(`/candidates/${id}`)).data
}

export async function updateApplicationStatus(applicationId: string, status: string, reason?: string): Promise<ApiApplication> {
  return (await apiClient.postJson<ApiApplication>(`/applications/${applicationId}/status`, { status, reason })).data
}

export async function createCandidate(input: { fullName: string; email?: string; phone?: string; source?: string; tags?: string[] }): Promise<ApiCandidate> {
  return (await apiClient.postJson<ApiCandidate>('/candidates', input)).data
}

export type CandidateStatus = 'active' | 'archived' | 'do_not_contact'

export async function updateCandidate(id: string, body: { fullName?: string; email?: string; phone?: string; source?: string; tags?: string[]; status?: CandidateStatus; reason?: string }): Promise<ApiCandidate> {
  return (await apiClient.patchJson<ApiCandidate>(`/candidates/${id}`, body)).data
}

export async function createApplication(input: { candidateId: string; jobId: string; source?: string }): Promise<ApiApplication> {
  return (await apiClient.postJson<ApiApplication>('/applications', input)).data
}

export async function loadApplications(candidateId?: string): Promise<ApiApplication[]> {
  const query = candidateId ? `?candidateId=${encodeURIComponent(candidateId)}` : ''
  return (await apiClient.getJson<ApiApplication[]>(`/applications${query}`)).data
}

export async function listResumes(candidateId?: string): Promise<ApiResume[]> {
  const query = candidateId ? `?candidateId=${encodeURIComponent(candidateId)}` : ''
  return (await apiClient.getJson<ApiResume[]>(`/resumes${query}`)).data
}

export async function uploadResume(input: { candidateId: string; applicationId?: string; originalFilename: string; mimeType?: string; content: string; encoding?: 'utf8' | 'base64' }): Promise<{ resume: ApiResume; task: ApiAnalysisTask }> {
  return (await apiClient.postJson<{ resume: ApiResume; task: ApiAnalysisTask }>('/resumes', input)).data
}

export async function listAnalysisTasks(): Promise<ApiAnalysisTask[]> {
  return (await apiClient.getJson<ApiAnalysisTask[]>('/analysis-tasks')).data
}

export async function getAnalysisTask(taskId: string): Promise<ApiAnalysisTask> {
  return (await apiClient.getJson<ApiAnalysisTask>(`/analysis-tasks/${taskId}`)).data
}

/** Reuse a resume without moving it from its original application or copying the old score. */
export async function analyzeResumeForApplication(candidateId: string, resumeId: string, applicationId: string): Promise<ApiAnalysisTask> {
  return (await apiClient.postJson<ApiAnalysisTask>(`/candidates/${encodeURIComponent(candidateId)}/resumes/${encodeURIComponent(resumeId)}/analyze-for-application`, { applicationId })).data
}

export async function reanalyzeResume(candidateId: string, resumeId: string): Promise<ApiAnalysisTask> {
  return (await apiClient.postJson<ApiAnalysisTask>(`/candidates/${candidateId}/resumes/${resumeId}/reanalyze`, {})).data
}

/** 本地/内联规则分析入口；生产环境由 Worker 轮询完成，此方法保持幂等。 */
export async function processAnalysisTask(taskId: string): Promise<ApiAnalysisTask> {
  return (await apiClient.postJson<ApiAnalysisTask>(`/analysis-tasks/${taskId}`, {})).data
}

export async function getAnalysisResult(taskId: string): Promise<ApiAnalysisResult> {
  return (await apiClient.getJson<ApiAnalysisResult>(`/analysis-tasks/${taskId}/result`)).data
}

export async function getAnalysisResultById(id: string): Promise<ApiAnalysisResult> {
  return (await apiClient.getJson<ApiAnalysisResult>(`/analysis-results/${id}`)).data
}

export async function reviewAnalysisResult(id: string, body: {
  status: 'accepted' | 'needs_correction'
  comment?: string
  edits?: { score?: number; recommendation?: string; strengths?: string[]; risks?: string[] }
}): Promise<ApiAnalysisResult> {
  return (await apiClient.patchJson<ApiAnalysisResult>(`/analysis-results/${id}`, body)).data
}

/** Delete only one job application; retain the candidate and reusable resume files. */
export async function deleteApplication(applicationId: string): Promise<void> {
  await apiClient.deleteJson(`/applications/${encodeURIComponent(applicationId)}`)
}
