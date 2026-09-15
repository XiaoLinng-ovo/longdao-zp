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

async function resolveEntityId(client: RepositoryClient, table: string, businessColumn: string, prefix: string, legacyPrefix: string, value: string): Promise<string> {
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

const REQUEST_COLUMNS = 'id, request_no, title, department_id, NULL::text AS department_name, requested_by, headcount, budget_min, budget_max, reason, status, version, created_at, updated_at'
const JOB_COLUMNS = 'id, job_no, recruitment_request_id, NULL::text AS recruitment_request_no, department_id, NULL::text AS department_name, title, status, headcount, created_by, created_at, updated_at'
const CANDIDATE_COLUMNS = 'id, candidate_no, name, email, phone, location, source, consent_status, created_at, updated_at'
const APPLICATION_COLUMNS = 'id, application_no, candidate_id, NULL::text AS candidate_no, job_id, NULL::text AS job_no, status, recruiter_id, source, applied_at, rejected_reason, withdrawn_at, created_at, updated_at'

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

export function createNormalizedRecruitingRepository(config: PoolConfig = poolConfigFromEnv(), options?: RepositoryOptions): NormalizedRecruitingRepository {
  return new NormalizedRecruitingRepository(config, options)
}

function isRepositoryPool(value: RepositoryPool | PoolConfig): value is RepositoryPool {
  return typeof (value as RepositoryPool).query === 'function' && typeof (value as RepositoryPool).connect === 'function'
}

export { Pool }
