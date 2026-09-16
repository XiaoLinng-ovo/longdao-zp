import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg'
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
      const row = await queryOne<RecruitmentRequestRow>(client,
        `INSERT INTO recruitment_requests
          (id, request_no, title, department_id, requested_by, headcount, budget_min, budget_max, reason, status, version)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11)
         RETURNING ${REQUEST_COLUMNS}`,
        [id, requestNo, required(input.title, 'title'), departmentId, requestedById, input.headcount, input.budgetMin ?? null, input.budgetMax ?? null, input.reason ?? '', input.status ?? 'draft', input.version ?? 1],
      )
      return mapRecruitmentRequest(row)
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
      if (input.reason !== undefined) add('reason', input.reason)
      if (input.status !== undefined) add('status', input.status)
      if (input.version !== undefined) add('version', input.version)
      if (!assignments.length) return this.getRecruitmentRequestWithExecutor(client, id)
      values.push(id)
      const row = await queryOne<RecruitmentRequestRow>(client, `UPDATE recruitment_requests SET ${assignments.join(', ')} WHERE id = $${values.length}::uuid RETURNING ${REQUEST_COLUMNS}`, values)
      return mapRecruitmentRequest(row)
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
          (id, job_no, recruitment_request_id, department_id, title, status, headcount, created_by)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, $8::uuid)
         RETURNING ${JOB_COLUMNS}`,
        [id, jobNo, requestId, departmentId, required(input.title, 'title'), input.status ?? 'draft', input.headcount, createdById],
      )
      return mapJob(row)
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
      if (input.createdById !== undefined) add('created_by', await resolveForeignKey(client, 'users', 'id', 'email', input.createdById), '::uuid')
      if (!assignments.length) return this.getJobWithExecutor(client, id)
      values.push(id)
      const row = await queryOne<JobRow>(client, `UPDATE jobs SET ${assignments.join(', ')} WHERE id = $${values.length}::uuid RETURNING ${JOB_COLUMNS}`, values)
      return mapJob(row)
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
        [id, applicationNo, candidateId, jobId, input.status ?? 'new', recruiterId, input.source ?? null, input.appliedAt ?? null],
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
      const row = await queryOne<any>(client, `INSERT INTO resumes (id, candidate_id, application_id, storage_key, original_filename, mime_type, size_bytes, scan_status, content_hash) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9) RETURNING id, candidate_id, application_id, storage_key, original_filename, mime_type, size_bytes, scan_status, content_hash, created_at`, [uuidOrGenerated(input.id), input.candidateId, input.applicationId ?? null, input.storageKey, input.originalFilename, input.mimeType, input.sizeBytes, input.scanStatus ?? 'quarantined', input.contentHash])
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

interface RecruitmentRequestRow extends QueryResultRow {
  id: string; request_no: string; title: string; department_id: string | null; department_name: string | null; requested_by: string | null; headcount: number; budget_min: string | number | null; budget_max: string | number | null; reason: string; status: string; version: number; created_at: string | Date; updated_at: string | Date
}
interface JobRow extends QueryResultRow {
  id: string; job_no: string; recruitment_request_id: string | null; recruitment_request_no: string | null; department_id: string; department_name: string | null; title: string; status: string; headcount: number; created_by: string | null; created_at: string | Date; updated_at: string | Date
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

const REQUEST_COLUMNS = 'id, request_no, title, department_id, NULL::text AS department_name, requested_by, headcount, budget_min, budget_max, reason, status, version, created_at, updated_at'
const JOB_COLUMNS = 'id, job_no, recruitment_request_id, NULL::text AS recruitment_request_no, department_id, NULL::text AS department_name, title, status, headcount, created_by, created_at, updated_at'
const CANDIDATE_COLUMNS = 'id, candidate_no, name, email, phone, location, source, consent_status, created_at, updated_at'
const APPLICATION_COLUMNS = 'id, application_no, candidate_id, NULL::text AS candidate_no, job_id, NULL::text AS job_no, status, recruiter_id, source, applied_at, rejected_reason, withdrawn_at, created_at, updated_at'
const ANALYSIS_TASK_COLUMNS = 'SELECT id, resume_id, application_id, status, attempts, idempotency_key, last_error, available_at, started_at, completed_at, created_at'
const ANALYSIS_TASK_RETURNING = 'id, resume_id, application_id, status, attempts, idempotency_key, last_error, available_at, started_at, completed_at, created_at'
const ANALYSIS_RESULT_COLUMNS = 'SELECT id, analysis_task_id, resume_id, application_id, result, analyzer_version, input_hash, human_review_status, created_at'
const ANALYSIS_RESULT_RETURNING = 'id, analysis_task_id, resume_id, application_id, result, analyzer_version, input_hash, human_review_status, created_at'

const REQUEST_SELECT = `SELECT rr.id, rr.request_no, rr.title, rr.department_id, d.name AS department_name, rr.requested_by, rr.headcount, rr.budget_min, rr.budget_max, rr.reason, rr.status, rr.version, rr.created_at, rr.updated_at
  FROM recruitment_requests rr
  LEFT JOIN departments d ON d.id = rr.department_id`
const JOB_SELECT = `SELECT j.id, j.job_no, j.recruitment_request_id, rr.request_no AS recruitment_request_no, j.department_id, d.name AS department_name, j.title, j.status, j.headcount, j.created_by, j.created_at, j.updated_at
  FROM jobs j
  LEFT JOIN recruitment_requests rr ON rr.id = j.recruitment_request_id
  LEFT JOIN departments d ON d.id = j.department_id`
const CANDIDATE_SELECT = `SELECT c.${CANDIDATE_COLUMNS.replaceAll(', ', ', c.')}
  FROM candidates c`
const APPLICATION_SELECT = `SELECT a.${APPLICATION_COLUMNS.replaceAll(', ', ', a.')}
  FROM applications a
  LEFT JOIN candidates c ON c.id = a.candidate_id
  LEFT JOIN jobs j ON j.id = a.job_id`

function mapRecruitmentRequest(row: RecruitmentRequestRow): RecruitmentRequestRecord {
  return { id: row.id, businessId: row.request_no, legacyId: legacyId('REQ', row.request_no), code: row.request_no, title: row.title, departmentId: row.department_id, departmentName: row.department_name, requestedById: row.requested_by, headcount: row.headcount, budgetMin: numberValue(row.budget_min), budgetMax: numberValue(row.budget_max), reason: row.reason, status: row.status, version: row.version, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}

function mapJob(row: JobRow): JobRecord {
  return { id: row.id, businessId: row.job_no, legacyId: legacyId('JOB', row.job_no), code: row.job_no, recruitmentRequestId: row.recruitment_request_id, recruitmentRequestBusinessId: row.recruitment_request_no, departmentId: row.department_id, departmentName: row.department_name, title: row.title, status: row.status, headcount: row.headcount, createdById: row.created_by, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
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
