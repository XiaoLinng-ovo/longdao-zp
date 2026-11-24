import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { AiUsageService } from '../src/platform/ai-usage.js'
import { createPostgresHealthPool } from '../src/recruiting/db-health.js'
test('AI usage diagnostics and immutable manual review (isolated real PG)', async t => {
 assert.equal(process.env.PGPORT, '15433'); assert.equal(process.env.PGDATABASE, 'smartrecruit_test')
 const pool = createPostgresHealthPool(), service = new AiUsageService(pool)
 const org = randomUUID(), other = randomUUID(), owner = randomUUID(), member = randomUUID(), resource = randomUUID()
 let uncertain = '', settled = '', stale = '', foreign = ''
 const input = { organizationId: org, actorId: owner, operation: 'jd' as const, resourceId: resource, key: randomUUID(), input: { prompt: 'private fixture input' }, model: 'fixture-model', requestId: randomUUID() }
 const task = async (key: string) => (await pool.query('SELECT * FROM ai_usage_tasks WHERE organization_id=$1 AND idempotency_key=$2', [org, key])).rows[0]
 const note = () => ({ key: randomUUID(), outcome: 'awaiting_provider', note: '等待服务商账单核对' })
 try {
  await pool.query("INSERT INTO users(id,email,display_name,is_active) VALUES($1,$3,'review owner',true),($2,$4,'review member',true)", [owner, member, owner + '@example.invalid', member + '@example.invalid'])
  await pool.query("INSERT INTO organizations(id,name,kind) VALUES($1,'diagnostic fixture','test'),($2,'other fixture','test')", [org, other])
  await pool.query("INSERT INTO organization_members(organization_id,user_id,role,business_role) VALUES($1,$2,'owner','recruiter'),($1,$3,'member','recruiter'),($4,$2,'owner','recruiter')", [org, owner, member, other])
  await t.test('new calls persist request ID, duration and safe classification; success retains replay', async () => {
   await service.execute(input, async () => ({ content: 'private generated result' })); const row = await task(input.key); settled = row.id
   assert.equal(row.request_id, input.requestId); assert.equal(row.failure_category, null); assert.ok(row.duration_ms >= 0)
   const failed = { ...input, key: randomUUID() }; await assert.rejects(service.execute(failed, async () => { throw Object.assign(new Error('private upstream body'), { code: 'MODEL_REQUEST_FAILED', cause: new DOMException('private key', 'TimeoutError') }) }))
   const rejected = await task(failed.key); uncertain = rejected.id; assert.equal(rejected.failure_category, 'request_timeout'); assert.equal(rejected.state, 'uncertain')
   const invalidId = { ...input, key: randomUUID(), requestId: 'unsafe request <key>' }; await service.execute(invalidId, async () => ({})); assert.equal((await task(invalidId.key)).request_id, null)
  })
  await pool.query("INSERT INTO ai_usage_tasks(id,organization_id,actor_user_id,operation,resource_id,idempotency_key,fingerprint,model,state,created_at) VALUES($1,$2,$3,'job_spec',$4,$5,'fixture','model','reserved',now()-interval '11 minutes')", [stale = randomUUID(), org, owner, resource, randomUUID()])
  await pool.query("INSERT INTO ai_usage_tasks(id,organization_id,actor_user_id,operation,resource_id,idempotency_key,fingerprint,model,state) VALUES($1,$2,$3,'jd',$4,$5,'fixture','model','uncertain')", [foreign = randomUUID(), other, owner, resource, randomUUID()])
  await t.test('filters use tenant boundary and exclusive end time while summary stays whole-enterprise', async () => {
   const report = await service.read(owner, org, 1, { operation: 'jd', state: 'uncertain', reviewOnly: true }); assert.equal(report.filteredTotal, 1); assert.equal(report.items[0].id, uncertain); assert.equal(report.summary.total, 4)
   const time = (await pool.query('SELECT created_at FROM ai_usage_tasks WHERE id=$1', [settled])).rows[0].created_at.toISOString()
   const before = await service.read(owner, org, 1, { to: time }); assert.ok(before.items.every(item => item.id !== settled))
   const future = await service.read(owner, org, 1, { from: '2100-01-01T00:00:00.000Z' }); assert.equal(future.filteredTotal, 0); assert.equal(future.summary.total, 4)
   const staleReport = await service.read(owner, org, 1, { operation: 'job_spec', reviewOnly: true }); assert.equal(staleReport.items[0].durationMs, null); assert.equal(staleReport.items[0].failureCategory, null)
   assert.ok(!JSON.stringify(report).includes('private')); assert.ok(!('result' in report.items[0])); assert.ok(!('fingerprint' in report.items[0]))
  })
  await t.test('review history and additions reject cross-tenant IDs, members and malformed UUIDs', async () => {
   for (const id of ['------------------------------------', 'not-a-uuid']) await assert.rejects(service.reviewHistory(owner, org, id), { status: 400 })
   await assert.rejects(service.reviewHistory(owner, org, foreign), { status: 404 }); await assert.rejects(service.addReview(owner, org, foreign, note()), { status: 404 })
   await assert.rejects(service.reviewHistory(member, org, uncertain), { status: 403 }); await assert.rejects(service.addReview(member, org, uncertain, note()), { status: 403 })
   await assert.rejects(service.addReview(owner, org, uncertain, { ...note(), note: 'a' }), { status: 400 })
   await assert.rejects(service.addReview(owner, org, uncertain, { ...note(), note: '字'.repeat(1001) }), { status: 400 })
  })
  await t.test('same key replays one durable note and changed content conflicts', async () => {
   const entry = note(), first = await service.addReview(owner, org, uncertain, entry)
   const replay = await new AiUsageService(pool).addReview(owner, org, uncertain, entry); assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.equal(first.item.id, replay.item.id)
   await assert.rejects(service.addReview(owner, org, uncertain, { ...entry, note: '不同证据' }), { code: 'REVIEW_KEY_CONFLICT' })
   const history = await service.reviewHistory(owner, org, uncertain); assert.equal(history.items.length, 1); assert.equal(history.items[0].actorId, owner); assert.equal((await service.read(owner, org, 1, { state: 'uncertain' })).items[0].reviewCount, 1)
  })
  await t.test('concurrent duplicate submissions create one note without changing reconciliation', async () => {
   const entry = note(); const results = await Promise.all([service.addReview(owner, org, stale, entry), service.addReview(owner, org, stale, entry)])
   assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]); assert.equal((await service.reviewHistory(owner, org, stale)).items.length, 1)
   const row = (await pool.query('SELECT state,settled_units,result FROM ai_usage_tasks WHERE id=$1', [stale])).rows[0]; assert.deepEqual(row, { state: 'reserved', settled_units: 0, result: null }); assert.equal((await service.read(owner, org)).summary.reconciliation, 2)
  })
  await t.test('settled and recent reserved tasks cannot acquire a misleading anomaly note', async () => {
   await assert.rejects(service.addReview(owner, org, settled, note()), { code: 'AI_REVIEW_NOT_REQUIRED' })
   const fresh = randomUUID(); await pool.query("INSERT INTO ai_usage_tasks(id,organization_id,actor_user_id,operation,resource_id,idempotency_key,fingerprint,model) VALUES($1,$2,$3,'jd',$4,$5,'fixture','model')", [fresh, org, owner, resource, randomUUID()]); await assert.rejects(service.addReview(owner, org, fresh, note()), { code: 'AI_REVIEW_NOT_REQUIRED' })
  })
  await t.test('previously saved key does not bypass live downgrade, disabled user or suspended enterprise', async () => {
   const entry = note(); await service.addReview(owner, org, uncertain, entry)
   await pool.query("UPDATE organization_members SET role='member' WHERE organization_id=$1 AND user_id=$2", [org, owner]); await assert.rejects(service.addReview(owner, org, uncertain, entry), { status: 403 })
   await pool.query("UPDATE organization_members SET role='owner' WHERE organization_id=$1 AND user_id=$2", [org, owner]); await pool.query('UPDATE users SET is_active=false WHERE id=$1', [owner]); await assert.rejects(service.addReview(owner, org, uncertain, entry), { status: 403 })
   await pool.query('UPDATE users SET is_active=true WHERE id=$1', [owner]); await pool.query("UPDATE organizations SET service_status='suspended' WHERE id=$1", [org]); await assert.rejects(service.addReview(owner, org, uncertain, entry), { status: 403 }); await pool.query("UPDATE organizations SET service_status='enabled' WHERE id=$1", [org])
  })
  await t.test('failed note insert rolls back and connection is reusable', async () => {
   const client = await pool.connect(); let released = false
   const broken = { connect: async () => ({ query: async (sql: string, params: unknown[]) => { if (sql.startsWith('INSERT INTO ai_usage_review_notes')) throw new Error('fixture write failure'); return client.query(sql, params) }, release: () => { released = true; client.release() } }) } as unknown as Pool
   const before = (await service.reviewHistory(owner, org, uncertain)).items.length
   await assert.rejects(new AiUsageService(broken).addReview(owner, org, uncertain, note()), /fixture write failure/); assert.equal(released, true); assert.equal((await service.reviewHistory(owner, org, uncertain)).items.length, before); await service.addReview(owner, org, uncertain, note())
  })
 } finally {
  await pool.query('DELETE FROM ai_usage_tasks WHERE organization_id=ANY($1::uuid[])', [[org, other]])
  await pool.query('DELETE FROM organization_members WHERE organization_id=ANY($1::uuid[])', [[org, other]])
  await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [[org, other]])
  await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[owner, member]]); await pool.end()
 }
})
