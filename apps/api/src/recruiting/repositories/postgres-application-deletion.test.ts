import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NormalizedRecruitingRepository } from './postgres-repository.js'
import type { RepositoryClient, RepositoryPool } from './types.js'

const applicationId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const candidateId = '33333333-3333-4333-8333-333333333333'
const resumeId = '44444444-4444-4444-8444-444444444444'
function fixture(options: { missing?: boolean; missingCandidate?: boolean; raced?: boolean; processing?: boolean; protectedRecord?: boolean; sibling?: boolean; shared?: boolean; sharedResultOnly?: boolean; unboundProcessing?: boolean } = {}) {
  const calls: { sql: string; values: readonly unknown[] }[] = []
  let released = false
  const query: RepositoryClient['query'] = async (sql, values = []) => {
    calls.push({ sql, values })
    let rows: Record<string, unknown>[] = []
    if (sql.startsWith('SELECT id FROM applications')) rows = sql.includes('candidate_id')
      ? options.raced ? [] : [{ id: applicationId }, ...(options.sibling ? [{ id: 'sibling' }] : [])]
      : options.missing ? [] : [{ id: applicationId }]
    if (sql.startsWith('SELECT id, candidate_id FROM applications')) rows = [{ id: applicationId, candidate_id: candidateId }]
    if (sql.startsWith('SELECT id, organization_id FROM candidates')) rows = options.missingCandidate ? [] : [{ id: candidateId, organization_id: organizationId }]
    if (sql.startsWith('SELECT id, storage_key, application_id FROM resumes')) rows = [{ id: resumeId, storage_key: 'resume-key', application_id: applicationId }]
    if (sql.includes('UNION ALL SELECT id FROM offers')) rows = options.protectedRecord ? [{ id: 'interview' }] : []
    if (sql.startsWith('SELECT resume_id, application_id, status FROM analysis_tasks')) rows = [
      { resume_id: resumeId, application_id: applicationId, status: options.processing ? 'processing' : 'queued' },
      ...(options.shared ? [{ resume_id: resumeId, application_id: 'sibling', status: 'processing' }] : []),
      ...(options.unboundProcessing ? [{ resume_id: resumeId, application_id: null, status: 'processing' }] : []),
    ]
    if (sql.startsWith('SELECT resume_id, application_id FROM analysis_results')) rows = options.sharedResultOnly ? [{ resume_id: resumeId, application_id: 'sibling' }] : []
    return { rows: rows as never[] }
  }
  const client: RepositoryClient = { query, release() { released = true } }
  const pool: RepositoryPool = { query, async connect() { return client }, async end() {} }
  return { repository: new NormalizedRecruitingRepository(pool, { organizationId }), calls, released: () => released }
}

test('final application deletion atomically cleans candidate, files, AI data and queues physical cleanup', async () => {
  const { repository, calls, released } = fixture()
  assert.deepEqual(await repository.deleteApplication(applicationId), { candidateDeleted: true })
  assert.equal(calls[0]!.sql, 'BEGIN'); assert.equal(calls.at(-1)!.sql, 'COMMIT'); assert.ok(released())
  for (const table of ['applications', 'candidates', 'resumes', 'analysis_tasks', 'analysis_results']) {
    const deletion = calls.find(({ sql }) => sql.startsWith('DELETE FROM ' + table))!
    assert.ok(deletion, table)
    assert.match(deletion.sql, /organization_id = \$[23]::uuid/)
    assert.equal(deletion.values.at(-1), organizationId)
  }
  assert.deepEqual(calls.find(({ sql }) => sql.startsWith('DELETE FROM resumes'))!.values, [[resumeId], organizationId])
  assert.ok(calls.some(({ sql, values }) => sql.includes('public.object_cleanup_tasks') && values[0] === organizationId && values[1] === 'resume-key'))
  assert.equal(calls.filter(({ sql }) => sql.includes('INSERT INTO workflow_events')).length, 2)
  assert.ok(calls.findIndex(({ sql }) => sql.includes('FROM candidates') && sql.includes('FOR UPDATE')) < calls.findIndex(({ sql }) => sql.includes('FROM applications') && sql.includes('FOR UPDATE')))
})
for (const shared of [false, true, 'result-only'] as const) {
  test('sibling application preserves candidate; retains only shared resumes: ' + shared, async () => {
    const { repository, calls } = fixture({ sibling: true, shared: shared === true, sharedResultOnly: shared === 'result-only' })
    assert.deepEqual(await repository.deleteApplication(applicationId), { candidateDeleted: false })
    assert.ok(!calls.some(({ sql }) => sql.startsWith('DELETE FROM candidates')))
    assert.deepEqual(calls.find(({ sql }) => sql.startsWith('DELETE FROM resumes'))!.values[0], shared ? [] : [resumeId])
    assert.equal(calls.filter(({ sql }) => sql.includes('public.object_cleanup_tasks')).length, shared ? 0 : 1)
  })
}
for (const [options, code] of [
  [{ missing: true }, 'REPOSITORY_NOT_FOUND'], [{ missingCandidate: true }, 'REPOSITORY_NOT_FOUND'], [{ raced: true }, 'REPOSITORY_NOT_FOUND'],
  [{ processing: true }, 'APPLICATION_ANALYSIS_IN_PROGRESS'], [{ unboundProcessing: true }, 'APPLICATION_ANALYSIS_IN_PROGRESS'], [{ protectedRecord: true }, 'APPLICATION_IN_USE'],
] as const) {
  test('application deletion rolls back for ' + JSON.stringify(options), async () => {
    const { repository, calls, released } = fixture(options)
    await assert.rejects(repository.deleteApplication(applicationId), (error: any) => error.code === code)
    assert.equal(calls.at(-1)!.sql, 'ROLLBACK'); assert.ok(released())
    assert.ok(!calls.some(({ sql }) => /^(DELETE|UPDATE|INSERT)/.test(sql)))
  })
}
