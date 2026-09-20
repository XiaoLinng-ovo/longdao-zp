import { randomUUID } from 'node:crypto'
import type { IdempotencyRecord, IdempotencyStore } from '../runner.js'

export type AnalysisTaskStatus = 'queued' | 'processing' | 'completed' | 'failed'
export type HumanReviewStatus = 'pending' | 'accepted' | 'needs_correction' | 'not_required'
export type ResumeScanStatus = 'quarantined' | 'scanning' | 'clean' | 'infected' | 'failed'

export interface PgQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[]
}

/** The small pg surface keeps the store easy to contract-test without a live database. */
export interface PgClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PgQueryResult<Row>>
  release(): void
}

export interface PgPool {
  connect(): Promise<PgClient>
}

export interface AnalysisTaskRecord {
  id: string
  resumeId: string
  applicationId?: string
  status: AnalysisTaskStatus
  attempts: number
  idempotencyKey: string
  lastError?: string
  availableAt: string
  startedAt?: string
  completedAt?: string
  createdAt: string
}

export interface AnalysisResultRecord {
  id: string
  analysisTaskId: string
  resumeId: string
  applicationId?: string
  result: unknown
  analyzerVersion?: string
  inputHash?: string
  humanReviewStatus: HumanReviewStatus
  createdAt: string
}

export interface AnalysisTaskLease {
  task: AnalysisTaskRecord
  /** The attempt number atomically consumed by this lease. */
  attempt: number
  maxAttempts: number
  leaseExpiresAt: string
}

export interface ClaimNextTaskInput {
  maxAttempts: number
  leaseDurationMs: number
  now?: Date | string
}

export interface CompleteTaskInput {
  taskId: string
  attempt: number
  result: unknown
  analyzerVersion?: string
  inputHash?: string
  humanReviewStatus?: HumanReviewStatus
  resultId?: string
  completedAt?: Date | string
}

export interface FailTaskInput {
  taskId: string
  attempt: number
  maxAttempts: number
  error: string
  retryAt?: Date | string
}

export interface ResumeAnalysisSource {
  resumeId: string
  candidateId: string
  storageKey: string
  originalFilename: string
  mimeType: string
  contentHash?: string
}

interface ResumeSourceRow extends Record<string, unknown> {
  id: string
  candidate_id: string
  storage_key: string
  original_filename: string
  mime_type: string
  content_hash: string | null
}

interface JobApplicationRow extends Record<string, unknown> {
  job_id: string | null
}
interface ResumeScanRow extends Record<string, unknown> {
  id: string
  scan_status: ResumeScanStatus
}
interface ResumeScanClaimRow extends Record<string, unknown> {
  id: string
  storage_key: string
}
export class AnalysisTaskNotFoundError extends Error {
  readonly code = 'ANALYSIS_TASK_NOT_FOUND'

  constructor(taskId: string) {
    super(`Analysis task ${taskId} was not found`)
    this.name = 'AnalysisTaskNotFoundError'
  }
}

export class AnalysisTaskLeaseLostError extends Error {
  readonly code = 'ANALYSIS_TASK_LEASE_LOST'

  constructor(taskId: string, attempt: number) {
    super(`Analysis task ${taskId} lease for attempt ${attempt} is no longer current`)
    this.name = 'AnalysisTaskLeaseLostError'
  }
}

interface TaskRow extends Record<string, unknown> {
  id: string
  resume_id: string
  application_id: string | null
  status: AnalysisTaskStatus
  attempts: number
  idempotency_key: string
  last_error: string | null
  available_at: string | Date
  started_at: string | Date | null
  completed_at: string | Date | null
  created_at: string | Date
}

interface ResultRow extends Record<string, unknown> {
  id: string
  analysis_task_id: string
  resume_id: string
  application_id: string | null
  result: unknown
  analyzer_version: string | null
  input_hash: string | null
  human_review_status: HumanReviewStatus
  created_at: string | Date
  idempotency_key?: string
}

const TASK_COLUMNS = `
  at.id,
  at.resume_id,
  at.application_id,
  at.status,
  at.attempts,
  at.idempotency_key,
  at.last_error,
  at.available_at,
  at.started_at,
  at.completed_at,
  at.created_at
`

const TASK_COLUMNS_UNQUALIFIED = TASK_COLUMNS.replaceAll('at.', '')

const RESULT_COLUMNS = `
  ar.id,
  ar.analysis_task_id,
  ar.resume_id,
  ar.application_id,
  ar.result,
  ar.analyzer_version,
  ar.input_hash,
  ar.human_review_status,
  ar.created_at
`

function timestamp(value: Date | string | undefined, fallback: Date = new Date()): string {
  const date = value === undefined ? fallback : value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('timestamp must be a valid date')
  return date.toISOString()
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value)
}

function rowTimestamp(value: unknown, field: string): string {
  if (value instanceof Date) return timestamp(value)
  if (typeof value === 'string') return timestamp(value)
  throw new TypeError(`${field} must be a PostgreSQL timestamp`)
}

function mapTask(row: TaskRow): AnalysisTaskRecord {
  return {
    id: row.id,
    resumeId: row.resume_id,
    ...(optionalString(row.application_id) === undefined ? {} : { applicationId: String(row.application_id) }),
    status: row.status,
    attempts: Number(row.attempts),
    idempotencyKey: row.idempotency_key,
    ...(optionalString(row.last_error) === undefined ? {} : { lastError: String(row.last_error) }),
    availableAt: rowTimestamp(row.available_at, 'available_at'),
    ...(row.started_at === null ? {} : { startedAt: rowTimestamp(row.started_at, 'started_at') }),
    ...(row.completed_at === null ? {} : { completedAt: rowTimestamp(row.completed_at, 'completed_at') }),
    createdAt: rowTimestamp(row.created_at, 'created_at'),
  }
}

function mapResult(row: ResultRow): AnalysisResultRecord {
  return {
    id: row.id,
    analysisTaskId: row.analysis_task_id,
    resumeId: row.resume_id,
    ...(optionalString(row.application_id) === undefined ? {} : { applicationId: String(row.application_id) }),
    result: row.result,
    ...(row.analyzer_version === null ? {} : { analyzerVersion: row.analyzer_version }),
    ...(row.input_hash === null ? {} : { inputHash: row.input_hash }),
    humanReviewStatus: row.human_review_status,
    createdAt: rowTimestamp(row.created_at, 'created_at'),
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${field} must be an integer >= 1`)
}

async function inTransaction<T>(pool: PgPool, operation: (client: PgClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const value = await operation(client)
    await client.query('COMMIT')
    return value
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/**
 * PostgreSQL boundary for analysis_tasks and analysis_results.
 * `available_at` doubles as the lease deadline because the existing schema has
 * no worker-owned lease column. Attempt fencing prevents an expired worker
 * from completing a task after another worker has reclaimed it.
 */
export class PostgresAnalysisTaskStore {
  constructor(readonly pool: PgPool) {}

  async claimNextResumeForScan(): Promise<{ resumeId: string; storageKey: string } | undefined> {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<ResumeScanClaimRow>(
        `WITH candidate AS (
           SELECT id
           FROM resumes
           WHERE scan_status = 'quarantined'
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE resumes AS r
         SET scan_status = 'scanning'
         FROM candidate
         WHERE r.id = candidate.id
         RETURNING r.id, r.storage_key`,
      )
      const row = result.rows[0]
      return row ? { resumeId: row.id, storageKey: row.storage_key } : undefined
    })
  }

  async claimNextTask(input: ClaimNextTaskInput): Promise<AnalysisTaskLease | undefined> {
    assertPositiveInteger(input.maxAttempts, 'maxAttempts')
    assertPositiveInteger(input.leaseDurationMs, 'leaseDurationMs')
    const now = timestamp(input.now)
    const leaseExpiresAt = new Date(Date.parse(now) + input.leaseDurationMs).toISOString()

    return inTransaction(this.pool, async (client) => {
      const result = await client.query<TaskRow>(
        `WITH candidate AS (
           SELECT at.id AS task_id
           FROM analysis_tasks AS at
           INNER JOIN resumes AS r ON r.id = at.resume_id
           WHERE (
             (at.status = 'queued' AND at.available_at <= $1::timestamptz)
             OR (at.status = 'processing' AND at.available_at <= $1::timestamptz)
           )
             AND r.scan_status = 'clean'
             AND at.attempts < $3::integer
           ORDER BY at.available_at ASC, at.created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE analysis_tasks AS at
         SET status = 'processing',
             attempts = at.attempts + 1,
             started_at = $1::timestamptz,
             available_at = $2::timestamptz,
             last_error = NULL
         FROM candidate
         WHERE at.id = candidate.task_id
         RETURNING ${TASK_COLUMNS_UNQUALIFIED}`,
        [now, leaseExpiresAt, input.maxAttempts],
      )
      const row = result.rows[0]
      if (!row) return undefined
      const task = mapTask(row)
      return { task, attempt: task.attempts, maxAttempts: input.maxAttempts, leaseExpiresAt }
    })
  }

  async getTask(taskId: string): Promise<AnalysisTaskRecord | undefined> {
    const result = await this.pool.connect().then(async (client) => {
      try {
        return await client.query<TaskRow>(
          `SELECT ${TASK_COLUMNS} FROM analysis_tasks AS at WHERE at.id = $1`,
          [taskId],
        )
      } finally {
        client.release()
      }
    })
    const row = result.rows[0]
    return row ? mapTask(row) : undefined
  }

  async getResult(taskId: string): Promise<AnalysisResultRecord | undefined> {
    const client = await this.pool.connect()
    try {
      const result = await client.query<ResultRow>(
        `SELECT ${RESULT_COLUMNS}
         FROM analysis_results AS ar
         WHERE ar.analysis_task_id = $1`,
        [taskId],
      )
      const row = result.rows[0]
      return row ? mapResult(row) : undefined
    } finally {
      client.release()
    }
  }

  async getResultByIdempotencyKey(idempotencyKey: string): Promise<AnalysisResultRecord | undefined> {
    const client = await this.pool.connect()
    try {
      const result = await client.query<ResultRow>(
        `SELECT ${RESULT_COLUMNS}
         FROM analysis_results AS ar
         INNER JOIN analysis_tasks AS at ON at.id = ar.analysis_task_id
         WHERE at.idempotency_key = $1`,
        [idempotencyKey],
      )
      const row = result.rows[0]
      return row ? mapResult(row) : undefined
    } finally {
      client.release()
    }
  }

  async getResumeAnalysisSource(resumeId: string): Promise<ResumeAnalysisSource> {
    const client = await this.pool.connect()
    try {
      const result = await client.query<ResumeSourceRow>(
        `SELECT r.id, r.candidate_id, r.storage_key, r.original_filename, r.mime_type, r.content_hash
         FROM resumes AS r
         WHERE r.id = $1`,
        [resumeId],
      )
      const row = result.rows[0]
      if (!row) throw new AnalysisTaskNotFoundError(resumeId)
      return {
        resumeId: row.id,
        candidateId: row.candidate_id,
        storageKey: row.storage_key,
        originalFilename: row.original_filename,
        mimeType: row.mime_type,
        ...(row.content_hash === null ? {} : { contentHash: row.content_hash }),
      }
    } finally {
      client.release()
    }
  }

  async getApplicationJob(applicationId: string): Promise<string | undefined> {
    const client = await this.pool.connect()
    try {
      const result = await client.query<JobApplicationRow>(
        'SELECT a.job_id FROM applications AS a WHERE a.id = $1',
        [applicationId],
      )
      return result.rows[0]?.job_id?.toString() || undefined
    } finally {
      client.release()
    }
  }

  async getJobAnalysisContext(jobId: string): Promise<{ title: string; requirements: string[] } | undefined> {
    const client = await this.pool.connect()
    try {
      const result = await client.query<{ title: string; content: Record<string, unknown> | null }>(
        `SELECT j.title, latest.content
         FROM jobs AS j
         LEFT JOIN LATERAL (
           SELECT content FROM job_spec_versions
           WHERE job_id = j.id
           ORDER BY version DESC
           LIMIT 1
         ) AS latest ON true
         WHERE j.id = $1`,
        [jobId],
      )
      const row = result.rows[0]
      if (!row) return undefined
      const content = row.content && typeof row.content === 'object' ? row.content : {}
      const requirements = Array.isArray(content.requirements)
        ? content.requirements.map((item) => {
            if (!item || typeof item !== 'object') return ''
            const entry = item as Record<string, unknown>
            return [entry.label, entry.description].filter((value) => typeof value === 'string' && value.trim()).join('：')
          }).filter(Boolean)
        : []
      const skills = Array.isArray(content.skills) ? content.skills.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
      return { title: row.title, requirements: [...requirements, ...skills] }
    } finally {
      client.release()
    }
  }

  /**
   * Advances a resume scan state in PostgreSQL. Terminal scan states cannot be
   * overwritten, preventing a late scanner result from reopening a quarantined
   * or rejected file.
   */
  async updateResumeScanStatus(resumeId: string, status: Exclude<ResumeScanStatus, 'quarantined'>): Promise<ResumeScanStatus> {
    const client = await this.pool.connect()
    try {
      const updated = await client.query<ResumeScanRow>(
        `UPDATE resumes
         SET scan_status = $2
         WHERE id = $1
           AND (
             (scan_status = 'quarantined' AND $2 IN ('scanning', 'clean', 'infected', 'failed'))
             OR (scan_status = 'scanning' AND $2 IN ('clean', 'infected', 'failed'))
           )
         RETURNING id, scan_status`,
        [resumeId, status],
      )
      if (updated.rows[0]) return updated.rows[0].scan_status

      const current = await client.query<ResumeScanRow>(
        'SELECT id, scan_status FROM resumes WHERE id = $1',
        [resumeId],
      )
      const row = current.rows[0]
      if (!row) throw new AnalysisTaskNotFoundError(resumeId)
      if (row.scan_status === status) return row.scan_status
      throw new Error(`Invalid resume scan status transition: ${row.scan_status} -> ${status}`)
    } finally {
      client.release()
    }
  }

  async completeTask(input: CompleteTaskInput): Promise<{ task: AnalysisTaskRecord; result: AnalysisResultRecord }> {
    const completedAt = timestamp(input.completedAt)
    const humanReviewStatus = input.humanReviewStatus ?? 'pending'

    return inTransaction(this.pool, async (client) => {
      const taskResult = await client.query<TaskRow>(
        `SELECT ${TASK_COLUMNS}
         FROM analysis_tasks AS at
         WHERE at.id = $1
         FOR UPDATE`,
        [input.taskId],
      )
      const taskRow = taskResult.rows[0]
      if (!taskRow) throw new AnalysisTaskNotFoundError(input.taskId)
      const task = mapTask(taskRow)

      if (task.status === 'completed') {
        const existing = await this.resultForTask(client, input.taskId)
        if (!existing) throw new Error(`Completed analysis task ${input.taskId} has no result`)
        return { task, result: existing }
      }
      if (task.status !== 'processing' || task.attempts !== input.attempt) {
        throw new AnalysisTaskLeaseLostError(input.taskId, input.attempt)
      }

      const inserted = await client.query<ResultRow>(
        `INSERT INTO analysis_results (
           id, analysis_task_id, resume_id, application_id, result,
           analyzer_version, input_hash, human_review_status, created_at
         )
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::timestamptz)
         ON CONFLICT (analysis_task_id) DO NOTHING
         RETURNING ${RESULT_COLUMNS.replaceAll('ar.', '')}`,
        [
          input.resultId ?? randomUUID(),
          task.id,
          task.resumeId,
          task.applicationId ?? null,
          JSON.stringify(input.result),
          input.analyzerVersion ?? null,
          input.inputHash ?? null,
          humanReviewStatus,
          completedAt,
        ],
      )
      const result = inserted.rows[0] ? mapResult(inserted.rows[0]) : await this.resultForTask(client, input.taskId)
      if (!result) throw new Error(`Analysis result for task ${input.taskId} could not be stored`)

      const updated = await client.query<TaskRow>(
        `UPDATE analysis_tasks
         SET status = 'completed', completed_at = $2::timestamptz,
             available_at = $2::timestamptz, last_error = NULL
         WHERE id = $1 AND status = 'processing' AND attempts = $3
         RETURNING ${TASK_COLUMNS_UNQUALIFIED}`,
        [input.taskId, completedAt, input.attempt],
      )
      const updatedTask = updated.rows[0]
      if (!updatedTask) throw new AnalysisTaskLeaseLostError(input.taskId, input.attempt)
      return { task: mapTask(updatedTask), result }
    })
  }

  async failTask(input: FailTaskInput): Promise<AnalysisTaskRecord> {
    assertPositiveInteger(input.maxAttempts, 'maxAttempts')
    const retryAt = timestamp(input.retryAt)

    return inTransaction(this.pool, async (client) => {
      const current = await client.query<TaskRow>(
        `SELECT ${TASK_COLUMNS}
         FROM analysis_tasks AS at
         WHERE at.id = $1
         FOR UPDATE`,
        [input.taskId],
      )
      const row = current.rows[0]
      if (!row) throw new AnalysisTaskNotFoundError(input.taskId)
      const task = mapTask(row)
      if (task.status === 'completed') return task
      if (task.status !== 'processing' || task.attempts !== input.attempt) {
        throw new AnalysisTaskLeaseLostError(input.taskId, input.attempt)
      }

      const retryable = input.attempt < input.maxAttempts
      const nextStatus: AnalysisTaskStatus = retryable ? 'queued' : 'failed'
      const updated = await client.query<TaskRow>(
        `UPDATE analysis_tasks
         SET status = $2,
             last_error = $3,
             available_at = $4::timestamptz,
             completed_at = NULL
         WHERE id = $1 AND status = 'processing' AND attempts = $5
         RETURNING ${TASK_COLUMNS_UNQUALIFIED}`,
        [input.taskId, nextStatus, input.error, retryAt, input.attempt],
      )
      const updatedTask = updated.rows[0]
      if (!updatedTask) throw new AnalysisTaskLeaseLostError(input.taskId, input.attempt)
      return mapTask(updatedTask)
    })
  }

  private async resultForTask(client: PgClient, taskId: string): Promise<AnalysisResultRecord | undefined> {
    const result = await client.query<ResultRow>(
      `SELECT ${RESULT_COLUMNS}
       FROM analysis_results AS ar
       WHERE ar.analysis_task_id = $1`,
      [taskId],
    )
    const row = result.rows[0]
    return row ? mapResult(row) : undefined
  }
}

/** Adapter for the existing TaskExecutor idempotency port. */
export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly store: PostgresAnalysisTaskStore) {}

  async get(idempotencyKey: string): Promise<IdempotencyRecord | undefined> {
    const client = await this.store.pool.connect()
    try {
      const result = await client.query<ResultRow>(
        `SELECT ${RESULT_COLUMNS}, at.idempotency_key, at.attempts
         FROM analysis_results AS ar
         INNER JOIN analysis_tasks AS at ON at.id = ar.analysis_task_id
         WHERE at.idempotency_key = $1`,
        [idempotencyKey],
      )
      const row = result.rows[0]
      if (!row) return undefined
      return {
        idempotencyKey,
        taskId: row.analysis_task_id,
        taskType: 'resume-analysis',
        attempts: Number(row.attempts),
        storedAt: rowTimestamp(row.created_at, 'created_at'),
        result: row.result,
      }
    } finally {
      client.release()
    }
  }

  async set(record: IdempotencyRecord): Promise<void> {
    if (record.taskType !== 'resume-analysis') {
      throw new TypeError(`Unsupported persisted task type: ${record.taskType}`)
    }
    await this.store.completeTask({
      taskId: record.taskId,
      attempt: record.attempts,
      result: record.result,
      completedAt: record.storedAt,
    })
  }
}

export function createPostgresAnalysisTaskStore(pool: PgPool): PostgresAnalysisTaskStore {
  return new PostgresAnalysisTaskStore(pool)
}
