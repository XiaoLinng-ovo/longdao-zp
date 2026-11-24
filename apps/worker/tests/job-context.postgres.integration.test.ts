import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { PostgresAnalysisTaskStore, type PgClient } from '../src/db/analysis-task-store.js'

const skip = !process.env.DATABASE_URL?.trim() || ['true', '1'].includes(process.env.POSTGRES_INTEGRATION_SKIP ?? '')

test('PostgreSQL worker scoring ignores drafts and reads confirmed JD fallback', { skip }, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
  const client = await pool.connect()
  const organizationId = randomUUID()
  const jobId = randomUUID()
  // One transaction makes the fixture invisible to live pollers and always rolls back.
  const store = new PostgresAnalysisTaskStore({ async connect() {
    return { query: client.query.bind(client), release() {} } as PgClient
  } })
  try {
    await client.query('BEGIN')
    await client.query("INSERT INTO organizations (id, name, kind) VALUES ($1, 'worker-job-context-test', 'test')", [organizationId])
    await client.query("INSERT INTO jobs (id, organization_id, job_no, title, headcount) VALUES ($1, $2, $3, '后端', 1)", [jobId, organizationId, 'JOB-' + jobId])
    await client.query('INSERT INTO job_spec_versions (job_id, organization_id, version, content, confirmed_at) VALUES ($1, $2, 1, $3::jsonb, now()), ($1, $2, 2, $4::jsonb, NULL)', [jobId, organizationId, JSON.stringify({ confirmed: false, requirements: [{ label: '掌握Python', required: true }], skills: ['Python'] }), JSON.stringify({ requirements: [{ label: '销售经验' }] })])
    await client.query("INSERT INTO job_description_versions (job_id, organization_id, version, title, content, confirmed_at) VALUES ($1, $2, 1, '后端', $3, now()), ($1, $2, 2, '后端', $4, NULL)", [jobId, organizationId, '任职要求\n本科以上\n技能要求\nPostgreSQL\n福利待遇\n五险一金', '任职要求\n销售经验'])
    assert.deepEqual(await store.getJobAnalysisContext(jobId), { title: '后端', requirements: ['掌握Python'], requirementRequired: [true], skills: ['Python'] })
    await client.query('UPDATE job_spec_versions SET content = $2::jsonb WHERE job_id = $1 AND version = 1', [jobId, '{}'])
    assert.deepEqual(await store.getJobAnalysisContext(jobId), { title: '后端', requirements: ['本科以上'], requirementRequired: [false], skills: ['PostgreSQL'] })
    await client.query('UPDATE job_description_versions SET confirmed_at = NULL WHERE job_id = $1', [jobId])
    assert.deepEqual(await store.getJobAnalysisContext(jobId), { title: '后端', requirements: [], requirementRequired: [], skills: [] })
  } finally {
    try { await client.query('ROLLBACK') } finally { client.release(); await pool.end() }
  }
})
