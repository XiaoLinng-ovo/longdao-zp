import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { successfulTapSummary } from './test-business-postgres-isolated.mjs'

assert.ok(process.argv[2], 'An explicit isolated PostgreSQL binary directory is required')
const instance = await startIsolatedPostgres(process.argv[2])
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
const { Pool } = require('pg')
const admin = new Pool(instance.connection)
let pool
const report = { passed: false, checks: [], cleanup: {} }
try {
  assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name, instance.cluster)
  await admin.query('CREATE DATABASE "' + instance.database + '"')
  pool = new Pool({ ...instance.connection, database: instance.database, max: 4 })
  const load = name => import(pathToFileURL(join(projectRoot, 'apps/api/dist/src', name + '.js')).href)
  const { runMigrations } = await load('db/migrations')
  report.migrations = (await runMigrations(pool, join(projectRoot, 'db/migrations'))).applied
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', join(projectRoot, 'apps/api/dist/tests/interview-completion.postgres.integration.test.js')],
      { cwd: projectRoot, env: { ...instance.env, NODE_ENV: 'test' }, windowsHide: true, timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.once('error', reject); child.once('close', code => resolve({ code, output }))
  })
  await writeFile(join(instance.directory, 'completion.tap.log'), result.output)
  assert.equal(result.code, 0, 'Completion integration failed; inspect ' + instance.directory)
  report.integration = successfulTapSummary(result.output)
  report.checks.push('31-to-30 review; immutable corrections; stable stop time; stale version rejection; conclusion gate')
  report.checks.push('stage confirmation: score retention; recording gate; complete rollback on next-round insert failure; idempotent round reuse; scheduling gate')

  const f = Object.fromEntries(['org', 'user', 'candidate', 'job', 'app', 'interview', 'offer'].map(key => [key, randomUUID()]))
  await pool.query("INSERT INTO organizations(id,name,kind) VALUES($1,'isolated-role-review','test')", [f.org])
  await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'isolated-role-review')", [f.user, f.user + '@example.invalid'])
  await pool.query('INSERT INTO organization_members(organization_id,user_id) VALUES($1,$2)', [f.org, f.user])
  await pool.query("INSERT INTO candidates(id,organization_id,candidate_no,name) VALUES($1,$2,$3,'isolated')", [f.candidate, f.org, f.candidate])
  await pool.query("INSERT INTO jobs(id,organization_id,job_no,title,headcount) VALUES($1,$2,$3,'isolated',1)", [f.job, f.org, f.job])
  await pool.query("INSERT INTO applications(id,organization_id,application_no,candidate_id,job_id,status) VALUES($1,$2,$3,$4,$5,'interviewing')", [f.app, f.org, f.app, f.candidate, f.job])
  await pool.query("INSERT INTO interviews(id,organization_id,application_id,interview_no,round,stage,type,title,participants) VALUES($1,$2,$3,$4,1,'initial','technical','isolated','[]')", [f.interview, f.org, f.app, f.interview])
  await pool.query("INSERT INTO offers(id,organization_id,application_id,status) VALUES($1,$2,$3,'draft')", [f.offer, f.org, f.app])
  const { LiveInterviewSessionRepository } = await load('interviews/live-session-repository')
  const { InterviewAudioRecordingRepository } = await load('interviews/audio-recording-repository')
  const { NormalizedRecruitingRepository } = await load('recruiting/repositories/postgres-repository')
  const sessions = new LiveInterviewSessionRepository(pool)
  const session = await sessions.create(f.interview, f.user)
  await pool.query('UPDATE interview_live_sessions SET organization_id=$2 WHERE id=$1', [session.id, f.org])
  const recordings = new InterviewAudioRecordingRepository(pool)
  const recording = { sessionId: session.id, objectKey: 'isolated/' + randomUUID(), contentType: 'audio/webm', offsetMs: 0, endMs: 1000,
    byteLength: 1, audioSource: 'meeting', sourceRole: 'unknown', sourceMultipleSpeakers: true }
  await recordings.save(recording, {})
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM interview_audio_transcription_jobs WHERE session_id=$1', [session.id])).rows[0].n, 1)
  await recordings.save(recording, {})
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM interview_audio_transcription_jobs WHERE session_id=$1', [session.id])).rows[0].n, 1)
  await sessions.end(session.id)
  await pool.query("UPDATE interview_live_sessions SET status='completed' WHERE id=$1", [session.id])
  await assert.rejects(recordings.save({ ...recording, objectKey: 'isolated/' + randomUUID() }, {}), /LIVE_SESSION_CLOSED/)
  report.checks.push('atomic manifest and transcription queue; duplicate uploads; closed session rejects late audio')

  const recruiting = new NormalizedRecruitingRepository(pool, { organizationId: f.org })
  const { QuestionSheetRepository } = await load('interviews/question-sheet-repository')
  const stageCandidate = randomUUID(), stageApp = randomUUID(), stageInterview = randomUUID()
  await pool.query("INSERT INTO candidates(id,organization_id,candidate_no,name) VALUES($1,$2,$3,'stage-concurrency')", [stageCandidate, f.org, stageCandidate])
  await pool.query("INSERT INTO applications(id,organization_id,application_no,candidate_id,job_id,status) VALUES($1,$2,$3,$4,$5,'interviewing')", [stageApp, f.org, stageApp, stageCandidate, f.job])
  await pool.query("INSERT INTO interviews(id,organization_id,application_id,interview_no,round,stage,type,title,participants) VALUES($1,$2,$3,$4,1,'initial','technical','stage-concurrency','[]')", [stageInterview, f.org, stageApp, stageInterview])
  const stageSheets = new QuestionSheetRepository(pool)
  const confirmations = await Promise.all([
    ...Array.from({ length: 8 }, () => stageSheets.recordStageDecision(stageApp, 'initial', 'advanced', f.user)),
    recruiting.concludeInterview(stageInterview, 'continue', f.user, true),
  ])
  assert.equal(new Set(confirmations.slice(0, 8).map(row => row.nextInterview.id)).size, 1)
  const stageRounds = await recruiting.listInterviews(stageApp)
  assert.equal(stageRounds.length, 2)
  assert.equal(stageRounds.find(row => row.id === stageInterview).status, 'completed')
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM workflow_events WHERE subject_id=$1 AND event_type='conclude'", [stageInterview])).rows[0].n, 1)
  assert.equal((await recruiting.listInterviewResults([stageInterview])).get(stageInterview).outcome, 'continue')
  await recruiting.correctInterviewConclusion(stageInterview, 'reject', 'isolated correction test', f.user)
  await assert.rejects(stageSheets.recordStageDecision(stageApp, 'initial', 'advanced', f.user), /初试已有其他结论/)
  assert.equal((await recruiting.listInterviewResults([stageInterview])).get(stageInterview).outcome, 'reject')
  assert.equal((await recruiting.listInterviews(stageApp)).filter(row => row.stage === 'final').length, 1)
  report.checks.push('8 concurrent stage confirmations plus formal completion produce exactly one next round and one conclusion; corrected rejection cannot be overwritten')
  const input = { offerId: f.offer, positionTitle: 'isolated', employmentType: 'full_time', content: 'v1' }
  const v1 = await recruiting.createOfferVersion(input)
  assert.equal(v1.version, 1)
  await pool.query('UPDATE offers SET current_version_id=$2 WHERE id=$1', [f.offer, v1.id])
  const initial = await recruiting.getOffer(f.offer)
  const parallel = await Promise.allSettled([1, 2].map(index => recruiting.reviseOffer({ ...input, content: 'update-' + index }, v1.id, initial.version, f.user)))
  assert.equal(parallel.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(parallel.find(row => row.status === 'rejected').reason.code, 'OFFER_VERSION_CONFLICT')
  const latest = await recruiting.getOffer(f.offer)
  const versions = await recruiting.listOfferVersions(f.offer)
  assert.deepEqual(versions.map(row => row.version), [2, 1])
  assert.equal(latest.currentVersionId, versions[0].id)
  assert.equal(versions[1].content, 'v1')
  await assert.rejects(recruiting.createOfferVersion({ ...input, version: 9 }), { code: 'OFFER_VERSION_CONFLICT' })
  assert.equal((await recruiting.listOfferVersions(f.offer)).length, 2)
  report.checks.push('Offer v1/v2; one concurrent CAS conflict; latest pointer; preserved history; no version jumps')

  const schema = (await pool.query('SELECT public.initialize_organization_schema($1) AS schema', [f.org])).rows[0].schema
  assert.match(schema, /^company_[a-f0-9]{32}$/)
  const tenant = await pool.connect()
  try {
    await tenant.query('BEGIN')
    await tenant.query('SET LOCAL search_path="' + schema + '",public')
    assert.equal((await tenant.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='interview_live_sessions' AND column_name='manual_transcript_roles'", [schema])).rows[0].n, 1)
    assert.equal((await tenant.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='interview_audio_recordings'::regclass AND tgname='invalidate_stopped_interview_audio'")).rows[0].n, 1)
    await assert.rejects(new InterviewAudioRecordingRepository(tenant).save({ ...recording, objectKey: 'isolated/' + randomUUID() }, {}), /LIVE_SESSION_CLOSED/)
    await tenant.query('ROLLBACK')
  } finally { tenant.release() }
  report.checks.push('new company schemas inherit manual review column and late-audio protection')
  report.passed = true
} finally {
  try { await pool?.end(); await admin.end(); report.cleanup.connectionsClosed = true }
  finally { await instance.stop(); report.cleanup.postgresStopped = true }
  await writeFile(join(instance.directory, 'role-review-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...report, reportPath: join(instance.directory, 'role-review-report.json') }, null, 2))
}
