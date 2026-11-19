import assert from 'node:assert/strict'
import { RecruitingService } from '../src/recruiting/service.js'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { NormalizedRecruitingRepository } from '../src/recruiting/repositories/postgres-repository.js'
import type { RepositoryPool } from '../src/recruiting/repositories/types.js'

test('job specs and JDs inherit parent enterprise; foreign tenant reads, writes and confirmations are rejected', async (context) => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool(), client = await pool.connect()
  // All fixtures and assertions share a rollback-only transaction, invisible to live workers.
  const txPool = { query: client.query.bind(client), async connect() {
    return { query: client.query.bind(client), release() {} }
  }, async end() {} } as RepositoryPool
  // Repository-owned BEGIN/COMMIT are savepoints so no fixture can escape the outer transaction.
  txPool.connect = async () => ({ async query<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
    const command = sql === 'BEGIN' ? 'SAVEPOINT repository_test' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT repository_test' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT repository_test' : sql
    const result = await client.query<Row>(command, [...values])
    return { rows: result.rows }
  }, release() {} })
  const org = randomUUID(), other = randomUUID(), job = randomUUID()
  const repository = new NormalizedRecruitingRepository(txPool, { organizationId: org })
  const foreign = new NormalizedRecruitingRepository(txPool, { organizationId: other })
  const internal = new NormalizedRecruitingRepository(txPool)
  try {
    await client.query('BEGIN')
    for (const id of [org, other]) await client.query("INSERT INTO organizations (id, name, kind) VALUES ($1, 'job-version-scope-test', 'test')", [id])
    await client.query("INSERT INTO jobs (id, organization_id, job_no, title, headcount) VALUES ($1, $2, $3, '人事', 1)", [job, org, 'JOB-' + job])
    const spec = await repository.createJobSpecVersion({ jobId: job, content: { requirements: [{ label: '入离职管理' }] } })
    const jd = await internal.createJobDescriptionVersion({ jobId: job, title: '人事JD', content: '任职要求\n员工档案管理' })
    for (const table of ['job_spec_versions', 'job_description_versions']) {
      assert.equal((await client.query('SELECT organization_id FROM ' + table + ' WHERE job_id = $1', [job])).rows[0]?.organization_id, org)
    }
    assert.ok((await repository.confirmJobSpecVersion(job)).confirmedAt)
    assert.ok((await repository.confirmJobDescriptionVersion(job, jd.version)).confirmedAt)
    assert.equal((await repository.listJobSpecVersions(job))[0]?.id, spec.id)
    assert.equal((await repository.listJobDescriptionVersions(job))[0]?.id, jd.id)
    assert.deepEqual(await foreign.listJobSpecVersions(), [])
    assert.deepEqual(await foreign.listJobDescriptionVersions(), [])
    for (const action of [
      () => foreign.listJobSpecVersions(job), () => foreign.listJobDescriptionVersions(job),
      () => foreign.createJobSpecVersion({ jobId: job, content: {} }),
      () => foreign.createJobDescriptionVersion({ jobId: job, content: '' }),
      () => foreign.confirmJobSpecVersion(job), () => foreign.confirmJobDescriptionVersion(job),
      () => foreign.assertJobAnalysisContextScope(job),
    ]) await assert.rejects(action, (e: unknown) => (e as { code: string }).code === 'REPOSITORY_NOT_FOUND')
    await client.query('UPDATE job_spec_versions SET organization_id = $2 WHERE id = $1', [spec.id, other])
    assert.deepEqual(await repository.listJobSpecVersions(job), [], 'ordinary job details do not leak foreign version content or block remediation')
    for (const action of [() => repository.assertJobAnalysisContextScope(job)]) {
      await assert.rejects(action, (e: unknown) => (e as { code: string }).code === 'JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH')
    }
    // Reproduce the old-resume failure against real PostgreSQL, not only a mock.
    const candidate = randomUUID(), application = randomUUID(), resume = randomUUID()
    await client.query("INSERT INTO candidates (id, organization_id, candidate_no, name) VALUES ($1, $2, $3, 'scope-reanalysis-test')", [candidate, org, 'CAN-' + candidate])
    await client.query("INSERT INTO applications (id, organization_id, application_no, candidate_id, job_id, status) VALUES ($1, $2, $3, $4, $5, 'human_review')", [application, org, 'APP-' + application, candidate, job])
    await client.query("INSERT INTO resumes (id, organization_id, candidate_id, application_id, storage_key, original_filename, mime_type, size_bytes, scan_status) VALUES ($1::uuid, $2, $3, $4, $1::uuid::text, 'resume.txt', 'text/plain', 1, 'clean')", [resume, org, candidate, application])
    const service = new RecruitingService(undefined, undefined, undefined, repository)
    for (const action of [() => service.reanalyzeResume(candidate, resume), () => service.analyzeResumeForApplication(candidate, resume, application)]) {
      await assert.rejects(action, (e: unknown) => (e as { code: string }).code === 'JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH')
    }
    assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM analysis_tasks WHERE application_id = $1', [application])).rows[0]?.count, 0, 'preflight does not enqueue doomed tasks')
    await client.query('UPDATE job_spec_versions SET confirmed_at = NULL WHERE id = $1', [spec.id])
    assert.deepEqual(await repository.listJobSpecVersions(job), [], 'foreign drafts are never read')
    await assert.rejects(repository.confirmJobSpecVersion(job), (e: unknown) => (e as { code: string }).code === 'REPOSITORY_NOT_FOUND')
    await client.query('UPDATE job_spec_versions SET organization_id = $2, confirmed_at = now() WHERE id = $1', [spec.id, org])
    await repository.assertJobAnalysisContextScope(job)
    const task = await service.reanalyzeResume(candidate, resume)
    assert.equal(task.status, 'queued')
    assert.equal(task.attempts, 0)
    assert.equal((await service.analyzeResumeForApplication(candidate, resume, application)).id, task.id, 'active-task reuse remains idempotent')
    assert.equal((await repository.getResume(resume)).applicationId, application)

    // Hidden historical versions still occupy (job_id, version), even though tenant reads omit them.
    await client.query('UPDATE job_spec_versions SET organization_id = $2, confirmed_at = NULL WHERE id = $1', [spec.id, other])
    await client.query('UPDATE job_description_versions SET organization_id = $2, confirmed_at = NULL WHERE id = $1', [jd.id, other])
    assert.deepEqual(await repository.listJobSpecVersions(job), [])
    assert.deepEqual(await repository.listJobDescriptionVersions(job), [])
    const nextSpec = await service.createSpec(job, { title: '新说明书', summary: '新正文', requirements: [], skills: [], responsibilities: [] })
    assert.equal(nextSpec.spec?.version, 2, 'version allocation includes hidden history without reading its content')
    const nextJd = await service.createJd(job, { language: 'zh-CN', content: '新JD正文' })
    assert.equal(nextJd.jd?.version, 2)
    const storedSpec = (await repository.listJobSpecVersions(job))[0]!
    assert.equal(storedSpec.content.version, storedSpec.version, 'JSON metadata agrees with the allocated database version')
    assert.equal((await repository.listJobSpecVersions(job)).length, 1, 'foreign history remains hidden')
    assert.equal((await repository.listJobDescriptionVersions(job)).length, 1)

  } finally {
    try { await client.query('ROLLBACK') } finally { client.release(); await pool.end() }
  }
})

test('concurrent service saves allocate distinct spec and JD versions under the parent job lock', async (context) => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool()
  const org = randomUUID(), job = randomUUID()
  const repository = new NormalizedRecruitingRepository(pool, { organizationId: org })
  const service = new RecruitingService(undefined, undefined, undefined, repository)
  try {
    await pool.query("INSERT INTO organizations (id, name, kind) VALUES ($1, 'concurrent-job-version-test', 'test')", [org])
    await pool.query("INSERT INTO jobs (id, organization_id, job_no, title, headcount) VALUES ($1, $2, $3, '版本并发测试', 1)", [job, org, 'JOB-' + job])
    // allSettled keeps cleanup from racing writes if any request fails.
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => [
      service.createSpec(job, { title: '说明书' + index, summary: '并发保存' + index, responsibilities: [], requirements: [], skills: [] }),
      service.createJd(job, { language: 'zh-CN', content: '并发JD' + index }),
    ]).flat())
    assert.deepEqual(outcomes.filter(result => result.status === 'rejected'), [], 'all simultaneous saves complete without unique-constraint errors')
    for (const versions of [await repository.listJobSpecVersions(job), await repository.listJobDescriptionVersions(job)]) {
      assert.deepEqual(versions.map(item => item.version), [6, 5, 4, 3, 2, 1])
    }
    const specs = await repository.listJobSpecVersions(job)
    assert.equal(new Set(specs.map(item => item.content.summary)).size, 6, 'each submitted document is retained')
    for (const spec of specs) assert.equal(spec.content.version, spec.version)
    for (const table of ['job_spec_versions', 'job_description_versions']) {
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE job_id=$1 AND organization_id<>$2`, [job, org])).rows[0]?.count, 0)
    }
  } finally {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const table of ['job_spec_versions', 'job_description_versions']) await client.query(`DELETE FROM ${table} WHERE job_id=$1`, [job])
      await client.query('DELETE FROM workflow_events WHERE organization_id=$1', [org])
      await client.query('DELETE FROM jobs WHERE id=$1 AND organization_id=$2', [job, org])
      await client.query('DELETE FROM organizations WHERE id=$1', [org])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release(); await pool.end() }
  }
})
