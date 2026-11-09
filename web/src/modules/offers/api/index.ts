import { apiClient } from '../../../shared/api'
import type { OfferTemplateFields } from '../utils/templateFields'

export type OfferStatus = 'draft' | 'pending_approval' | 'approved' | 'sent' | 'accepted' | 'declined' | 'cancelled' | 'expired'
export type OfferAction = 'send' | 'resend' | 'accept' | 'decline' | 'expire' | 'cancel' | 'archive-onboarding'
export type OnboardingStatus = 'pending' | 'preparing' | 'scheduled' | 'completed' | 'no_show' | 'cancelled'

export interface MoneyAmount { amount: number; currency: string }
export interface OfferEmailAttachment { filename: string; mimeType: 'application/pdf'; content: string }
export interface SendOfferEmailInput { to?: string; subject: string; html?: string; markdown?: string; attachment?: OfferEmailAttachment }

export interface ApiOfferVersion {
  id: string
  version: number
  positionTitle: string
  departmentId: string
  employmentType: string
  startDate?: string
  reportingLocation?: string
  invoiceTitle?: string
  taxNumber?: string
  templateFields?: OfferTemplateFields
  compensation: { baseSalary: MoneyAmount; probationSalary?: MoneyAmount; bonus?: MoneyAmount; equity?: string }
  benefits: string[]
  materials: string[]
  content: string
  createdAt: string
}

export interface ApiOffer {
  id: string
  code: string
  applicationId: string
  status: OfferStatus
  currentVersionId?: string
  sentAt?: string
  respondedAt?: string
  expiresAt?: string
  version: number
  createdAt: string
  updatedAt: string
  versions?: ApiOfferVersion[]
  onboarding?: { status: OnboardingStatus }
}

export interface ApiOfferTemplate {
  id: string
  name: string
  filename: string
  content: string
  isActive: boolean
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export interface OfferTemplateInput {
  name: string
  filename: string
  content: string
  isActive?: boolean
  isDefault?: boolean
}

export interface ApiApplication { id: string; code: string; candidateId: string; jobId: string; status: string; candidateName?: string; jobTitle?: string }

interface ApiCandidateLookup { id: string; code: string; fullName: string }
interface ApiJobLookup { id: string; code: string; title: string }
interface ApiOnboardingLookup { id: string; offerId: string; status: OnboardingStatus }

export interface CreateOfferInput {
  applicationId: string
  positionTitle: string
  departmentId: string
  employmentType: string
  startDate?: string
  reportingLocation?: string
  invoiceTitle?: string
  taxNumber?: string
  templateFields?: OfferTemplateFields
  baseSalary: MoneyAmount
  probationSalary?: MoneyAmount
  bonus?: MoneyAmount
  equity?: string
  benefits?: string[]
  materials?: string[]
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
  sentAt?: string
  respondedAt?: string
  onboardingStatus?: OnboardingStatus
  updatedAt: string
}

export interface OfferDetail {
  offer: ApiOffer
  version?: ApiOfferVersion
}

export const OFFER_STATUS_LABEL: Record<OfferStatus, string> = {
  draft: '草稿',
  pending_approval: '待发送',
  approved: '待发送',
  sent: '已发送',
  accepted: '已接受',
  declined: '已拒绝',
  cancelled: '已取消',
  expired: '已过期',
}

export const OFFER_ACTION_LABEL: Record<OfferAction, string> = {
  send: '发送 Offer',
  resend: '重新发送',
  accept: '候选人接受',
  decline: '候选人拒绝',
  expire: '标记过期',
  cancel: '取消',
  'archive-onboarding': '入职归档',
}

export function offerActionsFor(status: OfferStatus, onboardingStatus?: OnboardingStatus): OfferAction[] {
  switch (status) {
    case 'draft':
    case 'pending_approval':
    case 'approved': return ['send', 'cancel']
    case 'sent': return ['resend', 'accept', 'decline', 'expire', 'cancel']
    case 'accepted': return onboardingStatus ? [] : ['archive-onboarding']
    case 'declined':
    case 'expired': return []
    case 'cancelled': return ['resend']
  }
}

function candidateLabel(candidate: ApiCandidateLookup | undefined): string {
  if (!candidate) return '未知候选人'
  return candidate.fullName || '未知候选人'
}

function jobLabel(job: ApiJobLookup | undefined, _jobId: string): string {
  if (!job) return '未知岗位'
  return job.title || '未知岗位'
}

function toRow(row: ApiOffer, applicationMap: Map<string, ApiApplication>, candidateMap: Map<string, ApiCandidateLookup>, jobMap: Map<string, ApiJobLookup>, onboardingMap = new Map<string, ApiOnboardingLookup>()): OfferRow {
  const application = applicationMap.get(row.applicationId)
  const onboarding = onboardingMap.get(row.id)
  return {
    id: row.id,
    entityId: row.id,
    code: row.code,
    applicationId: row.applicationId,
    applicationCode: application?.code || row.applicationId,
    candidate: candidateLabel(candidateMap.get(application?.candidateId ?? '')),
    job: jobLabel(jobMap.get(application?.jobId ?? ''), application?.jobId ?? ''),
    status: row.status,
    ...(row.sentAt ? { sentAt: row.sentAt } : {}),
    ...(row.respondedAt ? { respondedAt: row.respondedAt } : {}),
    ...(onboarding ? { onboardingStatus: onboarding.status } : {}),
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
  const [offerResponse, applicationResponse, candidateResponse, jobResponse, onboardingResponse] = await Promise.all([
    apiClient.getJson<ApiOffer[]>(`/offers${query}`),
    apiClient.getJson<ApiApplication[]>('/applications'),
    apiClient.getJson<ApiCandidateLookup[]>('/candidates'),
    apiClient.getJson<ApiJobLookup[]>('/jobs'),
    apiClient.getJson<ApiOnboardingLookup[]>('/onboarding'),
  ])
  const applicationMap = new Map(applicationResponse.data.map((item) => [item.id, item]))
  const candidateMap = new Map(candidateResponse.data.map((item) => [item.id, item]))
  const jobMap = new Map(jobResponse.data.map((item) => [item.id, item]))
  const onboardingMap = new Map(onboardingResponse.data.map((item) => [item.offerId, item]))
  return offerResponse.data.map((row) => toRow(row, applicationMap, candidateMap, jobMap, onboardingMap))
}

export async function getOffer(id: string): Promise<OfferDetail> {
  const offer = (await apiClient.getJson<ApiOffer>(`/offers/${id}`)).data
  return { offer, version: offer.versions?.find((v) => v.id === offer.currentVersionId) ?? offer.versions?.at(-1) }
}

export async function createOffer(input: CreateOfferInput): Promise<ApiOffer> {
  return (await apiClient.postJson<ApiOffer>('/offers', input)).data
}

export async function listOfferTemplates(): Promise<ApiOfferTemplate[]> {
  return (await apiClient.getJson<ApiOfferTemplate[]>('/offer-templates')).data
}

export async function createOfferTemplate(input: OfferTemplateInput): Promise<ApiOfferTemplate> {
  return (await apiClient.postJson<ApiOfferTemplate>('/offer-templates', input)).data
}

export async function updateOfferTemplate(id: string, input: Partial<OfferTemplateInput>): Promise<ApiOfferTemplate> {
  return (await apiClient.patchJson<ApiOfferTemplate>(`/offer-templates/${encodeURIComponent(id)}`, input)).data
}

export async function deleteOfferTemplate(id: string): Promise<void> {
  await apiClient.deleteJson(`/offer-templates/${encodeURIComponent(id)}`)
}

export function renderOfferTemplate(content: string, values: Record<string, string | number | undefined>): string {
  return content.replace(/\{\{\s*([^{}]+?)\s*\}\}/gu, (_, name: string) => String(values[name.trim()] ?? ''))
}

export async function offerAction(id: string, action: OfferAction, reason?: string): Promise<ApiOffer> {
  return (await apiClient.postJson<ApiOffer>(`/offers/${id}/${action}`, reason ? { reason } : {})).data
}

export async function sendOfferEmail(id: string, input: SendOfferEmailInput): Promise<ApiOffer> {
  return (await apiClient.postJson<ApiOffer>(`/offers/${id}/send-email`, input)).data
}

export async function updateOffer(id: string, input: Partial<CreateOfferInput>): Promise<ApiOffer> {
  return (await apiClient.patchJson<ApiOffer>(`/offers/${id}`, input)).data
}

export async function loadApplicationsForOffer(eligibleOnly = false): Promise<ApiApplication[]> {
  const [applicationResponse, candidateResponse, jobResponse] = await Promise.all([
    apiClient.getJson<ApiApplication[]>(eligibleOnly ? '/offers/eligible-applications' : '/applications'),
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
