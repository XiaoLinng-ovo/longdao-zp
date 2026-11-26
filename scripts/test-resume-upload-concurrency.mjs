import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

// Compile current API/worker into an isolated directory, never the live dist.
const root = resolve(import.meta.dirname, '..')
const compiled = resolve(root, process.argv[2] || 'tmp/resume-upload-load-20261026')
const require = createRequire(join(root, 'apps/api/package.json'))
const { Pool } = require('pg')
const pools = new Set()
const connect = Pool.prototype.connect
Pool.prototype.connect = function (...args) { pools.add(this); return connect.apply(this, args) }
const load = (app, name) => import(pathToFileURL(join(compiled, `${app}/src/${name}.js`)).href)
await load('api', 'env')
const { loadDatabaseConfig } = await load('api', 'db/config')
const original = loadDatabaseConfig()
const parsed = original.connectionString ? new URL(original.connectionString) : undefined
const host = parsed?.hostname || original.host
assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host), 'Only local PostgreSQL may be tested')
const database = `resume_load_${randomUUID().replaceAll('-', '')}`
const { target, ...connection } = original
const admin = new Pool({ ...connection, max: 1, application_name: 'resume-load-readonly' })
const scratchConnection = process.env.RESUME_LOAD_DATABASE ? JSON.parse(process.env.RESUME_LOAD_DATABASE) : {
  host, port: Number(parsed?.port || original.port || 5432),
  user: parsed ? decodeURIComponent(parsed.username) : original.user,
  password: parsed ? decodeURIComponent(parsed.password) : original.password || '',
  database: parsed ? decodeURIComponent(parsed.pathname.slice(1)) : original.database,
}
assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(scratchConnection.host), 'Scratch PostgreSQL must be local')
const scratchAdmin = new Pool({ ...scratchConnection, max: 1, application_name: 'resume-load-isolated' })
const report = { measuredAt: new Date().toISOString(), scope: 'isolated local PostgreSQL; current HTTP API; local file storage; synthetic TXT; no external AI/OCR', production: {}, upload: [], worker: [], checks: {} }
report.testOnlyUploadLimits = { concurrency: 24, workspaceConcurrency: 24 }
let created = false, server, pool, baseUrl, token, csrf, organizationId, jobId, stopPoll
const storageRoot = join(compiled, `storage-${database}`)
const round = value => Math.round(value * 100) / 100
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0
async function send(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, { method,
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173',
      ...(token ? { authorization: `Bearer ${token}`, cookie: `smartrecruit_csrf=${csrf}`, 'x-csrf-token': csrf, 'x-workspace-id': organizationId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) })
  return { status: response.status, body: await response.json() }
}
function synthetic(bytes, index = 0) {
  return Buffer.from(`Name: Synthetic Tester\nEmail: test-${index}@example.invalid\nEducation: Bachelor of Computer Science\nExperience: 5 years\nSkills: Java, Spring Boot, PostgreSQL\n`.padEnd(bytes, ' '))
}
async function batch(count, bytes) {
  const response = await send('POST', '/api/v1/resume-import-batches', { jobId,
    files: Array.from({ length: count }, (_, index) => ({ clientFileId: randomUUID(), originalFilename: `synthetic-${index}.txt`, mimeType: 'text/plain', sizeBytes: bytes })) })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  return response.body.data
}
const uploadPath = (batch, item) => `/api/v1/resume-import-batches/${batch.id}/items/${item.id}/content`
async function lanes(items, concurrency, action) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; await action(items[index], index) }
  }))
}
async function waitFor(predicate, timeout = 60_000) {
  const start = performance.now()
  while (!(await predicate())) {
    if (performance.now() - start > timeout) throw new Error('Isolated test work timed out')
    await delay(20)
  }
}

try {
  await admin.query('BEGIN READ ONLY')
  try {
    await admin.query("SET LOCAL statement_timeout = '5s'")
    report.production.taskCounts = (await admin.query('SELECT status, count(*)::int AS count FROM analysis_tasks GROUP BY status')).rows
    report.production.recentTaskDurations = (await admin.query(`SELECT count(*)::int AS count,
      round(avg(extract(epoch FROM completed_at-started_at))::numeric,2) AS average_seconds,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at-started_at)) AS p50_seconds,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at-started_at)) AS p95_seconds
      FROM analysis_tasks WHERE status='completed' AND started_at IS NOT NULL AND completed_at>=started_at
      AND completed_at>now()-interval '24 hours'`)).rows[0]
    report.production.queue = (await admin.query("SELECT count(*)::int AS queued, max(extract(epoch FROM now()-created_at))::int AS oldest_seconds FROM analysis_tasks WHERE status='queued'")).rows[0]
    report.production.poolMax = original.max
    report.production.configuredWorkerConcurrency = Number(process.env.WORKER_CONCURRENCY || 1)
  } finally { await admin.query('ROLLBACK') }
  assert.match(database, /^resume_load_[a-f0-9]{32}$/)
  await scratchAdmin.query(`CREATE DATABASE "${database}"`)
  created = true
  delete process.env.DATABASE_URL
  Object.assign(process.env, { NODE_ENV: 'development', PGHOST: scratchConnection.host, PGPORT: String(scratchConnection.port),
    PGUSER: scratchConnection.user, PGPASSWORD: scratchConnection.password || '',
    DATABASE_URL: `postgresql://${encodeURIComponent(scratchConnection.user)}:${encodeURIComponent(scratchConnection.password || '')}@${scratchConnection.host}:${scratchConnection.port}/${database}`,
    PGDATABASE: database, DB_POOL_MAX: '10', REQUIRE_CSRF: 'true', ALLOWED_ORIGINS: 'http://127.0.0.1:5173', ALLOW_DEV_BOOTSTRAP_AUTH: 'false',
    RESUME_VIRUS_SCAN_ENABLED: 'false', WORKER_USE_LLM_ANALYSIS: 'false', QUESTION_SHEET_POLL: 'off',
    RESUME_UPLOAD_CONCURRENCY: '24', RESUME_UPLOAD_WORKSPACE_CONCURRENCY: '24', RESUME_ANALYSIS_QUEUE_LIMIT: '2000', RESUME_ANALYSIS_WORKSPACE_QUEUE_LIMIT: '500',
    S3_ENDPOINT: '', OPENAI_BASE_URL: '', OPENAI_API_KEY: '', OPENAI_MODEL: '', RESUME_LOCAL_OCR_ENABLED: 'false', RECRUITING_QUARANTINE_ROOT: storageRoot })
  assert.equal(loadDatabaseConfig().target, `${scratchConnection.host}:${scratchConnection.port}/${database}`)
  await mkdir(storageRoot, { recursive: true })
  pool = new Pool({ host: scratchConnection.host, port: Number(process.env.PGPORT), user: process.env.PGUSER, password: process.env.PGPASSWORD, database, max: 10 })
  const { runMigrations } = await load('api', 'db/migrations')
  report.checks.migrations = (await runMigrations(pool, join(root, 'db/migrations'))).applied.length
  const { hashPassword } = await load('api', 'auth/password')
  const actor = randomUUID(), password = randomUUID()
  organizationId = randomUUID(); jobId = randomUUID()
  await pool.query('INSERT INTO users(id,email,display_name,password_hash,is_active) VALUES($1,$2,$3,$4,true)', [actor, 'load-test@example.invalid', 'Synthetic Load Test', await hashPassword(password)])
  await pool.query("INSERT INTO organizations(id,name,kind,service_status) VALUES($1,'Isolated load test','test','enabled')", [organizationId])
  await pool.query("INSERT INTO organization_members(organization_id,user_id,role,business_role) VALUES($1,$2,'owner','recruiter')", [organizationId, actor])
  await pool.query("INSERT INTO jobs(id,organization_id,job_no,title,headcount,status) VALUES($1,$2,$3,'Synthetic Software Engineer',1,'published')", [jobId, organizationId, `JOB-${randomUUID()}`])
  const { createHttpServer } = await load('api', 'server')
  const { loadConfig } = await load('api', 'config')
  server = createHttpServer(loadConfig({ ...process.env, PORT: '0' }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  const login = await fetch(`${baseUrl}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'load-test@example.invalid', password }), signal: AbortSignal.timeout(30_000) })
  assert.equal(login.status, 200, await login.clone().text())
  const cookies = login.headers.getSetCookie()
  token = decodeURIComponent(cookies.find(value => value.startsWith('smartrecruit_session=')).split(';')[0].slice('smartrecruit_session='.length))
  csrf = decodeURIComponent(cookies.find(value => value.startsWith('smartrecruit_csrf=')).split(';')[0].slice('smartrecruit_csrf='.length))
  await login.arrayBuffer()
  await pool.query('UPDATE sessions SET active_organization_id=$1 WHERE user_id=$2', [organizationId, actor])
  if (process.env.RESUME_LOAD_BROWSER === 'true') {
    const { verifyResumeUploadBrowser } = await import('./resume-upload-browser-check.mjs')
    report.checks.browser = await verifyResumeUploadBrowser({ root, baseUrl, token, csrf, jobId, reportDirectory: compiled })
    console.log(JSON.stringify({ browser: report.checks.browser }))
    // The synthetic PDF verifies transport only, not document parsing.
    await pool.query('DELETE FROM analysis_tasks WHERE id IN (SELECT analysis_task_id FROM resume_import_items WHERE batch_id=$1::uuid)', [report.checks.browser.batchId])
    report.checks.browserResponseRecovery = await verifyResumeUploadBrowser({ root, baseUrl, token, csrf, jobId, reportDirectory: compiled, loseResponse: true })
    console.log(JSON.stringify({ browserResponseRecovery: report.checks.browserResponseRecovery }))
    await pool.query('DELETE FROM analysis_tasks WHERE id IN (SELECT analysis_task_id FROM resume_import_items WHERE batch_id=$1::uuid)', [report.checks.browserResponseRecovery.batchId])
  }
  for (const bytes of [256 * 1024, 5 * 1024 * 1024]) {
    for (const concurrency of [1, 3, 5, 10, 20]) {
      const count = bytes > 1024 * 1024 ? Math.max(concurrency, 6) : Math.max(concurrency * 2, 12)
      const fixture = await batch(count, bytes)
      const durations = [], probes = [], errors = [], statuses = {}
      let active = 0, peak = 0, peakRss = process.memoryUsage().rss, probeBusy = false
      const sampler = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss)
        if (!probeBusy) {
          probeBusy = true
          const start = performance.now()
          void send('GET', '/api/v1/jobs').then(response => {
            probes.push(performance.now() - start)
            if (response.status !== 200) errors.push(`read:${response.status}`)
          }).catch(error => errors.push(`read:${error.message}`)).finally(() => { probeBusy = false })
        }
      }, 100)
      const start = performance.now()
      try {
        await lanes(fixture.items, concurrency, async (item, index) => {
          peak = Math.max(peak, ++active)
          const requestStart = performance.now()
          try {
            const response = await send('POST', uploadPath(fixture, item), { content: synthetic(bytes, index).toString('base64'), encoding: 'base64' })
            statuses[response.status] = (statuses[response.status] || 0) + 1
            if (response.status !== 200) errors.push(response.body.error)
          } catch (error) { errors.push(error.message) }
          finally { active--; durations.push(performance.now() - requestStart) }
        })
      } finally { clearInterval(sampler); await waitFor(() => !probeBusy) }
      const elapsed = performance.now() - start
      const refreshed = await send('GET', `/api/v1/resume-import-batches/${fixture.id}`)
      assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body))
      const result = { bytes, count, concurrency, peak, accepted: refreshed.body.data.counts.uploaded,
        seconds: round(elapsed / 1000), perSecond: round(count / (elapsed / 1000)),
        p50Ms: round(percentile(durations, 0.5)), p95Ms: round(percentile(durations, 0.95)),
        readProbeCount: probes.length, readP95Ms: round(percentile(probes, 0.95)), peakProcessRssMiB: round(peakRss / 1024 / 1024), statuses, errors }
      report.upload.push(result)
      console.log(JSON.stringify({ upload: result }))
      assert.equal(errors.length, 0, JSON.stringify(errors))
      assert.equal(result.accepted, count)
      const stored = (await pool.query('SELECT count(*)::int AS count FROM resumes WHERE id=ANY($1::uuid[])', [refreshed.body.data.items.map(item => item.resumeId)])).rows[0].count
      assert.equal(stored, count)
      await pool.query('DELETE FROM analysis_tasks WHERE id=ANY($1::uuid[])', [refreshed.body.data.items.map(item => item.analysisTaskId)])
    }
  }
  const { createLocalObjectStorage } = await import(pathToFileURL(join(root, 'packages/object-storage/dist/index.js')).href)
  const { PostgresAnalysisTaskStore } = await load('worker', 'db/analysis-task-store')
  const { startPersistedPoll } = await load('worker', 'db/persisted-poll')
  const { createTaskExecutor } = await load('worker', 'runner')
  const storage = createLocalObjectStorage(storageRoot)
  for (const concurrency of [1, 3, 5]) {
    const fixture = await batch(12, 4096)
    await lanes(fixture.items, 3, item => send('POST', uploadPath(fixture, item), { content: synthetic(4096).toString('base64'), encoding: 'base64' }).then(response => assert.equal(response.status, 200)))
    const ready = (await send('GET', `/api/v1/resume-import-batches/${fixture.id}`)).body.data
    let active = 0, peak = 0
    const ids = ready.items.map(item => item.analysisTaskId)
    const store = new PostgresAnalysisTaskStore(pool)
    const claim = store.claimNextTask.bind(store), complete = store.completeTask.bind(store), fail = store.failTask.bind(store)
    store.claimNextTask = async input => { const lease = await claim(input); if (lease) peak = Math.max(peak, ++active); return lease }
    store.completeTask = async input => { try { return await complete(input) } finally { active-- } }
    store.failTask = async input => { try { return await fail(input) } finally { active-- } }
    const errors = [], start = performance.now()
    stopPoll = startPersistedPoll({ pool, store, storage, concurrency, maxAttempts: 3, leaseDurationMs: 360_000, pollIntervalMs: 20,
      executor: (() => {
        const executor = createTaskExecutor(), execute = executor.execute.bind(executor)
        executor.execute = async input => { await delay(100); return execute(input) }
        return executor
      })(), logger: { log() {}, warn(message) { errors.push(message) }, error(message) { errors.push(message) } } })
    try {
      await waitFor(async () => (await pool.query("SELECT count(*)::int AS count FROM analysis_tasks WHERE id=ANY($1::uuid[]) AND status='completed'", [ids])).rows[0].count === ids.length)
      await waitFor(() => active === 0)
      const results = (await pool.query('SELECT count(*)::int AS count, count(DISTINCT analysis_task_id)::int AS unique_count FROM analysis_results WHERE analysis_task_id=ANY($1::uuid[])', [ids])).rows[0]
      report.worker.push({ concurrency, peak, count: ids.length, seconds: round((performance.now() - start) / 1000), results: results.count, uniqueResults: results.unique_count, errors })
      assert.equal(results.count, ids.length); assert.equal(results.unique_count, ids.length)
      assert.equal(peak, concurrency)
      assert.equal(errors.length, 0, JSON.stringify(errors))
    } finally { stopPoll(); stopPoll = undefined; await delay(60) }
    console.log(JSON.stringify({ worker: report.worker.at(-1) }))
  }

  const backlog = await batch(18, 4096)
  await lanes(backlog.items, 3, item => send('POST', uploadPath(backlog, item), { content: synthetic(4096).toString('base64'), encoding: 'base64' }).then(response => assert.equal(response.status, 200)))
  const slowExecutor = createTaskExecutor(), execute = slowExecutor.execute.bind(slowExecutor)
  slowExecutor.execute = async input => { await delay(100); return execute(input) }
  const slowErrors = [], backlogStart = performance.now()
  stopPoll = startPersistedPoll({ pool, store: new PostgresAnalysisTaskStore(pool), storage, concurrency: 3,
    maxAttempts: 3, leaseDurationMs: 360_000, pollIntervalMs: 20, executor: slowExecutor,
    logger: { log() {}, warn(message) { slowErrors.push(message) }, error(message) { slowErrors.push(message) } } })
  try {
    await waitFor(async () => (await pool.query("SELECT count(*)::int AS count FROM analysis_tasks WHERE status='processing'")).rows[0].count === 3)
    const additional = await batch(6, 4096), additionalStart = performance.now()
    await lanes(additional.items, 3, item => send('POST', uploadPath(additional, item), { content: synthetic(4096).toString('base64'), encoding: 'base64' }).then(response => assert.equal(response.status, 200)))
    const uploadMs = performance.now() - additionalStart
    const snapshot = (await pool.query('SELECT status, count(*)::int AS count FROM analysis_tasks GROUP BY status')).rows
    const read = await send('GET', '/api/v1/jobs')
    assert.equal(read.status, 200)
    assert.ok(snapshot.some(row => row.status === 'queued' && row.count > 0))
    assert.equal(snapshot.find(row => row.status === 'processing')?.count, 3)
    const imported = await Promise.all([backlog, additional].map(fixture => send('GET', `/api/v1/resume-import-batches/${fixture.id}`)))
    const ids = imported.flatMap(response => response.body.data.items.map(item => item.analysisTaskId))
    await waitFor(async () => (await pool.query("SELECT count(*)::int AS count FROM analysis_tasks WHERE status='completed' AND id=ANY($1::uuid[])", [ids])).rows[0].count === 24)
    const results = (await pool.query('SELECT count(*)::int AS count, count(DISTINCT analysis_task_id)::int AS unique_count FROM analysis_results WHERE analysis_task_id=ANY($1::uuid[])', [ids])).rows[0]
    assert.equal(results.count, 24); assert.equal(results.unique_count, 24); assert.equal(slowErrors.length, 0)
    report.checks.congestion = { artificialParserDelayMs: 100, concurrency: 3, backlogBefore: 18, additionalUploads: 6,
      additionalUploadMs: round(uploadMs), snapshot, readStatus: read.status, completed: results.count,
      uniqueResults: results.unique_count, drainSeconds: round((performance.now() - backlogStart) / 1000), errors: slowErrors }
  } finally { stopPoll(); stopPoll = undefined; await delay(60) }

  const retryBatch = await batch(2, 4096), firstItem = retryBatch.items[0]
  const invalid = await send('POST', uploadPath(retryBatch, firstItem), { content: '====', encoding: 'base64' })
  const failedItem = (await send('GET', `/api/v1/resume-import-batches/${retryBatch.id}`)).body.data.items[0]
  const valid = await send('POST', uploadPath(retryBatch, firstItem), { content: synthetic(4096).toString('base64'), encoding: 'base64' })
  const repeated = await send('POST', uploadPath(retryBatch, firstItem), { content: synthetic(4096).toString('base64'), encoding: 'base64' })
  const cancelled = await send('POST', `/api/v1/resume-import-batches/${retryBatch.id}/cancel`, {})
  report.checks.retry = { failureStatus: invalid.status, initialCandidateIdRetained: valid.body.data.candidateId === failedItem.candidateId,
    repeatedTaskReused: valid.body.data.analysisTaskId === repeated.body.data.analysisTaskId,
    acceptedItemSurvivesCancellation: cancelled.body.data.items[0].status === 'queued', pendingItemCancelled: cancelled.body.data.items[1].status === 'cancelled' }
  assert.equal(invalid.status, 400); assert.equal(failedItem.status, 'failed'); assert.ok(failedItem.candidateId); assert.equal(valid.status, 200)
  assert.ok(Object.entries(report.checks.retry).every(([key, value]) => key === 'failureStatus' || value === true))
  const duplicateBatch = await batch(1, 4096)
  const before = (await pool.query('SELECT count(*)::int AS count FROM resumes')).rows[0].count
  const duplicates = await Promise.all(Array.from({ length: 10 }, () => send('POST', uploadPath(duplicateBatch, duplicateBatch.items[0]), { content: synthetic(4096).toString('base64'), encoding: 'base64' })))
  const after = (await pool.query('SELECT count(*)::int AS count FROM resumes')).rows[0].count
  report.checks.concurrentDuplicate = { requests: 10, statuses: duplicates.map(result => result.status), createdResumes: after - before,
    uniqueAcceptedTaskIds: new Set(duplicates.filter(result => result.status === 200).map(result => result.body.data.analysisTaskId)).size, safe: after - before === 1 }
  assert.equal(report.checks.concurrentDuplicate.safe, true, 'Concurrent retries must not create duplicate resumes')
  assert.equal(report.checks.concurrentDuplicate.uniqueAcceptedTaskIds, 1)

  // A second HTTP app uses the real default caps rather than the high test-only upload caps.
  const previousServer = server, previousBaseUrl = baseUrl
  process.env.RESUME_UPLOAD_CONCURRENCY = '6'; process.env.RESUME_UPLOAD_WORKSPACE_CONCURRENCY = '3'
  process.env.RESUME_ANALYSIS_WORKSPACE_QUEUE_LIMIT = '1'
  server = createHttpServer(loadConfig({ ...process.env, PORT: '0' }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    const guarded = await batch(1, 4096)
    const rejected = await send('POST', uploadPath(guarded, guarded.items[0]), { content: synthetic(4096).toString('base64'), encoding: 'base64' })
    assert.equal(rejected.status, 429)
    assert.equal(rejected.body.error.code, 'RESUME_ANALYSIS_QUEUE_FULL')
    assert.equal(rejected.body.error.details.retryAfterSeconds, 10)
    const untouched = (await send('GET', `/api/v1/resume-import-batches/${guarded.id}`)).body.data.items[0]
    assert.equal(untouched.status, 'pending_upload'); assert.equal(untouched.attempts, 0); assert.equal(untouched.candidateId, undefined)
    const read = await send('GET', '/api/v1/jobs'); assert.equal(read.status, 200)
    report.checks.backpressure = { status: rejected.status, code: rejected.body.error.code, retryAfterSeconds: 10, noCandidateCreated: !untouched.candidateId, itemStatus: untouched.status, readStatus: read.status }
  } finally {
    server.closeIdleConnections(); await new Promise(resolve => server.close(resolve))
    server = previousServer; baseUrl = previousBaseUrl
  }
  report.checks.oversizedBatch = (await send('POST', '/api/v1/resume-import-batches', { jobId, files: Array.from({ length: 501 }, (_, index) => ({ clientFileId: String(index), originalFilename: `limit-${index}.txt`, mimeType: 'text/plain', sizeBytes: 4096 })) })).status
  assert.equal(report.checks.oversizedBatch, 400)
  console.log(JSON.stringify({ checks: report.checks }))
} catch (error) {
  report.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
  process.exitCode = 1
  console.error(report.error)
} finally {
  stopPoll?.()
  if (server) { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)) }
  await Promise.all([...pools].filter(candidate => candidate !== admin && candidate !== scratchAdmin).map(candidate => candidate.end().catch(() => undefined)))
  if (created) {
    assert.match(database, /^resume_load_[a-f0-9]{32}$/)
    assert.notEqual(database, original.database)
    await scratchAdmin.query(`DROP DATABASE "${database}"`)
    report.checks.scratchDatabaseRemoved = true
  }
  await admin.end()
  await scratchAdmin.end()
  assert.equal(resolve(storageRoot, '..'), compiled)
  await rm(storageRoot, { recursive: true, force: true })
  report.checks.scratchStorageRemoved = true
  await mkdir(compiled, { recursive: true })
  await writeFile(join(compiled, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`Report: ${join(compiled, 'report.json')}`)
}
