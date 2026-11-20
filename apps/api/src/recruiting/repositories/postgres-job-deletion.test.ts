import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NormalizedRecruitingRepository } from './postgres-repository.js'
import type { RepositoryClient, RepositoryPool } from './types.js'

const jobId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
function fixture(options: { missing?: boolean; inUse?: boolean; fkRace?: boolean; auditFailure?: boolean } = {}) {
  const calls: { sql: string; values: readonly unknown[] }[] = []
  let released = false
  const query: RepositoryClient['query'] = async (sql, values = []) => {
    calls.push({ sql, values })
    let rows: Record<string, unknown>[] = []
    if (sql.startsWith('SELECT id FROM jobs')) rows = options.missing ? [] : [{ id: jobId }]
    if (sql.startsWith('SELECT id, title FROM jobs')) rows = options.missing ? [] : [{ id: jobId, title: '待删除岗位' }]
    if (sql.startsWith('SELECT id FROM applications')) rows = options.inUse ? [{ id: 'application' }] : []
    if (sql.startsWith('DELETE FROM jobs')) {
      if (options.fkRace) throw Object.assign(new Error('FK reference'), { code: '23503' })
      rows = [{ id: jobId }]
    }
    if (sql.includes('INSERT INTO workflow_events') && options.auditFailure) throw new Error('audit failed')
    return { rows: rows as never[] }
  }
  const client: RepositoryClient = { query, release() { released = true } }
  const pool: RepositoryPool = { query, async connect() { return client }, async end() {} }
  return { repository: new NormalizedRecruitingRepository(pool, { organizationId }), calls, released: () => released }
}
test('job deletion locks the row, is tenant scoped, audits, and never deletes candidate data', async () => {
  const { repository, calls, released } = fixture()
  await repository.deleteJob('JOB-42')
  assert.equal(calls[0]!.sql, 'BEGIN'); assert.equal(calls.at(-1)!.sql, 'COMMIT'); assert.ok(released())
  const lock = calls.find(call => call.sql.includes('FOR UPDATE'))!
  assert.match(lock.sql, /organization_id = \$2::uuid/)
  assert.deepEqual(lock.values, [jobId, organizationId])
  const deletes = calls.filter(call => call.sql.startsWith('DELETE'))
  assert.equal(deletes.length, 1)
  assert.match(deletes[0]!.sql, /DELETE FROM jobs.*organization_id = \$2::uuid/)
  assert.deepEqual(deletes[0]!.values, [jobId, organizationId])
  assert.ok(calls.some(call => call.sql.includes('INSERT INTO workflow_events')))
})
for (const [options, code] of [[{ missing: true }, 'REPOSITORY_NOT_FOUND'], [{ inUse: true }, 'JOB_IN_USE'], [{ fkRace: true }, 'JOB_IN_USE']] as const) {
  test(`job deletion rolls back for ${JSON.stringify(options)}`, async () => {
    const { repository, calls, released } = fixture(options)
    await assert.rejects(repository.deleteJob(jobId), (error: any) => error.code === code)
    assert.equal(calls.at(-1)!.sql, 'ROLLBACK'); assert.ok(released())
    if (!('fkRace' in options)) assert.ok(!calls.some(call => /^(DELETE|INSERT|UPDATE)/.test(call.sql)))
  })
}
test('audit failure rolls back job deletion', async () => {
  const { repository, calls } = fixture({ auditFailure: true })
  await assert.rejects(repository.deleteJob(jobId), /audit failed/)
  assert.equal(calls.at(-1)!.sql, 'ROLLBACK')
})
