import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'

test('已完成初试的历史复试补齐：保留原结论、隔离企业、跳过无效记录且可重复执行', async context => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const sql = await readFile(new URL('../../../../db/migrations/0047_backfill_concluded_initial_interviews.sql', import.meta.url), 'utf8')
  const pool = createPostgresHealthPool()
  const client = await pool.connect()
  const cases = [
    'continue', 'other-tenant', 'locked-only', 'reject', 'offer', 'cancelled-initial',
    'existing-final', 'cancelled-final', 'offer-application', 'conflicting-review',
    'already-advanced', 'latest-reject', 'newer-initial',
  ].map(name => ({ name, org: randomUUID(), user: randomUUID(), candidate: randomUUID(), job: randomUUID(), app: randomUUID(), initial: randomUUID() }))
  await client.query('BEGIN')
  try {
    for (const f of cases) {
      await client.query("INSERT INTO organizations (id,name,kind) VALUES ($1,'backfill-test','test')", [f.org])
      await client.query("INSERT INTO users (id,email,display_name) VALUES ($1,$2,'backfill-test')", [f.user, f.user + '@example.invalid'])
      await client.query('INSERT INTO organization_members (organization_id,user_id) VALUES ($1,$2)', [f.org, f.user])
      await client.query("INSERT INTO candidates (id,organization_id,candidate_no,name) VALUES ($1,$2,$3,'backfill-test')", [f.candidate, f.org, 'CAN-' + f.candidate])
      await client.query("INSERT INTO jobs (id,organization_id,job_no,title,headcount) VALUES ($1,$2,$3,'backfill-test',1)", [f.job, f.org, 'JOB-' + f.job])
      await client.query('INSERT INTO applications (id,organization_id,application_no,candidate_id,job_id,status) VALUES ($1,$2,$3,$4,$5,$6)', [f.app, f.org, 'APP-' + f.app, f.candidate, f.job, f.name === 'offer-application' ? 'offer_approval' : 'interviewing'])
      await client.query("INSERT INTO interviews (id,organization_id,application_id,interview_no,round,stage,type,title,status,timezone,participants) VALUES ($1,$2,$3,$4,1,'initial','technical','初试',$5,'Asia/Shanghai',$6::jsonb)", [f.initial, f.org, f.app, 'INT-' + f.initial.toUpperCase(), f.name === 'locked-only' ? 'scheduled' : f.name === 'cancelled-initial' ? 'cancelled' : 'completed', JSON.stringify([{ userId: f.user, role: 'interviewer', required: true }])])
      if (f.name === 'locked-only') {
        await client.query("INSERT INTO interview_feedback (interview_id,interviewer_id,status,overall_score,organization_id) VALUES ($1,$2,'locked',90,$3)", [f.initial, f.user, f.org])
      } else {
        const outcome = f.name === 'reject' ? 'reject' : f.name === 'offer' ? 'offer' : 'continue'
        await client.query("INSERT INTO workflow_events (subject_type,subject_id,event_type,actor_user_id,metadata,organization_id,created_at) VALUES ('interview',$1,'conclude',$2,$3::jsonb,$4,'2026-10-01T01:00:00Z')", [f.initial, f.user, JSON.stringify({ outcome }), f.org])
      }
      if (['existing-final', 'cancelled-final'].includes(f.name)) {
        await client.query("INSERT INTO interviews (organization_id,application_id,interview_no,round,stage,type,title,status) VALUES ($1,$2,$3,2,'final','technical','复试',$4)", [f.org, f.app, 'INT-' + randomUUID().toUpperCase(), f.name === 'cancelled-final' ? 'cancelled' : 'completed'])
      }
      if (['already-advanced', 'conflicting-review'].includes(f.name)) {
        await client.query("INSERT INTO interview_stage_reviews (application_id,stage,decision,decided_by,decided_at,organization_id) VALUES ($1,'initial',$2,$3,'2026-09-30T01:00:00Z',$4)", [f.app, f.name === 'already-advanced' ? 'advanced' : 'rejected', f.user, f.org])
      }
      if (f.name === 'latest-reject') {
        await client.query("INSERT INTO workflow_events (subject_type,subject_id,event_type,actor_user_id,metadata,organization_id,created_at) VALUES ('interview',$1,'conclude',$2,'{\"outcome\":\"reject\"}'::jsonb,$3,'2026-10-02T01:00:00Z')", [f.initial, f.user, f.org])
      }
      if (f.name === 'newer-initial') {
        await client.query("INSERT INTO interviews (organization_id,application_id,interview_no,round,stage,type,title,status,created_at) VALUES ($1,$2,$3,1,'initial','technical','重排初试','scheduled',now()+interval '1 second')", [f.org, f.app, 'INT-' + randomUUID().toUpperCase()])
      }
    }
    await client.query(sql)
    await client.query(sql)
    for (const f of cases) {
      const finals = (await client.query("SELECT * FROM interviews WHERE application_id=$1 AND stage='final'", [f.app])).rows
      const advanced = ['continue', 'other-tenant', 'already-advanced'].includes(f.name)
      assert.equal(finals.length, advanced || ['existing-final', 'cancelled-final'].includes(f.name) ? 1 : 0, f.name)
      const audits = (await client.query("SELECT * FROM workflow_events WHERE subject_id=$1 AND event_type='advance_to_final_interview'", [f.app])).rows
      assert.equal(audits.length, advanced ? 1 : 0, f.name)
      if (!advanced) continue
      assert.equal(finals[0].organization_id, f.org)
      assert.equal(finals[0].status, 'scheduled')
      assert.equal(finals[0].scheduled_start_at, null)
      assert.equal(finals[0].timezone, 'Asia/Shanghai')
      assert.deepEqual(finals[0].participants, [{ userId: f.user, role: 'interviewer', required: true }])
      assert.equal(finals[0].interview_no, 'INT-' + finals[0].id.toUpperCase())
      assert.equal(audits[0].organization_id, f.org)
      assert.equal(audits[0].metadata.migration, '0047')
      assert.equal((await client.query("SELECT count(*) FROM workflow_events WHERE subject_id=$1 AND event_type='conclude'", [f.initial])).rows[0].count, '1')
      const review = (await client.query("SELECT * FROM interview_stage_reviews WHERE application_id=$1 AND stage='initial'", [f.app])).rows[0]
      assert.equal(review.decision, 'advanced')
      assert.equal(review.decided_by, f.user)
      assert.equal(review.decided_at.toISOString(), f.name === 'already-advanced' ? '2026-09-30T01:00:00.000Z' : '2026-10-01T01:00:00.000Z')
    }
  } finally {
    await client.query('ROLLBACK')
    client.release()
    await pool.end()
  }
})
