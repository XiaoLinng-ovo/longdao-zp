import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg'

// DATE 列按字面返回，避免驱动按本地午夜解析 Date 后序列化出现时区偏移（差一天）。
import { types as pgTypes } from 'pg'
pgTypes.setTypeParser(1082, (value: string) => value)
import type {
  ApplicationCreateInput,
  ApplicationRecord,
  ApplicationUpdateInput,
  CandidateCreateInput,
  CandidateRecord,
  CandidateUpdateInput,
  JobCreateInput,
  JobRecord,
  JobUpdateInput,
  RecruitmentRequestCreateInput,
  RecruitmentRequestRecord,
  RecruitmentRequestUpdateInput,
  RepositoryClient,
  RepositoryOptions,
  RepositoryPool,
  TransactionCallback,
  ResumeCreateInput, ResumeRecord,
  RecruitmentApprovalInstanceRecord,
  RecruitmentApprovalStepRecord,
  RecruitmentApprovalAuditRecord,
  AnalysisTaskRecord, AnalysisResultRecord,
  JobSpecVersionDbRecord, JobDescriptionVersionDbRecord,
  JobSpecVersionCreateInput, JobDescriptionVersionCreateInput,
  InterviewDbRecord, InterviewParticipantDbRecord, InterviewCreateInput, InterviewUpdateInput,
  InterviewFeedbackDbRecord, InterviewFeedbackUpsertInput, InterviewFeedbackUpdateInput,
  OfferDbRecord, OfferVersionDbRecord, OfferCreateInput, OfferUpdateInput, OfferVersionCreateInput,
  OnboardingDbRecord, OnboardingCreateInput, OnboardingUpdateInput,
  WorkflowEventDbRecord, WorkflowEventCreateInput, WorkflowEventFilter,
} from './types.js'

export class RepositoryNotFoundError extends Error {
  readonly code = 'REPOSITORY_NOT_FOUND'

  constructor(message: string) {
    super(message)
    this.name = 'RepositoryNotFoundError'
  }
}

export class RepositoryValidationError extends Error {
  readonly code = 'REPOSITORY_VALIDATION_ERROR'
  readonly status = 400

  constructor(message: string) {
    super(message)
    this.name = 'RepositoryValidationError'
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

function text(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

function required(value: string | null | undefined, field: string): string {
  const result = text(value)
  if (!result) throw new RepositoryValidationError(`${field} is required`)
  return result
}

function uuidOrGenerated(value: string | undefined): string {
  return value && isUuid(value) ? value : randomUUID()
}

function businessNumber(prefix: string, legacyPrefix: string, input: string | undefined, generate: (prefix: string) => string): string {
  const value = text(input)
  if (!value) return generate(prefix)
  if (new RegExp(`^${prefix}-`, 'i').test(value)) return value.toUpperCase()
  if (new RegExp(`^${legacyPrefix}-`, 'i').test(value)) return `${prefix}-${value.slice(legacyPrefix.length + 1)}`.toUpperCase()
  return value
}

function legacyId(prefix: string, businessId: string): string {
  const suffix = businessId.startsWith(`${prefix}-`) ? businessId.slice(prefix.length + 1) : businessId
  const legacyPrefix = prefix === 'REQ' ? 'rr' : prefix === 'APP' ? 'application' : prefix === 'CAN' ? 'candidate' : 'job'
  return `${legacyPrefix}-${suffix}`
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()
}

function poolConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  if (env.DATABASE_URL?.trim()) return { connectionString: env.DATABASE_URL.trim(), max: 10 }
  return {
    host: env.PGHOST?.trim() || '127.0.0.1',
    port: Number(env.PGPORT || 5432),
    user: env.PGUSER?.trim() || 'postgres',
    password: env.PGPASSWORD,
    database: env.PGDATABASE?.trim() || 'smartrecruit',
    max: 10,
  }
}

function defaultGeneratedBusinessId(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`
}

function whereReference(idColumn: string, businessColumn: string, value: string, parameter: number): string {
  return isUuid(value) ? `${idColumn} = $${parameter}::uuid` : `${businessColumn} = $${parameter}`
}

function normalizeReference(value: string, prefix: string, legacyPrefix: string): string {
  return businessNumber(prefix, legacyPrefix, value, () => value)
}

async function queryOne<T extends QueryResultRow>(executor: Pick<RepositoryPool, 'query'> | Pick<RepositoryClient, 'query'>, sql: string, values: readonly unknown[]): Promise<T> {
  const result = await executor.query<T>(sql, values as unknown[])
  const row = result.rows[0]
  if (!row) throw new RepositoryNotFoundError('Expected one database row, but no row was returned')
  return row
}

export class NormalizedRecruitingRepository {
  readonly pool: RepositoryPool
  private readonly generateBusinessId: (prefix: string) => string

  constructor(poolOrConfig: RepositoryPool | PoolConfig = poolConfigFromEnv(), options: RepositoryOptions = {}) {
    this.pool = isRepositoryPool(poolOrConfig) ? poolOrConfig : new Pool(poolOrConfig)
    this.generateBusinessId = options.generatedBusinessId ?? defaultGeneratedBusinessId
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async transaction<T>(callback: TransactionCallback<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await callback(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async withTransaction<T>(callback: TransactionCallback<T>): Promise<T> {
    return this.transaction(callback)
  }

  async listRecruitmentRequests(status?: string): Promise<RecruitmentRequestRecord[]> {
    const values: string[] = []
    const filter = text(status)
    const where = filter ? `WHERE rr.status = $${values.push(filter)}` : ''
    const result = await this.pool.query<RecruitmentRequestRow>(`${REQUEST_SELECT} ${where} ORDER BY rr.updated_at DESC, rr.request_no`, values)
    return result.rows.map(mapRecruitmentRequest)
  }

  async getRecruitmentRequest(idOrBusinessId: string): Promise<RecruitmentRequestRecord> {
    const reference = normalizeReference(required(idOrBusinessId, 'recruitment request id'), 'REQ', 'rr')
    const result = await this.pool.query<RecruitmentRequestRow>(`${REQUEST_SELECT} WHERE ${whereReference('rr.id', 'rr.request_no', reference, 1)}`, [reference])
    const row = result.rows[0]
    if (!row) throw new RepositoryNotFoundError(`Recruitment request not found: ${idOrBusinessId}`)
    return mapRecruitmentRequest(row)
  }

  async createRecruitmentRequest(input: RecruitmentRequestCreateInput): Promise<RecruitmentRequestRecord> {
    return this.transaction(async (client) => {
      const id = uuidOrGenerated(input.id)
      const requestNo = businessNumber('REQ', 'rr', input.businessId ?? input.requestNo ?? input.id, this.generateBusinessId)
      const departmentId = await resolveForeignKey(client, 'departments', 'id', 'code', input.departmentId)
      const requestedById = await resolveForeignKey(client, 'users', 'id', 'email', input.requestedById)
      const hiringManagerId = input.hiringManagerId ? await resolveForeignKey(client, 'users', 'id', 'email', input.hiringManagerId).catch(() => null) : null
      const row = await queryOne<RecruitmentRequestRow>(client,
        `INSERT INTO recruitment_requests
          (id, request_no, title, department_id, requested_by, hiring_manager_id, headcount, budget_min, budget_max, employment_type, work_mode, location, reason, status, version)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING ${REQUEST_COLUMNS}`,
        [id, requestNo, required(input.title, 'title'), departmentId, requestedById, hiringManagerId, input.headcount, input.budgetMin ?? null, input.budgetMax ?? null, input.employmentType ?? null, input.workMode ?? null, input.location ?? null, input.reason ?? '', input.status ?? 'draft', input.version ?? 1],
      )
      return this.getRecruitmentRequestWithExecutor(client, id)
    })
  }

  async updateRecruitmentRequest(idOrBusinessId: string, input: RecruitmentRequestUpdateInput): Promise<RecruitmentRequestRecord> {
    return this.transaction(async (client) => {
      const id = await resolveEntityId(client, 'recruitment_requests', 'request_no', 'REQ', 'rr', idOrBusinessId)
      const assignments: string[] = []
      const values: unknown[] = []
      const add = (column: string, value: unknown, cast = '') => { assignments.push(`${column} = $${values.push(value)}${cast}`) }
      if (input.title !== undefined) add('title', required(input.title, 'title'))
      if (input.departmentId !== undefined) add('department_id', await resolveForeignKey(client, 'departments', 'id', 'code', input.departmentId), '::uuid')
      if (input.requestedById !== undefined) add('requested_by', await resolveForeignKey(client, 'users', 'id', 'email', input.requestedById), '::uuid')
      if (input.headcount !== undefined) add('headcount', input.headcount)
      if (input.budgetMin !== undefined) add('budget_min', input.budgetMin)
      if (input.budgetMax !== undefined) add('budget_max', input.budgetMax)
      if (input.hiringManagerId !== undefined) add('hiring_manager_id', input.hiringManagerId ? await resolveForeignKey(client, 'users', 'id', 'email', input.hiringManagerId).catch(() => null) : null, '::uuid')
      if (input.employmentType !== undefined) add('employment_type', input.employmentType)
      if (input.workMode !== undefined) add('work_mode', input.workMode)
      if (input.location !== undefined) add('location', input.location)
      if (input.reason !== undefined) add('reason', input.reason)
      if (input.status !== undefined) add('status', input.status)
      if (input.version !== undefined) add('version', input.version)
      if (!assignments.length) return this.getRecruitmentRequestWithExecutor(client, id)
      values.push(id)
      const row = await queryOne<RecruitmentRequestRow>(client, `UPDATE recruitment_requests SET ${assignments.join(', ')} WHERE id = $${values.length}::uuid RETURNING ${REQUEST_COLUMNS}`, values)
      return this.getRecruitmentRequestWithExecutor(client, id)
    })
  }

  async listJobs(status?: string, recruitmentRequestId?: string): Promise<JobRecord[]> {
    const values: string[] = []
    const conditions: string[] = []
    if (text(status)) conditions.push(`j.status = $${values.push(text(status))}`)
    if (text(recruitmentRequestId)) {
      const reference = normalizeReference(text(recruitmentRequestId), 'REQ', 'rr')
      if (isUuid(reference)) conditions.push(`j.recruitment_request_id = $${values.push(reference)}::uuid`)
      else conditions.push(`rr.request_no = $${values.push(reference)}`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const result = await this.pool.query<JobRow>(`${JOB_SELECT} ${where} ORDER BY j.updated_at DESC, j.job_no`, values)
    return result.rows.map(mapJob)
  }

  async getJob(idOrBusinessId: string): Promise<JobRecord> {
    const reference = normalizeReference(required(idOrBusinessId, 'job id'), 'JOB', 'job')
    const result = await this.pool.query<JobRow>(`${JOB_SELECT} WHERE ${whereReference('j.id', 'j.job_no', reference, 1)}`, [reference])
    const row = result.rows[0]
    if (!row) throw new RepositoryNotFoundError(`Job not found: ${idOrBusinessId}`)
    return mapJob(row)
  }

  async createJob(input: JobCreateInput): Promise<JobRecord> {
    return this.transaction(async (client) => {
      const id = uuidOrGenerated(input.id)
      const jobNo = businessNumber('JOB', 'job', input.businessId ?? input.jobNo ?? input.id, this.generateBusinessId)
      const requestId = await resolveForeignKey(client, 'recruitment_requests', 'id', 'request_no', input.recruitmentRequestId)
      const departmentId = await resolveForeignKey(client, 'departments', 'id', 'code', input.departmentId)
      if (!departmentId) throw new RepositoryValidationError('departmentId is required for a job')
      const createdById = await resolveForeignKey(client, 'users', 'id', 'email', input.createdById)
      const row = await queryOne<JobRow>(client,
        `INSERT INTO jobs
          (id, job_no, recruitment_request_id, department_id, title, status, headcount, employment_type, work_mode, location, created_by)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11::uuid)
         RETURNING ${JOB_COLUMNS}`,
        [id, jobNo, requestId, departmentId, required(input.title, 'title'), input.status ?? 'draft', input.headcount, input.employmentType ?? null, input.workMode ?? null, input.location ?? null, createdById],
      )
      return this.getJobWithExecutor(client, id)
    })
  }

  async updateJob(idOrBusinessId: string, input: JobUpdateInput): Promise<JobRecord> {
    return this.transaction(async (client) => {
      const id = await resolveEntityId(client, 'jobs', 'job_no', 'JOB', 'job', idOrBusinessId)
      const assignments: string[] = []
      const values: unknown[] = []
      const add = (column: string, value: unknown, cast = '') => { assignments.push(`${column} = $${values.push(value)}${cast}`) }
      if (input.departmentId !== undefined) add('department_id', await resolveForeignKey(client, 'departments', 'id', 'code', input.departmentId), '::uuid')
      if (input.title !== undefined) add('title', required(input.title, 'title'))
      if (input.status !== undefined) add('status', input.status)
      if (input.headcount !== undefined) add('headcount', input.headcount)
      if (input.employmentType !== undefined) add('employment_type', input.employmentType)
      if (input.workMode !== undefined) add('work_mode', input.workMode)
      if (input.location !== undefined) add('location', input.location)
      if (input.createdById !== undefined) add('created_by', await resolveForeignKey(client, 'users', 'id', 'email', input.createdById), '::uuid')
      if (!assignments.length) return this.getJobWithExecutor(client, id)
      values.push(id)
      const row = await queryOne<JobRow>(client, `UPDATE jobs SET ${assignments.join(', ')} WHERE id = $${values.length}::uuid RETURNING ${JOB_COLUMNS}`, values)
      return this.getJobWithExecutor(client, id)
    })
  }

  async listCandidates(): Promise<CandidateRecord[]> {
    const result = await this.pool.query<CandidateRow>(`${CANDIDATE_SELECT} ORDER BY c.updated_at DESC, c.candidate_no`, [])
    return result.rows.map(mapCandidate)
  }

  async getCandidate(idOrBusinessId: string): Promise<CandidateRecord> {
    const reference = normalizeReference(required(idOrBusinessId, 'candidate id'), 'CAN', 'candidate')
    const result = await this.pool.query<CandidateRow>(`${CANDIDATE_SELECT} WHERE ${whereReference('c.id', 'c.candidate_no', reference, 1)}`, [reference])
    const row = result.rows[0]
    if (!row) throw new RepositoryNotFoundError(`Candidate not found: ${idOrBusinessId}`)
    return mapCandidate(row)
  }

  async createCandidate(input: CandidateCreateInput): Promise<CandidateRecord> {
    return this.transaction(async (client) => {
      const id = uuidOrGenerated(input.id)
      const candidateNo = businessNumber('CAN', 'candidate', input.businessId ?? input.candidateNo ?? input.id, this.generateBusinessId)
      const row = await queryOne<CandidateRow>(client,
        `INSERT INTO candidates
          (id, candidate_no, name, email, phone, location, source, consent_status)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${CANDIDATE_COLUMNS}`,
        [id, candidateNo, required(input.name, 'name'), input.email ?? null, input.phone ?? null, input.location ?? null, input.source ?? null, input.consentStatus ?? 'unknown'],
      )
      return mapCandidate(row)
    })
  }

  async updateCandidate(idOrBusinessId: string, input: CandidateUpdateInput): Promise<CandidateRecord> {
    return this.transaction(async (client) => {
      const id = await resolveEntityId(client, 'candidates', 'candidate_no', 'CAN', 'candidate', idOrBusinessId)
      const assignments: string[] = []
      const values: unknown[] = []
      const add = (column: string, value: unknown) => { assignments.push(`${column} = $${values.push(value)}`) }
      if (input.name !== undefined) add('name', required(input.name, 'name'))
      if (input.email !== undefined) add('email', input.email)
      if (input.phone !== undefined) add('phone', input.phone)
      if (input.location !== undefined) add('location', input.location)
      if (input.source !== undefined) add('source', input.source)
      if (input.consentStatus !== undefined) add('consent_status', input.consentStatus)
      if (!assignments.length) return this.getCandidateWithExecutor(client, id)
      values.push(id)
      const row = await queryOne<CandidateRow>(client, `UPDATE candidates SET ${assignments.join(', ')} WHERE id = $${values.length}::uuid RETURNING ${CANDIDATE_COLUMNS}`, values)
      return mapCandidate(row)
    })
  }

  async listApplications(candidateId?: string, jobId?: string): Promise<ApplicationRecord[]> {
    const values: string[] = []
    const conditions: string[] = []
    if (text(candidateId)) conditions.push(isUuid(text(candidateId)) ? `a.candidate_id = $${values.push(text(candidateId))}::uuid` : `c.candidate_no = $${values.push(normalizeReference(text(candidateId), 'CAN', 'candidate'))}`)
    if (text(jobId)) conditions.push(isUuid(text(jobId)) ? `a.job_id = $${values.push(text(jobId))}::uuid` : `j.job_no = $${values.push(normalizeReference(text(jobId), 'JOB', 'job'))}`)
    const result = await this.pool.query<ApplicationRow>(`${APPLICATION_SELECT} ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY a.applied_at DESC, a.application_no`, values)
    return result.rows.map(mapApplication)
  }

  async getApplication(idOrBusinessId: string): Promise<ApplicationRecord> {
    const reference = normalizeReference(required(idOrBusinessId, 'application id'), 'APP', 'application')
    const result = await this.pool.query<ApplicationRow>(`${APPLICATION_SELECT} WHERE ${whereReference('a.id', 'a.application_no', reference, 1)}`, [reference])
    const row = result.rows[0]
    if (!row) throw new RepositoryNotFoundError(`Application not found: ${idOrBusinessId}`)
    return mapApplication(row)
  }

  async createApplication(input: ApplicationCreateInput): Promise<ApplicationRecord> {
    return this.transaction(async (client) => {
      const id = uuidOrGenerated(input.id)
      const applicationNo = businessNumber('APP', 'application', input.businessId ?? input.applicationNo ?? input.id, this.generateBusinessId)
      const candidateId = await resolveRequiredForeignKey(client, 'candidates', 'id', 'candidate_no', input.candidateId, 'candidateId')
      const jobId = await resolveRequiredForeignKey(client, 'jobs', 'id', 'job_no', input.jobId, 'jobId')
      const recruiterId = await resolveForeignKey(client, 'users', 'id', 'email', input.recruiterId)
      const row = await queryOne<ApplicationRow>(client,
        `INSERT INTO applications
          (id, application_no, candidate_id, job_id, status, recruiter_id, source, applied_at)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6::uuid, $7, COALESCE($8::timestamptz, now()))
         RETURNING ${APPLICATION_COLUMNS}`,
        [id, applicationNo, candidateId, jobId, input.status ?? 'pending_analysis', recruiterId, input.source ?? null, input.appliedAt ?? null],
      )
      return mapApplication(row)
    })
  }

  async updateApplication(idOrBusinessId: string, input: ApplicationUpdateInput): Promise<ApplicationRecord> {
    return this.transaction(async (client) => {
      const id = await resolveEntityId(client, 'applications', 'application_no', 'APP', 'application', idOrBusinessId)
      const assignments: string[] = []
      const values: unknown[] = []
      const add = (column: string, value: unknown) => { assignments.push(`${column} = $${values.push(value)}`) }
      if (input.status !== undefined) add('status', input.status)
      if (input.recruiterId !== undefined) add('recruiter_id', await resolveForeignKey(client, 'users', 'id', 'email', input.recruiterId))
      if (input.source !== undefined) add('source', input.source)
      if (input.rejectedReason !== undefined) add('rejected_reason', input.rejectedReason)
      if (input.withdrawnAt !== undefined) add('withdrawn_at', input.withdrawnAt)
      if (!assignments.length) return this.getApplicationWithExecutor(client, id)
      values.push(id)
      const row = await queryOne<ApplicationRow>(client, `UPDATE applications SET ${assignments.join(', ')} WHERE id = $${values.length}::uuid RETURNING ${APPLICATION_COLUMNS}`, values)
      return mapApplication(row)
    })
  }

  async updateApplicationStatus(idOrBusinessId: string, status: string, rejectedReason?: string): Promise<ApplicationRecord> {
    return this.updateApplication(idOrBusinessId, { status, ...(rejectedReason === undefined ? {} : { rejectedReason }) })
  }

  async listResumes(candidateId?: string, applicationId?: string): Promise<ResumeRecord[]> {
    const values: unknown[] = []; const where: string[] = []
    if (candidateId) where.push(`r.candidate_id = $${values.push(candidateId)}::uuid`)
    if (applicationId) where.push(`r.application_id = $${values.push(applicationId)}::uuid`)
    const result = await this.pool.query<any>(`SELECT r.id, r.candidate_id, r.application_id, r.storage_key, r.original_filename, r.mime_type, r.size_bytes, r.scan_status, r.content_hash, r.created_at FROM resumes r ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created_at DESC`, values)
    return result.rows.map((row) => ({ id: row.id, candidateId: row.candidate_id, applicationId: row.application_id, storageKey: row.storage_key, originalFilename: row.original_filename, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes), scanStatus: row.scan_status, contentHash: row.content_hash, createdAt: iso(row.created_at) }))
  }

  async getResume(id: string): Promise<ResumeRecord> {
    const result = await this.pool.query<any>('SELECT id, candidate_id, application_id, storage_key, original_filename, mime_type, size_bytes, scan_status, content_hash, created_at FROM resumes WHERE id = $1::uuid', [id])
    const row = result.rows[0]; if (!row) throw new RepositoryNotFoundError(`Resume not found: ${id}`)
    return { id: row.id, candidateId: row.candidate_id, applicationId: row.application_id, storageKey: row.storage_key, originalFilename: row.original_filename, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes), scanStatus: row.scan_status, contentHash: row.content_hash, createdAt: iso(row.created_at) }
  }

  async createResume(input: ResumeCreateInput): Promise<ResumeRecord> {
    return this.transaction(async (client) => {
      const row = await queryOne<any>(client, `INSERT INTO resumes (id, candidate_id, application_id, storage_key, original_filename, mime_type, size_bytes, scan_status, content_hash) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9) RETURNING id, candidate_id, application_id, storage_key, original_filename, mime_type, size_bytes, scan_status, content_hash, created_at`, [uuidOrGenerated(input.id), input.candidateId, input.applicationId ?? null, input.storageKey, input.originalFilename, input.mimeType, input.sizeBytes, input.scanStatus ?? 'clean', input.contentHash])
      return { id: row.id, candidateId: row.candidate_id, applicationId: row.application_id, storageKey: row.storage_key, originalFilename: row.original_filename, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes), scanStatus: row.scan_status, contentHash: row.content_hash, createdAt: iso(row.created_at) }
    })
  }

  async createAnalysisTask(input: { resumeId: string; applicationId?: string | null; idempotencyKey: string }): Promise<{ id: string; resumeId: string; applicationId: string | null; status: string; attempts: number; idempotencyKey: string; availableAt: string; createdAt: string }> {
    const id = randomUUID()
    const result = await this.pool.query<any>(`INSERT INTO analysis_tasks (id, resume_id, application_id, status, attempts, idempotency_key) VALUES ($1::uuid, $2::uuid, $3::uuid, 'queued', 0, $4) RETURNING id, resume_id, application_id, status, attempts, idempotency_key, available_at, created_at`, [id, input.resumeId, input.applicationId ?? null, input.idempotencyKey])
    const row = result.rows[0]; if (!row) throw new RepositoryNotFoundError('Analysis task insert returned no row')
    return { id: row.id, resumeId: row.resume_id, applicationId: row.application_id, status: row.status, attempts: row.attempts, idempotencyKey: row.idempotency_key, availableAt: iso(row.available_at), createdAt: iso(row.created_at) }
  }

  async getAnalysisTask(id: string): Promise<AnalysisTaskRecord> {
    const result = await this.pool.query<AnalysisTaskRow>(`${ANALYSIS_TASK_COLUMNS} FROM analysis_tasks WHERE id = $1::uuid`, [id])
    const row = result.rows[0]; if (!row) throw new RepositoryNotFoundError(`Analysis task not found: ${id}`)
    return mapAnalysisTask(row)
  }

  async listAnalysisTasks(status?: string): Promise<AnalysisTaskRecord[]> {
    const values: unknown[] = []; const where = status ? `WHERE status = $1` : ''
    if (status) values.push(status)
    const result = await this.pool.query<AnalysisTaskRow>(`${ANALYSIS_TASK_COLUMNS} FROM analysis_tasks ${where} ORDER BY created_at DESC`, values)
    return result.rows.map(mapAnalysisTask)
  }

  async updateAnalysisTask(id: string, input: { status?: string; attempts?: number; lastError?: string | null; startedAt?: string | null; completedAt?: string | null }): Promise<AnalysisTaskRecord> {
    return this.transaction(async (client) => {
      const assignments: string[] = []; const values: unknown[] = []
      const add = (column: string, value: unknown, cast = '') => assignments.push(`${column} = $${values.push(value)}${cast}`)
      if (input.status !== undefined) add('status', input.status)
      if (input.attempts !== undefined) add('attempts', input.attempts)
      if (input.lastError !== undefined) add('last_error', input.lastError)
      if (input.startedAt !== undefined) add('started_at', input.startedAt, '::timestamptz')
      if (input.completedAt !== undefined) add('completed_at', input.completedAt, '::timestamptz')
      if (!assignments.length) return this.getAnalysisTaskWithExecutor(client, id)
      values.push(id)
      const row = await queryOne<AnalysisTaskRow>(client, `UPDATE analysis_tasks SET ${assignments.join(', ')} WHERE id = $${values.length}::uuid RETURNING ${ANALYSIS_TASK_RETURNING}`, values)
      return mapAnalysisTask(row)
    })
  }

  async listAnalysisResults(resumeId?: string, applicationId?: string): Promise<AnalysisResultRecord[]> {
    const values: unknown[] = []; const where: string[] = []
    if (resumeId) where.push(`resume_id = $${values.push(resumeId)}::uuid`)
    if (applicationId) where.push(`application_id = $${values.push(applicationId)}::uuid`)
    const result = await this.pool.query<AnalysisResultRow>(`${ANALYSIS_RESULT_COLUMNS} FROM analysis_results ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`, values)
    return result.rows.map(mapAnalysisResult)
  }

  async getAnalysisResultByTask(taskId: string): Promise<AnalysisResultRecord> {
    const result = await this.pool.query<AnalysisResultRow>(`${ANALYSIS_RESULT_COLUMNS} FROM analysis_results WHERE analysis_task_id = $1::uuid`, [taskId])
    const row = result.rows[0]; if (!row) throw new RepositoryNotFoundError(`Analysis result not found for task: ${taskId}`)
    return mapAnalysisResult(row)
  }

  async getAnalysisResult(id: string): Promise<AnalysisResultRecord> {
    const result = await this.pool.query<AnalysisResultRow>(`${ANALYSIS_RESULT_COLUMNS} FROM analysis_results WHERE id = $1::uuid`, [id])
    const row = result.rows[0]; if (!row) throw new RepositoryNotFoundError(`Analysis result not found: ${id}`)
    return mapAnalysisResult(row)
  }

  async createAnalysisResult(input: { id?: string; analysisTaskId: string; resumeId: string; applicationId?: string | null; result: Record<string, unknown>; analyzerVersion?: string | null; inputHash?: string | null; humanReviewStatus?: string }): Promise<AnalysisResultRecord> {
    return this.transaction(async (client) => {
      const row = await queryOne<AnalysisResultRow>(client, `INSERT INTO analysis_results (id, analysis_task_id, resume_id, application_id, result, analyzer_version, input_hash, human_review_status) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, $6, $7, $8) ON CONFLICT (analysis_task_id) DO UPDATE SET result = EXCLUDED.result, analyzer_version = EXCLUDED.analyzer_version, input_hash = EXCLUDED.input_hash, human_review_status = EXCLUDED.human_review_status RETURNING ${ANALYSIS_RESULT_RETURNING}`, [uuidOrGenerated(input.id), input.analysisTaskId, input.resumeId, input.applicationId ?? null, JSON.stringify(input.result), input.analyzerVersion ?? null, input.inputHash ?? null, input.humanReviewStatus ?? 'pending'])
      return mapAnalysisResult(row)
    })
  }

  async reviewAnalysisResult(id: string, status: string, result: Record<string, unknown>): Promise<AnalysisResultRecord> {
    const row = await queryOne<AnalysisResultRow>(this.pool, `UPDATE analysis_results SET human_review_status = $1, result = $2::jsonb WHERE id = $3::uuid RETURNING ${ANALYSIS_RESULT_RETURNING}`, [status, JSON.stringify(result), id])
    return mapAnalysisResult(row)
  }

  private async getAnalysisTaskWithExecutor(executor: RepositoryClient, id: string): Promise<AnalysisTaskRecord> {
    return mapAnalysisTask(await queryOne<AnalysisTaskRow>(executor, `${ANALYSIS_TASK_COLUMNS} FROM analysis_tasks WHERE id = $1::uuid`, [id]))
  }

  async requestApprovalAction(idOrBusinessId: string, action: 'submit' | 'resubmit' | 'approve' | 'reject', actorId: string, reason?: string): Promise<RecruitmentRequestRecord> {
    return this.transaction(async (client) => {
      const requestId = await resolveEntityId(client, 'recruitment_requests', 'request_no', 'REQ', 'rr', idOrBusinessId)
      const current = await queryOne<{ id: string; status: string; version: number }>(client,
        'SELECT id, status, version FROM recruitment_requests WHERE id = $1::uuid FOR UPDATE', [requestId])
      if (action === 'submit' || action === 'resubmit') {
        if (current.status !== 'draft' && current.status !== 'rejected') throw new RepositoryValidationError(`Recruitment request status ${current.status} cannot be submitted`)
        const instanceId = randomUUID()
        const stepId = randomUUID()
        await client.query(
          `INSERT INTO approval_instances (id, subject_type, subject_id, version, status, current_step, created_by, updated_at)
           SELECT $1::uuid, 'recruitment_request', $2::uuid, COALESCE(MAX(version), 0) + 1, 'pending', 1, $3::uuid, now()
           FROM approval_instances WHERE subject_type = 'recruitment_request' AND subject_id = $2::uuid`,
          [instanceId, requestId, isUuid(actorId) ? actorId : null],
        )
        await client.query(
          `INSERT INTO approval_steps (id, approval_instance_id, step_no, approver_role_code, status)
           VALUES ($1::uuid, $2::uuid, 1, 'approver', 'pending')`, [stepId, instanceId])
        return mapRecruitmentRequest(await queryOne<RecruitmentRequestRow>(client,
          `UPDATE recruitment_requests SET status = 'pending_approval', version = version + 1, updated_at = now()
           WHERE id = $1::uuid RETURNING ${REQUEST_COLUMNS}`, [requestId]))
      }

      if (current.status !== 'pending_approval') throw new RepositoryValidationError(`Recruitment request status ${current.status} cannot be approved`)
      if (action === 'reject' && !text(reason)) throw new RepositoryValidationError('Approval rejection reason is required')
      const instance = await queryOne<{ id: string; status: string }>(client,
        `SELECT id, status FROM approval_instances
         WHERE subject_type = 'recruitment_request' AND subject_id = $1::uuid AND status = 'pending'
         ORDER BY version DESC, created_at DESC LIMIT 1 FOR UPDATE`, [requestId])
      const step = await queryOne<{ id: string; status: string }>(client,
        `SELECT id, status FROM approval_steps WHERE approval_instance_id = $1::uuid AND status = 'pending' ORDER BY step_no LIMIT 1 FOR UPDATE`, [instance.id])
      const decision = action === 'approve' ? 'approved' : 'rejected'
      await client.query(
        `INSERT INTO approval_records (id, approval_instance_id, approval_step_id, actor_user_id, decision, comment)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)`,
        [randomUUID(), instance.id, step.id, isUuid(actorId) ? actorId : null, decision, text(reason)],
      )
      await client.query(`UPDATE approval_steps SET status = $2, acted_at = now() WHERE id = $1::uuid`, [step.id, decision])
      await client.query(`UPDATE approval_instances SET status = $2, completed_at = now(), updated_at = now() WHERE id = $1::uuid`, [instance.id, decision])
      return mapRecruitmentRequest(await queryOne<RecruitmentRequestRow>(client,
        `UPDATE recruitment_requests SET status = $2, version = version + 1, updated_at = now()
         WHERE id = $1::uuid RETURNING ${REQUEST_COLUMNS}`, [requestId, decision]))
    })
  }

  async getRecruitmentRequestApproval(idOrBusinessId: string): Promise<{ current: RecruitmentApprovalInstanceRecord | null; steps: RecruitmentApprovalStepRecord[]; records: RecruitmentApprovalAuditRecord[] }> {
    const requestId = await resolveEntityId(this.pool as Pick<RepositoryPool, 'query'>, 'recruitment_requests', 'request_no', 'REQ', 'rr', idOrBusinessId)
    const instances = await this.pool.query<ApprovalInstanceRow>(
      `SELECT id, subject_type, subject_id, version, status, created_at, updated_at
       FROM approval_instances WHERE subject_type = 'recruitment_request' AND subject_id = $1::uuid ORDER BY version DESC, created_at DESC`, [requestId])
    const current = instances.rows[0] ? mapApprovalInstance(instances.rows[0]) : null
    const ids = instances.rows.map((row) => row.id)
    if (!ids.length) return { current, steps: [], records: [] }
    const steps = await this.pool.query<ApprovalStepRow>(
      `SELECT id, approval_instance_id, step_no, approver_role_code, status, acted_at FROM approval_steps WHERE approval_instance_id = ANY($1::uuid[]) ORDER BY step_no`, [ids])
    const records = await this.pool.query<ApprovalRecordRow>(
      `SELECT id, approval_instance_id, approval_step_id, actor_user_id, decision, comment, created_at FROM approval_records WHERE approval_instance_id = ANY($1::uuid[]) ORDER BY created_at`, [ids])
    return { current, steps: steps.rows.map(mapApprovalStep), records: records.rows.map(mapApprovalRecord) }
  }

  // ===== 岗位说明书 / JD 版本 =====
  async listJobSpecVersions(jobIdOrBusinessId?: string): Promise<JobSpecVersionDbRecord[]> {
    const values: string[] = []
    const where = text(jobIdOrBusinessId)
      ? `WHERE job_id = $${values.push(await resolveReferenceLine(this.pool, 'jobs', 'job_no', 'JOB', 'job', text(jobIdOrBusinessId)))}::uuid`
      : ''
    const result = await this.pool.query<JobSpecVersionRow>(`SELECT ${JOB_SPEC_VERSION_COLUMNS} FROM job_spec_versions ${where} ORDER BY job_id, version DESC`, values)
    return result.rows.map(mapJobSpecVersion)
  }

  /** 确认岗位说明书最新版本（transitionJob 的 confirm_spec 需要落库）。 */
  async confirmJobSpecVersion(jobIdOrBusinessId: string, version?: number): Promise<JobSpecVersionDbRecord> {
    return this.transaction(async (client) => {
      const jobId = await resolveReferenceLine(client, 'jobs', 'job_no', 'JOB', 'job', required(jobIdOrBusinessId, 'jobId'))
      const latest = version === undefined
      const row = await queryOne<JobSpecVersionRow>(client,
        `UPDATE job_spec_versions SET confirmed_at = now()
          WHERE job_id = $1::uuid AND version = ${latest ? '(SELECT MAX(version) FROM job_spec_versions WHERE job_id = $1::uuid)' : '$2::int'}
          RETURNING ${JOB_SPEC_VERSION_COLUMNS}`,
        latest ? [jobId] : [jobId, version])
      return mapJobSpecVersion(row)
    })
  }

  async createJobSpecVersion(input: JobSpecVersionCreateInput): Promise<JobSpecVersionDbRecord> {
    return this.transaction(async (client) => {
      const jobId = await resolveRequiredForeignKey(client, 'jobs', 'id', 'job_no', input.jobId, 'jobId')
      const createdById = await resolveActorId(client, input.createdById)
      const version = input.version ?? await nextVersionFor(client, 'job_spec_versions', 'job_id', jobId)
      const row = await queryOne<JobSpecVersionRow>(client,
        `INSERT INTO job_spec_versions (id, job_id, version, content, created_by, confirmed_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::uuid, $6::timestamptz)
         RETURNING ${JOB_SPEC_VERSION_COLUMNS}`,
        [uuidOrGenerated(input.id), jobId, version, JSON.stringify(input.content ?? {}), createdById, input.confirmedAt ?? null])
      return mapJobSpecVersion(row)
    })
  }

  async listJobDescriptionVersions(jobIdOrBusinessId?: string): Promise<JobDescriptionVersionDbRecord[]> {
    const values: string[] = []
    const where = text(jobIdOrBusinessId)
      ? `WHERE job_id = $${values.push(await resolveReferenceLine(this.pool, 'jobs', 'job_no', 'JOB', 'job', text(jobIdOrBusinessId)))}::uuid`
      : ''
    const result = await this.pool.query<JobDescriptionVersionRow>(`SELECT ${JD_VERSION_COLUMNS} FROM job_description_versions ${where} ORDER BY job_id, version DESC`, values)
    return result.rows.map(mapJobDescriptionVersion)
  }

  /** 确认 JD 最新版本（transitionJob 的 confirm_jd 需要落库）。 */
  async confirmJobDescriptionVersion(jobIdOrBusinessId: string, version?: number): Promise<JobDescriptionVersionDbRecord> {
    return this.transaction(async (client) => {
      const jobId = await resolveReferenceLine(client, 'jobs', 'job_no', 'JOB', 'job', required(jobIdOrBusinessId, 'jobId'))
      const latest = version === undefined
      const row = await queryOne<JobDescriptionVersionRow>(client,
        `UPDATE job_description_versions SET confirmed_at = now(), status = 'confirmed'
          WHERE job_id = $1::uuid AND version = ${latest ? '(SELECT MAX(version) FROM job_description_versions WHERE job_id = $1::uuid)' : '$2::int'}
          RETURNING ${JD_VERSION_COLUMNS}`,
        latest ? [jobId] : [jobId, version])
      return mapJobDescriptionVersion(row)
    })
  }

  async createJobDescriptionVersion(input: JobDescriptionVersionCreateInput): Promise<JobDescriptionVersionDbRecord> {
    return this.transaction(async (client) => {
      const jobId = await resolveRequiredForeignKey(client, 'jobs', 'id', 'job_no', input.jobId, 'jobId')
      const createdById = await resolveActorId(client, input.createdById)
      const version = input.version ?? await nextVersionFor(client, 'job_description_versions', 'job_id', jobId)
      const row = await queryOne<JobDescriptionVersionRow>(client,
        `INSERT INTO job_description_versions (id, job_id, version, title, content, status, created_by)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid)
         RETURNING ${JD_VERSION_COLUMNS}`,
        [uuidOrGenerated(input.id), jobId, version, text(input.title) || `v${version}`, input.content ?? '', input.status ?? 'draft', createdById])
      return mapJobDescriptionVersion(row)
    })
  }

  // ===== 面试 =====
  async listInterviews(applicationId?: string): Promise<InterviewDbRecord[]> {
    const values: string[] = []
    const conditions: string[] = []
    if (text(applicationId)) {
      const reference = normalizeReference(text(applicationId), 'APP', 'application')
      if (isUuid(reference)) conditions.push(`i.application_id = $${values.push(reference)}::uuid`)
      else conditions.push(`a.application_no = $${values.push(reference)}`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const result = await this.pool.query<InterviewRow>(`${INTERVIEW_SELECT} ${where} ORDER BY i.round, i.created_at`, values)
    return result.rows.map(mapInterview)
  }

  async getInterview(idOrBusinessId: string): Promise<InterviewDbRecord> {
    const reference = normalizeReference(required(idOrBusinessId, 'interview id'), 'INT', 'int')
    const result = await this.pool.query<InterviewRow>(`${INTERVIEW_SELECT} WHERE ${whereReference('i.id', 'i.interview_no', reference, 1)}`, [reference])
    const row = result.rows[0]
    if (!row) throw new RepositoryNotFoundError(`Interview not found: ${idOrBusinessId}`)
    return mapInterview(row)
  }

  async createInterview(input: InterviewCreateInput): Promise<InterviewDbRecord> {
    return this.transaction(async (client) => {
      const applicationId = await resolveRequiredForeignKey(client, 'applications', 'id', 'application_no', input.applicationId, 'applicationId')
      const participants = await Promise.all((input.participants ?? []).map(async (participant) => ({
        ...participant,
        userId: await resolveActorId(client, participant.userId, { required: true, allowDisplayName: true }) as string,
      })))
      const interviewNo = businessNumber('INT', 'int', input.businessId ?? input.id, this.generateBusinessId)
      const round = input.round ?? await this.nextInterviewRound(client, applicationId)
      const row = await queryOne<InterviewRow>(client,
        `INSERT INTO interviews
          (id, interview_no, application_id, round, type, title, status, scheduled_start_at, scheduled_end_at, timezone, location, meeting_url, participants)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10, $11, $12, $13::jsonb)
         RETURNING ${INTERVIEW_COLUMNS}`,
        [uuidOrGenerated(input.id), interviewNo, applicationId, round, input.type ?? 'other', required(input.title, 'title'),
         input.status ?? 'scheduled', input.scheduledStartAt ?? null, input.scheduledEndAt ?? null, input.timezone ?? null,
         input.location ?? null, input.meetingUrl ?? null, JSON.stringify(participants)])
      return mapInterview(row)
    })
  }

  async updateInterview(idOrBusinessId: string, input: InterviewUpdateInput): Promise<InterviewDbRecord> {
    return this.transaction(async (client) => {
      const id = await resolveEntityId(client, 'interviews', 'interview_no', 'INT', 'int', idOrBusinessId)
      const assignments: string[] = []
      const values: unknown[] = []
      const add = (column: string, value: unknown, cast = '') => { assignments.push(`${column} = $${values.push(value)}${cast}`) }
      if (input.round !== undefined) add('round', input.round)
      if (input.type !== undefined) add('type', input.type)
      if (input.title !== undefined) add('title', required(input.title, 'title'))
      if (input.status !== undefined) add('status', input.status)
      if (input.scheduledStartAt !== undefined) add('scheduled_start_at', input.scheduledStartAt, '::timestamptz')
      if (input.scheduledEndAt !== undefined) add('scheduled_end_at', input.scheduledEndAt, '::timestamptz')
      if (input.timezone !== undefined) add('timezone', input.timezone)
      if (input.location !== undefined) add('location', input.location)
      if (input.meetingUrl !== undefined) add('meeting_url', input.meetingUrl)
      if (input.participants !== undefined) add('participants', JSON.stringify(input.participants), '::jsonb')
      if (!assignments.length) return this.getInterviewWithExecutor(client, id)
      assignments.push('updated_at = now()')
      values.push(id)
      const row = await queryOne<InterviewRow>(client, `UPDATE interviews SET ${assignments.join(', ')} WHERE id = $${values.length}::uuid RETURNING ${INTERVIEW_COLUMNS}`, values)
      return mapInterview(row)
    })
  }

  async listInterviewFeedback(interviewId?: string, interviewerId?: string): Promise<InterviewFeedbackDbRecord[]> {
    const values: string[] = []
    const conditions: string[] = []
    if (text(interviewId)) conditions.push(`f.interview_id = $${values.push(await resolveReferenceLine(this.pool, 'interviews', 'interview_no', 'INT', 'int', text(interviewId)))}::uuid`)
    if (text(interviewerId)) conditions.push(`f.interviewer_id = $${values.push(await this.resolveUserId(this.pool, text(interviewerId), true) as string)}::uuid`)
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const result = await this.pool.query<InterviewFeedbackRow>(`SELECT ${FEEDBACK_COLUMNS} FROM interview_feedback f ${where} ORDER BY f.submitted_at DESC NULLS LAST, f.id`, values)
    return result.rows.map(mapInterviewFeedback)
  }

  async getInterviewFeedbackForInterviewer(interviewId: string, interviewerId: string): Promise<InterviewFeedbackDbRecord | null> {
    const interview = await resolveReferenceLine(this.pool, 'interviews', 'interview_no', 'INT', 'int', required(interviewId, 'interviewId'))
    const interviewer = await this.resolveUserId(this.pool, required(interviewerId, 'interviewerId'))
    const result = await this.pool.query<InterviewFeedbackRow>(`SELECT ${FEEDBACK_COLUMNS} FROM interview_feedback f WHERE f.interview_id = $1::uuid AND f.interviewer_id = $2::uuid`, [interview, interviewer])
    const row = result.rows[0]
    return row ? mapInterviewFeedback(row) : null
  }

  async getInterviewFeedback(id: string): Promise<InterviewFeedbackDbRecord> {
    const result = await this.pool.query<InterviewFeedbackRow>(`SELECT ${FEEDBACK_COLUMNS} FROM interview_feedback f WHERE f.id = $1::uuid`, [required(id, 'feedback id')])
    const row = result.rows[0]
    if (!row) throw new RepositoryNotFoundError(`Interview feedback not found: ${id}`)
    return mapInterviewFeedback(row)
  }

  async createInterviewFeedback(input: InterviewFeedbackUpsertInput): Promise<InterviewFeedbackDbRecord> {
    return this.transaction(async (client) => {
      const interviewId = await resolveReferenceLine(client, 'interviews', 'interview_no', 'INT', 'int', input.interviewId)
      const interviewerId = await this.resolveUserId(client, input.interviewerId, true) as string
      const row = await queryOne<InterviewFeedbackRow>(client,
        `INSERT INTO interview_feedback
          (id, interview_id, interviewer_id, status, overall_score, recommendation, ratings, strengths, concerns, notes, submitted_at, locked_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::timestamptz, $12::timestamptz)
         RETURNING ${FEEDBACK_RETURNING}`,
        [uuidOrGenerated(input.id), interviewId, interviewerId, input.status ?? 'draft',
         input.overallScore ?? null, input.recommendation ?? null, JSON.stringify(input.ratings ?? {}),
         JSON.stringify(input.strengths ?? []), JSON.stringify(input.concerns ?? []), input.notes ?? null,
         input.submittedAt ?? null, input.lockedAt ?? null])
      return mapInterviewFeedback(row)
    })
  }

  async updateInterviewFeedback(id: string, input: InterviewFeedbackUpdateInput): Promise<InterviewFeedbackDbRecord> {
    return this.transaction(async (client) => {
      const assignments: string[] = []
      const values: unknown[] = []
      const add = (column: string, value: unknown, cast = '') => { assignments.push(`${column} = $${values.push(value)}${cast}`) }
      if (input.status !== undefined) add('status', input.status)
      if (input.overallScore !== undefined) add('overall_score', input.overallScore)
      if (input.recommendation !== undefined) add('recommendation', input.recommendation)
      if (input.ratings !== undefined) add('ratings', JSON.stringify(input.ratings), '::jsonb')
      if (input.strengths !== undefined) add('strengths', JSON.stringify(input.strengths), '::jsonb')
      if (input.concerns !== undefined) add('concerns', JSON.stringify(input.concerns), '::jsonb')
      if (input.notes !== undefined) add('notes', input.notes)
      if (input.submittedAt !== undefined) add('submitted_at', input.submittedAt, '::timestamptz')
      if (input.lockedAt !== undefined) add('locked_at', input.lockedAt, '::timestamptz')
      values.push(required(id, 'feedback id'))
      const row = await queryOne<InterviewFeedbackRow>(client, `UPDATE interview_feedback SET ${assignments.join(', ')} WHERE id = $${values.length}::uuid RETURNING ${FEEDBACK_RETURNING}`, values)
      return mapInterviewFeedback(row)
    })
  }

  // ===== Offer =====
  async listOffers(status?: string): Promise<OfferDbRecord[]> {
    const values: string[] = []
    const where = text(status) ? `WHERE o.status = $${values.push(text(status))}` : ''
    const result = await this.pool.query<OfferRow>(`${OFFER_SELECT} ${where} ORDER BY o.updated_at DESC, o.id`, values)
    return result.rows.map(mapOffer)
  }

  async getOffer(id: string): Promise<OfferDbRecord> {
    const reference = required(id, 'offer id')
    if (!isUuid(reference)) throw new RepositoryValidationError('offer lookups require the database uuid (offers table has no business-number column)')
    const result = await this.pool.query<OfferRow>(`${OFFER_SELECT} WHERE o.id = $1::uuid`, [reference])
    const row = result.rows[0]
    if (!row) throw new RepositoryNotFoundError(`Offer not found: ${id}`)
    return mapOffer(row)
  }

  async createOffer(input: OfferCreateInput): Promise<OfferDbRecord> {
    return this.transaction(async (client) => {
      const applicationId = await resolveRequiredForeignKey(client, 'applications', 'id', 'application_no', input.applicationId, 'applicationId')
      const row = await queryOne<OfferRow>(client,
        `INSERT INTO offers (id, application_id, status, approval_status, version)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5)
         RETURNING ${OFFER_COLUMNS}`,
        [uuidOrGenerated(input.id), applicationId, input.status ?? 'draft', input.approvalStatus ?? 'pending', input.version ?? 1])
      return mapOffer(row)
    })
  }

  async updateOffer(id: string, input: OfferUpdateInput): Promise<OfferDbRecord> {
    return this.transaction(async (client) => {
      const assignments: string[] = []
      const values: unknown[] = []
      const add = (column: string, value: unknown, cast = '') => { assignments.push(`${column} = $${values.push(value)}${cast}`) }
      if (input.status !== undefined) add('status', input.status)
      if (input.approvalStatus !== undefined) add('approval_status', input.approvalStatus)
      if (input.currentVersionId !== undefined) add('current_version_id', input.currentVersionId, '::uuid')
      if (input.sentAt !== undefined) add('sent_at', input.sentAt, '::timestamptz')
      if (input.respondedAt !== undefined) add('responded_at', input.respondedAt, '::timestamptz')
      if (input.expiresAt !== undefined) add('expires_at', input.expiresAt, '::timestamptz')
      if (input.version !== undefined) add('version', input.version)
      if (!assignments.length) return this.getOfferWithExecutor(client, required(id, 'offer id'))
      assignments.push('updated_at = now()')
      values.push(required(id, 'offer id'))
      const row = await queryOne<OfferRow>(client, `UPDATE offers SET ${assignments.join(', ')} WHERE id = $${values.length}::uuid RETURNING ${OFFER_COLUMNS}`, values)
      return mapOffer(row)
    })
  }

  async listOfferVersions(offerId?: string): Promise<OfferVersionDbRecord[]> {
    const values: string[] = []
    const where = text(offerId) ? `WHERE v.offer_id = $${values.push(required(offerId, 'offerId'))}::uuid` : ''
    const result = await this.pool.query<OfferVersionRow>(`SELECT ${OFFER_VERSION_COLUMNS} FROM offer_versions v ${where} ORDER BY v.version DESC`, values)
    return result.rows.map(mapOfferVersion)
  }

  async createOfferVersion(input: OfferVersionCreateInput): Promise<OfferVersionDbRecord> {
    return this.transaction(async (client) => {
      const offerId = required(input.offerId, 'offerId')
      const departmentId = await resolveForeignKey(client, 'departments', 'id', 'code', input.departmentId)
      const version = input.version ?? await nextVersionFor(client, 'offer_versions', 'offer_id', offerId)
      const row = await queryOne<OfferVersionRow>(client,
        `INSERT INTO offer_versions (id, offer_id, version, position_title, department_id, employment_type, start_date, compensation, benefits, content)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7::date, $8::jsonb, $9::jsonb, $10)
         RETURNING ${OFFER_VERSION_RETURNING}`,
        [uuidOrGenerated(input.id), offerId, version, required(input.positionTitle, 'positionTitle'), departmentId,
         required(input.employmentType, 'employmentType'), input.startDate ?? null, JSON.stringify(input.compensation ?? {}),
         JSON.stringify(input.benefits ?? []), input.content ?? ''])
      return mapOfferVersion(row)
    })
  }

  // ===== 入职归档 =====
  async listOnboarding(applicationId?: string): Promise<OnboardingDbRecord[]> {
    const values: string[] = []
    const conditions: string[] = []
    if (text(applicationId)) {
      const reference = normalizeReference(text(applicationId), 'APP', 'application')
      if (isUuid(reference)) conditions.push(`r.application_id = $${values.push(reference)}::uuid`)
      else conditions.push(`a.application_no = $${values.push(reference)}`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const result = await this.pool.query<OnboardingRow>(`${ONBOARDING_SELECT} ${where} ORDER BY r.created_at`, values)
    return result.rows.map(mapOnboarding)
  }

  async getOnboarding(id: string): Promise<OnboardingDbRecord> {
    const reference = required(id, 'onboarding id')
    if (!isUuid(reference)) throw new RepositoryValidationError('onboarding lookups require the database uuid')
    const result = await this.pool.query<OnboardingRow>(`${ONBOARDING_SELECT} WHERE r.id = $1::uuid`, [reference])
    const row = result.rows[0]
    if (!row) throw new RepositoryNotFoundError(`Onboarding record not found: ${id}`)
    return mapOnboarding(row)
  }

  async getOnboardingByOfferId(offerId: string): Promise<OnboardingDbRecord | undefined> {
    const reference = required(offerId, 'offer id')
    if (!isUuid(reference)) throw new RepositoryValidationError('onboarding offer lookups require the database uuid')
    const result = await this.pool.query<OnboardingRow>(`${ONBOARDING_SELECT} WHERE r.offer_id = $1::uuid LIMIT 1`, [reference])
    return result.rows[0] ? mapOnboarding(result.rows[0]) : undefined
  }

  async createOnboarding(input: OnboardingCreateInput): Promise<OnboardingDbRecord> {
    return this.transaction(async (client) => {
      const applicationId = await resolveRequiredForeignKey(client, 'applications', 'id', 'application_no', input.applicationId, 'applicationId')
      const offerId = await resolveRequiredForeignKey(client, 'offers', 'id', 'id', input.offerId, 'offerId')
      const row = await queryOne<OnboardingRow>(client,
        `INSERT INTO onboarding_records (id, application_id, offer_id, planned_start_date, status, notes)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6)
         ON CONFLICT (offer_id) DO UPDATE SET offer_id = EXCLUDED.offer_id
         RETURNING ${ONBOARDING_COLUMNS}`,
        [uuidOrGenerated(input.id), applicationId, offerId, input.plannedStartDate ?? null, input.status ?? 'pending', input.notes ?? null])
      return mapOnboarding(row)
    })
  }

  async updateOnboarding(id: string, input: OnboardingUpdateInput): Promise<OnboardingDbRecord> {
    return this.transaction(async (client) => {
      const assignments: string[] = []
      const values: unknown[] = []
      const add = (column: string, value: unknown, cast = '') => { assignments.push(`${column} = $${values.push(value)}${cast}`) }
      if (input.plannedStartDate !== undefined) add('planned_start_date', input.plannedStartDate, '::date')
      if (input.status !== undefined) add('status', input.status)
      if (input.notes !== undefined) add('notes', input.notes)
      if (input.archivedAt !== undefined) add('archived_at', input.archivedAt, '::timestamptz')
      if (!assignments.length) return this.getOnboardingWithExecutor(client, required(id, 'onboarding id'))
      assignments.push('updated_at = now()')
      values.push(required(id, 'onboarding id'))
      const row = await queryOne<OnboardingRow>(client, `UPDATE onboarding_records SET ${assignments.join(', ')} WHERE id = $${values.length}::uuid RETURNING ${ONBOARDING_COLUMNS}`, values)
      return mapOnboarding(row)
    })
  }

  // ===== 流程事件（审计轨迹）=====
  async appendWorkflowEvent(input: WorkflowEventCreateInput): Promise<WorkflowEventDbRecord> {
    return this.transaction(async (client) => {
      const actorId = await resolveActorId(client, input.actorId)
      const row = await queryOne<WorkflowEventRow>(client,
        `INSERT INTO workflow_events (id, subject_type, subject_id, event_type, from_status, to_status, actor_user_id, reason, metadata)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::uuid, $8, $9::jsonb)
         RETURNING ${WORKFLOW_EVENT_COLUMNS}`,
        [uuidOrGenerated(input.id), required(input.subjectType, 'subjectType'), required(input.subjectId, 'subjectId'), required(input.action, 'action'),
         input.fromStatus ?? null, input.toStatus ?? null, actorId, input.reason ?? '', JSON.stringify(input.metadata ?? {})])
      return mapWorkflowEvent(row)
    })
  }

  async listWorkflowEvents(filter: WorkflowEventFilter = {}): Promise<WorkflowEventDbRecord[]> {
    const values: string[] = []
    const conditions: string[] = []
    if (text(filter.subjectType)) conditions.push(`e.subject_type = $${values.push(text(filter.subjectType))}`)
    if (text(filter.subjectId)) conditions.push(`e.subject_id = $${values.push(required(filter.subjectId, 'subjectId'))}::uuid`)
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 500))
    const result = await this.pool.query<WorkflowEventRow>(`SELECT e.id, e.subject_type, e.subject_id, e.event_type, e.from_status, e.to_status, e.actor_user_id, u.display_name AS actor_name, e.reason, e.metadata, e.created_at FROM workflow_events e LEFT JOIN users u ON u.id = e.actor_user_id ${where} ORDER BY e.created_at DESC, e.id LIMIT ${limit}`, values)
    return result.rows.map(mapWorkflowEvent)
  }

  /** 批量解析用户 display_name，用于面试参与人、审计操作人等只读展示。 */
  async resolveUserDisplayNames(userIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds.filter((userId) => isUuid(userId)))]
    if (!unique.length) return new Map()
    const result = await this.pool.query<{ id: string; display_name: string }>('SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])', [unique])
    return new Map(result.rows.map((row) => [row.id, row.display_name]))
  }

  // ===== 内部辅助 =====
  private async resolveUserId(executor: Pick<RepositoryClient, 'query'>, value: string | null | undefined, requiredActor = false): Promise<string | null> {
    return resolveActorId(executor as RepositoryClient, value, { required: requiredActor })
  }

  private async nextInterviewRound(client: RepositoryClient, applicationId: string): Promise<number> {
    const result = await client.query<{ next: number }>('SELECT COALESCE(MAX(round), 0) + 1 AS next FROM interviews WHERE application_id = $1::uuid', [applicationId])
    return Number(result.rows[0]?.next ?? 1)
  }

  private async getInterviewWithExecutor(client: RepositoryClient, id: string): Promise<InterviewDbRecord> {
    const row = await queryOne<InterviewRow>(client, `${INTERVIEW_SELECT} WHERE i.id = $1::uuid`, [id])
    return mapInterview(row)
  }

  private async getOfferWithExecutor(client: RepositoryClient, id: string): Promise<OfferDbRecord> {
    const row = await queryOne<OfferRow>(client, `${OFFER_SELECT} WHERE o.id = $1::uuid`, [id])
    return mapOffer(row)
  }

  private async getOnboardingWithExecutor(client: RepositoryClient, id: string): Promise<OnboardingDbRecord> {
    const row = await queryOne<OnboardingRow>(client, `${ONBOARDING_SELECT} WHERE r.id = $1::uuid`, [id])
    return mapOnboarding(row)
  }

  private async getRecruitmentRequestWithExecutor(executor: RepositoryClient, id: string): Promise<RecruitmentRequestRecord> {
    return mapRecruitmentRequest(await queryOne<RecruitmentRequestRow>(executor, `${REQUEST_SELECT} WHERE rr.id = $1::uuid`, [id]))
  }

  private async getJobWithExecutor(executor: RepositoryClient, id: string): Promise<JobRecord> {
    return mapJob(await queryOne<JobRow>(executor, `${JOB_SELECT} WHERE j.id = $1::uuid`, [id]))
  }

  private async getCandidateWithExecutor(executor: RepositoryClient, id: string): Promise<CandidateRecord> {
    return mapCandidate(await queryOne<CandidateRow>(executor, `${CANDIDATE_SELECT} WHERE c.id = $1::uuid`, [id]))
  }

  private async getApplicationWithExecutor(executor: RepositoryClient, id: string): Promise<ApplicationRecord> {
    return mapApplication(await queryOne<ApplicationRow>(executor, `${APPLICATION_SELECT} WHERE a.id = $1::uuid`, [id]))
  }
}

async function resolveForeignKey(client: RepositoryClient, table: string, idColumn: string, businessColumn: string, value: string | null | undefined): Promise<string | null> {
  if (value === null || value === undefined || !text(value)) return null
  const reference = text(value)
  const normalizedBusinessId = normalizeTableBusinessId(table, reference)
  const result = isUuid(reference)
    ? await client.query<{ id: string }>(`SELECT ${idColumn} AS id FROM ${table} WHERE ${idColumn} = $1::uuid`, [reference])
    : await client.query<{ id: string }>(`SELECT ${idColumn} AS id FROM ${table} WHERE ${businessColumn} = $1 OR ${businessColumn} = $2`, [reference, normalizedBusinessId])
  const row = result.rows[0]
  if (!row) throw new RepositoryNotFoundError(`Referenced ${table} row not found: ${value}`)
  return row.id
}

function normalizeTableBusinessId(table: string, value: string): string {
  if (table === 'recruitment_requests') return normalizeReference(value, 'REQ', 'rr')
  if (table === 'jobs') return normalizeReference(value, 'JOB', 'job')
  if (table === 'candidates') return normalizeReference(value, 'CAN', 'candidate')
  if (table === 'applications') return normalizeReference(value, 'APP', 'application')
  return value
}

async function resolveRequiredForeignKey(client: RepositoryClient, table: string, idColumn: string, businessColumn: string, value: string, field: string): Promise<string> {
  const result = await resolveForeignKey(client, table, idColumn, businessColumn, value)
  if (!result) throw new RepositoryValidationError(`${field} is required`)
  return result
}

async function resolveEntityId(client: Pick<RepositoryPool, 'query'> | Pick<RepositoryClient, 'query'>, table: string, businessColumn: string, prefix: string, legacyPrefix: string, value: string): Promise<string> {
  const reference = normalizeReference(required(value, 'id'), prefix, legacyPrefix)
  const result = isUuid(reference)
    ? await client.query<{ id: string }>(`SELECT id FROM ${table} WHERE id = $1::uuid`, [reference])
    : await client.query<{ id: string }>(`SELECT id FROM ${table} WHERE ${businessColumn} = $1`, [reference])
  const row = result.rows[0]
  if (!row) throw new RepositoryNotFoundError(`${table} row not found: ${value}`)
  return row.id
}

async function nextVersionFor(client: RepositoryClient, table: string, column: string, owner: string): Promise<number> {
  const result = await client.query<{ next: number }>(`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM ${table} WHERE ${column} = $1::uuid`, [owner])
  return Number(result.rows[0]?.next ?? 1)
}

async function resolveReferenceLine(executor: Pick<RepositoryPool, 'query'> | Pick<RepositoryClient, 'query'>, table: string, businessColumn: string, prefix: string, legacyPrefix: string, value: string): Promise<string> {
  return resolveEntityId(executor, table, businessColumn, prefix, legacyPrefix, required(value, 'id'))
}

/**
 * 解析操作者/面试官引用：uuid → 直接校验存在；邮箱 → 按邮箱查；
 * 其余（历史 seed 里的 user-recruiter 之类）返回 null，由调用方决定是否必须（NOT NULL 列传 required）。
 */
async function resolveActorId(executor: Pick<RepositoryClient, 'query'>, value: string | null | undefined, options: { required?: boolean; allowDisplayName?: boolean } = {}): Promise<string | null> {
  const reference = text(value)
  if (!reference) {
    if (options.required) throw new RepositoryValidationError('actor is required but was empty')
    return null
  }
  const lookup = isUuid(reference)
    ? await executor.query<{ id: string }>('SELECT id FROM users WHERE id = $1::uuid', [reference])
    : reference.includes('@')
      ? await executor.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1)', [reference])
      : options.allowDisplayName
        ? await executor.query<{ id: string }>('SELECT id FROM users WHERE lower(display_name) = lower($1) AND is_active = true ORDER BY id', [reference])
        : { rows: [] as Array<{ id: string }> }
  if (lookup.rows.length > 1) throw new RepositoryValidationError(`面试官姓名不唯一，请填写邮箱或用户 ID：${reference}`)
  const row = lookup.rows[0]
  if (row) return row.id
  if (options.required) {
    throw new RepositoryValidationError(options.allowDisplayName
      ? `未找到有效面试官：${reference}，请填写系统用户姓名、邮箱或用户 ID`
      : `actor must reference an existing user: ${reference}`)
  }
  return null
}

function dateText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const raw = String(value)
  return raw.length >= 10 ? raw.slice(0, 10) : raw
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function jsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

interface RecruitmentRequestRow extends QueryResultRow {
  id: string; request_no: string; title: string; department_id: string | null; department_name: string | null; department_code: string | null; requested_by: string | null; requester_name?: string | null; requester_email?: string | null; hiring_manager_id: string | null; headcount: number; budget_min: string | number | null; budget_max: string | number | null; employment_type: string | null; work_mode: string | null; location: string | null; reason: string; status: string; version: number; created_at: string | Date; updated_at: string | Date
}
interface JobRow extends QueryResultRow {
  id: string; job_no: string; recruitment_request_id: string | null; recruitment_request_no: string | null; department_id: string; department_name: string | null; department_code: string | null; title: string; status: string; headcount: number; employment_type: string | null; work_mode: string | null; location: string | null; created_by: string | null; created_at: string | Date; updated_at: string | Date
}
interface CandidateRow extends QueryResultRow {
  id: string; candidate_no: string; name: string; email: string | null; phone: string | null; location: string | null; source: string | null; consent_status: string; created_at: string | Date; updated_at: string | Date
}
interface ApplicationRow extends QueryResultRow {
  id: string; application_no: string; candidate_id: string; candidate_no: string | null; job_id: string; job_no: string | null; status: string; recruiter_id: string | null; source: string | null; applied_at: string | Date; rejected_reason: string | null; withdrawn_at: string | Date | null; created_at: string | Date; updated_at: string | Date
}
interface AnalysisTaskRow extends QueryResultRow { id: string; resume_id: string; application_id: string | null; status: string; attempts: number; idempotency_key: string; last_error: string | null; available_at: string | Date; started_at: string | Date | null; completed_at: string | Date | null; created_at: string | Date }
interface AnalysisResultRow extends QueryResultRow { id: string; analysis_task_id: string; resume_id: string; application_id: string | null; result: Record<string, unknown>; analyzer_version: string | null; input_hash: string | null; human_review_status: string; created_at: string | Date }
interface ApprovalInstanceRow extends QueryResultRow { id: string; subject_type: string; subject_id: string; version: number; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; created_at: string | Date; updated_at: string | Date }
interface ApprovalStepRow extends QueryResultRow { id: string; approval_instance_id: string; step_no: number; approver_role_code: string | null; status: 'pending' | 'approved' | 'rejected'; acted_at: string | Date | null }
interface ApprovalRecordRow extends QueryResultRow { id: string; approval_instance_id: string; approval_step_id: string | null; actor_user_id: string | null; decision: 'approved' | 'rejected'; comment: string; created_at: string | Date }

interface JobSpecVersionRow extends QueryResultRow { id: string; job_id: string; version: number; content: Record<string, unknown> | null; created_by: string | null; created_at: string | Date; confirmed_at: string | Date | null }
interface JobDescriptionVersionRow extends QueryResultRow { id: string; job_id: string; version: number; title: string; content: string; status: string; created_by: string | null; created_at: string | Date; confirmed_at: string | Date | null }
interface InterviewRow extends QueryResultRow { id: string; interview_no: string; application_id: string; round: number; type: string; title: string; status: string; scheduled_start_at: string | Date | null; scheduled_end_at: string | Date | null; timezone: string | null; location: string | null; meeting_url: string | null; participants: unknown; created_at: string | Date; updated_at: string | Date }
interface InterviewFeedbackRow extends QueryResultRow { id: string; interview_id: string; interviewer_id: string; status: string; overall_score: string | number | null; recommendation: string | null; ratings: unknown; strengths: unknown; concerns: unknown; notes: string | null; submitted_at: string | Date | null; locked_at: string | Date | null }
interface OfferRow extends QueryResultRow { id: string; application_id: string; status: string; current_version_id: string | null; approval_status: string; sent_at: string | Date | null; responded_at: string | Date | null; expires_at: string | Date | null; version: number; created_at: string | Date; updated_at: string | Date }
interface OfferVersionRow extends QueryResultRow { id: string; offer_id: string; version: number; position_title: string; department_id: string; employment_type: string; start_date: string | Date | null; compensation: unknown; benefits: unknown; content: string; created_at: string | Date }
interface OnboardingRow extends QueryResultRow { id: string; application_id: string; offer_id: string; planned_start_date: string | Date | null; status: string; notes: string | null; archived_at: string | Date | null; created_at: string | Date; updated_at: string | Date }
interface WorkflowEventRow extends QueryResultRow { id: string; subject_type: string; subject_id: string; event_type: string; from_status: string | null; to_status: string | null; actor_user_id: string | null; actor_name?: string | null; reason: string | null; metadata: unknown; created_at: string | Date }

const REQUEST_COLUMNS = 'id, request_no, title, department_id, NULL::text AS department_name, requested_by, hiring_manager_id, headcount, budget_min, budget_max, employment_type, work_mode, location, reason, status, version, created_at, updated_at'
const JOB_COLUMNS = 'id, job_no, recruitment_request_id, NULL::text AS recruitment_request_no, department_id, NULL::text AS department_name, title, status, headcount, employment_type, work_mode, location, created_by, created_at, updated_at'
const CANDIDATE_COLUMNS = 'id, candidate_no, name, email, phone, location, source, consent_status, created_at, updated_at'
const APPLICATION_COLUMNS = 'id, application_no, candidate_id, NULL::text AS candidate_no, job_id, NULL::text AS job_no, status, recruiter_id, source, applied_at, rejected_reason, withdrawn_at, created_at, updated_at'
const ANALYSIS_TASK_COLUMNS = 'SELECT id, resume_id, application_id, status, attempts, idempotency_key, last_error, available_at, started_at, completed_at, created_at'
const ANALYSIS_TASK_RETURNING = 'id, resume_id, application_id, status, attempts, idempotency_key, last_error, available_at, started_at, completed_at, created_at'
const ANALYSIS_RESULT_COLUMNS = 'SELECT id, analysis_task_id, resume_id, application_id, result, analyzer_version, input_hash, human_review_status, created_at'
const ANALYSIS_RESULT_RETURNING = 'id, analysis_task_id, resume_id, application_id, result, analyzer_version, input_hash, human_review_status, created_at'

const JOB_SPEC_VERSION_COLUMNS = 'id, job_id, version, content, created_by, created_at, confirmed_at'
const JD_VERSION_COLUMNS = 'id, job_id, version, title, content, status, created_by, created_at, confirmed_at'
const INTERVIEW_COLUMNS = 'id, interview_no, application_id, round, type, title, status, scheduled_start_at, scheduled_end_at, timezone, location, meeting_url, participants, created_at, updated_at'
const FEEDBACK_COLUMNS = 'f.id, f.interview_id, f.interviewer_id, f.status, f.overall_score, f.recommendation, f.ratings, f.strengths, f.concerns, f.notes, f.submitted_at, f.locked_at'
const OFFER_COLUMNS = 'id, application_id, status, current_version_id, approval_status, sent_at, responded_at, expires_at, version, created_at, updated_at'
const OFFER_VERSION_COLUMNS = 'v.id, v.offer_id, v.version, v.position_title, v.department_id, v.employment_type, v.start_date, v.compensation, v.benefits, v.content, v.created_at'
const ONBOARDING_COLUMNS = 'id, application_id, offer_id, planned_start_date, status, notes, archived_at, created_at, updated_at'
const WORKFLOW_EVENT_COLUMNS = 'id, subject_type, subject_id, event_type, from_status, to_status, actor_user_id, reason, metadata, created_at'
// RETURNING 子句里没有 FROM 别名，必须使用不带前缀的列清单。
const FEEDBACK_RETURNING = 'id, interview_id, interviewer_id, status, overall_score, recommendation, ratings, strengths, concerns, notes, submitted_at, locked_at'
const OFFER_VERSION_RETURNING = 'id, offer_id, version, position_title, department_id, employment_type, start_date, compensation, benefits, content, created_at'

const REQUEST_SELECT = `SELECT rr.id, rr.request_no, rr.title, rr.department_id, d.name AS department_name, d.code AS department_code, rr.requested_by, u.display_name AS requester_name, u.email AS requester_email, rr.hiring_manager_id, rr.headcount, rr.budget_min, rr.budget_max, rr.employment_type, rr.work_mode, rr.location, rr.reason, rr.status, rr.version, rr.created_at, rr.updated_at
  FROM recruitment_requests rr
  LEFT JOIN departments d ON d.id = rr.department_id
  LEFT JOIN users u ON u.id = rr.requested_by`
const JOB_SELECT = `SELECT j.id, j.job_no, j.recruitment_request_id, rr.request_no AS recruitment_request_no, j.department_id, d.name AS department_name, d.code AS department_code, j.title, j.status, j.headcount, j.employment_type, j.work_mode, j.location, j.created_by, j.created_at, j.updated_at
  FROM jobs j
  LEFT JOIN recruitment_requests rr ON rr.id = j.recruitment_request_id
  LEFT JOIN departments d ON d.id = j.department_id`
const CANDIDATE_SELECT = `SELECT c.id, c.candidate_no, c.name, c.email, c.phone, c.location, c.source, c.consent_status, c.created_at, c.updated_at
  FROM candidates c`
const APPLICATION_SELECT = `SELECT a.id, a.application_no, a.candidate_id, c.candidate_no, a.job_id, j.job_no, a.status, a.recruiter_id, a.source, a.applied_at, a.rejected_reason, a.withdrawn_at, a.created_at, a.updated_at
  FROM applications a
  LEFT JOIN candidates c ON c.id = a.candidate_id
  LEFT JOIN jobs j ON j.id = a.job_id`

const INTERVIEW_SELECT = `SELECT i.id, i.interview_no, i.application_id, i.round, i.type, i.title, i.status, i.scheduled_start_at, i.scheduled_end_at, i.timezone, i.location, i.meeting_url, i.participants, i.created_at, i.updated_at
  FROM interviews i
  LEFT JOIN applications a ON a.id = i.application_id`
const OFFER_SELECT = `SELECT o.id, o.application_id, o.status, o.current_version_id, o.approval_status, o.sent_at, o.responded_at, o.expires_at, o.version, o.created_at, o.updated_at
  FROM offers o`
const ONBOARDING_SELECT = `SELECT r.id, r.application_id, r.offer_id, r.planned_start_date, r.status, r.notes, r.archived_at, r.created_at, r.updated_at
  FROM onboarding_records r
  LEFT JOIN applications a ON a.id = r.application_id`

function mapRecruitmentRequest(row: RecruitmentRequestRow): RecruitmentRequestRecord {
  return { id: row.id, businessId: row.request_no, legacyId: legacyId('REQ', row.request_no), code: row.request_no, title: row.title, departmentId: row.department_code ?? row.department_id ?? '', departmentName: row.department_name, requestedById: row.requested_by, requesterName: row.requester_name ?? null, requesterEmail: row.requester_email ?? null, hiringManagerId: row.hiring_manager_id, headcount: row.headcount, budgetMin: numberValue(row.budget_min), budgetMax: numberValue(row.budget_max), employmentType: row.employment_type, workMode: row.work_mode, location: row.location, reason: row.reason, status: row.status, version: row.version, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}

function mapJob(row: JobRow): JobRecord {
  return { id: row.id, businessId: row.job_no, legacyId: legacyId('JOB', row.job_no), code: row.job_no, recruitmentRequestId: row.recruitment_request_id, recruitmentRequestBusinessId: row.recruitment_request_no, departmentId: row.department_code ?? row.department_id, departmentName: row.department_name, title: row.title, status: row.status, headcount: row.headcount, employmentType: row.employment_type, workMode: row.work_mode, location: row.location, createdById: row.created_by, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}

function mapCandidate(row: CandidateRow): CandidateRecord {
  return { id: row.id, businessId: row.candidate_no, legacyId: legacyId('CAN', row.candidate_no), code: row.candidate_no, name: row.name, email: row.email, phone: row.phone, location: row.location, source: row.source, consentStatus: row.consent_status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}

function mapApplication(row: ApplicationRow): ApplicationRecord {
  return { id: row.id, businessId: row.application_no, legacyId: legacyId('APP', row.application_no), code: row.application_no, candidateId: row.candidate_id, candidateBusinessId: row.candidate_no, jobId: row.job_id, jobBusinessId: row.job_no, status: row.status, recruiterId: row.recruiter_id, source: row.source, appliedAt: iso(row.applied_at), rejectedReason: row.rejected_reason, withdrawnAt: row.withdrawn_at ? iso(row.withdrawn_at) : null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}

function mapAnalysisTask(row: AnalysisTaskRow): AnalysisTaskRecord {
  return { id: row.id, resumeId: row.resume_id, applicationId: row.application_id, status: row.status, attempts: Number(row.attempts), idempotencyKey: row.idempotency_key, lastError: row.last_error, availableAt: iso(row.available_at), startedAt: row.started_at ? iso(row.started_at) : null, completedAt: row.completed_at ? iso(row.completed_at) : null, createdAt: iso(row.created_at) }
}

function mapAnalysisResult(row: AnalysisResultRow): AnalysisResultRecord {
  return { id: row.id, analysisTaskId: row.analysis_task_id, resumeId: row.resume_id, applicationId: row.application_id, result: row.result ?? {}, analyzerVersion: row.analyzer_version, inputHash: row.input_hash, humanReviewStatus: row.human_review_status, createdAt: iso(row.created_at) }
}

function mapJobSpecVersion(row: JobSpecVersionRow): JobSpecVersionDbRecord {
  return { id: row.id, jobId: row.job_id, version: Number(row.version), content: jsonObject(row.content), createdById: row.created_by, createdAt: iso(row.created_at), confirmedAt: row.confirmed_at ? iso(row.confirmed_at) : null }
}

function mapJobDescriptionVersion(row: JobDescriptionVersionRow): JobDescriptionVersionDbRecord {
  return { id: row.id, jobId: row.job_id, version: Number(row.version), title: row.title, content: row.content, status: row.status, createdById: row.created_by, createdAt: iso(row.created_at), confirmedAt: row.confirmed_at ? iso(row.confirmed_at) : null }
}

function mapInterview(row: InterviewRow): InterviewDbRecord {
  return { id: row.id, businessId: row.interview_no, applicationId: row.application_id, round: Number(row.round), type: row.type, title: row.title, status: row.status, scheduledStartAt: row.scheduled_start_at ? iso(row.scheduled_start_at) : null, scheduledEndAt: row.scheduled_end_at ? iso(row.scheduled_end_at) : null, timezone: row.timezone, location: row.location, meetingUrl: row.meeting_url, participants: jsonArray<InterviewParticipantDbRecord>(row.participants), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}

function mapInterviewFeedback(row: InterviewFeedbackRow): InterviewFeedbackDbRecord {
  return { id: row.id, interviewId: row.interview_id, interviewerId: row.interviewer_id, status: row.status, overallScore: numberValue(row.overall_score), recommendation: row.recommendation, ratings: jsonObject(row.ratings) as Record<string, number>, strengths: jsonArray<string>(row.strengths), concerns: jsonArray<string>(row.concerns), notes: row.notes, submittedAt: row.submitted_at ? iso(row.submitted_at) : null, lockedAt: row.locked_at ? iso(row.locked_at) : null }
}

function mapOffer(row: OfferRow): OfferDbRecord {
  return { id: row.id, businessId: `OFF-${row.id.replaceAll('-', '').slice(0, 10).toUpperCase()}`, applicationId: row.application_id, status: row.status, currentVersionId: row.current_version_id, approvalStatus: row.approval_status, sentAt: row.sent_at ? iso(row.sent_at) : null, respondedAt: row.responded_at ? iso(row.responded_at) : null, expiresAt: row.expires_at ? iso(row.expires_at) : null, version: Number(row.version), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}

function mapOfferVersion(row: OfferVersionRow): OfferVersionDbRecord {
  return { id: row.id, offerId: row.offer_id, version: Number(row.version), positionTitle: row.position_title, departmentId: row.department_id, employmentType: row.employment_type, startDate: dateText(row.start_date), compensation: jsonObject(row.compensation), benefits: jsonArray<string>(row.benefits), content: row.content, createdAt: iso(row.created_at) }
}

function mapOnboarding(row: OnboardingRow): OnboardingDbRecord {
  return { id: row.id, applicationId: row.application_id, offerId: row.offer_id, plannedStartDate: dateText(row.planned_start_date), status: row.status, notes: row.notes, archivedAt: row.archived_at ? iso(row.archived_at) : null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}

function mapWorkflowEvent(row: WorkflowEventRow): WorkflowEventDbRecord {
  return { id: row.id, subjectType: row.subject_type, subjectId: row.subject_id, action: row.event_type, fromStatus: row.from_status, toStatus: row.to_status, actorId: row.actor_user_id, actorName: row.actor_name ?? null, reason: row.reason, metadata: jsonObject(row.metadata), createdAt: iso(row.created_at) }
}

function mapApprovalInstance(row: ApprovalInstanceRow): RecruitmentApprovalInstanceRecord {
  return { id: row.id, entityType: 'recruitment_request', entityId: row.subject_id, version: row.version, status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}

function mapApprovalStep(row: ApprovalStepRow): RecruitmentApprovalStepRecord {
  return { id: row.id, instanceId: row.approval_instance_id, order: row.step_no, name: '招聘需求审批', approverRole: row.approver_role_code ?? 'approver', status: row.status, ...(row.acted_at ? { actedAt: iso(row.acted_at) } : {}) }
}

function mapApprovalRecord(row: ApprovalRecordRow): RecruitmentApprovalAuditRecord {
  return { id: row.id, instanceId: row.approval_instance_id, stepId: row.approval_step_id ?? '', actorId: row.actor_user_id ?? '', action: row.decision === 'approved' ? 'approve' : 'reject', ...(row.comment ? { comment: row.comment } : {}), createdAt: iso(row.created_at) }
}

export function createNormalizedRecruitingRepository(config: PoolConfig = poolConfigFromEnv(), options?: RepositoryOptions): NormalizedRecruitingRepository {
  return new NormalizedRecruitingRepository(config, options)
}

function isRepositoryPool(value: RepositoryPool | PoolConfig): value is RepositoryPool {
  return typeof (value as RepositoryPool).query === 'function' && typeof (value as RepositoryPool).connect === 'function'
}

export { Pool }
