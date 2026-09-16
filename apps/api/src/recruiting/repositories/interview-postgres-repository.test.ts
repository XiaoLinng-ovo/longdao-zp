import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  InterviewPostgresRepository,
  InterviewRepositoryNotFoundError,
  InterviewRepositoryWorkflowError,
  type InterviewRepositoryClient,
  type InterviewRepositoryPool,
} from './interview-postgres-repository.js'

const applicationId = '22222222-2222-4222-8222-222222222222'
const interviewId = '44444444-4444-4444-8444-444444444444'
const interviewerId = '55555555-5555-4555-8555-555555555555'
const timestamp = '2026-09-16T02:00:00.000Z'

const applicationRow = {
  application_id: applicationId,
  application_no: 'APP-8821',
  application_status: 'human_review',
  candidate_id: '11111111-1111-4111-8111-111111111111',
  job_id: '33333333-3333-4333-8333-333333333333',
  application_source: '内推',
  applied_at: timestamp,
  application_updated_at: timestamp,
}

const interviewRow = {
  id: interviewId,
  application_id: applicationId,
  interview_no: 'INT-501',
  round: 1,
  type: 'technical',
  title: '技术面试',
  status: 'scheduled',
  scheduled_start_at: timestamp,
  scheduled_end_at: null,
  timezone: 'Asia/Shanghai',
  location: null,
  meeting_url: 'https://meet.example/interview',
  participants: [{ userId: interviewerId, name: '面试官', role: 'interviewer', required: true }],
  created_at: timestamp,
  updated_at: timestamp,
  ...applicationRow,
  feedback_status: 'pending',
}

const feedbackRow = {
  id: '66666666-6666-4666-8666-666666666666',
  interview_id: interviewId,
  interviewer_id: interviewerId,
  status: 'submitted',
  overall_score: '88.50',
  recommendation: 'yes',
  ratings: { coding: 4 },
  strengths: ['清晰'],
  concerns: [],
  notes: '通过',
  submitted_at: timestamp,
  locked_at: null,
}

class FakeClient implements InterviewRepositoryClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = []
  private readonly responses: Array<unknown>

  constructor(responses: unknown[]) { this.responses = responses }

  async query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ sql, values: [...values] })
    return { rows: (this.responses.shift() ?? []) as T[] }
  }

  release(): void {}
}

class FakePool implements InterviewRepositoryPool {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = []
  readonly client: FakeClient
  private readonly responses: Array<unknown>

  constructor(responses: unknown[] = [], clientResponses: unknown[] = []) {
    this.responses = responses
    this.client = new FakeClient(clientResponses)
  }

  async query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ sql, values: [...values] })
    return { rows: (this.responses.shift() ?? []) as T[] }
  }

  async connect(): Promise<InterviewRepositoryClient> { return this.client }
  async end(): Promise<void> {}
}

describe('InterviewPostgresRepository SQL contract', () => {
  it('lists interviews with application data and aggregate feedback status', async () => {
    const pool = new FakePool([[interviewRow]])
    const repository = new InterviewPostgresRepository(pool)

    const result = await repository.listInterviews('APP-8821')

    assert.equal(result[0]?.code, 'INT-501')
    assert.equal(result[0]?.application.code, 'APP-8821')
    assert.equal(result[0]?.feedbackStatus, 'pending')
    assert.deepEqual(pool.calls[0]?.values, ['APP-8821'])
    assert.match(pool.calls[0]?.sql ?? '', /LEFT JOIN interview_feedback/)
    assert.match(pool.calls[0]?.sql ?? '', /a\.application_no = \$1/)
  })

  it('gets an interview and its feedback records', async () => {
    const pool = new FakePool([[{ ...interviewRow, feedback_status: 'submitted' }], [feedbackRow]])
    const repository = new InterviewPostgresRepository(pool)

    const result = await repository.getInterview(interviewId)

    assert.equal(result.feedbackStatus, 'submitted')
    assert.equal(result.feedback[0]?.overallScore, 88.5)
    assert.deepEqual(result.feedback[0]?.ratings, { coding: 4 })
    assert.match(pool.calls[1]?.sql ?? '', /FROM interview_feedback/)
  })

  it('creates an interview and advances an interviewable application atomically', async () => {
    const inserted = { ...interviewRow, feedback_status: undefined }
    const pool = new FakePool([], [
      [],
      [{ id: applicationId, status: 'human_review' }],
      [{ next_round: 1 }],
      [inserted],
      [],
      [],
      [],
    ])
    const repository = new InterviewPostgresRepository(pool, { generatedBusinessId: () => 'INT-501' })

    const result = await repository.createInterview({
      applicationId: 'APP-8821', title: ' 技术面试 ', type: 'technical', scheduledStartAt: timestamp,
      participants: [{ userId: interviewerId, name: ' 面试官 ' }],
    }, interviewerId)

    assert.equal(result.code, 'INT-501')
    assert.deepEqual(pool.client.calls.map((call) => call.sql), [
      'BEGIN', pool.client.calls[1]!.sql, pool.client.calls[2]!.sql, pool.client.calls[3]!.sql,
      pool.client.calls[4]!.sql, pool.client.calls[5]!.sql, 'COMMIT',
    ])
    assert.match(pool.client.calls[1]?.sql ?? '', /FROM applications[\s\S]*FOR UPDATE/)
    assert.match(pool.client.calls[3]?.sql ?? '', /INSERT INTO interviews/)
    assert.match(pool.client.calls[4]?.sql ?? '', /UPDATE applications/)
    assert.match(pool.client.calls[5]?.sql ?? '', /INSERT INTO workflow_events/)
  })

  it('rejects creation for a terminal application and rolls back', async () => {
    const pool = new FakePool([], [[], [{ id: applicationId, status: 'rejected' }], []])
    const repository = new InterviewPostgresRepository(pool)

    await assert.rejects(
      repository.createInterview({ applicationId, title: '面试', participants: [{ userId: interviewerId }] }),
      (error: unknown) => error instanceof InterviewRepositoryWorkflowError && error.code === 'APPLICATION_NOT_INTERVIEWABLE',
    )

    assert.equal(pool.client.calls.at(-1)?.sql, 'ROLLBACK')
  })

  it('upserts submitted feedback but refuses to overwrite locked feedback', async () => {
    const pool = new FakePool([], [
      [], [{ id: interviewId }], [], [feedbackRow], [], [],
      [], [{ id: interviewId }], [{ status: 'locked' }], [],
    ])
    const repository = new InterviewPostgresRepository(pool)

    const result = await repository.submitFeedback(interviewId, {
      interviewerId, overallScore: 88.5, recommendation: 'yes', ratings: { coding: 4 }, strengths: ['清晰'], notes: '通过',
    })
    assert.equal(result.status, 'submitted')
    assert.match(pool.client.calls[3]?.sql ?? '', /INSERT INTO interview_feedback[\s\S]*ON CONFLICT/)

    await assert.rejects(
      repository.submitFeedback(interviewId, { interviewerId }),
      (error: unknown) => error instanceof InterviewRepositoryWorkflowError && error.code === 'FEEDBACK_LOCKED',
    )
    assert.equal(pool.client.calls.at(-1)?.sql, 'ROLLBACK')
  })

  it('locks only submitted feedback in one transaction', async () => {
    const locked = { ...feedbackRow, status: 'locked', locked_at: timestamp }
    const pool = new FakePool([], [[], [feedbackRow], [locked], [], []])
    const repository = new InterviewPostgresRepository(pool)

    const result = await repository.lockFeedback(interviewId, interviewerId)

    assert.equal(result.status, 'locked')
    assert.match(pool.client.calls[1]?.sql ?? '', /FOR UPDATE/)
    assert.match(pool.client.calls[2]?.sql ?? '', /status = 'locked'/)
    assert.match(pool.client.calls[3]?.sql ?? '', /INSERT INTO workflow_events/)
    assert.equal(pool.client.calls.at(-1)?.sql, 'COMMIT')
  })

  it('concludes only when all feedback is locked and updates the application atomically', async () => {
    const completed = { ...interviewRow, status: 'completed', updated_at: timestamp }
    const pool = new FakePool([], [
      [],
      [{ id: interviewId, application_id: applicationId, status: 'scheduled' }],
      [{ id: applicationId, status: 'interviewing' }],
      [{ feedback_count: '2', unlocked_count: '0' }],
      [completed],
      [],
      [],
      [],
    ])
    const repository = new InterviewPostgresRepository(pool)

    const result = await repository.concludeInterview(interviewId, 'offer', interviewerId)

    assert.equal(result.status, 'completed')
    assert.match(pool.client.calls[1]?.sql ?? '', /FROM interviews[\s\S]*FOR UPDATE/)
    assert.match(pool.client.calls[2]?.sql ?? '', /FROM applications[\s\S]*FOR UPDATE/)
    assert.equal(pool.client.calls[5]?.values[0], 'offer_approval')
    assert.match(pool.client.calls[6]?.sql ?? '', /INSERT INTO workflow_events/)
    assert.equal(pool.client.calls.at(-1)?.sql, 'COMMIT')
  })

  it('rolls back conclusion when feedback is missing or unlocked', async () => {
    const pool = new FakePool([], [
      [],
      [{ id: interviewId, application_id: applicationId, status: 'scheduled' }],
      [{ id: applicationId, status: 'interviewing' }],
      [{ feedback_count: '1', unlocked_count: '1' }],
      [],
    ])
    const repository = new InterviewPostgresRepository(pool)

    await assert.rejects(
      repository.concludeInterview(interviewId, 'continue'),
      (error: unknown) => error instanceof InterviewRepositoryWorkflowError && error.code === 'INTERVIEW_FEEDBACK_INCOMPLETE',
    )

    assert.equal(pool.client.calls.at(-1)?.sql, 'ROLLBACK')
  })

  it('reports missing interviews without attempting dependent writes', async () => {
    const pool = new FakePool([], [[], [], []])
    const repository = new InterviewPostgresRepository(pool)

    await assert.rejects(repository.lockFeedback(interviewId, interviewerId), InterviewRepositoryNotFoundError)
    assert.equal(pool.client.calls.at(-1)?.sql, 'ROLLBACK')
  })
})
