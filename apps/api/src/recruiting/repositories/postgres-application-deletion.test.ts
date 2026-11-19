import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NormalizedRecruitingRepository } from './postgres-repository.js'
import type { RepositoryClient, RepositoryPool } from './types.js'

const applicationId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
function fixture(options: { missing?: boolean; processing?: boolean; protectedRecord?: boolean } = {}) {
  const calls: { sql: string; values: readonly unknown[] }[] = []
  let released = false
  const query: RepositoryClient['query'] = async (sql, values = []) => {
    calls.push({ sql, values })
    let rows: Record<string, unknown>[] = []
    if (sql.startsWith('SELECT id FROM applications')) rows = options.missing ? [] : [{ id: applicationId }]
    if (sql.startsWith('SELECT id, candidate_id FROM applications')) rows = [{ id: applicationId, candidate_id: 'candidate-id' }]
    if (sql.includes('UNION ALL SELECT id FROM offers')) rows = options.protectedRecord ? [{ id: 'interview' }] : []
    if (sql.startsWith('SELECT status FROM analysis_tasks')) rows = [{ status: options.processing ? 'processing' : 'queued' }]
    if (sql.startsWith('DELETE FROM applications')) rows = [{ id: applicationId }]
    return { rows: rows as never[] }
  }
  const client: RepositoryClient = { query, release() { released = true } }
  const pool: RepositoryPool = { query, async connect() { return client }, async end() {} }
  return { repository: new NormalizedRecruitingRepository(pool, { organizationId }), calls, released: () => released }
}

test('application deletion is transactional, tenant scoped, and never deletes shared files or siblings', async () => {
  const { repository, calls, released } = fixture()
  await repository.deleteApplication(applicationId)
  assert.equal(calls[0]!.sql, 'BEGIN'); assert.equal(calls.at(-1)!.sql, 'COMMIT'); assert.ok(released())
  const deletes = calls.filter((call) => call.sql.startsWith('DELETE'))
  assert.equal(deletes.length, 3)
  for (const { sql, values } of deletes) {
    assert.match(sql, /organization_id = \$2::uuid/)
    assert.deepEqual(values, [applicationId, organizationId])
    assert.doesNotMatch(sql, /resume_id|candidate_id|ANY|DELETE FROM (candidates|resumes)/)
  }
  assert.ok(calls.some(({ sql }) => sql.includes('UPDATE resumes SET application_id = NULL')))
  assert.ok(calls.some(({ sql }) => sql.includes('INSERT INTO workflow_events')))
  assert.ok(calls.some(({ sql }) => sql.includes('analysis_tasks') && sql.includes('FOR UPDATE')))
})
for (const [options, code] of [[{ missing: true }, 'REPOSITORY_NOT_FOUND'], [{ processing: true }, 'APPLICATION_ANALYSIS_IN_PROGRESS'], [{ protectedRecord: true }, 'APPLICATION_IN_USE']] as const) {
  test(`application deletion rolls back for ${code}`, async () => {
    const { repository, calls, released } = fixture(options)
    await assert.rejects(repository.deleteApplication(applicationId), (error: any) => error.code === code)
    assert.equal(calls.at(-1)!.sql, 'ROLLBACK'); assert.ok(released())
    assert.ok(!calls.some(({ sql }) => /^(DELETE|UPDATE|INSERT)/.test(sql)))
  })
}
