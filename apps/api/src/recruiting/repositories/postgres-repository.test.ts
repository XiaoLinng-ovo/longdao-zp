import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RepositoryClient, RepositoryPool } from './types.js'
import { NormalizedRecruitingRepository } from './postgres-repository.js'
import { prepareOfferSalary } from '../offer-salary.js'

const candidateRow = {
  id: '11111111-1111-4111-8111-111111111111', candidate_no: 'CAN-8821', name: '王思远', email: null, phone: null,
  location: null, source: '内推', consent_status: 'unknown', created_at: '2026-09-10T00:00:00.000Z', updated_at: '2026-09-10T00:00:00.000Z',
}
const applicationRow = {
  id: '22222222-2222-4222-8222-222222222222', application_no: 'APP-8821', candidate_id: candidateRow.id, candidate_no: candidateRow.candidate_no,
  job_id: '33333333-3333-4333-8333-333333333333', job_no: 'JOB-108', status: 'new', recruiter_id: null, source: '内推',
  applied_at: '2026-09-10T00:00:00.000Z', rejected_reason: null, withdrawn_at: null, created_at: '2026-09-10T00:00:00.000Z', updated_at: '2026-09-10T00:00:00.000Z',
}
const offerTemplateRow = {
  id: '66666666-6666-4666-8666-666666666666', name: 'Offer Template', filename: 'offer.md', content: 'Hello {{candidateName}}',
  is_active: true, is_default: true, created_by: null, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
}

class FakeClient implements RepositoryClient {
  readonly calls: Array<{ sql: string; values: unknown[] }> = []
  private readonly responses: Array<unknown>

  constructor(
    responses: unknown[] = [],
    private readonly queryError?: (sql: string, callIndex: number) => Error | undefined,
  ) {
    this.responses = responses
  }

  async query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ sql, values: [...values] })
    const error = this.queryError?.(sql, this.calls.length)
    if (error) throw error
    return { rows: (this.responses.shift() ?? []) as T[] }
  }

  release(): void {}
}

class FakePool implements RepositoryPool {
  readonly calls: Array<{ sql: string; values: unknown[] }> = []
  readonly client: FakeClient
  private readonly responses: Array<unknown>

  constructor(
    responses: unknown[] = [],
    clientResponses: unknown[] = [],
    private readonly queryError?: (sql: string, callIndex: number) => Error | undefined,
  ) {
    this.responses = responses
    this.client = new FakeClient(clientResponses, queryError)
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
  it('borrows only the upload connection, keeps transactions separate and never releases its owner', async () => {
    const pool = new FakePool()
    pool.connect = async () => { throw new Error('不能另取共享连接') }
    let releases = 0
    const client = new FakeClient()
    client.release = () => { releases++ }
    const scoped = new NormalizedRecruitingRepository(pool, { organizationId: candidateRow.id }).withUploadConnection(client)
    await scoped.withTransaction(async () => {
      await assert.rejects(scoped.withTransaction(async () => undefined), /嵌套或并行事务/)
      assert.throws(() => scoped.pool.query('SELECT 1'), /正在事务中/)
    })
    await scoped.withTransaction(async () => undefined)
    await scoped.listCandidates()
    await scoped.close()
    assert.equal(releases, 0)
    assert.deepEqual(client.calls.slice(0, 4).map(call => call.sql), ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT'])
    assert.ok(client.calls.at(-1)!.values.includes(candidateRow.id), '借用连接仍保留公司范围')
    assert.equal(pool.calls.length, 0)
  })

  it('rolls back a borrowed connection and makes it reusable after failure', async () => {
    const client = new FakeClient()
    const scoped = new NormalizedRecruitingRepository(new FakePool()).withUploadConnection(client)
    await assert.rejects(scoped.withTransaction(async () => { throw new Error('checkpoint failed') }), /checkpoint failed/)
    await scoped.withTransaction(async () => undefined)
    assert.deepEqual(client.calls.map(call => call.sql), ['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT'])
  })
  it('schedules failed uploads from the original location even after the candidate is deleted', async () => {
    const organizationId = '99999999-9999-4999-8999-999999999999'
    const pool = new FakePool([[{ id: 'cleanup-id' }]])
    await new NormalizedRecruitingRepository(pool, { organizationId }).scheduleResumeUploadCleanup(candidateRow.id, 'upload.txt')
    assert.equal(pool.calls.length, 1)
    assert.match(pool.calls[0]!.sql, /FROM public\.stored_object_locations/)
    assert.match(pool.calls[0]!.sql, /storage_location_id/)
    assert.deepEqual(pool.calls[0]!.values, [organizationId, 'upload.txt'])
  })

  it('marks manual names and atomically preserves them during automatic extraction', async () => {
    for (const automatic of [false, true]) {
      const pool = new FakePool([], [[], [{ id: candidateRow.id }], [{ ...candidateRow, name_manually_edited: true }], []])
      const repository = new NormalizedRecruitingRepository(pool)
      const saved = await repository.updateCandidate(candidateRow.id, { name: '人工姓名', ...(automatic ? { nameManuallyEdited: false } : {}) })
      const update = pool.client.calls.find(call => call.sql.startsWith('UPDATE candidates'))!
      assert.ok(update)
      if (automatic) assert.match(update.sql, /CASE WHEN name_manually_edited THEN name ELSE/u)
      else { assert.match(update.sql, /name_manually_edited = \$2/u); assert.equal(update.values[1], true) }
      assert.equal(saved.nameManuallyEdited, true)
    }
  })
  it('uses valid PostgreSQL placeholders for organization-scoped workflow events', async () => {
    const organizationId = '99999999-9999-4999-8999-999999999999'
    const actorId = '77777777-7777-4777-8777-777777777777'
    const pool = new FakePool([], [[], [], []])
    const repository = new NormalizedRecruitingRepository(pool, { organizationId })

    await repository.appendWorkflowEvent({
      subjectType: 'recruitment_request',
      subjectId: '44444444-4444-4444-8444-444444444444',
      action: 'submit',
      actorId,
    })

    const insert = pool.client.calls.find((call) => call.sql.includes('INSERT INTO workflow_events'))
    assert.ok(insert)
    assert.match(insert.sql, /VALUES \(\$1::uuid, \$2::uuid, \$3, \$4::uuid, \$5, \$6, \$7, \$8::uuid, \$9, \$10::jsonb\)/)
    assert.equal(insert.values[0], organizationId)
    assert.match(String(insert.values[1]), /^[0-9a-f-]{36}$/i)
    assert.deepEqual(insert.values.slice(2), ['recruitment_request', '44444444-4444-4444-8444-444444444444', 'submit', null, null, null, '', '{}'])
  })


  for (const [action, fromStatus, toStatus] of [
    ['cancel', 'draft', 'cancelled'],
    ['withdraw', 'approved', 'withdrawn'],
    ['close', 'approved', 'closed'],
  ] as const) {
    it(`persists ${action} and its audit event within the selected organization`, async () => {
      const organizationId = '99999999-9999-4999-8999-999999999999'
      const requestId = '44444444-4444-4444-8444-444444444444'
      const row = { id: requestId, request_no: 'REQ-1', title: 'Test', department_id: null, department_name: null,
        requested_by: null, hiring_manager_id: null, headcount: 1, budget_min: null, budget_max: null,
        employment_type: null, work_mode: null, location: null, reason: 'Test', status: toStatus, version: 2,
        created_at: '2026-10-08T00:00:00.000Z', updated_at: '2026-10-08T00:00:00.000Z' }
      const pool = new FakePool([], [[], [{ id: requestId }], [{ id: requestId, status: fromStatus, version: 1 }], [row], []])
      const repository = new NormalizedRecruitingRepository(pool, { organizationId })
      const result = await repository.requestApprovalAction(requestId, action, 'legacy-user', 'Test reason')
      assert.equal(result.status, toStatus)
      const update = pool.client.calls.find(({ sql }) => sql.includes('UPDATE recruitment_requests'))!
      assert.match(update.sql, /organization_id = \$3::uuid/)
      assert.deepEqual(update.values, [requestId, toStatus, organizationId])
      const audit = pool.client.calls.find(({ sql }) => sql.includes('INSERT INTO workflow_events'))!
      assert.deepEqual(audit.values.slice(0, 1), [organizationId])
      assert.deepEqual(audit.values.slice(2, 7), ['recruitment_request', requestId, action, fromStatus, toStatus])
      assert.equal(pool.client.calls.at(-1)?.sql, 'COMMIT')
    })
  }

  it('cancels a historical pending request without resuming obsolete approval processing', async () => {
    const organizationId = '99999999-9999-4999-8999-999999999999'
    const requestId = '44444444-4444-4444-8444-444444444444'
    const instanceId = '55555555-5555-4555-8555-555555555555'
    const row = { id: requestId, request_no: 'REQ-1', title: 'Test', status: 'cancelled', headcount: 1,
      version: 3, created_at: '2026-10-08T00:00:00.000Z', updated_at: '2026-10-08T00:00:00.000Z' }
    const pool = new FakePool([], [[], [{ id: requestId }], [{ id: requestId, status: 'pending_approval', version: 2 }],
      [row], []])
    const repository = new NormalizedRecruitingRepository(pool, { organizationId })
    await repository.requestApprovalAction(requestId, 'cancel', 'legacy-user', 'Test reason')
    assert.ok(!pool.client.calls.some(({sql}) => /UPDATE approval_(steps|instances)/.test(sql)))
    const update = pool.client.calls.find(({sql}) => sql.startsWith('UPDATE recruitment_requests'))!
    assert.deepEqual(update.values, [requestId, 'cancelled', organizationId])
    assert.equal(pool.client.calls.at(-1)?.sql, 'COMMIT')
  })

  it('deletes an interview by business number in a transaction', async () => {
    const interviewId = '88888888-8888-4888-8888-888888888888'
    const pool = new FakePool([], [[], [{ id: interviewId }], [{ organization_id: '99999999-9999-4999-8999-999999999999' }], [], [], [], [{ id: interviewId }]])
    const repository = new NormalizedRecruitingRepository(pool)

    await repository.deleteInterview('INT-1003')

    assert.equal(pool.client.calls[0]?.sql, 'BEGIN')
    assert.match(pool.client.calls[2]!.sql, /FOR UPDATE/)
    assert.match(pool.client.calls[3]!.sql, /INSERT INTO public.object_cleanup_tasks/)
    assert.match(pool.client.calls[3]!.sql, /'interview'/)
    assert.match(pool.client.calls[4]!.sql, /DELETE FROM public.interview_stored_objects/)
    assert.match(pool.client.calls[5]!.sql, /DELETE FROM public.full_audio_transcription_tasks/)
    assert.match(pool.client.calls[6]!.sql, /DELETE FROM interviews/)
    assert.equal(pool.client.calls.at(-1)?.sql, 'COMMIT')
    assert.deepEqual(pool.client.calls[1]?.values, ['INT-1003'])
    assert.deepEqual(pool.client.calls[6]?.values, [interviewId])
  })

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
    const pool = new FakePool([], [[], [{ id: applicationId }], [{ id: applicationId }], [{ id: userId }], [], [interviewRow], []])
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
    const pool = new FakePool([], [[], [{ id: applicationId }], [{ id: applicationId }], [], [interviewRow]])
    const repository = new NormalizedRecruitingRepository(pool)

    const result = await repository.createInterview({ applicationId, round: 2, title: '复试', participants: [] })

    const insert = pool.client.calls.find((call) => call.sql.includes('INSERT INTO interviews'))
    assert.equal(insert?.values[4], 'final')
    assert.equal(result.stage, 'final')
  })

  it('rejects third-round interviews at the repository boundary', async () => {
    const applicationId = applicationRow.id
    const pool = new FakePool([], [[], [{ id: applicationId }], [{ id: applicationId }], []])
    const repository = new NormalizedRecruitingRepository(pool)

    await assert.rejects(
      repository.createInterview({ applicationId, round: 3, title: '第三轮', participants: [] }),
      (error: any) => error.code === 'REPOSITORY_VALIDATION_ERROR' && /仅支持初试和复试两轮/u.test(error.message),
    )
  })

  it('rejects a free-text interviewer when no system user matches', async () => {
    const interviewId = '88888888-8888-4888-8888-888888888888'
    const applicationId = applicationRow.id
    const pool = new FakePool([], [[], [{ id: applicationId }], [{ id: applicationId }], [], []])
    const repository = new NormalizedRecruitingRepository(pool)

    await assert.rejects(
      () => repository.createInterview({
        applicationId,
        round: 1,
        title: '技术面',
        participants: [{ userId: '张三', name: '张三', role: 'interviewer', required: true }],
      }),
      /未找到有效面试官/u,
    )
    assert.equal(pool.client.calls.some((call) => call.sql.includes('INSERT INTO interviews')), false)
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
  it('submits a recruitment request directly without writing approval tables', async () => {
    const requestId = '44444444-4444-4444-8444-444444444444'
    const pool = new FakePool([], [
      [],
      [{ id: requestId }],
      [{ id: requestId, status: 'draft', version: 1 }],
      [{ id: requestId, request_no: 'REQ-1001', title: '后端', department_id: null, department_name: null, requested_by: null, headcount: 1, budget_min: null, budget_max: null, reason: '扩编', status: 'approved', version: 2, created_at: '2026-09-10T00:00:00.000Z', updated_at: '2026-09-10T00:00:00.000Z' }],
      [],
    ])
    const repository = new NormalizedRecruitingRepository(pool)

    const result = await repository.requestApprovalAction(requestId, 'submit', '77777777-7777-4777-8777-777777777777')

    assert.equal(result.status, 'approved')
    assert.ok(!pool.client.calls.some((call) => /INSERT INTO approval_/.test(call.sql)))
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

    await assert.rejects(repository.requestApprovalAction(requestId, 'reject', '77777777-7777-4777-8777-777777777777', '预算不足'), /RECRUITMENT_APPROVAL_DISABLED/)
    assert.ok(!pool.client.calls.some((call) => /(?:INSERT INTO|UPDATE) approval_/.test(call.sql)))
    assert.equal(pool.client.calls.at(-1)?.sql, 'ROLLBACK')
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

  it('lists all onboarding tasks for the board and parameterizes an onboarding filter for details', async () => {
    const onboardingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const pool = new FakePool([[], []])
    const repository = new NormalizedRecruitingRepository(pool)

    await repository.listOnboardingTasks()
    await repository.listOnboardingTasks(onboardingId)

    assert.match(pool.calls[0]?.sql ?? '', /FROM onboarding_tasks t JOIN onboarding_records r ON r\.id = t\.onboarding_id/)
    assert.match(pool.calls[0]?.sql ?? '', /ORDER BY t\.category, t\.created_at/)
    assert.deepEqual(pool.calls[0]?.values, [])
    assert.match(pool.calls[1]?.sql ?? '', /t\.onboarding_id = \$1::uuid/)
    assert.deepEqual(pool.calls[1]?.values, [onboardingId])
    assert.ok(!pool.calls[1]?.sql.includes(onboardingId))
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

describe('candidate deletion SQL contract', () => {
  const organizationId = '99999999-9999-4999-8999-999999999999'
  const id = candidateRow.id
  const resumeId = '55555555-5555-4555-8555-555555555555'
  const setup = (protection: unknown[] = [], tasks: unknown[] = []) => new FakePool([], [
    [], [{ id }], [{ id }], [{ id: applicationRow.id }], [{ id: resumeId, storage_key: 'resume.txt' }],
    protection, tasks, [], [], [], [], [{ id }], [],
  ])

  it('scopes candidate list to the active enterprise', async () => {
    const pool = new FakePool([[]])
    await new NormalizedRecruitingRepository(pool, { organizationId }).listCandidates()
    assert.match(pool.calls[0]!.sql, /WHERE c.organization_id = \$1::uuid/)
    assert.deepEqual(pool.calls[0]!.values, [organizationId])
  })

  it('cleans up dependent rows and writes an audit event atomically', async () => {
    const pool = setup()
    const keys = await new NormalizedRecruitingRepository(pool, { organizationId }).deleteCandidate(id)
    assert.deepEqual(keys, ['resume.txt'])
    const calls = pool.client.calls
    assert.match(calls[1]!.sql, /organization_id/)
    assert.deepEqual(calls[1]!.values, [id, organizationId])
    for (const table of ['candidates', 'applications', 'resumes', 'analysis_tasks', 'analysis_results']) {
      const deletion = calls.find((call) => call.sql.includes(`DELETE FROM ${table}`))!
      assert.match(deletion.sql, /organization_id = \$[23]::uuid/)
      assert.equal(deletion.values.at(-1), organizationId)
    }
    assert.ok(calls.find((call) => call.sql.includes('INSERT INTO workflow_events')))
    assert.equal(calls.at(-1)!.sql, 'COMMIT')
  })

  it('refuses a cross-enterprise or missing candidate without deleting anything', async () => {
    const pool = new FakePool([], [[], []])
    await assert.rejects(new NormalizedRecruitingRepository(pool, { organizationId }).deleteCandidate(id), /not found/i)
    assert.match(pool.client.calls[1]!.sql, /organization_id/)
    assert.equal(pool.client.calls.at(-1)!.sql, 'ROLLBACK')
    assert.ok(!pool.client.calls.some((call) => call.sql.startsWith('DELETE')))
  })

  for (const [description, protection, tasks, code] of [
    ['existing interview or offer', [{ id: applicationRow.id }], [], 'CANDIDATE_IN_USE'],
    ['running analysis', [], [{ status: 'processing' }], 'CANDIDATE_ANALYSIS_IN_PROGRESS'],
  ] as const) {
    it(`rolls back when there is ${description}`, async () => {
      const pool = setup([...protection], [...tasks])
      await assert.rejects(new NormalizedRecruitingRepository(pool, { organizationId }).deleteCandidate(id), (error: any) => error.code === code && error.status === 409)
      assert.equal(pool.client.calls.at(-1)!.sql, 'ROLLBACK')
      assert.ok(!pool.client.calls.some((call) => call.sql.startsWith('DELETE')))
    })
  }
})

describe('offer template SQL contract', () => {
  it('serializes regular salary without a stale or null initial salary', async () => {
    const id = '88888888-8888-4888-8888-888888888888'
    const baseSalary = { amount: 10000, currency: 'CNY' }
    const salary = prepareOfferSalary({ probationSalary: null, templateFields: { probationSalaryMonths: '0', formalSalaryStartMonth: '1' } }, {
      employmentType: 'full_time', templateFields: { probationDuration: '3个月', probationSalaryMonths: '1', formalSalaryStartMonth: '2' },
      compensation: { baseSalary, probationSalary: { amount: 8000, currency: 'CNY' } },
    })
    const compensation = { baseSalary: salary.baseSalary, ...(salary.probationSalary ? { probationSalary: salary.probationSalary } : {}) }
    const row = { id, offer_id: id, version: 2, position_title: 'Engineer', department_id: candidateRow.id,
      employment_type: 'full_time', start_date: null, reporting_location: null, invoice_title: null, tax_number: null,
      compensation, template_fields: salary.templateFields, benefits: [], materials: [], content: '<p>Original terms</p>', created_at: '2026-11-27T00:00:00Z' }
    const pool = new FakePool([], [[], [{ id }], [{ id: candidateRow.id }], [{ next: 2 }], [row], []])
    const saved = await new NormalizedRecruitingRepository(pool).createOfferVersion({ offerId: id, positionTitle: row.position_title,
      departmentId: candidateRow.id, employmentType: 'full_time', templateFields: salary.templateFields, compensation, content: row.content })
    const insert = pool.client.calls.find(call => call.sql.startsWith('INSERT INTO offer_versions'))!
    assert.deepEqual(JSON.parse(String(insert.values[10])), { baseSalary })
    assert.deepEqual(JSON.parse(String(insert.values[14])), { probationDuration: '3个月', probationSalaryMonths: '0', formalSalaryStartMonth: '1' })
    assert.deepEqual(saved.compensation, { baseSalary })
    assert.equal(saved.templateFields?.probationSalaryMonths, '0')
    assert.ok(!pool.client.calls.some(call => call.sql.startsWith('UPDATE offer_versions')))
    assert.equal(pool.client.calls.at(-1)?.sql, 'COMMIT')
  })

  it('persists and reads Offer invoice details with aligned SQL placeholders', async () => {
    const id = '88888888-8888-4888-8888-888888888888'
    const row = {
      id, offer_id: id, version: 1, position_title: '测试岗位', department_id: candidateRow.id,
      employment_type: 'full_time', start_date: null, reporting_location: null,
      invoice_title: '测试公司', tax_number: 'TEST9133', compensation: {}, benefits: [], materials: [],
      content: '<p>Offer</p>', created_at: '2026-11-07T00:00:00.000Z',
    }
    const pool = new FakePool([], [[], [{ id }], [{ id: candidateRow.id }], [{ next: 1 }], [row], []])
    const saved = await new NormalizedRecruitingRepository(pool).createOfferVersion({
      offerId: id, version: 1, positionTitle: row.position_title, departmentId: candidateRow.id,
      employmentType: 'full_time', invoiceTitle: '测试公司', taxNumber: 'TEST9133', compensation: {}, content: row.content,
    })
    assert.equal(saved.invoiceTitle, '测试公司')
    assert.equal(saved.taxNumber, 'TEST9133')
    const insert = pool.client.calls.find(call => call.sql.startsWith('INSERT INTO offer_versions'))!
    assert.match(insert.sql, /invoice_title, tax_number/u)
    assert.match(insert.sql, /\$11::jsonb, \$12::jsonb, \$13::jsonb, \$14/u)
    assert.equal(insert.values.length, 15)
    assert.deepEqual(insert.values.slice(8, 10), ['测试公司', 'TEST9133'])
  })
  it('deactivates the current default template and clears its default flag', async () => {
    const organizationId = '99999999-9999-4999-8999-999999999999'
    const pool = new FakePool([], [
      [],
      [offerTemplateRow],
      [{ ...offerTemplateRow, is_active: false, is_default: false }],
      [],
    ])
    const repository = new NormalizedRecruitingRepository(pool, { organizationId })

    const updated = await repository.updateOfferTemplate(offerTemplateRow.id, { isActive: false })

    assert.equal(updated.isActive, false)
    assert.equal(updated.isDefault, false)
    const update = pool.client.calls.find((call) => call.sql.startsWith('UPDATE offer_templates SET is_active'))
    assert.ok(update)
    assert.match(update.sql, /is_default = \$2/)
    assert.deepEqual(update.values.slice(0, 2), [false, false])
    assert.equal(pool.client.calls.at(-1)?.sql, 'COMMIT')
  })
})

describe('offer workflow transition SQL contract', () => {
  const offerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const versionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const actorId = '77777777-7777-4777-8777-777777777777'
  const offerRow = {
    id: offerId,
    application_id: applicationRow.id,
    status: 'sent',
    current_version_id: versionId,
    approval_status: 'approved',
    sent_at: '2026-11-01T08:00:00.000Z',
    responded_at: null,
    expires_at: null,
    version: 2,
    created_at: '2026-11-01T07:00:00.000Z',
    updated_at: '2026-11-01T08:00:00.000Z',
  }
  const sentApplicationRow = { ...applicationRow, status: 'offer_sent' }
  const transitionInput = {
    action: 'resend' as const,
    fromStatus: 'sent' as const,
    toStatus: 'sent' as const,
    applicationStatus: 'offer_sent' as const,
    actorId,
  }

  it('updates the Offer and application, writes both audit events, and commits atomically', async () => {
    const pool = new FakePool([], [
      [],
      [offerRow],
      [],
      [],
      [offerRow],
      [sentApplicationRow],
      [{ id: versionId }],
      [{ ...offerRow, version: 3 }],
      [sentApplicationRow],
      [{ id: actorId }],
      [],
      [{ id: actorId }],
      [],
      [],
    ])
    const repository = new NormalizedRecruitingRepository(pool)

    const result = await repository.transitionOffer(offerId, transitionInput)

    assert.equal(result.offer.version, 3)
    assert.equal(result.offer.sentAt, offerRow.sent_at)
    assert.equal(result.offer.currentVersionId, versionId)
    assert.equal(result.application.status, 'offer_sent')
    const calls = pool.client.calls
    const offerUpdate = calls.find((call) => call.sql.startsWith('UPDATE offers'))!
    assert.match(offerUpdate.sql, /sent_at = COALESCE\(sent_at, now\(\)\)/)
    assert.match(offerUpdate.sql, /version = version \+ 1/)
    assert.ok(calls.find((call) => call.sql.startsWith('UPDATE applications')))
    assert.equal(calls.filter((call) => call.sql.includes('INSERT INTO workflow_events')).length, 2)
    assert.ok(!calls.some((call) => call.sql.startsWith('UPDATE offer_versions')))
    assert.equal(calls[0]?.sql, 'BEGIN')
    assert.equal(calls.at(-1)?.sql, 'COMMIT')
  })

  it('rolls back both status updates when the second audit event cannot be written', async () => {
    let workflowEventWrites = 0
    const pool = new FakePool([], [
      [],
      [offerRow],
      [],
      [],
      [offerRow],
      [sentApplicationRow],
      [{ id: versionId }],
      [{ ...offerRow, version: 3 }],
      [sentApplicationRow],
      [{ id: actorId }],
      [],
      [{ id: actorId }],
      [],
    ], (sql) => {
      if (sql.includes('INSERT INTO workflow_events') && ++workflowEventWrites === 2) {
        return new Error('模拟第二条审计事件写入失败')
      }
      return undefined
    })
    const repository = new NormalizedRecruitingRepository(pool)

    await assert.rejects(repository.transitionOffer(offerId, transitionInput), /模拟第二条审计事件写入失败/)

    assert.equal(pool.client.calls.at(-1)?.sql, 'ROLLBACK')
    assert.ok(!pool.client.calls.some((call) => call.sql === 'COMMIT'))
  })

  it('rolls back when the Offer status changes before the row lock is acquired', async () => {
    const pool = new FakePool([], [
      [],
      [offerRow],
      [],
      [],
      [{ ...offerRow, status: 'declined' }],
    ])
    const repository = new NormalizedRecruitingRepository(pool)

    await assert.rejects(
      repository.transitionOffer(offerId, transitionInput),
      (error: any) => error.code === 'OFFER_INVALID_TRANSITION',
    )

    assert.equal(pool.client.calls.at(-1)?.sql, 'ROLLBACK')
    assert.ok(!pool.client.calls.some((call) => call.sql.startsWith('UPDATE offers')))
    assert.ok(!pool.client.calls.some((call) => call.sql.includes('INSERT INTO workflow_events')))
  })
})
