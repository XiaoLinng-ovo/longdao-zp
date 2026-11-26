import { apiClient } from '../../../shared/api'
import { ensureCsrfToken } from '../../../shared/api/client'
import { candidateSourceLabel } from '../../../shared/utils/candidate-contact'
import { getWorkspaceContext } from '../../../shared/api/workspace-context'
import type { Candidate, ResumeScoreSummary } from '../../../shared/types/recruiting'
import { ResumeUploadError, retryResumeUpload } from '../utils/resume-upload-retry'

export { loadJobs } from '../../jobs/api'

interface ApiJob { id: string; title: string }
export interface ApiApplication { interviewProgress?: Candidate['interviewProgress']; analysisStatus?: string; analysisProgress?: number; analysisAttempts?: number; analysisError?: string; resumeReview?: ResumeScoreSummary; id: string; code?: string; candidateId: string; jobId: string; status: string; source?: string; score?: number; aiStatus: string; updatedAt: string; rejectionReason?: string }
export interface ApiCandidate { id: string; code: string; fullName: string; email?: string; phone?: string; source?: string; company?: string; skills?: string[]; tags?: string[]; status: string; updatedAt: string; aiStatus?: string; score?: number | null; analysisStatus?: string; analysisProgress?: number; analysisAttempts?: number; analysisError?: string; applications: ApiApplication[] }
export interface ApiResume { id: string; candidateId: string; applicationId?: string; originalFilename: string; mimeType: string; sizeBytes: number; contentHash: string; scanStatus: string; createdAt: string }
export interface ApiResumeDocument { originalFilename: string; mimeType: string; content: string; previewHtml?: string }
export async function getApplicationResume(applicationId: string): Promise<ApiResume | null> {
  return (await apiClient.getJson<ApiResume | null>('/applications/' + encodeURIComponent(applicationId) + '/resume')).data
}
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
    provenance?: { engine?: string; modelName?: string; scoringSkill?: ResumeScoreSummary['scoringSkill']; documentRepair?: { repairedAt: string } }
    assessment?: ApiMatchAssessment
    humanReview?: { status?: string; comment?: string; reviewedBy?: string; reviewedAt?: string; history?: ApiAnalysisEditRecord[] }
    extraction?: ApiResumeExtraction
    analysis?: {
      suggestion?: { summary?: string }
      report?: {
        provenance?: { engine?: string; modelName?: string; scoringSkill?: ResumeScoreSummary['scoringSkill']; documentRepair?: { repairedAt: string } }
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
    // 接口返回顺序不能作为“最新申请”的依据（仓储可能按申请创建时间返回）。
    // 主行必须使用最近更新的申请，否则候选人的更新时间会被旧申请覆盖。
    const applicationRows = [...row.applications]
      .sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0))
      .map((application): Candidate => ({
      id: row.code || row.id, entityId: row.id, name: row.fullName, email: row.email, phone: row.phone,
      applicationId: application.id, rawApplicationStatus: application.status, resumeReview: application.resumeReview, interviewProgress: application.interviewProgress,
      job: jobs.get(application.jobId) || application.jobId,
      score: application.resumeReview?.aiScore ?? application.score ?? 0,
      scoreAvailable: typeof (application.resumeReview?.aiScore ?? application.score) === 'number',
      aiStatus: application.aiStatus === 'completed' ? 'completed' : 'pending',
      analysisStatus: application.analysisStatus, analysisProgress: application.analysisProgress,
      analysisAttempts: application.analysisAttempts, analysisError: application.analysisError,
      applicationStatus: (application.status === 'interviewing' ? 'scheduled' : application.status) as Candidate['applicationStatus'],
      source: candidateSourceLabel(application.source || row.source), company: row.company, skills: row.skills, tags: row.tags,
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
    source: candidateSourceLabel(application?.source || row.source),
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
    strengths: (assessment?.strengths ?? []).filter((item) => !isCommunicationCollaborationLabel(item)), risks: (assessment?.risks ?? []).filter((item) => !isCommunicationCollaborationLabel(item)),
    evidence: ([['matchedRequirements', 'matched'], ['conflicts', 'conflict'], ['missingRequirements', 'missing']] as const).flatMap(([key, outcome]) =>
      (assessment?.[key] ?? []).filter((item) => !isCommunicationCollaborationLabel(item.label ?? '')).map((item) => ({ label: item.label || '岗位要求', rationale: item.rationale || '', sourceTexts: [...new Set((item.evidence ?? []).map((e) => e.sourceText).filter((v): v is string => !!v))], ...(typeof item.score === 'number' ? { score: item.score } : {}), outcome: item.status === 'partial' ? 'partial' as const : outcome }))),
  }
}

function isCommunicationCollaborationLabel(label: string): boolean {
  const value = label.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
  return /(沟通|协作|合作|团队|跨部门|跨团队|人际|表达能力|表达技巧|语言表达|书面表达|口头表达)/u.test(value) && !/(协议|接口|通信|网络|信号|通讯录)/u.test(value)
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

export type ApiResumeImportBatchStatus = 'uploading' | 'completed' | 'cancelled'
export type ApiResumeImportItemStatus = 'pending_upload' | 'uploading' | 'queued' | 'failed' | 'cancelled'
export type ApiResumeImportBatchPhase =
  | 'uploading'
  | 'waiting_analysis'
  | 'analyzing'
  | 'completed'
  | 'completed_with_issues'
  | 'cancelled'

export interface ApiResumeImportItem {
  id: string
  batchId: string
  ordinal: number
  clientFileId: string
  originalFilename: string
  mimeType: string
  sizeBytes: number
  status: ApiResumeImportItemStatus
  candidateId?: string
  applicationId?: string
  resumeId?: string
  analysisTaskId?: string
  analysisStatus?: string
  attempts: number
  error?: string
  createdAt: string
  updatedAt: string
}

export interface ApiResumeImportBatch {
  id: string
  jobId: string
  detachedJobId?: string
  detachedJobTitle?: string
  detachedAt?: string
  status: ApiResumeImportBatchStatus
  phase?: ApiResumeImportBatchPhase
  items: ApiResumeImportItem[]
  counts: {
    total: number
    pendingUpload: number
    uploading: number
    uploaded: number
    queued?: number
    analyzing: number
    completed: number
    failed: number
    cancelled: number
    removed?: number
  }
  createdAt: string
  updatedAt: string
  cancelledAt?: string
}

export async function createResumeImportBatch(input: {
  jobId: string
  files: Array<{ clientFileId: string; originalFilename: string; mimeType: string; sizeBytes: number }>
}): Promise<ApiResumeImportBatch> {
  return (await apiClient.postJson<ApiResumeImportBatch>('/resume-import-batches', input)).data
}

export async function getResumeImportBatch(batchId: string): Promise<ApiResumeImportBatch> {
  return (await apiClient.getJson<ApiResumeImportBatch>(`/resume-import-batches/${encodeURIComponent(batchId)}`)).data
}

export async function detachResumeImportJob(batchId: string): Promise<ApiResumeImportBatch> {
  return (await apiClient.postJson<ApiResumeImportBatch>(`/resume-import-batches/${encodeURIComponent(batchId)}/detach-job`)).data
}

export async function listResumeImportBatches(): Promise<ApiResumeImportBatch[]> {
  const result = await apiClient.getJson<ApiResumeImportBatch[] | { items: ApiResumeImportBatch[] }>('/resume-import-batches?pageSize=20')
  return Array.isArray(result.data) ? result.data : result.data.items
}

export async function cancelResumeImportBatch(batchId: string): Promise<ApiResumeImportBatch> {
  return (await apiClient.postJson<ApiResumeImportBatch>(`/resume-import-batches/${encodeURIComponent(batchId)}/cancel`)).data
}

/**
 * XHR is used only for resume bytes because fetch does not expose upload
 * progress. Every item has its own timeout and abort signal.
 */
export function uploadResumeImportItem(
  batchId: string,
  itemId: string,
  content: string,
  options: { onProgress?: (percent: number) => void; signal?: AbortSignal; timeoutMs?: number; onRetry?: (attempt: number, delayMs: number, error: ResumeUploadError) => void } = {},
): Promise<ApiResumeImportItem> {
  const workspace = getWorkspaceContext()
  let needsConfirmation = false
  let csrfRefreshed = false
  const assertContext = () => {
    if (getWorkspaceContext().revision !== workspace.revision) throw new ResumeUploadError('账号或企业已变更，请刷新后重新上传', 'WORKSPACE_CONTEXT_CHANGED', 409)
  }
  const confirm = async (): Promise<ApiResumeImportItem | undefined> => {
    assertContext()
    const controller = new AbortController()
    const abort = () => controller.abort()
    const timer = window.setTimeout(abort, 5000)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    try {
      const batch = (await apiClient.getJson<ApiResumeImportBatch>(`/resume-import-batches/${encodeURIComponent(batchId)}`, { signal: controller.signal })).data
      assertContext()
      const item = batch.items.find(candidate => candidate.id === itemId)
      if (!item) throw new ResumeUploadError('上传文件记录不存在，请刷新后重新选择', 'ITEM_NOT_FOUND', 404)
      if (item.status === 'queued' && item.analysisTaskId) { options.onProgress?.(100); return item }
      if (item.status === 'cancelled' || batch.status === 'cancelled') throw new ResumeUploadError('上传已取消', 'ITEM_CANCELLED', 409)
      if (item.status === 'uploading' && Date.now() - Date.parse(item.updatedAt) < 120000) {
        throw new ResumeUploadError('服务器已收到文件，正在确认保存结果', 'UPLOAD_IN_PROGRESS', 409, 2)
      }
      needsConfirmation = false
      return undefined
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException('上传已取消', 'AbortError')
      if (error instanceof ResumeUploadError) throw error
      const status = (error as { status?: number }).status
      if (status && status >= 400 && status < 500) throw new ResumeUploadError(error instanceof Error ? error.message : '读取上传状态失败', 'UPLOAD_STATUS_REJECTED', status)
      throw new ResumeUploadError('无法确认服务器是否已保存文件，正在重连确认', 'UPLOAD_NETWORK_ERROR')
    } finally {
      window.clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }
  return retryResumeUpload(async () => {
    assertContext()
    if (needsConfirmation) {
      const saved = await confirm()
      if (saved) return saved
    }
    options.onProgress?.(0)
    try {
      let token = await ensureCsrfToken()
      assertContext()
      let uploaded: ApiResumeImportItem
      try {
        uploaded = await sendResumeImportItem(batchId, itemId, content, token, options)
      } catch (error) {
        // The API rejects invalid CSRF tokens before processing any file bytes.
        if (!(error instanceof ResumeUploadError) || error.status !== 403 || error.code !== 'CSRF_TOKEN_INVALID' || csrfRefreshed) throw error
        csrfRefreshed = true
        token = await ensureCsrfToken(true)
        assertContext()
        uploaded = await sendResumeImportItem(batchId, itemId, content, token, options)
      }
      assertContext()
      return uploaded
    } catch (error) {
      if (error instanceof ResumeUploadError && (['UPLOAD_NETWORK_ERROR', 'UPLOAD_TIMEOUT', 'UPLOAD_IN_PROGRESS'].includes(error.code) || [502, 503, 504].includes(error.status))) {
        needsConfirmation = true
        const saved = await confirm()
        if (saved) return saved
      }
      throw error
    }
  }, options)
}

function sendResumeImportItem(
  batchId: string,
  itemId: string,
  content: string,
  csrf: string | undefined,
  options: { onProgress?: (percent: number) => void; signal?: AbortSignal; timeoutMs?: number },
): Promise<ApiResumeImportItem> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('上传已取消', 'AbortError'))
      return
    }
    const xhr = new XMLHttpRequest()
    const workspace = getWorkspaceContext().workspaceId
    let timedOut = false
    let transmitted = false
    const timeout = window.setTimeout(() => {
      timedOut = true
      xhr.abort()
    }, options.timeoutMs ?? 60_000)
    const finish = (operation: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      operation()
    }
    let settled = false
    const abort = () => xhr.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    xhr.open('POST', `/api/v1/resume-import-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/content`)
    xhr.withCredentials = true
    xhr.setRequestHeader('content-type', 'application/json; charset=utf-8')
    xhr.setRequestHeader('accept', 'application/json')
    if (csrf) xhr.setRequestHeader('x-csrf-token', csrf)
    if (workspace) xhr.setRequestHeader('x-workspace-id', workspace)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        transmitted = event.loaded >= event.total
        options.onProgress?.(transmitted ? 100 : Math.min(99, Math.round(event.loaded / event.total * 100)))
      }
    }
    xhr.onerror = () => finish(() => reject(new ResumeUploadError('网络连接中断，上传失败', 'UPLOAD_NETWORK_ERROR')))
    xhr.onabort = () => finish(() => reject(timedOut ? new ResumeUploadError(transmitted ? '文件已发送，但服务器未及时确认保存结果' : '文件传输超时，请检查网络连接', 'UPLOAD_TIMEOUT') : new DOMException('上传已取消', 'AbortError')))
    xhr.ontimeout = () => finish(() => reject(new ResumeUploadError('上传超时，请重试', 'UPLOAD_TIMEOUT')))
    xhr.onload = () => finish(() => {
      let payload: unknown
      try { payload = JSON.parse(xhr.responseText) } catch {
        reject(new ResumeUploadError(xhr.status >= 500 ? `上传代理暂时不可用（HTTP ${xhr.status}）` : '上传接口未返回有效 JSON，请检查代理地址', 'INVALID_UPLOAD_RESPONSE', xhr.status, 0, xhr.getResponseHeader('x-request-id') || undefined)); return
      }
      const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
      if (xhr.status >= 200 && xhr.status < 300 && record.ok === true && record.data) {
        options.onProgress?.(100)
        resolve(record.data as ApiResumeImportItem)
        return
      }
      const error = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : {}
      const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {}
      const retryAfter = Number(xhr.getResponseHeader('retry-after') || details.retryAfterSeconds || 0)
      reject(new ResumeUploadError(typeof error.message === 'string' ? error.message : `上传失败（HTTP ${xhr.status}）`,
        typeof error.code === 'string' ? error.code : 'UPLOAD_FAILED', xhr.status, Number.isFinite(retryAfter) ? retryAfter : 0,
        typeof record.requestId === 'string' ? record.requestId : xhr.getResponseHeader('x-request-id') || undefined))
    })
    xhr.send(JSON.stringify({ content, encoding: 'base64' }))
  })
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

/** Delete the application, unused resumes, and the candidate when no applications remain. */
export async function deleteApplication(applicationId: string): Promise<{ candidateDeleted: boolean }> {
  return (await apiClient.deleteJson<{ candidateDeleted: boolean }>(`/applications/${encodeURIComponent(applicationId)}`)).data
}
