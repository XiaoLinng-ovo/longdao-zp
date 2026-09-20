import { apiClient } from '../../../shared/api'

export type OfferStatus = 'draft' | 'pending_approval' | 'approved' | 'sent' | 'accepted' | 'declined' | 'cancelled' | 'expired'
export type OfferAction = 'submit-approval' | 'approve' | 'reject' | 'send' | 'accept' | 'decline' | 'expire' | 'cancel' | 'archive-onboarding'

export interface MoneyAmount { amount: number; currency: string }

export interface OfferApproval {
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  approver?: string
  comment?: string
  actedAt?: string
}

export interface ApiOfferVersion {
  id: string
  version: number
  positionTitle: string
  departmentId: string
  employmentType: string
  startDate?: string
  compensation: { baseSalary: MoneyAmount; bonus?: MoneyAmount; equity?: string }
  benefits: string[]
  content: string
  createdAt: string
}

export interface ApiOffer {
  id: string
  code: string
  applicationId: string
  status: OfferStatus
  currentVersionId?: string
  approval: OfferApproval
  sentAt?: string
  respondedAt?: string
  expiresAt?: string
  version: number
  createdAt: string
  updatedAt: string
  versions?: ApiOfferVersion[]
}

export interface ApiApplication { id: string; code: string; candidateId: string; jobId: string; status: string; candidateName?: string; jobTitle?: string }

interface ApiCandidateLookup { id: string; code: string; fullName: string }
interface ApiJobLookup { id: string; code: string; title: string }

export interface CreateOfferInput {
  applicationId: string
  positionTitle: string
  departmentId: string
  employmentType: string
  startDate?: string
  baseSalary: MoneyAmount
  bonus?: MoneyAmount
  equity?: string
  benefits?: string[]
  content: string
  expiresAt?: string
}

export interface OfferRow {
  id: string
  entityId: string
  code: string
  applicationId: string
  applicationCode: string
  candidate: string
  job: string
  status: OfferStatus
  approvalStatus: OfferApproval['status']
  approver: string
  sentAt?: string
  respondedAt?: string
  updatedAt: string
}

export interface OfferDetail {
  offer: ApiOffer
  version?: ApiOfferVersion
}

export const OFFER_STATUS_LABEL: Record<OfferStatus, string> = {
  draft: '草稿',
  pending_approval: '待审批',
  approved: '已审批',
  sent: '已发送',
  accepted: '已接受',
  declined: '已拒绝',
  cancelled: '已取消',
  expired: '已过期',
}

export const OFFER_ACTION_LABEL: Record<OfferAction, string> = {
  'submit-approval': '提交审批',
  approve: '审批通过',
  reject: '审批驳回',
  send: '发送 Offer',
  accept: '候选人接受',
  decline: '候选人拒绝',
  expire: '标记过期',
  cancel: '取消',
  'archive-onboarding': '入职归档',
}

function candidateLabel(candidate: ApiCandidateLookup | undefined): string {
  if (!candidate) return '未知候选人'
  return candidate.fullName ? `${candidate.fullName}（${candidate.code || candidate.id}）` : candidate.code || candidate.id
}

function jobLabel(job: ApiJobLookup | undefined, jobId: string): string {
  if (!job) return jobId || '未知岗位'
  return `${job.title || job.code}（${job.code || job.id}）`
}

function toRow(row: ApiOffer, applicationMap: Map<string, ApiApplication>, candidateMap: Map<string, ApiCandidateLookup>, jobMap: Map<string, ApiJobLookup>): OfferRow {
  const application = applicationMap.get(row.applicationId)
  return {
    id: row.id,
    entityId: row.id,
    code: row.code,
    applicationId: row.applicationId,
    applicationCode: application?.code || row.applicationId,
    candidate: candidateLabel(candidateMap.get(application?.candidateId ?? '')),
    job: jobLabel(jobMap.get(application?.jobId ?? ''), application?.jobId ?? ''),
    status: row.status,
    approvalStatus: row.approval?.status ?? 'pending',
    approver: row.approval?.approver ?? '待审批',
    ...(row.sentAt ? { sentAt: row.sentAt } : {}),
    ...(row.respondedAt ? { respondedAt: row.respondedAt } : {}),
    updatedAt: (row.updatedAt ?? '').slice(0, 10),
  }
}

export function offerStatusCode(item: unknown): OfferStatus | undefined {
  if (!item || typeof item !== 'object') return undefined
  const status = (item as { status?: unknown }).status
  return typeof status === 'string' && status in OFFER_STATUS_LABEL ? (status as OfferStatus) : undefined
}

export async function listOffers(status?: string): Promise<OfferRow[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : ''
  const response = await apiClient.getJson<ApiOffer[]>(`/offers${query}`)
  return response.data.map((row) => toRow(row, new Map(), new Map(), new Map()))
}

export async function listOfferContextRows(status?: string): Promise<OfferRow[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : ''
  const [offerResponse, applicationResponse, candidateResponse, jobResponse] = await Promise.all([
    apiClient.getJson<ApiOffer[]>(`/offers${query}`),
    apiClient.getJson<ApiApplication[]>('/applications'),
    apiClient.getJson<ApiCandidateLookup[]>('/candidates'),
    apiClient.getJson<ApiJobLookup[]>('/jobs'),
  ])
  const applicationMap = new Map(applicationResponse.data.map((item) => [item.id, item]))
  const candidateMap = new Map(candidateResponse.data.map((item) => [item.id, item]))
  const jobMap = new Map(jobResponse.data.map((item) => [item.id, item]))
  return offerResponse.data.map((row) => toRow(row, applicationMap, candidateMap, jobMap))
}

export async function getOffer(id: string): Promise<OfferDetail> {
  const offer = (await apiClient.getJson<ApiOffer>(`/offers/${id}`)).data
  return { offer, version: offer.versions?.find((v) => v.id === offer.currentVersionId) ?? offer.versions?.at(-1) }
}

export async function createOffer(input: CreateOfferInput): Promise<ApiOffer> {
  return (await apiClient.postJson<ApiOffer>('/offers', input)).data
}

export async function offerAction(id: string, action: OfferAction, reason?: string): Promise<ApiOffer> {
  return (await apiClient.postJson<ApiOffer>(`/offers/${id}/${action}`, reason ? { reason } : {})).data
}

export async function updateOffer(id: string, input: Partial<CreateOfferInput>): Promise<ApiOffer> {
  return (await apiClient.patchJson<ApiOffer>(`/offers/${id}`, input)).data
}

export async function loadApplicationsForOffer(): Promise<ApiApplication[]> {
  const [applicationResponse, candidateResponse, jobResponse] = await Promise.all([
    apiClient.getJson<ApiApplication[]>('/applications'),
    apiClient.getJson<ApiCandidateLookup[]>('/candidates'),
    apiClient.getJson<ApiJobLookup[]>('/jobs'),
  ])
  const candidateMap = new Map(candidateResponse.data.map((candidate) => [candidate.id, candidate]))
  const jobMap = new Map(jobResponse.data.map((job) => [job.id, job]))
  return applicationResponse.data.map((application) => ({
    ...application,
    candidateName: candidateMap.get(application.candidateId)?.fullName || candidateMap.get(application.candidateId)?.code,
    jobTitle: jobMap.get(application.jobId)?.title || jobMap.get(application.jobId)?.code || application.jobId,
  }))
}
