import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RepositoryClient, RepositoryPool } from './types.js'
import { NormalizedRecruitingRepository } from './postgres-repository.js'

const candidateRow = {
  id: '11111111-1111-4111-8111-111111111111', candidate_no: 'CAN-8821', name: '王思远', email: null, phone: null,
  location: null, source: '内推', consent_status: 'unknown', created_at: '2026-09-10T00:00:00.000Z', updated_at: '2026-09-10T00:00:00.000Z',
}
const applicationRow = {
  id: '22222222-2222-4222-8222-222222222222', application_no: 'APP-8821', candidate_id: candidateRow.id, candidate_no: candidateRow.candidate_no,
  job_id: '33333333-3333-4333-8333-333333333333', job_no: 'JOB-108', status: 'new', recruiter_id: null, source: '内推',
  applied_at: '2026-09-10T00:00:00.000Z', rejected_reason: null, withdrawn_at: null, created_at: '2026-09-10T00:00:00.000Z', updated_at: '2026-09-10T00:00:00.000Z',
}

class FakeClient implements RepositoryClient {
  readonly calls: Array<{ sql: string; values: unknown[] }> = []
  private readonly responses: Array<unknown>

  constructor(responses: unknown[] = []) {
    this.responses = responses
  }

  async query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ sql, values: [...values] })
    return { rows: (this.responses.shift() ?? []) as T[] }
  }

  release(): void {}
}

class FakePool implements RepositoryPool {
  readonly calls: Array<{ sql: string; values: unknown[] }> = []
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

  async connect(): Promise<RepositoryClient> {
    return this.client
  }

  async end(): Promise<void> {}
}

describe('NormalizedRecruitingRepository SQL contract', () => {
  it('resolves display names only for UUID participants', async () => {
    const userId = '77777777-7777-4777-8777-777777777777'
    const pool = new FakePool([[{ id: userId, display_name: '林晓' }]])
    const repository = new NormalizedRecruitingRepository(pool)

    const names = await repository.resolveUserDisplayNames(['ddd', userId, 'interviewer-legacy'])

    assert.equal(names.get(userId), '林晓')
    assert.equal(names.size, 1)
    assert.deepEqual(pool.calls[0]?.values, [[userId]])
  })

  it('resolves an interviewer display name to a user id before storing interview participants', async () => {
    const interviewId = '88888888-8888-4888-8888-888888888888'
    const applicationId = applicationRow.id
    const userId = '77777777-7777-4777-8777-777777777777'
    const interviewRow = {
      id: interviewId,
      interview_no: 'INT-1001',
      application_id: applicationId,
      round: 1,
      type: 'technical',
      title: '技术面',
      status: 'scheduled',
      scheduled_start_at: null,
      scheduled_end_at: null,
      timezone: null,
      location: null,
      meeting_url: null,
      participants: [{ userId, name: '林晓', role: 'interviewer', required: true }],
      created_at: '2026-09-10T00:00:00.000Z',
      updated_at: '2026-09-10T00:00:00.000Z',
    }
    const pool = new FakePool([], [[], [{ id: applicationId }], [{ id: userId }], [interviewRow], []])
    const repository = new NormalizedRecruitingRepository(pool)

    const result = await repository.createInterview({
      applicationId,
      round: 1,
      title: '技术面',
      participants: [{ userId: '林晓', name: '林晓', role: 'interviewer', required: true }],
    })

    assert.equal(result.participants[0]?.userId, userId)
    const nameLookup = pool.client.calls.find((call) => call.sql.includes('lower(display_name) = lower($1)'))
    assert.deepEqual(nameLookup?.values, ['林晓'])
    const insert = pool.client.calls.find((call) => call.sql.includes('INSERT INTO interviews'))
    assert.deepEqual(JSON.parse(String(insert?.values[13])), [{ userId, name: '林晓', role: 'interviewer', required: true }])
    // 第 1 轮属于初试阶段，面试问题表按 stage 归属，必须跟着轮次一起写入。
    assert.equal(insert?.values[4], 'initial')
  })

  it('marks a second-round interview as the final stage so 复试问答归属正确', async () => {
    const interviewId = '99999999-9999-4999-8999-999999999999'
    const applicationId = applicationRow.id
    const interviewRow = {
      id: interviewId,
      interview_no: 'INT-1002',
      application_id: applicationId,
      round: 2,
      stage: 'final',
      type: 'onsite',
      title: '复试',
      status: 'scheduled',
      scheduled_start_at: null,
      scheduled_end_at: null,
      timezone: null,
      location: null,
      meeting_url: null,
      participants: [],
      created_at: '2026-09-10T00:00:00.000Z',
      updated_at: '2026-09-10T00:00:00.000Z',
    }
    const pool = new FakePool([], [[], [{ id: applicationId }], [interviewRow]])
    const repository = new NormalizedRecruitingRepository(pool)

    const result = await repository.createInterview({ applicationId, round: 2, title: '复试', participants: [] })

    const insert = pool.client.calls.find((call) => call.sql.includes('INSERT INTO interviews'))
    assert.equal(insert?.values[4], 'final')
    assert.equal(result.stage, 'final')
  })

  it('keeps a free-text interviewer name when no system user matches', async () => {
    const interviewId = '88888888-8888-4888-8888-888888888888'
    const applicationId = applicationRow.id
    const interviewRow = {
      id: interviewId,
      interview_no: 'INT-1002',
      application_id: applicationId,
      round: 1,
      type: 'technical',
      title: '技术面',
      status: 'scheduled',
      scheduled_start_at: null,
      scheduled_end_at: null,
      timezone: null,
      location: null,
      meeting_url: null,
      participants: [{ userId: '张三', name: '张三', role: 'interviewer', required: true }],
      created_at: '2026-09-20T00:00:00.000Z',
      updated_at: '2026-09-20T00:00:00.000Z',
    }
    const pool = new FakePool([], [[], [{ id: applicationId }], [], [interviewRow]])
    const repository = new NormalizedRecruitingRepository(pool)

    const result = await repository.createInterview({
      applicationId,
      round: 1,
      title: '技术面',
      participants: [{ userId: '张三', name: '张三', role: 'interviewer', required: true }],
    })

    assert.equal(result.participants[0]?.userId, '张三')
    const insert = pool.client.calls.find((call) => call.sql.includes('INSERT INTO interviews'))
    assert.deepEqual(JSON.parse(String(insert?.values[13])), [{ userId: '张三', name: '张三', role: 'interviewer', required: true }])
  })

  it('lists and loads normalized analysis tasks and results', async () => {
    const taskRow = { id: '44444444-4444-4444-8444-444444444444', resume_id: '55555555-5555-4555-8555-555555555555', application_id: null, status: 'queued', attempts: 0, idempotency_key: 'resume-analysis:x:y', last_error: null, available_at: '2026-09-10T00:00:00.000Z', started_at: null, completed_at: null, created_at: '2026-09-10T00:00:00.000Z' }
    const resultRow = { id: '66666666-6666-4666-8666-666666666666', analysis_task_id: taskRow.id, resume_id: taskRow.resume_id, application_id: null, result: { assessment: { score: 88 } }, analyzer_version: 'rule-1', input_hash: 'hash', human_review_status: 'pending', created_at: '2026-09-10T00:00:00.000Z' }
    const pool = new FakePool([[taskRow], [resultRow]])
    const repository = new NormalizedRecruitingRepository(pool)

    const tasks = await repository.listAnalysisTasks('queued')
    const results = await repository.listAnalysisResults(taskRow.resume_id)

    assert.equal(tasks[0]?.id, taskRow.id)
    assert.equal(tasks[0]?.lastError, null)
    assert.equal(results[0]?.analysisTaskId, taskRow.id)
    assert.equal((results[0]?.result.assessment as { score: number }).score, 88)
    assert.equal(pool.calls.length, 2)
    assert.ok(pool.calls[0]?.sql.includes('FROM analysis_tasks'))
    assert.ok(pool.calls[1]?.sql.includes('FROM analysis_results'))
  })

  it('updates task lifecycle and upserts an analysis result in one transaction', async () => {
    const taskRow = { id: '44444444-4444-4444-8444-444444444444', resume_id: '55555555-5555-4555-8555-555555555555', application_id: null, status: 'completed', attempts: 1, idempotency_key: 'k', last_error: null, available_at: '2026-09-10T00:00:00.000Z', started_at: '2026-09-10T00:00:00.000Z', completed_at: '2026-09-10T00:01:00.000Z', created_at: '2026-09-10T00:00:00.000Z' }
    const resultRow = { id: '66666666-6666-4666-8666-666666666666', analysis_task_id: taskRow.id, resume_id: taskRow.resume_id, application_id: null, result: { ok: true }, analyzer_version: 'rule-1', input_hash: 'hash', human_review_status: 'pending', created_at: '2026-09-10T00:01:00.000Z' }
    const pool = new FakePool([], [[], [taskRow], [], [], [resultRow], []])
    const repository = new NormalizedRecruitingRepository(pool)

    const task = await repository.updateAnalysisTask(taskRow.id, { status: 'completed', attempts: 1, startedAt: taskRow.started_at, completedAt: taskRow.completed_at })
    const result = await repository.createAnalysisResult({ analysisTaskId: taskRow.id, resumeId: taskRow.resume_id, result: resultRow.result, analyzerVersion: 'rule-1', inputHash: 'hash' })

    assert.equal(task.status, 'completed')
    assert.equal(result.id, resultRow.id)
    assert.deepEqual(pool.client.calls.map((call) => call.sql), ['BEGIN', pool.client.calls[1]!.sql, 'COMMIT', 'BEGIN', pool.client.calls[4]!.sql, 'COMMIT'])
    assert.ok(pool.client.calls[1]?.sql.startsWith('UPDATE analysis_tasks'))
    assert.ok(pool.client.calls[4]?.sql.startsWith('INSERT INTO analysis_results'))
  })
  it('persists recruitment request approval submission in normalized approval tables', async () => {
    const requestId = '44444444-4444-4444-8444-444444444444'
    const pool = new FakePool([], [
      [],
      [{ id: requestId }],
      [{ id: requestId, status: 'draft', version: 1 }],
      [],
      [],
      [{ id: requestId, request_no: 'REQ-1001', title: '后端', department_id: null, department_name: null, requested_by: null, headcount: 1, budget_min: null, budget_max: null, reason: '扩编', status: 'pending_approval', version: 2, created_at: '2026-09-10T00:00:00.000Z', updated_at: '2026-09-10T00:00:00.000Z' }],
      [],
    ])
    const repository = new NormalizedRecruitingRepository(pool)

    const result = await repository.requestApprovalAction(requestId, 'submit', '77777777-7777-4777-8777-777777777777')

    assert.equal(result.status, 'pending_approval')
    assert.ok(pool.client.calls.some((call) => call.sql.includes('INSERT INTO approval_instances')))
    assert.ok(pool.client.calls.some((call) => call.sql.includes('INSERT INTO approval_steps')))
    assert.ok(pool.client.calls.some((call) => call.sql.includes('UPDATE recruitment_requests')))
  })

  it('records a normalized rejection decision and requires a reason', async () => {
    const requestId = '44444444-4444-4444-8444-444444444444'
    const pool = new FakePool([], [
      [],
      [{ id: requestId }],
      [{ id: requestId, status: 'pending_approval', version: 2 }],
      [{ id: '55555555-5555-4555-8555-555555555555', status: 'pending' }],
      [{ id: '66666666-6666-4666-8666-666666666666', status: 'pending' }],
      [],
      [],
      [],
      [{ id: requestId, request_no: 'REQ-1001', title: '后端', department_id: null, department_name: null, requested_by: null, headcount: 1, budget_min: null, budget_max: null, reason: '扩编', status: 'rejected', version: 3, created_at: '2026-09-10T00:00:00.000Z', updated_at: '2026-09-10T00:00:00.000Z' }],
      [],
    ])
    const repository = new NormalizedRecruitingRepository(pool)

    const result = await repository.requestApprovalAction(requestId, 'reject', '77777777-7777-4777-8777-777777777777', '预算不足')

    assert.equal(result.status, 'rejected')
    const record = pool.client.calls.find((call) => call.sql.includes('INSERT INTO approval_records'))
    assert.equal(record?.values.at(-1), '预算不足')
    assert.ok(pool.client.calls.some((call) => call.sql.includes('UPDATE approval_instances')))
  })

  it('maps a legacy seed candidate id to a generated UUID and business number', async () => {
    const pool = new FakePool([], [
      [],
      [candidateRow],
      [],
    ])
    const repository = new NormalizedRecruitingRepository(pool)

    const result = await repository.createCandidate({ id: 'candidate-8821', name: '王思远', source: '内推' })

    assert.match(result.id, /^[0-9a-f-]{36}$/i)
    assert.equal(result.businessId, 'CAN-8821')
    assert.equal(result.legacyId, 'candidate-8821')
    assert.equal(pool.client.calls[0]?.sql, 'BEGIN')
    assert.ok(pool.client.calls[1]?.sql.startsWith(expectInsert('candidates')))
    assert.equal(pool.client.calls[2]?.sql, 'COMMIT')
    const insert = pool.client.calls[1]!
    assert.equal(insert.values?.[1], 'CAN-8821')
    assert.match(String(insert.values?.[0]), /^[0-9a-f-]{36}$/i)
    assert.ok(!insert.sql.includes('candidate-8821'))
    assert.ok(insert.sql.includes('$1::uuid'))
  })

  it('upserts onboarding by offer id so repeated archive cannot violate the unique constraint', async () => {
    const applicationId = '99999999-9999-4999-8999-999999999999'
    const offerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const onboardingRow = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      application_id: applicationId,
      offer_id: offerId,
      planned_start_date: null,
      status: 'pending',
      notes: null,
      archived_at: null,
      created_at: '2026-09-20T00:00:00.000Z',
      updated_at: '2026-09-20T00:00:00.000Z',
    }
    const pool = new FakePool([], [[], [{ id: applicationId }], [{ id: offerId }], [onboardingRow]])
    const repository = new NormalizedRecruitingRepository(pool)

    const result = await repository.createOnboarding({ applicationId, offerId, status: 'pending' })

    assert.equal(result.id, onboardingRow.id)
    const insert = pool.client.calls.find((call) => call.sql.includes('INSERT INTO onboarding_records'))
    assert.match(insert?.sql ?? '', /ON CONFLICT \(offer_id\) DO UPDATE SET offer_id = EXCLUDED.offer_id/)
  })

  it('looks up an existing onboarding record by offer id', async () => {
    const offerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const onboardingRow = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      application_id: '99999999-9999-4999-8999-999999999999',
      offer_id: offerId,
      planned_start_date: null,
      status: 'pending',
      notes: null,
      archived_at: null,
      created_at: '2026-09-20T00:00:00.000Z',
      updated_at: '2026-09-20T00:00:00.000Z',
    }
    const pool = new FakePool([[onboardingRow]])
    const repository = new NormalizedRecruitingRepository(pool)

    const result = await repository.getOnboardingByOfferId(offerId)

    assert.equal(result?.id, onboardingRow.id)
    assert.match(pool.calls[0]?.sql ?? '', /r\.offer_id = \$1::uuid/)
  })

  it('resolves legacy candidate/job ids before inserting an application', async () => {
    const pool = new FakePool([], [
      [],
      [{ id: candidateRow.id }],
      [{ id: applicationRow.job_id }],
      [applicationRow],
      [],
    ])
    const repository = new NormalizedRecruitingRepository(pool)

    const result = await repository.createApplication({ candidateId: 'candidate-8821', jobId: 'job-108', applicationNo: 'application-8821', source: '内推' })

    assert.equal(result.id, applicationRow.id)
    assert.equal(result.candidateId, candidateRow.id)
    assert.equal(result.jobId, applicationRow.job_id)
    const candidateLookup = pool.client.calls.find((call) => call.sql.includes('FROM candidates'))!
    const jobLookup = pool.client.calls.find((call) => call.sql.includes('FROM jobs'))!
    assert.equal(candidateLookup.values[0], 'candidate-8821')
    assert.deepEqual(jobLookup.values, ['job-108', 'JOB-108'])
    const insert = pool.client.calls.find((call) => call.sql.includes('INSERT INTO applications'))!
    assert.equal(insert.values[1], 'APP-8821')
    assert.equal(insert.values[2], candidateRow.id)
    assert.equal(insert.values[3], applicationRow.job_id)
  })

  it('maps normalized rows and keeps UUID filters parameterized', async () => {
    const pool = new FakePool([[candidateRow]])
    const repository = new NormalizedRecruitingRepository(pool)

    const result = await repository.listCandidates()

    assert.equal(result[0]?.id, candidateRow.id)
    assert.equal(result[0]?.legacyId, 'candidate-8821')
    assert.equal(pool.calls[0]?.values.length, 0)
    assert.ok(pool.calls[0]?.sql.includes('ORDER BY c.updated_at DESC'))
  })

  it('rolls back and releases a client when the transaction callback fails', async () => {
    const pool = new FakePool()
    const repository = new NormalizedRecruitingRepository(pool)

    await assert.rejects(repository.transaction(async (client) => {
      await client.query('SELECT 1')
      throw new Error('contract failure')
    }), /contract failure/)

    assert.deepEqual(pool.client.calls.map((call) => call.sql), ['BEGIN', 'SELECT 1', 'ROLLBACK'])
  })
})

function expectInsert(table: string): string {
  return `INSERT INTO ${table}`
}
