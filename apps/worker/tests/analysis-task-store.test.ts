import assert from 'node:assert/strict'
import { describe, it, test } from 'node:test'
import {
  AnalysisTaskLeaseLostError,
  PostgresAnalysisTaskStore,
  type PgClient,
  type PgPool,
  type PgQueryResult,
} from '../src/db/analysis-task-store.js'

type QueryCall = { text: string; values: unknown[] }

const taskRow = {
  id: 'task-1',
  resume_id: 'resume-1',
  application_id: 'application-1',
  status: 'processing' as const,
  attempts: 1,
  idempotency_key: 'resume-analysis:resume-1:hash-1',
  last_error: null,
  available_at: '2026-09-10T00:01:00.000Z',
  started_at: '2026-09-10T00:00:00.000Z',
  completed_at: null,
  created_at: '2026-09-09T23:00:00.000Z',
}

const resultRow = {
  id: 'result-1',
  analysis_task_id: 'task-1',
  resume_id: 'resume-1',
  application_id: 'application-1',
  result: { taskType: 'resume-analysis', status: 'completed' },
  analyzer_version: null,
  input_hash: null,
  human_review_status: 'pending' as const,
  created_at: '2026-09-10T00:00:10.000Z',
}

class MockClient implements PgClient {
  readonly calls: QueryCall[] = []
  released = false
  private readonly responses: Array<PgQueryResult<Record<string, unknown>> | Error>

  constructor(...responses: Array<PgQueryResult<Record<string, unknown>> | Error>) {
    this.responses = [...responses]
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    this.calls.push({ text, values })
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
      return { rows: [] } as PgQueryResult<Row>
    }
    const response = this.responses.shift()
    if (response instanceof Error) throw response
    return (response ?? { rows: [] }) as PgQueryResult<Row>
  }

  release(): void {
    this.released = true
  }
}

class MockPool implements PgPool {
  constructor(readonly client: MockClient) {}

  async connect(): Promise<PgClient> {
    return this.client
  }
}

function rows<T extends Record<string, unknown>>(...items: T[]): PgQueryResult<Record<string, unknown>> {
  return { rows: items as Record<string, unknown>[] }
}

void describe('PostgresAnalysisTaskStore SQL contract', () => {
  it('persists identity with tenant joins, fencing and manual-value preservation', async () => {
    const client = new MockClient(rows(taskRow), rows({ name: '人工姓名' }), rows({ id: 'candidate-1' }))
    await new PostgresAnalysisTaskStore(new MockPool(client)).saveExtractedCandidate({ taskId: 'task-1', attempt: 1, candidate: { fullName: '胡俊杰', email: 'test@example.test' } })
    assert.match(client.calls[1]!.text, /FOR UPDATE/u)
    const update = client.calls[3]!
    assert.match(update.text, /c\.organization_id = t\.organization_id/u)
    assert.match(update.text, /r\.organization_id = t\.organization_id/u)
    assert.match(update.text, /a\.candidate_id = r\.candidate_id/u)
    assert.match(update.text, /t\.attempts = \$6/u)
    assert.match(update.text, /ELSE c\.name END/u)
    assert.match(update.text, /COALESCE\(NULLIF\(c\.email, ''\), NULLIF\(\$3, ''\)\)/u)
    assert.deepEqual(update.values.slice(0, 4), ['task-1', '胡俊杰', 'test@example.test', ''])
    assert.equal(update.values[6], null)
    assert.equal(client.calls.at(-1)!.text, 'COMMIT')
    assert.ok(client.calls.every((call) => !/analysis_results|SET status/u.test(call.text)))
  })

  it('repairs a persisted Unicode compatibility glyph in the candidate name', async () => {
    const client = new MockClient(rows(taskRow), rows({ name: '林北⾠' }), rows({ id: 'candidate-1' }))
    await new PostgresAnalysisTaskStore(new MockPool(client)).saveExtractedCandidate({ taskId: 'task-1', attempt: 1, candidate: { fullName: '林北⾠' } })
    const update = client.calls[3]!
    assert.equal(update.values[1], '林北辰')
    assert.equal(update.values[6], '林北⾠')
  })

  it('rejects stale identity writes and rolls back mismatched candidate scope', async () => {
    for (const row of [{ ...taskRow, attempts: 2 }, { ...taskRow, status: 'completed' }, taskRow]) {
      const client = new MockClient(rows(row), rows(), rows())
      const store = new PostgresAnalysisTaskStore(new MockPool(client))
      await assert.rejects(store.saveExtractedCandidate({ taskId: 'task-1', attempt: 1, candidate: { fullName: '胡俊杰' } }))
      assert.equal(client.calls.at(-1)!.text, 'ROLLBACK')
      if (row !== taskRow) assert.equal(client.calls.length, 3)
    }
  })

  it('locks and conditionally repairs a matching name with appended personal fields', async () => {
    for (const existingName of ['张惠亭 政治面貌：共青团员', '张 惠 亭｜民 族：汉', '王思远 政治面貌：群众', '张惠亭（人工确认）']) {
      const client = new MockClient(rows(taskRow), rows({ name: existingName }), rows({ id: 'candidate-1' }))
      await new PostgresAnalysisTaskStore(new MockPool(client)).saveExtractedCandidate({ taskId: 'task-1', attempt: 1, candidate: { fullName: '张惠亭' } })
      assert.match(client.calls[2]!.text, /FOR UPDATE OF c/u)
      assert.match(client.calls[2]!.text, /c\.organization_id/u)
      const update = client.calls[3]!
      assert.match(update.text, /OR c\.name = \$7/u)
      assert.equal(update.values[6], existingName.startsWith('王') || existingName.includes('人工') ? null : existingName)
    }
  })

  it('does not persist an invalid extracted name', async () => {
    const client = new MockClient()
    await new PostgresAnalysisTaskStore(new MockPool(client)).saveExtractedCandidate({ taskId: 'task-1', attempt: 1, candidate: { fullName: '张惠亭 政治面貌：群众' } })
    assert.equal(client.calls.length, 0)
  })

  it('claims one due task with a transactional SKIP LOCKED update and increments attempts once', async () => {
    const client = new MockClient(rows(taskRow))
    const store = new PostgresAnalysisTaskStore(new MockPool(client))

    const lease = await store.claimNextTask({
      maxAttempts: 3,
      leaseDurationMs: 60_000,
      now: '2026-09-10T00:00:00.000Z',
    })

    assert.equal(lease?.attempt, 1)
    assert.equal(lease?.task.status, 'processing')
    assert.match(client.calls[1]?.text ?? '', /WITH expired AS/)
    assert.match(client.calls[1]?.text ?? '', /attempts >= \$3::integer AND available_at <= \$1::timestamptz/)
    assert.match(client.calls[1]?.text ?? '', /SET status = 'failed', completed_at = \$1::timestamptz/)
    assert.match(client.calls[1]?.text ?? '', /FOR UPDATE SKIP LOCKED/)
    assert.match(client.calls[1]?.text ?? '', /organization_service_available\(at\.organization_id\)/)
    assert.match(client.calls[1]?.text ?? '', /attempts = at\.attempts \+ 1/)
    assert.deepEqual(client.calls[1]?.values, [
      '2026-09-10T00:00:00.000Z',
      '2026-09-10T00:01:00.000Z',
      3,
    ])
    assert.deepEqual(client.calls.map((call) => call.text), ['BEGIN', client.calls[1]?.text, 'COMMIT'])
    assert.equal(client.released, true)
  })

  it('only claims resumes whose virus scan status is clean', async () => {
    const client = new MockClient(rows(taskRow))
    const store = new PostgresAnalysisTaskStore(new MockPool(client))

    await store.claimNextTask({
      maxAttempts: 3,
      leaseDurationMs: 60_000,
      now: '2026-09-10T00:00:00.000Z',
    })

    const claimSql = client.calls[1]?.text ?? ''
    assert.match(claimSql, /JOIN resumes AS r ON r\.id = at\.resume_id/)
    assert.match(claimSql, /r\.scan_status = 'clean'/)
  })

  it('writes the result and completed status in one transaction with parameterized JSON', async () => {
    const completedTask = { ...taskRow, completed_at: '2026-09-10T00:00:10.000Z', available_at: '2026-09-10T00:00:10.000Z', status: 'completed' as const }
    const client = new MockClient(rows(taskRow), rows(resultRow), rows(completedTask))
    const store = new PostgresAnalysisTaskStore(new MockPool(client))

    const completion = await store.completeTask({
      taskId: 'task-1',
      attempt: 1,
      result: { answer: '$1 should remain data, not SQL' },
      completedAt: '2026-09-10T00:00:10.000Z',
    })

    assert.equal(completion.task.status, 'completed')
    assert.deepEqual(completion.result.result, resultRow.result)
    const insert = client.calls.find((call) => call.text.includes('INSERT INTO analysis_results'))
    assert.ok(insert)
    assert.equal(insert.values[4], JSON.stringify({ answer: '$1 should remain data, not SQL' }))
    assert.match(insert.text, /SELECT \$1::uuid, t\.id, t\.resume_id, t\.application_id, \$5::jsonb/)
    assert.match(insert.text, /created_at, organization_id/)
    assert.match(insert.text, /t\.organization_id/)
    assert.match(insert.text, /c\.organization_id = t\.organization_id/)
    assert.deepEqual(client.calls.map((call) => call.text === 'BEGIN' || call.text === 'COMMIT'), [true, false, false, false, true])
  })

  it('backfills the candidate profile from the completed analysis result', async () => {
    const completedTask = { ...taskRow, completed_at: '2026-09-10T00:00:10.000Z', available_at: '2026-09-10T00:00:10.000Z', status: 'completed' as const }
    const client = new MockClient(rows(taskRow), rows(resultRow), rows({ name: '张伟 政治面貌：群众' }), rows(), rows(completedTask))
    const store = new PostgresAnalysisTaskStore(new MockPool(client))

    await store.completeTask({
      taskId: 'task-1',
      attempt: 1,
      result: {
        analysis: {
          report: {
            extraction: {
              candidate: { fullName: '张伟', email: 'zhangwei@example.com', phone: '13800138000' },
            },
          },
        },
      },
      completedAt: '2026-09-10T00:00:10.000Z',
    })

    const profileUpdate = client.calls.find((call) => call.text.includes('UPDATE candidates'))
    assert.ok(profileUpdate)
    assert.deepEqual(profileUpdate.values.slice(0, 4), ['resume-1', '张伟', 'zhangwei@example.com', '13800138000'])
    assert.ok((profileUpdate.values[4] as string[]).includes('personal resume'))
    assert.ok((profileUpdate.values[4] as string[]).includes('现居'))
    assert.equal(profileUpdate.values[5], '张伟 政治面貌：群众')
    assert.match(profileUpdate.text, /OR name = \$6/u)
  })

  it('rolls back a fenced status update when the attempt is stale', async () => {
    const reclaimedTask = { ...taskRow, attempts: 2, status: 'processing' as const }
    const client = new MockClient(rows(reclaimedTask))
    const store = new PostgresAnalysisTaskStore(new MockPool(client))

    await assert.rejects(
      store.failTask({ taskId: 'task-1', attempt: 1, maxAttempts: 3, error: 'old worker failed' }),
      AnalysisTaskLeaseLostError,
    )
    assert.equal(client.calls.at(-1)?.text, 'ROLLBACK')
    assert.equal(client.released, true)
  })

  it('uses an idempotency key join for completed result lookup', async () => {
    const row = { ...resultRow, idempotency_key: 'idem-1', attempts: 2 }
    const client = new MockClient(rows(row))
    const store = new PostgresAnalysisTaskStore(new MockPool(client))

    const result = await store.getResultByIdempotencyKey('idem-1')

    assert.equal(result?.analysisTaskId, 'task-1')
    assert.deepEqual(client.calls[0]?.values, ['idem-1'])
    assert.match(client.calls[0]?.text ?? '', /INNER JOIN analysis_tasks AS at/)
  })

  it('advances resume scan status monotonically before analysis is claimable', async () => {
    const client = new MockClient(rows({ id: 'resume-1', scan_status: 'clean' }))
    const store = new PostgresAnalysisTaskStore(new MockPool(client))

    const status = await store.updateResumeScanStatus('resume-1', 'clean')

    assert.equal(status, 'clean')
    assert.match(client.calls[0]?.text ?? '', /UPDATE resumes\s+SET scan_status = \$2/)
    assert.match(client.calls[0]?.text ?? '', /scan_status = 'quarantined'/)
    assert.deepEqual(client.calls[0]?.values, ['resume-1', 'clean'])
  })

  it('atomically claims the oldest quarantined resume for scanning', async () => {
    const client = new MockClient(rows({ id: 'resume-1', storage_key: 'resume.pdf' }))
    const store = new PostgresAnalysisTaskStore(new MockPool(client))

    const claimed = await store.claimNextResumeForScan()

    assert.deepEqual(claimed, { resumeId: 'resume-1', storageKey: 'resume.pdf' })
    assert.match(client.calls[1]?.text ?? '', /FOR UPDATE SKIP LOCKED/)
    assert.match(client.calls[1]?.text ?? '', /scan_status = 'quarantined'/)
  })
})

void describe('job scoring Skill lookup', () => {
  it('loads only the exact job enabled scoring rule and converts its timestamp', async () => {
    const client = new MockClient(rows({ id: 'skill-1', name: '后端评分', content: '经验 100 分', updated_at: new Date('2026-10-08T00:00:00.000Z') }))
    const result = await new PostgresAnalysisTaskStore(new MockPool(client)).getJobScoringSkill('job-1')
    assert.deepEqual(result, { id: 'skill-1', name: '后端评分', content: '经验 100 分', updatedAt: '2026-10-08T00:00:00.000Z' })
    assert.deepEqual(client.calls[0]?.values, ['job-1'])
    assert.match(client.calls[0]?.text ?? '', /b.job_id = \$1 AND s.target_type = 'resume_score' AND s.is_active = true/)
    assert.equal(client.released, true)
  })
  it('returns no Skill for unbound or disabled jobs and releases on query failures', async () => {
    const client = new MockClient(rows())
    assert.equal(await new PostgresAnalysisTaskStore(new MockPool(client)).getJobScoringSkill('job-2'), undefined)
    assert.equal(client.released, true)
    const failing = new MockClient(new Error('database unavailable'))
    await assert.rejects(new PostgresAnalysisTaskStore(new MockPool(failing)).getJobScoringSkill('job-2'), /database unavailable/)
    assert.equal(failing.released, true)
  })
})


void describe('confirmed scoring context', () => {
  it('loads confirmed tenant-scoped spec and JD and releases the client', async () => {
    const client = new MockClient(rows({ title: '后端', spec_content: { confirmed: false, requirements: [{ label: '经验', description: '3年', required: true }], skills: ['Python'] }, jd_content: '任职要求\n博士' }))
    const store = new PostgresAnalysisTaskStore(new MockPool(client))
    assert.deepEqual(await store.getJobAnalysisContext('job-1'), { title: '后端', requirements: ['经验：3年'], requirementRequired: [true], skills: ['Python'] })
    assert.equal(client.calls[0]!.text.match(/confirmed_at IS NOT NULL/gu)?.length, 4)
    assert.equal(client.calls[0]!.text.match(/organization_id = j.organization_id/gu)?.length, 2)
    assert.deepEqual(client.calls[0]!.values, ['job-1'])
    assert.equal(client.released, true)
  })
  it('uses confirmed JD when the spec has no requirements', async () => {
    const client = new MockClient(rows({ title: '后端', spec_content: null, jd_content: '任职要求\n本科以上\n技能要求\nPython\n福利待遇\n五险一金' }))
    const context = await new PostgresAnalysisTaskStore(new MockPool(client)).getJobAnalysisContext('job-1')
    assert.deepEqual(context?.requirements, ['本科以上'])
    assert.deepEqual(context?.skills, ['Python'])
  })
  it('returns undefined for missing jobs and releases on query failure', async () => {
    const missing = new MockClient(rows())
    assert.equal(await new PostgresAnalysisTaskStore(new MockPool(missing)).getJobAnalysisContext('missing'), undefined)
    assert.equal(missing.released, true)
    const failed = new MockClient(new Error('db failure'))
    await assert.rejects(new PostgresAnalysisTaskStore(new MockPool(failed)).getJobAnalysisContext('job-1'), /db failure/u)
    assert.equal(failed.released, true)
  })
})


test('job context fails explicitly on enterprise mismatch rather than completing without an AI score', async () => {
  const client = new MockClient(rows({ title: '人事', spec_content: null, jd_content: null, scope_mismatch: true }))
  await assert.rejects(new PostgresAnalysisTaskStore(new MockPool(client)).getJobAnalysisContext('job-1'), /JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH/)
  assert.match(client.calls[0]!.text, /organization_id = j.organization_id/)
  assert.equal(client.released, true)
})
test('genuinely missing job rules stay unscored; confirmed same-tenant rules remain available', async () => {
  const client = new MockClient(
    rows({ title: '人事', spec_content: null, jd_content: null, scope_mismatch: false }),
    rows({ title: '人事', spec_content: { requirements: [{ label: '入离职管理', required: true }], skills: ['考勤管理'] }, jd_content: null, scope_mismatch: false }),
  )
  const store = new PostgresAnalysisTaskStore(new MockPool(client))
  assert.deepEqual(await store.getJobAnalysisContext('job-1'), { title: '人事', requirements: [], requirementRequired: [], skills: [] })
  assert.deepEqual(await store.getJobAnalysisContext('job-1'), { title: '人事', requirements: ['入离职管理'], requirementRequired: [true], skills: ['考勤管理'] })
})


describe('persisted failure retry classification', () => {
  for (const input of [
    { retryable: false, attempt: 1, expected: 'failed' },
    { retryable: true, attempt: 1, expected: 'queued' },
    { retryable: true, attempt: 3, expected: 'failed' },
  ]) {
    it(`writes ${input.expected} at attempt ${input.attempt} (retryable=${input.retryable})`, async () => {
      const client = new MockClient(rows({ ...taskRow, attempts: input.attempt }), rows({ ...taskRow, status: input.expected, attempts: input.attempt }))
      const store = new PostgresAnalysisTaskStore(new MockPool(client))
      const result = await store.failTask({ taskId: 'task-1', attempt: input.attempt, maxAttempts: 3, retryable: input.retryable, error: 'test failure' })
      assert.equal(result.status, input.expected)
      const write = client.calls.find(call => call.text.includes('UPDATE analysis_tasks'))!
      assert.equal(write.values[1], input.expected)
      assert.match(write.text, /status = 'processing' AND attempts = \$5/)
    })
  }
})
