import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { GeneratedInterviewQuestion, InterviewQuestionGroup } from './question-generator.js'

export type PreparationState = 'queued' | 'generating' | 'ready' | 'failed' | 'cancelled'
export type PreparationFailureStage = 'rubrics' | 'context' | 'question_generation' | 'publish'
export interface PreparationFailure {
  stage: PreparationFailureStage
  group?: InterviewQuestionGroup
  code: string
  diagnosticId?: string
  httpStatus?: number
  reason?: 'timeout' | 'network'
  retryable?: boolean
  durationMs?: number
  model?: string
}
export interface QuestionPreparation {
  status: PreparationState | 'not_started'
  completedGroups: InterviewQuestionGroup[]
  error?: string
  failure?: PreparationFailure
  attempts?: number
  nextRetryAt?: string
  rubricsStatus?: 'queued' | 'ready'
  updatedAt?: string
  materialsChanged?: boolean
}
export interface PreparationJob {
  interviewId: string
  requestedBy: string
  status: PreparationState
  attempts: number
  claimToken: string
  inputHash: string | null
  completedGroups: Partial<Record<InterviewQuestionGroup, GeneratedInterviewQuestion[]>>
  error?: string
  failure?: PreparationFailure
  rubricsStatus?: 'queued' | 'ready'
  updatedAt: string
}
export interface PreparationRepository {
  enqueue(interviewId: string, actorId: string, retry?: boolean): Promise<void>
  list(ids: string[]): Promise<Map<string, QuestionPreparation>>
  get(interviewId: string): Promise<PreparationJob | null>
  claim(): Promise<PreparationJob | null>
  heartbeat(job: PreparationJob): Promise<void>
  checkpoint(job: PreparationJob): Promise<boolean>
  complete(job: PreparationJob, questions: GeneratedInterviewQuestion[]): Promise<boolean>
  fail(job: PreparationJob, error: string, retry: boolean, failure?: PreparationFailure): Promise<void>
  cancel(job: PreparationJob): Promise<void>
}

function mapJob(row: Record<string, any>): PreparationJob {
  return { interviewId: String(row.interview_id), requestedBy: String(row.requested_by), status: row.status,
    attempts: Number(row.attempts), claimToken: String(row.claim_token ?? ''), inputHash: row.input_hash ?? null,
    completedGroups: row.completed_groups ?? {}, ...(row.error_message ? { error: String(row.error_message) } : {}),
    ...(row.rubrics_status ? { rubricsStatus: row.rubrics_status } : {}),
    ...(row.failure_stage && row.failure_code ? { failure: { ...row.failure_details, stage: row.failure_stage, ...(row.failure_group ? { group: row.failure_group } : {}), code: row.failure_code } } : {}),
    updatedAt: new Date(row.updated_at).toISOString() }
}
function view(job: PreparationJob): QuestionPreparation {
  return { status: job.status, completedGroups: Object.keys(job.completedGroups) as InterviewQuestionGroup[],
    ...(job.error ? { error: job.error } : {}), ...(job.failure ? { failure: job.failure } : {}),
    ...(job.rubricsStatus ? { rubricsStatus: job.rubricsStatus } : {}), attempts: job.attempts, updatedAt: job.updatedAt }
}

export class PostgresPreparationRepository implements PreparationRepository {
  constructor(private readonly pool: Pool) {}
  async enqueue(interviewId: string, actorId: string, retry = false): Promise<void> {
    await this.pool.query(
      `INSERT INTO interview_question_preparations (interview_id, requested_by)
       SELECT i.id, $2::uuid FROM interviews i WHERE i.id = $1::uuid AND i.status = 'scheduled'
         AND NOT EXISTS (SELECT 1 FROM interview_resume_question_sets s WHERE s.interview_id = i.id AND jsonb_array_length(s.questions) > 0)
       ON CONFLICT (interview_id) DO UPDATE SET status = 'queued', requested_by = EXCLUDED.requested_by,
         attempts = 0, available_at = now(), claim_token = NULL, lease_until = NULL, error_message = NULL,
         failure_stage = NULL, failure_group = NULL, failure_code = NULL, failure_details = NULL, updated_at = now()
       WHERE $3::boolean AND interview_question_preparations.status IN ('failed','cancelled')`, [interviewId, actorId, retry])
  }
  async list(ids: string[]): Promise<Map<string, QuestionPreparation>> {
    if (!ids.length) return new Map()
    const { rows } = await this.pool.query(
      `SELECT i.id, i.status AS interview_status, p.status, p.completed_groups, p.error_message,
        p.failure_stage, p.failure_group, p.failure_code, p.failure_details,
        CASE WHEN (SELECT count(*) FROM interview_question_sheets sh
          WHERE sh.application_id = i.application_id AND sh.stage = i.stage
            AND sh.sheet_type = ANY(CASE WHEN i.stage = 'final' THEN ARRAY['business','hr','boss'] ELSE ARRAY['hr_screen','hiring_department'] END)
            AND sh.status <> 'generating' AND sh.generation_error IS NULL
            AND EXISTS (SELECT 1 FROM interview_questions q WHERE q.sheet_id = sh.id)) = CASE WHEN i.stage = 'final' THEN 3 ELSE 2 END
          THEN 'ready' ELSE p.rubrics_status END AS rubrics_status,
        p.attempts, p.available_at, p.updated_at,
        COALESCE(jsonb_array_length(s.questions), 0) > 0 AS has_questions
       FROM interviews i LEFT JOIN interview_question_preparations p ON p.interview_id = i.id
       LEFT JOIN interview_resume_question_sets s ON s.interview_id = i.id WHERE i.id = ANY($1::uuid[])`, [ids])
    return new Map(rows.map(row => [String(row.id), { status: row.has_questions ? 'ready'
      : row.interview_status !== 'scheduled' ? 'cancelled' : row.status ?? 'not_started',
      completedGroups: Object.keys(row.completed_groups ?? {}) as InterviewQuestionGroup[],
      attempts: Number(row.attempts ?? 0),
      ...(row.rubrics_status ? { rubricsStatus: row.rubrics_status } : {}),
      ...(row.status === 'queued' && row.error_message && !row.has_questions ? { nextRetryAt: new Date(row.available_at).toISOString() } : {}),
      ...(row.error_message && !row.has_questions ? { error: row.error_message } : {}),
      ...(row.failure_stage && row.failure_code && !row.has_questions ? { failure: {
        ...row.failure_details, stage: row.failure_stage, ...(row.failure_group ? { group: row.failure_group } : {}), code: row.failure_code,
      } } : {}),
      ...(row.updated_at ? { updatedAt: new Date(row.updated_at).toISOString() } : {}) }]))
  }
  async get(interviewId: string): Promise<PreparationJob | null> {
    const { rows } = await this.pool.query('SELECT * FROM interview_question_preparations WHERE interview_id = $1::uuid', [interviewId])
    return rows[0] ? mapJob(rows[0]) : null
  }
  async claim(): Promise<PreparationJob | null> {
    const { rows } = await this.pool.query(
      `WITH next AS (SELECT p.interview_id FROM interview_question_preparations p
        JOIN interviews i ON i.id = p.interview_id JOIN applications a ON a.id = i.application_id
        WHERE i.status = 'scheduled' AND organization_service_available(a.organization_id)
          AND ((p.status = 'queued' AND p.available_at <= now()) OR (p.status = 'generating' AND p.lease_until < now()))
        ORDER BY p.created_at FOR UPDATE OF p SKIP LOCKED LIMIT 1)
       UPDATE interview_question_preparations p SET status = 'generating', attempts = attempts + 1,
         claim_token = $1::uuid, lease_until = now() + interval '90 seconds', updated_at = now()
       FROM next WHERE p.interview_id = next.interview_id RETURNING p.*`, [randomUUID()])
    return rows[0] ? mapJob(rows[0]) : null
  }
  async heartbeat(job: PreparationJob): Promise<void> {
    await this.pool.query(`UPDATE interview_question_preparations SET lease_until = now() + interval '90 seconds'
      WHERE interview_id = $1::uuid AND claim_token = $2::uuid AND status = 'generating'`, [job.interviewId, job.claimToken])
  }
  async checkpoint(job: PreparationJob): Promise<boolean> {
    const result = await this.pool.query(`UPDATE interview_question_preparations SET input_hash = $3,
      completed_groups = $4::jsonb, rubrics_status = $5, updated_at = now() WHERE interview_id = $1::uuid AND claim_token = $2::uuid AND status = 'generating'`,
    [job.interviewId, job.claimToken, job.inputHash, JSON.stringify(job.completedGroups), job.rubricsStatus ?? null])
    return result.rowCount === 1
  }
  async complete(job: PreparationJob, questions: GeneratedInterviewQuestion[]): Promise<boolean> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const interview = await client.query("SELECT id FROM interviews WHERE id = $1::uuid AND status = 'scheduled' FOR UPDATE", [job.interviewId])
      if (!interview.rows.length) { await client.query('ROLLBACK'); return false }
      const current = await client.query(`SELECT interview_id FROM interview_question_preparations
        WHERE interview_id = $1::uuid AND claim_token = $2::uuid AND status = 'generating' FOR UPDATE`, [job.interviewId, job.claimToken])
      if (!current.rows.length) { await client.query('ROLLBACK'); return false }
      // Never overwrite a bank edited/generated elsewhere while the worker was running.
      await client.query(`INSERT INTO interview_resume_question_sets (interview_id, generated_by, engine, questions)
        VALUES ($1::uuid, $2::uuid, 'llm', $3::jsonb) ON CONFLICT (interview_id) DO UPDATE
        SET generated_by = EXCLUDED.generated_by, engine = EXCLUDED.engine, questions = EXCLUDED.questions, updated_at = now()
        WHERE jsonb_array_length(interview_resume_question_sets.questions) = 0`, [job.interviewId, job.requestedBy, JSON.stringify(questions)])
      await client.query(`UPDATE interview_question_preparations SET status = 'ready', error_message = NULL,
        failure_stage = NULL, failure_group = NULL, failure_code = NULL, failure_details = NULL,
        claim_token = NULL, lease_until = NULL, updated_at = now() WHERE interview_id = $1::uuid`, [job.interviewId])
      await client.query('COMMIT')
      return true
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async fail(job: PreparationJob, error: string, retry: boolean, failure?: PreparationFailure): Promise<void> {
    await this.pool.query(`UPDATE interview_question_preparations SET status = $3, error_message = $4,
      failure_stage = $6, failure_group = $7, failure_code = $8, failure_details = $9::jsonb,
      available_at = now() + ($5 * interval '1 second'), claim_token = NULL, lease_until = NULL, updated_at = now()
      WHERE interview_id = $1::uuid AND claim_token = $2::uuid AND status = 'generating'`,
    [job.interviewId, job.claimToken, retry ? 'queued' : 'failed', error.slice(0, 500), Math.min(120, 15 * 2 ** Math.max(0, job.attempts - 1)),
      failure?.stage ?? null, failure?.group ?? null, failure?.code ?? null, failure ? JSON.stringify(failure) : null])
  }
  async cancel(job: PreparationJob): Promise<void> {
    await this.pool.query(`UPDATE interview_question_preparations SET status = 'cancelled', claim_token = NULL,
      lease_until = NULL, updated_at = now() WHERE interview_id = $1::uuid AND claim_token = $2::uuid`, [job.interviewId, job.claimToken])
  }
}

export class MemoryPreparationRepository implements PreparationRepository {
  readonly jobs = new Map<string, PreparationJob>()
  readonly results = new Map<string, GeneratedInterviewQuestion[]>()
  async enqueue(interviewId: string, actorId: string, retry = false): Promise<void> {
    const existing = this.jobs.get(interviewId)
    if (this.results.has(interviewId) || (existing && !(retry && ['failed', 'cancelled'].includes(existing.status)))) return
    this.jobs.set(interviewId, { interviewId, requestedBy: actorId, status: 'queued', attempts: 0, claimToken: '',
      inputHash: existing?.inputHash ?? null, completedGroups: existing?.completedGroups ?? {},
      ...(existing?.rubricsStatus ? { rubricsStatus: existing.rubricsStatus } : {}), updatedAt: new Date().toISOString() })
  }
  async list(ids: string[]): Promise<Map<string, QuestionPreparation>> {
    return new Map(ids.map(id => [id, this.jobs.has(id) ? view(this.jobs.get(id)!) : { status: 'not_started', completedGroups: [] }]))
  }
  async get(id: string) { return this.jobs.get(id) ?? null }
  async claim(): Promise<PreparationJob | null> {
    const job = [...this.jobs.values()].find(row => row.status === 'queued')
    if (!job) return null
    job.status = 'generating'; job.attempts++; job.claimToken = randomUUID()
    return structuredClone(job)
  }
  async heartbeat(_job: PreparationJob) {}
  async checkpoint(job: PreparationJob) {
    if (this.jobs.get(job.interviewId)?.claimToken !== job.claimToken || this.jobs.get(job.interviewId)?.status !== 'generating') return false
    this.jobs.set(job.interviewId, structuredClone(job)); return true
  }
  async complete(job: PreparationJob, questions: GeneratedInterviewQuestion[]) {
    if (this.jobs.get(job.interviewId)?.claimToken !== job.claimToken) return false
    if (!this.results.has(job.interviewId)) this.results.set(job.interviewId, questions)
    const ready = { ...job, status: 'ready' as const }; delete ready.error; delete ready.failure
    this.jobs.set(job.interviewId, ready); return true
  }
  async fail(job: PreparationJob, error: string, retry: boolean, failure?: PreparationFailure) {
    if (this.jobs.get(job.interviewId)?.claimToken === job.claimToken) this.jobs.set(job.interviewId, { ...job, status: retry ? 'queued' : 'failed', error, ...(failure ? { failure } : {}) })
  }
  async cancel(job: PreparationJob) {
    if (this.jobs.get(job.interviewId)?.claimToken === job.claimToken) this.jobs.set(job.interviewId, { ...job, status: 'cancelled' })
  }
}
