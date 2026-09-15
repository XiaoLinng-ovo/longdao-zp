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
