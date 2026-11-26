import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
assert.ok(process.argv[2], 'Explicit isolated PostgreSQL bin directory required')
const instance = await startIsolatedPostgres(process.argv[2])
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, instance.env)
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
const guard = require(join(projectRoot, 'scripts/isolated-network-guard.cjs'))
const { Pool } = require('pg'), admin = new Pool(instance.connection)
const load = file => import(pathToFileURL(join(projectRoot, 'apps/api/dist/src', file + '.js')))
let pool, tenant, otherTenant, created = false
try {
  await admin.query('CREATE DATABASE "' + instance.database + '"'); created = true
  pool = new Pool({ ...instance.connection, database: instance.database })
  await (await load('db/migrations')).runMigrations(pool, join(projectRoot, 'db/migrations'))
  const ids = Array.from({ length: 9 }, () => randomUUID())
  const [org, other, actor, job, candidate, application, interview, session, transcript] = ids
  for (const id of [org, other]) await pool.query("INSERT INTO public.organizations(id,name,kind,service_status) VALUES($1,'automatic-role-test','test','enabled')", [id])
  await pool.query("INSERT INTO public.users(id,email,display_name) VALUES($1,'automatic-role@example.invalid','synthetic')", [actor])
  const schema = (await pool.query('SELECT public.initialize_organization_schema($1) AS name', [org])).rows[0].name
  const otherSchema = (await pool.query('SELECT public.initialize_organization_schema($1) AS name', [other])).rows[0].name
  tenant = new Pool({ ...instance.connection, database: instance.database, options: '-c search_path=' + schema + ',public' })
  otherTenant = new Pool({ ...instance.connection, database: instance.database, options: '-c search_path=' + otherSchema + ',public' })
  await tenant.query("INSERT INTO jobs(id,job_no,title,headcount,organization_id) VALUES($1,'JOB-AUTO','synthetic job',1,$2)", [job,org])
  await tenant.query("INSERT INTO candidates(id,candidate_no,name,organization_id) VALUES($1,'CAN-AUTO','synthetic candidate',$2)", [candidate,org])
  await tenant.query("INSERT INTO applications(id,application_no,candidate_id,job_id,status,organization_id) VALUES($1,'APP-AUTO',$2,$3,'interviewing',$4)", [application,candidate,job,org])
  await tenant.query("INSERT INTO interviews(id,interview_no,application_id,round,type,title,status,organization_id) VALUES($1,'INT-AUTO',$2,1,'technical','synthetic interview','scheduled',$3)", [interview,application,org])
  await tenant.query("INSERT INTO interview_live_sessions(id,interview_id,created_by,status,organization_id) VALUES($1,$2,$3,'active',$4)", [session,interview,actor,org])
  await tenant.query("UPDATE interview_live_sessions SET status='paused',ended_at=now() WHERE id=$1", [session])
  const turns = Array.from({ length: 224 }, (_, index) => ({ id: 'turn-' + index, speakerId: 'voice-' + index % 2, role: 'unknown', confidence: .35, text: '待识别的原始发言' + index, startMs: index * 2000, endMs: index * 2000 + 1000, evidenceIds: [], roleReasons: [] }))
  turns.push({ ...turns[0], id: 'candidate', role: 'candidate', confidence: 1, speakerConfirmed: true, text: '我负责项目需求分析、后端开发、性能测试与上线维护。', startMs: 500000, endMs: 505000 })
  await tenant.query("INSERT INTO interview_transcript_versions(id,session_id,content_fingerprint,turns,evidence) VALUES($1,$2,'initial',$3::jsonb,'[]')", [transcript,session,JSON.stringify(turns)])
  await tenant.query("UPDATE interview_live_sessions SET corrected_transcript_version_id=$2 WHERE id=$1", [session,transcript])
  await tenant.query("UPDATE interview_transcript_postprocess_jobs SET status='completed' WHERE session_id=$1", [session])
  const { LiveInterviewSessionRepository } = await load('interviews/live-session-repository')
  const { InterviewSummaryRepository } = await load('interviews/interview-summary-repository')
  const { createUnscoredSummary, assessTranscriptQuality } = await load('interviews/interview-summary')
  const sessions = new LiveInterviewSessionRepository(tenant), summaries = new InterviewSummaryRepository(tenant)
  const ended = await sessions.end(session)
  assert.equal(ended.status, 'completed'); assert.equal(ended.completionReview.unresolvedCount, 224)
  const base = createUnscoredSummary((await sessions.get(session)).segments)
  assert.equal(assessTranscriptQuality(base.transcript, true).usable, true)
  console.log('PASS 224 unknown turns do not block completion or reliable candidate scoring')
  const claimed = await summaries.claim(); assert.ok(claimed)
  await summaries.save(claimed, { ...base, overallScore: 82 }, null)
  const activeClaim = await summaries.request(interview,actor).then(() => summaries.claim()); assert.ok(activeClaim)
  const corrected = await sessions.correctTranscriptRoles(session, transcript, ['turn-0'], 'interviewer', actor)
  assert.equal(corrected.session.status, 'completed'); assert.notEqual(corrected.completionReview.versionId, transcript)
  assert.equal(corrected.segments.find(row=>row.id==='turn-0').speakerConfirmed, true)
  const current = await summaries.latest(interview)
  assert.equal(current.status,'none'); assert.equal(current.stale,true); assert.equal(current.report.overallScore,82)
  assert.equal(await summaries.save(activeClaim,{...base,overallScore:99},null),false)
  assert.ok((await summaries.history(interview)).length >= 1)
  assert.equal((await new InterviewSummaryRepository(otherTenant).history(interview)).length,0)
  assert.equal(await new InterviewSummaryRepository(otherTenant).latest(interview),null)
  await assert.rejects(sessions.correctTranscriptRoles(session,transcript,['turn-0'],'candidate',actor),{code:'TRANSCRIPT_VERSION_CONFLICT'})
  console.log('PASS completed role corrections are versioned, tenant-isolated and fence stale scoring workers')
  await summaries.request(interview,actor)
  const next = await summaries.claim(); assert.ok(next)
  await summaries.save(next,{...base,overallScore:86},null)
  assert.equal((await summaries.latest(interview)).stale,false)
  assert.equal((await summaries.latest(interview)).report.overallScore,86)
  console.log('PASS explicit rescoring publishes a new report and retains score history')
  await tenant.query("UPDATE interview_transcript_postprocess_jobs SET status='failed',attempts=3,error='synthetic failure' WHERE session_id=$1",[session])
  const failed = await summaries.latest(interview)
  assert.equal(failed.status,'failed'); assert.equal(failed.phase,'failed')
  await summaries.request(interview,actor)
  const retry = (await tenant.query('SELECT status,attempts,error FROM interview_transcript_postprocess_jobs WHERE session_id=$1',[session])).rows[0]
  assert.deepEqual(retry,{status:'pending',attempts:0,error:null})
  assert.equal(await summaries.claim(),null)
  console.log('PASS exhausted upstream processing is terminal and explicit retry resets the job without premature scoring')
  await assert.rejects(new InterviewSummaryRepository(otherTenant).request(interview,actor),{code:'INTERVIEW_NOT_ENDED'})
} finally {
  await otherTenant?.end(); await tenant?.end(); await pool?.end()
  if(created) await admin.query('DROP DATABASE "'+instance.database+'" WITH (FORCE)')
  await admin.end(); await instance.stop()
}
