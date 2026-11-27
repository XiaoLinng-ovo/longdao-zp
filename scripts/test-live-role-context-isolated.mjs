import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'

assert.ok(process.argv[2], 'Explicit isolated PostgreSQL bin directory required')
const instance = await startIsolatedPostgres(process.argv[2])
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, instance.env)
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
require(join(projectRoot, 'scripts/isolated-network-guard.cjs'))
const { Pool } = require('pg'), admin = new Pool(instance.connection)
const load = file => import(pathToFileURL(join(projectRoot, 'apps/api/dist/src', file + '.js')))
const report = { passed: false, checks: [], businessDatabaseTouched: false, externalCalls: false, postgresStopped: false }
let pool, tenant, otherTenant
try {
  await admin.query('CREATE DATABASE "' + instance.database + '"')
  pool = new Pool({ ...instance.connection, database: instance.database })
  await (await load('db/migrations')).runMigrations(pool, join(projectRoot, 'db/migrations'))
  const [org, other, actor, job, candidate, application, interview, session] = Array.from({ length: 8 }, () => randomUUID())
  for (const id of [org, other]) await pool.query("INSERT INTO public.organizations(id,name,kind,service_status) VALUES($1,'role-context-test','test','enabled')", [id])
  await pool.query("INSERT INTO public.users(id,email,display_name) VALUES($1,'role-context@example.invalid','synthetic')", [actor])
  const schema = (await pool.query('SELECT public.initialize_organization_schema($1) AS name', [org])).rows[0].name
  const otherSchema = (await pool.query('SELECT public.initialize_organization_schema($1) AS name', [other])).rows[0].name
  tenant = new Pool({ ...instance.connection, database: instance.database, options: '-c search_path=' + schema + ',public' })
  otherTenant = new Pool({ ...instance.connection, database: instance.database, options: '-c search_path=' + otherSchema + ',public' })
  await tenant.query("INSERT INTO jobs(id,job_no,title,headcount,organization_id) VALUES($1,'JOB-ROLE','synthetic',1,$2)", [job, org])
  await tenant.query("INSERT INTO candidates(id,candidate_no,name,organization_id) VALUES($1,'CAN-ROLE','synthetic',$2)", [candidate, org])
  await tenant.query("INSERT INTO applications(id,application_no,candidate_id,job_id,status,organization_id) VALUES($1,'APP-ROLE',$2,$3,'interviewing',$4)", [application, candidate, job, org])
  await tenant.query("INSERT INTO interviews(id,interview_no,application_id,round,type,title,status,organization_id) VALUES($1,'INT-ROLE',$2,1,'technical','synthetic','scheduled',$3)", [interview, application, org])
  await tenant.query("INSERT INTO interview_live_sessions(id,interview_id,created_by,status,organization_id) VALUES($1,$2,$3,'active',$4)", [session, interview, actor, org])
  const { LiveInterviewSessionRepository } = await load('interviews/live-session-repository')
  const { createLiveSemanticRoleReviewer } = await load('interviews/live-semantic-role-review')
  const { SemanticRoleReviewer } = await load('interviews/semantic-role-review')
  const sessions = new LiveInterviewSessionRepository(tenant)
  const pendingReview = { method: 'semantic_context', status: 'uncertain', confidence: .4,
    reason: '片段尚不完整', model: 'synthetic', promptVersion: 'test' }
  const input = { speakerId: 'microphone:voice_1', role: 'unknown', confidence: .35, text: '就是客服 Agent 的时候，',
    startMs: 1000, endMs: 2000, audioSource: 'microphone', roleReview: pendingReview }
  const old = await sessions.addSegment(session, input)
  const manual = await sessions.addSegment(session, { ...input, speakerId: 'microphone:voice_2' })
  await sessions.correctRole(manual.id, 'interviewer')
  const current = { id: 'new-speech', speakerId: 'microphone:voice_1', role: 'unknown', confidence: .35,
    reasons: [], text: '我负责了这个项目的需求、开发和上线。', startMs: 3000, endMs: 6000, audioSource: 'microphone' }
  let requests = 0, duringRequest = async () => {}
  const model = new SemanticRoleReviewer(async (_url, init) => {
    requests++
    const context = JSON.parse(JSON.parse(String(init.body)).messages[1].content)
    assert.ok(context.turnsToReview.some(row => row.turnId === current.id))
    await duringRequest()
    return Response.json({ choices: [{ message: { content: JSON.stringify({ turns: context.turnsToReview.map(row => ({
      turnId: row.turnId, role: 'candidate', confidence: .95, mixed: false, reason: '后续项目回答明确了此前片段归属',
    })) }) } }] })
  })
  const env = { OPENAI_BASE_URL: 'https://synthetic.invalid/v1', OPENAI_API_KEY: 'synthetic', OPENAI_MODEL: 'synthetic' }
  const review = createLiveSemanticRoleReviewer(async () => env, model, (id, changes) => sessions.applyAutomaticRoleReviews(id, changes))
  const before = await sessions.get(session)
  const result = await review(session, [current], before.segments)
  const after = await sessions.get(session), resolved = after.segments.find(row => row.id === old.id)
  assert.deepEqual(result.map(row => row.id), [current.id])
  assert.equal(result[0].role, 'candidate'); assert.equal(resolved.role, 'candidate')
  assert.equal(resolved.roleReview.status, 'inferred'); assert.equal(resolved.speakerConfirmed, false)
  assert.equal(after.segments.find(row => row.id === manual.id).role, 'interviewer')
  assert.deepEqual([resolved.text, resolved.speakerId, resolved.startMs, resolved.endMs], [old.text, old.speakerId, old.startMs, old.endMs])
  report.checks.push('later context automatically resolves and persists an earlier uncertain fragment; manual confirmation and original evidence remain intact')

  const racing = await sessions.addSegment(session, input)
  duringRequest = () => sessions.correctRole(racing.id, 'interviewer').then(() => {})
  await review(session, [current], [racing])
  const corrected = (await sessions.get(session)).segments.find(row => row.id === racing.id)
  assert.equal(corrected.role, 'interviewer'); assert.equal(corrected.speakerConfirmed, true)
  report.checks.push('a manual correction made while the model is running cannot be overwritten')

  const edited = await sessions.addSegment(session, input)
  duringRequest = async () => { await tenant.query('UPDATE interview_live_segments SET text=$2 WHERE id=$1', [edited.id, '已修改的原文']) }
  await review(session, [current], [edited])
  assert.equal((await sessions.get(session)).segments.find(row => row.id === edited.id).role, 'unknown')
  report.checks.push('a stale model result cannot overwrite a segment changed since its snapshot')

  const fenced = await sessions.addSegment(session, input)
  const inferred = { ...fenced, reasons: [], role: 'candidate', confidence: .95,
    roleReview: { ...pendingReview, status: 'inferred', confidence: .95 } }
  const changes = [{ before: fenced, after: inferred }]
  assert.equal(await new LiveInterviewSessionRepository(otherTenant).applyAutomaticRoleReviews(session, changes), 0)
  assert.equal((await sessions.get(session)).segments.find(row => row.id === fenced.id).role, 'unknown')
  await tenant.query("UPDATE interview_live_sessions SET status='paused',ended_at=now() WHERE id=$1", [session])
  assert.equal(await sessions.applyAutomaticRoleReviews(session, changes), 0)
  assert.equal((await sessions.get(session)).segments.find(row => row.id === fenced.id).role, 'unknown')
  report.checks.push('cross-enterprise writes and writes after interview stop are rejected')
  assert.equal(requests, 3)
  report.passed = true
} finally {
  try { await otherTenant?.end(); await tenant?.end(); await pool?.end(); await admin.end() }
  finally { await instance.stop(); report.postgresStopped = true }
  const path = join(instance.directory, 'live-role-context-report.json')
  await writeFile(path, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...report, path }, null, 2))
}
