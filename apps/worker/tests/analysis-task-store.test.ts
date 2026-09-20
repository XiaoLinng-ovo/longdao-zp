import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
    assert.match(client.calls[1]?.text ?? '', /FOR UPDATE SKIP LOCKED/)
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
    assert.match(insert.text, /VALUES \(\$1, \$2, \$3, \$4, \$5::jsonb/)
    assert.deepEqual(client.calls.map((call) => call.text === 'BEGIN' || call.text === 'COMMIT'), [true, false, false, false, true])
  })

  it('backfills the candidate profile from the completed analysis result', async () => {
    const completedTask = { ...taskRow, completed_at: '2026-09-10T00:00:10.000Z', available_at: '2026-09-10T00:00:10.000Z', status: 'completed' as const }
    const client = new MockClient(rows(taskRow), rows(resultRow), rows(), rows(completedTask))
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
    assert.deepEqual(profileUpdate.values, ['resume-1', '张伟', 'zhangwei@example.com', '13800138000'])
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
