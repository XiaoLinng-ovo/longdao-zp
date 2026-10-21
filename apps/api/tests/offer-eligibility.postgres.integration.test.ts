import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { NormalizedRecruitingRepository, RepositoryNotFoundError } from '../src/recruiting/repositories/postgres-repository.js'
import type { RepositoryPool } from '../src/recruiting/repositories/types.js'

test('Offer eligibility requires explicit second-round pass and isolates enterprises', async context => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool(), client = await pool.connect()
  const query = async (sql: string, values: readonly unknown[] = []) => client.query(sql === 'BEGIN' ? 'SAVEPOINT offer_test' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT offer_test' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT offer_test' : sql, [...values])
  const adapter = { query, async connect() { return { query, release() {} } }, async end() {} } as RepositoryPool
  const org = randomUUID(), foreignOrg = randomUUID(), actor = randomUUID()
  const repo = new NormalizedRecruitingRepository(adapter, { organizationId: org })
  const cases = [
    { name: 'initial', round: 1, decision: 'advanced', eligible: false },
    { name: 'scheduled', round: 2, decision: null, eligible: false },
    { name: 'completed', round: 2, decision: null, completed: true, eligible: false },
    { name: 'hold', round: 2, decision: 'hold', eligible: false },
    { name: 'rejected', round: 2, decision: 'rejected', eligible: false },
    { name: 'pass', round: 2, decision: 'hired', eligible: true },
    { name: 'cancelled', round: 2, decision: 'hired', cancelled: true, eligible: false },
    { name: 'terminal', round: 2, decision: 'hired', terminal: true, eligible: false },
    { name: 'legacy', round: 2, decision: null, completed: true, outcome: 'offer', eligible: true },
    { name: 'foreign', round: 2, decision: 'hired', foreign: true, eligible: false },
  ]
  await client.query('BEGIN')
  try {
    await client.query("INSERT INTO organizations (id,name,kind) VALUES ($1,'offer-test','test'), ($2,'offer-foreign','test')", [org, foreignOrg])
    await client.query("INSERT INTO users (id,email,display_name) VALUES ($1,$2,'Offer Test')", [actor, actor + '@example.invalid'])
    const expected: string[] = [], fixtures: Array<{ app: string; name: string }> = []
    for (const entry of cases) {
      const organization = entry.foreign ? foreignOrg : org
      const job = randomUUID(), candidate = randomUUID(), app = randomUUID(), interview = randomUUID()
      fixtures.push({ app, name: entry.name })
      await client.query("INSERT INTO jobs (id,organization_id,job_no,title,headcount) VALUES ($1,$2,$3,'Offer Test',1)", [job, organization, 'JOB-' + job])
      await client.query("INSERT INTO candidates (id,organization_id,candidate_no,name) VALUES ($1,$2,$3,'Offer Test')", [candidate, organization, 'CAN-' + candidate])
      await client.query('INSERT INTO applications (id,organization_id,application_no,candidate_id,job_id,status) VALUES ($1,$2,$3,$4,$5,$6)', [app, organization, 'APP-' + app, candidate, job, entry.terminal ? 'rejected' : entry.completed ? 'offer_approval' : 'interviewing'])
      await client.query("INSERT INTO interviews (id,organization_id,application_id,interview_no,round,stage,type,title,status) VALUES ($1,$2,$3,$4,$5,$6,'other','Offer Test',$7)", [interview, organization, app, 'INT-' + interview, entry.round, entry.round === 1 ? 'initial' : 'final', entry.cancelled ? 'cancelled' : entry.completed ? 'completed' : 'scheduled'])
      if (entry.decision) await client.query('INSERT INTO interview_stage_reviews (application_id,organization_id,stage,decision,decided_by,decided_at) VALUES ($1,$2,$3,$4,$5,now())', [app, organization, entry.round === 1 ? 'initial' : 'final', entry.decision, actor])
      if (entry.outcome) await client.query("INSERT INTO workflow_events (subject_type,subject_id,event_type,metadata,organization_id) VALUES ('interview',$1,'conclude',$2::jsonb,$3)", [interview, JSON.stringify({ outcome: entry.outcome }), organization])
      if (entry.eligible) { expected.push(app); assert.equal((await repo.createOffer({ applicationId: app })).applicationId, app) }
      else await assert.rejects(repo.createOffer({ applicationId: app }), (error: any) => entry.foreign ? error instanceof RepositoryNotFoundError : error.code === 'OFFER_APPLICATION_INVALID')
    }
    assert.deepEqual((await repo.listApplications(undefined, undefined, true)).map(item => item.id).sort(), expected.sort())
    assert.equal((await repo.listApplications()).length, cases.length - 1)
    const passed = fixtures.find(item => item.name === 'pass')!
    // A decision may change while the user is filling in the Offer form.
    await client.query("UPDATE interview_stage_reviews SET decision='hold' WHERE application_id=$1 AND stage='final'", [passed.app])
    await assert.rejects(repo.createOffer({ applicationId: passed.app }), (error: any) => error.code === 'OFFER_APPLICATION_INVALID')
    assert.equal((await repo.listApplications(undefined, undefined, true)).some(item => item.id === passed.app), false)
    const legacy = fixtures.find(item => item.name === 'legacy')!
    await client.query("INSERT INTO interview_stage_reviews (application_id,organization_id,stage,decision) VALUES ($1,$2,'final','rejected')", [legacy.app, org])
    await assert.rejects(repo.createOffer({ applicationId: legacy.app }), (error: any) => error.code === 'OFFER_APPLICATION_INVALID')
    assert.deepEqual(await repo.listApplications(undefined, undefined, true), [])
  } finally { await client.query('ROLLBACK'); client.release(); await pool.end() }
})
