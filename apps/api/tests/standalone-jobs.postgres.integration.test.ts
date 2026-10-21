import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { RecruitingService } from '../src/recruiting/service.js'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { NormalizedRecruitingRepository } from '../src/recruiting/repositories/postgres-repository.js'
import type { RepositoryPool } from '../src/recruiting/repositories/types.js'

test('PostgreSQL standalone jobs persist NULL request and complete their workflow without demand records', async (context) => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool(), client = await pool.connect()
  // Rollback-only fixtures: do not leave jobs, departments or events in the live database.
  const txPool: RepositoryPool = {
    query: client.query.bind(client),
    async connect() {
      return { async query<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
        const command = sql === 'BEGIN' ? 'SAVEPOINT standalone_job_test' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT standalone_job_test' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT standalone_job_test' : sql
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
    const before = (await client.query('SELECT count(*)::int AS count FROM recruitment_requests')).rows[0]!.count
    const job = await service.createJob({ title: '独立人事岗位测试', departmentId: department, hiringManagerId: '  张三、李四  ', headcount: 1, employmentType: 'full_time', workMode: 'onsite' }, '')
    assert.equal(job.recruitmentRequestId, '')
    assert.equal(job.department, '人事测试部')
    assert.equal(job.hiringManagerId, '张三、李四')
    assert.equal((await service.getJob(job.id)).hiringManagerId, '张三、李四')
    assert.equal((await service.listJobs()).find(item => item.id === job.id)?.hiringManagerId, '张三、李四')
    assert.equal((await client.query('SELECT hiring_manager_names FROM jobs WHERE id=$1', [job.id])).rows[0]!.hiring_manager_names, '张三、李四')
    assert.equal((await service.updateJob(job.id, { hiringManagerId: '  王五、赵六  ' }, '')).hiringManagerId, '王五、赵六')
    assert.equal((await service.getJob(job.id)).hiringManagerId, '王五、赵六')
    assert.equal((await service.updateJob(job.id, { location: '测试地点' }, '')).hiringManagerId, '王五、赵六')
    assert.equal((await service.updateJob(job.id, { hiringManagerId: '' }, '')).hiringManagerId, undefined)
    assert.equal((await client.query('SELECT hiring_manager_names FROM jobs WHERE id=$1', [job.id])).rows[0]!.hiring_manager_names, null)
    await service.updateJob(job.id, { hiringManagerId: '张三、李四' }, '')
    const row = (await client.query('SELECT recruitment_request_id, organization_id FROM jobs WHERE id=$1', [job.id])).rows[0]!
    assert.equal(row.recruitment_request_id, null)
    assert.equal(row.organization_id, organizationId)
    assert.equal((await service.listJobs()).some(item => item.id === job.id), true)
    const foreignService = new RecruitingService(undefined, undefined, undefined, new NormalizedRecruitingRepository(txPool, { organizationId: foreignOrg }))
    assert.deepEqual(await foreignService.listJobs(), [])
    await assert.rejects(foreignService.getJob(job.id), (error: unknown) => (error as { code: string }).code === 'REPOSITORY_NOT_FOUND')
    await assert.rejects(service.jobAction(job.id, 'publish', undefined, ''), (error: unknown) => (error as { code: string }).code === 'JOB_DOCUMENT_NOT_CONFIRMED')
    await service.createSpec(job.id, { title: '人事岗位', summary: '人员档案管理', responsibilities: ['员工档案管理'], requirements: [], skills: [] }, '')
    await service.createJd(job.id, { language: 'zh-CN', content: '员工档案管理' }, '')
    await service.jobAction(job.id, 'confirm_spec', undefined, '')
    await assert.rejects(service.jobAction(job.id, 'publish', undefined, ''), (error: unknown) => (error as { code: string }).code === 'JOB_DOCUMENT_NOT_CONFIRMED')
    await service.jobAction(job.id, 'confirm_jd', undefined, '')
    assert.equal((await service.getJob(job.id)).status, 'ready')
    for (const [action, reason, expected] of [
      ['publish', undefined, 'published'], ['pause', '暂停招聘', 'paused'], ['resume', undefined, 'published'], ['close', '招聘结束', 'closed'],
    ] as const) {
      assert.equal((await service.jobAction(job.id, action, reason, '')).status, expected)
      assert.equal((await repository.getJob(job.id)).status, expected)
    }
    assert.equal((await client.query('SELECT count(*)::int AS count FROM recruitment_requests')).rows[0]!.count, before)
    assert.ok((await repository.listWorkflowEvents()).some(event => event.subjectId === job.id && event.action === 'publish'))
  } finally {
    try { await client.query('ROLLBACK') } finally { client.release(); await pool.end() }
  }
})
