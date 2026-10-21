import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { NormalizedRecruitingRepository } from '../src/recruiting/repositories/postgres-repository.js'

test('PostgreSQL candidate deletion cleans up dependents and protects tenant/workflow boundaries', async (context) => {
  if (shouldSkipPostgresIntegration()) {
    context.skip('PostgreSQL credentials are not configured or integration checks are disabled')
    return
  }
  const pool = createPostgresHealthPool()
  const organizationId = randomUUID()
  const foreignOrganizationId = randomUUID()
  const jobId = randomUUID()
  const applicationId = randomUUID()
  const resumeId = randomUUID()
  const taskId = randomUUID()
  const interviewId = randomUUID()
  const organizations = [organizationId, foreignOrganizationId]
  const repository = new NormalizedRecruitingRepository(pool, { organizationId })
  const foreignRepository = new NormalizedRecruitingRepository(pool, { organizationId: foreignOrganizationId })
  try {
    await pool.query("INSERT INTO organizations (id, name, kind) VALUES ($1, 'candidate-delete-integration-test', 'test'), ($2, 'candidate-delete-integration-foreign', 'test')", organizations)
    const candidate = await repository.createCandidate({ name: '删除联调候选人' })
    const foreignCandidate = await foreignRepository.createCandidate({ name: '其他企业候选人' })
    const ownCandidates = await repository.listCandidates()
    assert.deepEqual(ownCandidates.map((row) => row.id), [candidate.id])
    await assert.rejects(repository.deleteCandidate(foreignCandidate.id), /not found/i)
    assert.equal((await foreignRepository.getCandidate(foreignCandidate.id)).id, foreignCandidate.id)

    await pool.query("INSERT INTO jobs (id, organization_id, job_no, title, headcount) VALUES ($1, $2, $3, '删除联调岗位', 1)", [jobId, organizationId, `JOB-${jobId}`])
    await pool.query('INSERT INTO applications (id, organization_id, application_no, candidate_id, job_id) VALUES ($1, $2, $3, $4, $5)', [applicationId, organizationId, `APP-${applicationId}`, candidate.id, jobId])
    await pool.query("INSERT INTO resumes (id, organization_id, candidate_id, application_id, storage_key, original_filename, mime_type, size_bytes, scan_status) VALUES ($1, $2, $3, $4, $5, 'resume.txt', 'text/plain', 10, 'clean')", [resumeId, organizationId, candidate.id, applicationId, `${resumeId}.txt`])
    await pool.query("INSERT INTO analysis_tasks (id, organization_id, resume_id, application_id, status, idempotency_key) VALUES ($1, $2, $3, $4, 'processing', $5)", [taskId, organizationId, resumeId, applicationId, taskId])
    await assert.rejects(repository.deleteCandidate(candidate.id), (error: any) => error.code === 'CANDIDATE_ANALYSIS_IN_PROGRESS')
    assert.equal((await repository.getCandidate(candidate.id)).id, candidate.id)
    await pool.query("UPDATE analysis_tasks SET status = 'completed' WHERE id = $1", [taskId])
    await pool.query("INSERT INTO analysis_results (organization_id, analysis_task_id, resume_id, application_id, result) VALUES ($1, $2, $3, $4, '{}')", [organizationId, taskId, resumeId, applicationId])
    await pool.query("INSERT INTO interviews (id, organization_id, application_id, interview_no, title, round, type) VALUES ($1, $2, $3, $4, '关联面试保护', 1, 'technical')", [interviewId, organizationId, applicationId, `INT-${interviewId}`])
    await assert.rejects(repository.deleteCandidate(candidate.id), (error: any) => error.code === 'CANDIDATE_IN_USE')
    await pool.query('DELETE FROM interviews WHERE id = $1 AND organization_id = $2', [interviewId, organizationId])
    assert.deepEqual(await repository.deleteCandidate(candidate.id), [`${resumeId}.txt`])
    for (const table of ['candidates', 'applications', 'resumes', 'analysis_tasks', 'analysis_results']) {
      const result = await pool.query<{ count: string }>(`SELECT count(*) FROM ${table} WHERE organization_id = $1`, [organizationId])
      assert.equal(result.rows[0]?.count, '0', `${table} must be cleaned up`)
    }
    const audit = await pool.query('SELECT id FROM workflow_events WHERE organization_id = $1 AND subject_id = $2 AND event_type = \'delete\'', [organizationId, candidate.id])
    assert.equal(audit.rows.length, 1)
    assert.equal((await foreignRepository.listCandidates()).length, 1)
  } finally {
    // Only disposable enterprise IDs created by this test may be cleaned up.
    for (const table of ['interviews', 'analysis_results', 'analysis_tasks', 'resumes', 'applications', 'candidates', 'jobs', 'workflow_events']) {
      await pool.query(`DELETE FROM ${table} WHERE organization_id = ANY($1::uuid[])`, [organizations])
    }
    await pool.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [organizations])
    await pool.end()
  }
})
