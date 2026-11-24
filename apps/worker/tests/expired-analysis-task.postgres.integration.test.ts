import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { AnalysisTaskLeaseLostError, PostgresAnalysisTaskStore, type PgClient } from '../src/db/analysis-task-store.js'

const skip = !process.env.DATABASE_URL?.trim() || ['true', '1'].includes(process.env.POSTGRES_INTEGRATION_SKIP ?? '')

test('expired final attempts terminate without changing live leases or completed results', { skip }, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
  const client = await pool.connect()
  const now = '2000-01-01T00:00:00.000Z'
  const organizationId = randomUUID(), candidateId = randomUUID(), resumeId = randomUUID()
  const taskIds = Array.from({ length: 5 }, () => randomUUID())
  const query: PgClient['query'] = async (sql, values = []) => {
    const statement = sql === 'BEGIN' ? 'SAVEPOINT lease_test' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT lease_test' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT lease_test' : sql
    return await client.query(statement, values) as never
  }
  const store = new PostgresAnalysisTaskStore({ async connect() { return { query, release() {} } } })
  await client.query('BEGIN')
  try {
    const baseline = await client.query("SELECT count(*)::integer AS count FROM analysis_tasks WHERE status IN ('queued','processing') AND available_at <= $1", [now])
    assert.equal(baseline.rows[0].count, 0, 'Historical test clock must not include existing tasks')
    await client.query("INSERT INTO organizations (id,name,kind) VALUES ($1,'Expired lease rollback fixture','test')", [organizationId])
    await client.query("INSERT INTO candidates (id,organization_id,candidate_no,name) VALUES ($1,$2,$3,'Fixture')", [candidateId, organizationId, 'CAN-' + candidateId])
    await client.query("INSERT INTO resumes (id,organization_id,candidate_id,storage_key,original_filename,mime_type,size_bytes,scan_status,content_hash) VALUES ($1,$2,$3,$4,'fixture.txt','text/plain',7,'clean',$5)", [resumeId, organizationId, candidateId, resumeId, randomUUID()])
    const statuses = ['processing', 'queued', 'processing', 'completed', 'processing']
    for (let i = 0; i < taskIds.length; i++) {
      await client.query('INSERT INTO analysis_tasks (id,organization_id,resume_id,status,attempts,idempotency_key,available_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [taskIds[i], organizationId, resumeId, statuses[i], i === 4 ? 1 : 3, taskIds[i], i === 2 ? '2000-01-02T00:00:00.000Z' : '1999-01-01T00:00:00.000Z'])
    }
    const lease = await store.claimNextTask({ maxAttempts: 3, leaseDurationMs: 60_000, now })
    assert.equal(lease?.task.id, taskIds[4])
    assert.equal(lease?.attempt, 2)
    const states = (await client.query('SELECT id,status,attempts,completed_at,last_error FROM analysis_tasks WHERE id=ANY($1::uuid[])', [taskIds])).rows
    for (const id of taskIds.slice(0, 2)) {
      const row = states.find((item) => item.id === id)!
      assert.equal(row.status, 'failed')
      assert.equal(row.completed_at.toISOString(), now)
      assert.match(row.last_error, /重试次数已耗尽/u)
    }
    assert.equal(states.find((row) => row.id === taskIds[2])?.status, 'processing')
    assert.equal(states.find((row) => row.id === taskIds[3])?.status, 'completed')
    assert.equal(await store.claimNextTask({ maxAttempts: 3, leaseDurationMs: 60_000, now }), undefined)
    await assert.rejects(store.completeTask({ taskId: taskIds[0]!, attempt: 3, result: { fixture: true } }), AnalysisTaskLeaseLostError)
  } finally {
    await client.query('ROLLBACK')
    client.release()
    await pool.end()
  }
})
