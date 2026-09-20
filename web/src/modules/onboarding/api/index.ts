import { apiClient } from '../../../shared/api'

export type OnboardingStatus = 'pending' | 'scheduled' | 'completed' | 'cancelled'

export interface ApiOnboarding {
  id: string
  applicationId: string
  offerId: string
  plannedStartDate?: string
  status: OnboardingStatus
  notes?: string
  archivedAt?: string
  createdAt: string
  updatedAt: string
}

export interface ApiApplication { id: string; code: string; candidateId: string; jobId: string; status: string }
interface ApiCandidate { id: string; code: string; fullName: string }
interface ApiJob { id: string; code: string; title: string }
interface ApiOffer { id: string; code: string; applicationId: string; status: string }

export interface OnboardingRow {
  id: string
  applicationId: string
  applicationCode: string
  offerId: string
  candidate: string
  job: string
  offerCode: string
  status: OnboardingStatus
  plannedStartDate?: string
  archivedAt?: string
  updatedAt: string
}

export const ONBOARDING_STATUS_LABEL: Record<OnboardingStatus, string> = {
  pending: '待入职',
  scheduled: '已排期',
  completed: '已归档',
  cancelled: '已取消',
}

function label(value: string, fallback: string): string {
  return value || fallback
}

function candidateLabel(candidate: ApiCandidate | undefined, application: ApiApplication | undefined): string {
  const fallback = application?.candidateId || '未知候选人'
  if (!candidate) return fallback
  return label(candidate.fullName, candidate.code || candidate.id)
}

function jobLabel(job: ApiJob | undefined, application: ApiApplication | undefined): string {
  const fallback = application?.jobId || '未知岗位'
  if (!job) return fallback
  return label(job.title, job.code || job.id)
}

export function toOnboardingRow(
  record: ApiOnboarding,
  application: ApiApplication | undefined,
  candidate: ApiCandidate | undefined,
  job: ApiJob | undefined,
  offer: ApiOffer | undefined,
): OnboardingRow {
  return {
    id: record.id,
    applicationId: record.applicationId,
    applicationCode: application?.code || record.applicationId,
    offerId: record.offerId,
    candidate: candidateLabel(candidate, application),
    job: jobLabel(job, application),
    offerCode: offer?.code || record.offerId,
    status: record.status,
    ...(record.plannedStartDate ? { plannedStartDate: (record.plannedStartDate || '').slice(0, 10) } : {}),
    ...(record.archivedAt ? { archivedAt: (record.archivedAt || '').slice(0, 10) } : {}),
    updatedAt: (record.updatedAt || '').slice(0, 10),
  }
}

export async function listOnboarding(): Promise<ApiOnboarding[]> {
  return (await apiClient.getJson<ApiOnboarding[]>('/onboarding')).data
}

export async function listOnboardingRows(): Promise<OnboardingRow[]> {
  const [onboardingResponse, applicationResponse, candidateResponse, jobResponse, offerResponse] = await Promise.all([
    apiClient.getJson<ApiOnboarding[]>('/onboarding'),
    apiClient.getJson<ApiApplication[]>('/applications'),
    apiClient.getJson<ApiCandidate[]>('/candidates'),
    apiClient.getJson<ApiJob[]>('/jobs'),
    apiClient.getJson<ApiOffer[]>('/offers'),
  ])
  const applicationMap = new Map(applicationResponse.data.map((item) => [item.id, item]))
  const candidateMap = new Map(candidateResponse.data.map((item) => [item.id, item]))
  const jobMap = new Map(jobResponse.data.map((item) => [item.id, item]))
  const offerMap = new Map(offerResponse.data.map((item) => [item.id, item]))
  return onboardingResponse.data.map((record) => {
    const application = applicationMap.get(record.applicationId)
    return toOnboardingRow(
      record,
      application,
      candidateMap.get(application?.candidateId || ''),
      jobMap.get(application?.jobId || ''),
      offerMap.get(record.offerId),
    )
  })
}

export async function getOnboarding(id: string): Promise<ApiOnboarding> {
  return (await apiClient.getJson<ApiOnboarding>(`/onboarding/${id}`)).data
}

export type OnboardingAction = 'schedule' | 'complete' | 'cancel'

export const ONBOARDING_ACTION_LABEL: Record<OnboardingAction, string> = {
  schedule: '安排入职',
  complete: '完成归档',
  cancel: '取消入职',
}

export async function updateOnboarding(id: string, payload: { plannedStartDate?: string; notes?: string }): Promise<ApiOnboarding> {
  return (await apiClient.patchJson<ApiOnboarding>(`/onboarding/${id}`, payload)).data
}

export async function actionOnboarding(id: string, action: OnboardingAction, reason?: string): Promise<ApiOnboarding> {
  return (await apiClient.postJson<ApiOnboarding>(`/onboarding/${id}/${action}`, { reason })).data
}
