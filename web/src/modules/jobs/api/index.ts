import { DemoRecruitingData } from '../../../shared/data/demo-recruiting-data'
import { apiClient } from '../../../shared/api'

export type JobAction = 'confirm-spec' | 'confirm-jd' | 'publish' | 'pause' | 'resume' | 'close'

export interface JobRequirement {
  label: string
  description?: string
  required?: boolean
  weight?: number
}

export interface ApiJobSpec {
  version: number
  title: string
  summary: string
  responsibilities: string[]
  requirements: JobRequirement[]
  skills: string[]
  confirmed: boolean
  confirmedAt?: string
}

export interface ApiJobJd {
  version: number
  language: string
  content: string
  generatedBy: 'human' | 'ai_assisted'
  confirmed: boolean
  confirmedAt?: string
}

export interface ApiJobSpecVersion extends ApiJobSpec {
  jobId: string
  createdAt: string
  actorId?: string
}

export interface ApiJobJdVersion extends ApiJobJd {
  jobId: string
  createdAt: string
  actorId?: string
}

export interface ApiJob {
  id: string
  code: string
  title: string
  departmentId: string
  department: string
  hiringManagerId?: string
  recruitmentRequestId: string
  headcount: number
  filledCount: number
  employmentType: string
  workMode: string
  location?: string
  status: string
  channels: string[]
  spec?: ApiJobSpec
  jd?: ApiJobJd
  version: number
  createdAt: string
  updatedAt: string
}

export interface JobView {
  id: string
  entityId: string
  title: string
  department: string
  status: string
  statusLabel: string
  channels: string[]
  updatedAt: string
  spec?: ApiJobSpec
  jd?: ApiJobJd
  recruitmentRequestId: string
  headcount: number
  filledCount: number
}

export interface CreateJobInput {
  title: string
  departmentId: string
  hiringManagerId?: string
  recruitmentRequestId: string
  headcount: number
  employmentType: string
  workMode: string
  location?: string
}

export type UpdateJobInput = Partial<Omit<CreateJobInput, 'recruitmentRequestId'>>

export interface CreateSpecInput {
  title: string
  summary: string
  responsibilities: string[]
  requirements: JobRequirement[]
  skills: string[]
}

function toRow(row: ApiJob): JobView {
  return {
    id: row.code || row.id,
    entityId: row.id,
    title: row.title,
    department: row.department,
    status: row.status,
    statusLabel: row.status,
    channels: row.channels || [],
    updatedAt: (row.updatedAt || '').slice(0, 10),
    spec: row.spec,
    jd: row.jd,
    recruitmentRequestId: row.recruitmentRequestId || '',
    headcount: row.headcount || 0,
    filledCount: row.filledCount || 0,
  }
}

export async function loadJobs(): Promise<JobView[]> {
  const response = await apiClient.getJson<ApiJob[]>('/jobs')
  return response.data.map(toRow)
}

export async function getJob(id: string): Promise<ApiJob> {
  return (await apiClient.getJson<ApiJob>(`/jobs/${id}`)).data
}

export async function createJob(input: CreateJobInput): Promise<ApiJob> {
  const payload: CreateJobInput = {
    ...input,
    title: (input.title || '').trim(),
    departmentId: (input.departmentId || '').trim(),
    recruitmentRequestId: (input.recruitmentRequestId || '').trim(),
    location: input.location || undefined,
  }
  if (!payload.title || !payload.departmentId || !payload.recruitmentRequestId) {
    throw new Error('岗位缺少必填字段')
  }
  return (await apiClient.postJson<ApiJob>('/jobs', payload)).data
}

export async function updateJob(id: string, input: UpdateJobInput): Promise<ApiJob> {
  const payload: UpdateJobInput = { ...input }
  if (typeof payload.title === 'string') payload.title = payload.title.trim()
  if (typeof payload.departmentId === 'string') payload.departmentId = payload.departmentId.trim()
  if (payload.location !== undefined) payload.location = payload.location.trim() || undefined
  return (await apiClient.patchJson<ApiJob>(`/jobs/${id}`, payload)).data
}

export async function createSpec(id: string, input: CreateSpecInput): Promise<ApiJob> {
  return (await apiClient.postJson<ApiJob>(`/jobs/${id}/spec`, input)).data
}

export async function createJd(id: string, input: { language: string; content: string; generatedBy?: 'human' | 'ai_assisted' }): Promise<ApiJob> {
  return (await apiClient.postJson<ApiJob>(`/jobs/${id}/jd`, input)).data
}

export async function listJobSpecVersions(id: string): Promise<ApiJobSpecVersion[]> {
  return (await apiClient.getJson<ApiJobSpecVersion[]>(`/jobs/${id}/spec-versions`)).data
}

export async function listJobDescriptionVersions(id: string): Promise<ApiJobJdVersion[]> {
  return (await apiClient.getJson<ApiJobJdVersion[]>(`/jobs/${id}/jd-versions`)).data
}

export async function jobAction(id: string, action: JobAction, reason?: string): Promise<ApiJob> {
  return (await apiClient.postJson<ApiJob>(`/jobs/${id}/${action}`, reason ? { reason } : {})).data
}

/** 演示/只读切片，供 onboarding 与 demo-only 测试引用；真实数据请使用 loadJobs。 */
export const listJobs = () => DemoRecruitingData.jobs
/** 岗位详情读取：与 list/action 共用 entityId（后端主键 id）入参规则。 */
export const getJobDetail = getJob
