import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { readRuntimeConfig } from './runtime-config.mjs'
import { fingerprintTables, verifyTableFingerprints } from './recovery-snapshot.mjs'
import { writePrivateRecoveryFile } from './private-recovery-files.mjs'
import { verifyRelease } from './runtime-release.mjs'

const [evidenceInput, releaseInput] = process.argv.slice(2)
const root = resolve(import.meta.dirname, '..'), evidence = resolve(evidenceInput), release = resolve(releaseInput)
const profile = join(evidence, 'business-maintenance.env'), configuration = readRuntimeConfig(root, { ...process.env, ENV_FILE_PATH: profile })
const manifest = await verifyRelease(release)
const load = file => import(pathToFileURL(join(release, 'apps/api/dist/src', file)).href)
const { loadDatabaseConfig } = await load('db/config.js')
const { createDatabasePool } = await load('db/connection.js')
const { runWithTenantContext } = await load('db/tenant-context.js')
const { NormalizedRecruitingRepository } = await load('recruiting/repositories/postgres-repository.js')
const { LiveInterviewSessionRepository } = await load('interviews/live-session-repository.js')
const { InterviewSummaryRepository } = await load('interviews/interview-summary-repository.js')
const { PostgresResumeImportStore } = await load('recruiting/resume-import.js')
const five = JSON.parse(await readFile(join(evidence, 'five-decisions-approved.json')))
const reconcile = JSON.parse(await readFile(join(evidence, 'reconcile-approved.json')))
const org = five.snapshot.organizationId, schema = five.snapshot.schema
const config = loadDatabaseConfig(configuration.env)
assert.equal(config.target, '127.0.0.1:5432/smartrecruit')
const options = '-c timezone=UTC -c default_transaction_read_only=on -c statement_timeout=60s'
const { target, ...connection } = config
const { Pool } = createRequire(join(release, 'apps/api/package.json'))('pg')
const audit = new Pool({ ...connection, max: 1, options, application_name: 'smartrecruit-business-smoke-audit' })
const pool = createDatabasePool({ ...config, max: 1, options, application_name: 'smartrecruit-business-smoke-routed' })
const report = { format: 'controlled-source-business-smoke/v1', startedAt: new Date().toISOString(), passed: false,
  release: { id: manifest.id, sha256: manifest.sha256 }, organizationId: org, sourceDatabaseReadOnly: true,
  externalMailSent: false, businessActionsReplayed: false, checks: [], limitations: ['Read-only business repositories against the actual source database with the selected candidate and tenant routing. Login UI and running-service health are verified separately after seal. No production write workflow or external model/mail/payment call is exercised here.'] }
const quote = value => '"' + value.replaceAll('"', '""') + '"'
try {
  const before = await fingerprintTables(audit)
  await runWithTenantContext({ organizationId: org, schemaName: schema }, async () => {
    const runtime = (await pool.query("SELECT current_schema() AS schema,current_setting('default_transaction_read_only') AS readonly")).rows[0]
    assert.equal(runtime.schema, schema); assert.equal(runtime.readonly, 'on')
    report.checks.push('Candidate connection routes to the real company schema and refuses persistent writes')
    const repository = new NormalizedRecruitingRepository(pool).withOrganization(org)
    const expectedCollections = { jobs: await repository.listJobs(), job_spec_versions: await repository.listJobSpecVersions(), job_description_versions: await repository.listJobDescriptionVersions() }
    for (const table of Object.keys(expectedCollections)) {
      const expected = reconcile.snapshot.entries.filter(row => row.action === 'preserve-company' && row.table === table)
      assert.equal(expected.length, { jobs: 3, job_spec_versions: 7, job_description_versions: 4 }[table])
      assert.ok(expected.every(row => expectedCollections[table].some(item => item.id === row.primaryKey[0])))
    }
    report.checks.push('Company-only 3 jobs, 7 specification versions and 4 description versions are readable through actual business repositories')
    const sessionEntry = five.snapshot.entries.find(row => row.table === 'interview_live_sessions')
    const interview = await new LiveInterviewSessionRepository(pool).get(sessionEntry.id)
    assert.equal(interview.session.status, 'completed')
    assert.equal(interview.completionReview.phase, 'completed')
    assert.equal(interview.completionReview.unresolvedCount, 69)
    assert.equal(interview.completionReview.limit, 30)
    assert.equal(interview.completionReview.versionId, five.snapshot.correctedVersionId)
    assert.ok(interview.segments.length > 0)
    const rawSession = (await pool.query('SELECT summary_report,summary_revision,manual_transcript_roles FROM interview_live_sessions WHERE id=$1', [sessionEntry.id])).rows[0]
    assert.deepEqual(rawSession.manual_transcript_roles, [])
    const summary = await new InterviewSummaryRepository(pool).latest(interview.session.interviewId)
    assert.equal(summary.sessionId, sessionEntry.id); assert.deepEqual(summary.report, rawSession.summary_report)
    assert.equal(summary.revision, rawSession.summary_revision); assert.ok(summary.report)
    report.interview = { status: interview.session.status, phase: interview.completionReview.phase, unresolvedRoles: 69, newCompletionLimit: 30, manualRolesFabricated: false, correctedVersionId: five.snapshot.correctedVersionId, summaryRevision: summary.revision }
    report.checks.push('Actual completed interview exposes corrected transcript and matching summary, retaining all 69 genuinely unresolved roles')
    const offerEntry = five.snapshot.entries.find(row => row.table === 'offers')
    const offer = await repository.getOffer(offerEntry.id), versions = await repository.listOfferVersions(offerEntry.id)
    assert.deepEqual(versions.map(row => row.version).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6])
    assert.equal(offer.version, 10); assert.equal(offer.currentVersionId, versions.find(row => row.version === 6).id)
    assert.ok(versions.every(row => typeof row.content === 'string'))
    report.offer = { bodyVersions: [1, 2, 3, 4, 5, 6], currentBodyVersion: 6, concurrencyVersion: offer.version, fabricatedVersions: false }
    report.checks.push('Offer repository returns original body v1-v6/current v6 independently of concurrency token 10')
    const batchEntry = five.snapshot.entries.find(row => row.table === 'resume_import_batches')
    const batch = await new PostgresResumeImportStore(pool, org).getBatch(batchEntry.id)
    assert.ok(batch); assert.equal(batch.jobId, ''); assert.ok(batch.detachedJobId && batch.detachedAt)
    report.checks.push('Actual import-batch business view retains unbinding and detached-job history')
    const templateEntry = five.snapshot.entries.find(row => row.table === 'offer_templates')
    assert.ok((await repository.listOfferTemplates()).some(row => row.id === templateEntry.id))
    for (const row of five.snapshot.entries) {
      const result = await pool.query("SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS hash FROM " + quote(schema) + '.' + quote(row.table) + ' t WHERE ' + quote(row.key) + '=$1', [row.id])
      assert.equal(result.rows[0].hash, row.expectedHash)
    }
    report.checks.push('All five repaired rows still match the approved whole-row hashes, including database microsecond timestamps')
    for (const event of reconcile.snapshot.entries.filter(row => row.action === 'copy-original-event')) {
      const original = (await audit.query('SELECT subject_type,subject_id FROM public.workflow_events WHERE id=$1', [event.primaryKey[0]])).rows[0]
      const events = await repository.listWorkflowEvents({ subjectType: original.subject_type, subjectId: original.subject_id, allForSubject: true })
      assert.ok(events.some(row => row.id === event.primaryKey[0]))
    }
    report.checks.push('All nine imported original workflow events are visible through normal subject-history reads, without replay')
  })
  verifyTableFingerprints(before, await fingerprintTables(audit))
  report.checks.push('Every persistent table fingerprint is unchanged by this controlled business smoke')
  report.passed = true
} catch (error) {
  report.failure = { code: typeof error.code === 'string' ? error.code : 'BUSINESS_SMOKE_FAILED', assertion: error.operator || null }
  process.exitCode = 1
} finally {
  await pool.end(); await audit.end(); report.finishedAt = new Date().toISOString()
  await writePrivateRecoveryFile(join(evidence, 'business-smoke-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}
