import { apiClient } from '../../../shared/api'
import type { Candidate } from '../../../shared/types/recruiting'

export { loadJobs } from '../../jobs/api'

interface ApiJob { id: string; title: string }
export interface ApiApplication { id: string; code?: string; candidateId: string; jobId: string; status: string; source?: string; score?: number; aiStatus: string; updatedAt: string; rejectionReason?: string }
export interface ApiCandidate { id: string; code: string; fullName: string; email?: string; phone?: string; source?: string; company?: string; skills?: string[]; tags?: string[]; status: string; updatedAt: string; aiStatus?: string; score?: number; analysisStatus?: string; analysisProgress?: number; analysisAttempts?: number; analysisError?: string; applications: ApiApplication[] }
export interface ApiResume { id: string; candidateId: string; applicationId?: string; originalFilename: string; mimeType: string; sizeBytes: number; contentHash: string; scanStatus: string; createdAt: string }
export interface ApiAnalysisTask { id: string; resumeId: string; applicationId?: string; status: string; attempts: number; completedAt?: string; lastError?: string }

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
  requirementId?: string
  label?: string
  matched?: boolean
  score?: number
  rationale?: string
  evidence?: Array<{ sourceText?: string; normalizedValue?: string }>
}

export interface ApiMatchAssessment {
  score?: number
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
    assessment?: ApiMatchAssessment
    humanReview?: { status?: string; comment?: string; reviewedBy?: string; reviewedAt?: string; history?: ApiAnalysisEditRecord[] }
    extraction?: ApiResumeExtraction
    analysis?: {
      report?: {
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
  return {
    id: row.code || row.id,
    entityId: row.id,
    name: row.fullName,
    job: application ? jobs.get(application.jobId) || application.jobId : '未关联岗位',
    score: application?.score ?? row.score ?? 0,
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

export async function loadCandidateTags(): Promise<string[]> {
  return (await apiClient.getJson<string[]>('/candidate-tags')).data
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
