import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NormalizedRecruitingRepository } from './postgres-repository.js'
import type { RepositoryClient, RepositoryPool } from './types.js'
import { RecruitingWorkflowError } from '../workflow.js'

function failingPool(error: unknown) {
  const calls: string[] = []
  let released = false
  const query = async <T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> => {
    calls.push(sql)
    if (sql.includes('INSERT INTO applications')) throw error
    const rows = sql.includes('FROM candidates') || sql.includes('FROM jobs') ? [{ id: values[0] }] : []
    return { rows: rows as unknown as T[] }
  }
  const client: RepositoryClient = { query, release() { released = true } }
  const pool: RepositoryPool = { query, async connect() { return client }, async end() {} }
  return { repository: new NormalizedRecruitingRepository(pool), calls, released: () => released }
}
const input = { candidateId: '11111111-1111-4111-8111-111111111111', jobId: '33333333-3333-4333-8333-333333333333' }
test('duplicate candidate/job application maps to 409 only after transaction rollback', async () => {
  const fixture = failingPool({ code: '23505', constraint: 'applications_candidate_id_job_id_key' })
  await assert.rejects(fixture.repository.createApplication(input), (error: unknown) => {
    assert.ok(error instanceof RecruitingWorkflowError)
    assert.equal(error.code, 'APPLICATION_ALREADY_EXISTS'); assert.equal(error.status, 409)
    assert.match(error.message, /安排面试/); assert.doesNotMatch(error.message, /unique|applications_candidate_id_job_id_key/i)
    return true
  })
  assert.equal(fixture.calls[0], 'BEGIN'); assert.equal(fixture.calls.at(-1), 'ROLLBACK')
  assert.ok(!fixture.calls.includes('COMMIT')); assert.equal(fixture.released(), true)
})
for (const error of [{ code: '23505', constraint: 'applications_application_no_key' }, { code: '08006', constraint: 'applications_candidate_id_job_id_key' }, new Error('database unavailable')]) {
  test(`does not misclassify other database failures: ${JSON.stringify(error)}`, async () => {
    const fixture = failingPool(error)
    await assert.rejects(fixture.repository.createApplication(input), (actual: unknown) => actual === error)
    assert.equal(fixture.calls.at(-1), 'ROLLBACK'); assert.equal(fixture.released(), true)
  })
}
