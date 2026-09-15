import type { Pool, QueryResultRow } from 'pg'

export interface RepositoryQueryExecutor {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>
}

export interface RepositoryClient extends RepositoryQueryExecutor {
  release(): void
}

export interface RepositoryPool extends RepositoryQueryExecutor {
  connect(): Promise<RepositoryClient>
  end(): Promise<void>
}

export type RepositoryStatus = string

export interface IdMapping {
  /** Database primary key. This value is always a UUID. */
  id: string
  /** Stable business number stored in the *_no column. */
  businessId: string
  /** Compatibility key used by the legacy seed state. */
  legacyId: string
}

export interface RecruitmentRequestRecord extends IdMapping {
  code: string
  title: string
  departmentId: string | null
  departmentName: string | null
  requestedById: string | null
  headcount: number
  budgetMin: number | null
  budgetMax: number | null
  reason: string
  status: RepositoryStatus
  version: number
  createdAt: string
  updatedAt: string
}

export interface JobRecord extends IdMapping {
  code: string
  recruitmentRequestId: string | null
  recruitmentRequestBusinessId: string | null
  departmentId: string
  departmentName: string | null
  title: string
  status: RepositoryStatus
  headcount: number
  createdById: string | null
  createdAt: string
  updatedAt: string
}

export interface CandidateRecord extends IdMapping {
  code: string
  name: string
  email: string | null
  phone: string | null
  location: string | null
  source: string | null
  consentStatus: RepositoryStatus
  createdAt: string
  updatedAt: string
}

export interface ApplicationRecord extends IdMapping {
  code: string
  candidateId: string
  candidateBusinessId: string | null
  jobId: string
  jobBusinessId: string | null
  status: RepositoryStatus
  recruiterId: string | null
  source: string | null
  appliedAt: string
  rejectedReason: string | null
  withdrawnAt: string | null
  createdAt: string
  updatedAt: string
}

export interface RecruitmentRequestCreateInput {
  id?: string
  businessId?: string
  requestNo?: string
  title: string
  departmentId?: string | null
  requestedById?: string | null
  headcount: number
  budgetMin?: number | null
  budgetMax?: number | null
  reason?: string
  status?: string
  version?: number
}

export type RecruitmentRequestUpdateInput = Partial<Omit<RecruitmentRequestCreateInput, 'id' | 'businessId' | 'requestNo'>>

export interface JobCreateInput {
  id?: string
  businessId?: string
  jobNo?: string
  recruitmentRequestId?: string | null
  departmentId: string
  title: string
  status?: string
  headcount: number
  createdById?: string | null
}

export type JobUpdateInput = Partial<Omit<JobCreateInput, 'id' | 'businessId' | 'jobNo' | 'recruitmentRequestId'>>

export interface CandidateCreateInput {
  id?: string
  businessId?: string
  candidateNo?: string
  name: string
  email?: string | null
  phone?: string | null
  location?: string | null
  source?: string | null
  consentStatus?: string
}

export type CandidateUpdateInput = Partial<Omit<CandidateCreateInput, 'id' | 'businessId' | 'candidateNo'>>

export interface ApplicationCreateInput {
  id?: string
  businessId?: string
  applicationNo?: string
  candidateId: string
  jobId: string
  status?: string
  recruiterId?: string | null
  source?: string | null
  appliedAt?: string
}

export type ApplicationUpdateInput = Partial<Pick<ApplicationCreateInput, 'status' | 'recruiterId' | 'source'>> & {
  rejectedReason?: string | null
  withdrawnAt?: string | null
}

export interface RepositoryOptions {
  /** Used when a legacy id has no corresponding row in a *_no column. */
  generatedBusinessId?: (prefix: string) => string
}

export interface TransactionCallback<T> {
  (client: RepositoryClient): Promise<T> | T
}

export type PgPool = Pool
