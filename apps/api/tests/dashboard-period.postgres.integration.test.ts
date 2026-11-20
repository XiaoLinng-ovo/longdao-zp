import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { NormalizedRecruitingRepository } from '../src/recruiting/repositories/postgres-repository.js'
import type { RepositoryPool } from '../src/recruiting/repositories/types.js'

test('dashboard activity reads complete enterprise history beyond the audit display limit', async context => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool(), client = await pool.connect()
  const organizationId = randomUUID(), subjectId = randomUUID(), candidateId = randomUUID(), jobId = randomUUID()
  try {
    await client.query('BEGIN')
    await client.query("INSERT INTO organizations (id,name,kind) VALUES ($1,'dashboard-period-test','test')", [organizationId])
    await client.query("INSERT INTO candidates (id,organization_id,candidate_no,name) VALUES ($1,$2,$3,'period-test')", [candidateId, organizationId, 'CAN-' + candidateId])
    await client.query("INSERT INTO jobs (id,organization_id,job_no,title,headcount) VALUES ($1,$2,$3,'period-test',1)", [jobId, organizationId, 'JOB-' + jobId])
    await client.query("INSERT INTO applications (id,organization_id,application_no,candidate_id,job_id,status) VALUES ($1,$2,$3,$4,$5,'interviewing')", [subjectId, organizationId, 'APP-' + subjectId, candidateId, jobId])
    await client.query("INSERT INTO workflow_events (organization_id,subject_type,subject_id,event_type,from_status,to_status,created_at) SELECT $1,'application',$2,'status_changed','human_review','interviewing','2026-10-01T00:00:00Z'::timestamptz + n * interval '1 hour' FROM generate_series(0,600) n", [organizationId, subjectId])
    const fixturePool = { query: client.query.bind(client), async connect() { return client }, async end() {} } as unknown as RepositoryPool
    const repository = new NormalizedRecruitingRepository(fixturePool, { organizationId })
    const events = await repository.listDashboardActivityEvents('2026-11-01T00:00:00Z')
    const evidence = (await client.query('SELECT organization_id,subject_type,to_status,min(created_at) AS first,count(*)::int AS count FROM workflow_events WHERE subject_id=$1 GROUP BY organization_id,subject_type,to_status', [subjectId])).rows
    assert.equal(events.length, 601, JSON.stringify(evidence))
    assert.equal(events[0]?.createdAt, '2026-10-01T00:00:00.000Z')
    assert.equal((await repository.listDashboardActivityEvents('2026-10-01T00:00:00Z')).length, 0)
    const other = new NormalizedRecruitingRepository(fixturePool, { organizationId: randomUUID() })
    assert.equal((await other.listDashboardActivityEvents('2026-11-01T00:00:00Z')).length, 0)
  } finally { await client.query('ROLLBACK'); client.release(); await pool.end() }
})
