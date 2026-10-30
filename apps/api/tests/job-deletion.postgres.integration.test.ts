import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { RecruitingService } from '../src/recruiting/service.js'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { NormalizedRecruitingRepository } from '../src/recruiting/repositories/postgres-repository.js'
import type { RepositoryPool } from '../src/recruiting/repositories/types.js'

test('PostgreSQL job deletion cascades job-owned records, protects applications and isolates organizations', async (context) => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool(), client = await pool.connect()
  // Rollback-only fixtures: do not leave jobs, departments or events in the live database.
  const txPool: RepositoryPool = {
    query: client.query.bind(client),
    async connect() {
      return { async query<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
        const command = sql === 'BEGIN' ? 'SAVEPOINT job_deletion_test' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT job_deletion_test' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT job_deletion_test' : sql
        const result = await client.query<Row>(command, [...values])
        return { rows: result.rows }
      }, release() {} }
    }, async end() {},
  }
  const organizationId = randomUUID(), foreignOrg = randomUUID(), department = randomUUID()
  const repository = new NormalizedRecruitingRepository(txPool, { organizationId })
  const service = new RecruitingService(undefined, undefined, undefined, repository)
  try {
    await client.query('BEGIN')
    for (const id of [organizationId, foreignOrg]) await client.query("INSERT INTO organizations (id, name, kind) VALUES ($1, 'standalone-job-test', 'test')", [id])
    await client.query("INSERT INTO departments (id, code, name) VALUES ($1, $2, '人事测试部')", [department, 'HR-' + department])
    const input = { title: '岗位删除回滚测试', departmentId: department, headcount: 1, employmentType: 'full_time', workMode: 'onsite' }
    const job = await service.createJob(input, '')
    await service.createSpec(job.id, { title: job.title, summary: '摘要', responsibilities: [], requirements: [], skills: [] }, '')
    await service.createJd(job.id, { language: 'zh-CN', content: '岗位职责' }, '')
    const skillId = randomUUID()
    await client.query("INSERT INTO ai_prompt_skills (id, name, target_type, content) VALUES ($1, '删除测试规则', 'resume_score', '按证据评分')", [skillId])
    await client.query('INSERT INTO ai_resume_scoring_skill_jobs (job_id, skill_id) VALUES ($1, $2)', [job.id, skillId])
    await client.query("INSERT INTO job_channel_publications (job_id, provider) VALUES ($1, 'official_site')", [job.id])
    const foreignRepository = new NormalizedRecruitingRepository(txPool, { organizationId: foreignOrg })
    await assert.rejects(foreignRepository.deleteJob(job.id), (error: any) => error.code === 'REPOSITORY_NOT_FOUND')
    assert.equal((await service.getJob(job.id)).title, input.title)
    // Keep another job + applicant + resume while deleting this unused one.
    const used = await service.createJob({ ...input, title: '已有申请保护测试' }, '')
    const candidateId = randomUUID(), applicationId = randomUUID(), resumeId = randomUUID()
    await client.query("INSERT INTO candidates (id, candidate_no, name, organization_id) VALUES ($1, $2, '删除功能测试候选人', $3)", [candidateId, 'CAN-' + candidateId, organizationId])
    await client.query("INSERT INTO applications (id, application_no, candidate_id, job_id, organization_id) VALUES ($1, $2, $3, $4, $5)", [applicationId, 'APP-' + applicationId, candidateId, used.id, organizationId])
    await client.query("INSERT INTO resumes (id, candidate_id, application_id, storage_key, original_filename, mime_type, size_bytes, organization_id) VALUES ($1, $2, $3, $4, 'fixture.pdf', 'application/pdf', 1, $5)", [resumeId, candidateId, applicationId, 'job-deletion-fixture/' + resumeId, organizationId])
    await assert.rejects(service.deleteJob(used.id, ''), (error: any) => error.code === 'JOB_IN_USE' && error.status === 409)
    await service.deleteJob(job.id, '')
    for (const table of ['jobs', 'job_spec_versions', 'job_description_versions', 'ai_resume_scoring_skill_jobs', 'job_channel_publications']) {
      const key = table === 'jobs' ? 'id' : 'job_id'
      assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${key} = $1`, [job.id])).rows[0]!.count, 0, table)
    }
    for (const [table, id] of [['jobs', used.id], ['candidates', candidateId], ['applications', applicationId], ['resumes', resumeId], ['ai_prompt_skills', skillId]]) {
      assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${table} WHERE id = $1`, [id])).rows[0]!.count, 1, table)
    }
    assert.ok((await repository.listWorkflowEvents()).some(event => event.subjectId === job.id && event.action === 'delete'))
    await assert.rejects(service.deleteJob(job.id, ''), (error: any) => error.code === 'REPOSITORY_NOT_FOUND')
  } finally {
    try { await client.query('ROLLBACK') } finally { client.release(); await pool.end() }
  }
})
