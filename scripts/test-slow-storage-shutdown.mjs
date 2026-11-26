import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { createShutdownBudget, runWithRuntimeSignal } from '../packages/runtime-lifecycle/index.js'

const argument = process.argv.indexOf('--postgres-bin')
const audioArgument = process.argv.indexOf('--ffmpeg')
assert.ok(argument >= 0 && process.argv[argument + 1], '必须指定专用 PostgreSQL 工具目录')
assert.ok(audioArgument >= 0 && process.argv[audioArgument + 1], '必须指定真实 ffmpeg')
const instance = await startIsolatedPostgres(process.argv[argument + 1])
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, instance.env)
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
const { Pool } = require('pg')
const load = (app, file) => import(pathToFileURL(join(projectRoot, 'apps', app, 'dist/src', file + '.js')).href)
const report = { startedAt: new Date().toISOString(), scope: '真实API、Worker、PostgreSQL及ffmpeg，仅S3使用本机HTTP边界替身', checks: [], cleanup: {}, failures: [] }
const output = join(instance.directory, 'slow-storage-report.json')
const observer = new Pool(instance.connection)
let created = false, databasePool, api, worker, audio, audioWork, receiveWork, workspace, work = []
let holdPut = false, holdGet = false
const objects = new Map(), gates = new Set(), requests = new Set()
const counts = { blockedPuts: 0, blockedGets: 0 }
const storage = createServer(async (req, res) => {
  requests.add(res)
  res.once('close', () => requests.delete(res))
  try {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (req.method === 'HEAD') { res.writeHead(200); res.end(); return }
    const pause = () => new Promise(resolve => {
      const done = () => { gates.delete(done); res.removeListener('close', done); resolve() }
      gates.add(done); res.once('close', done)
    })
    if (req.method === 'PUT') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      objects.set(path, Buffer.concat(chunks))
      if (holdPut) { counts.blockedPuts++; await pause() }
      if (!res.destroyed) { res.writeHead(200, { ETag: '"synthetic-etag"' }); res.end() }
    } else if (req.method === 'GET') {
      if (holdGet) { counts.blockedGets++; await pause() }
      if (res.destroyed) return
      const body = objects.get(path)
      res.writeHead(body ? 200 : 404, { 'content-length': body?.length ?? 0, 'content-type': 'text/plain' }); res.end(body)
    } else if (req.method === 'DELETE') { objects.delete(path); res.writeHead(204); res.end() }
    else { res.writeHead(405); res.end() }
  } catch { if (!res.destroyed) { res.writeHead(500); res.end() } }
})
const releaseGates = () => { holdPut = false; holdGet = false; for (const release of [...gates]) release() }
async function waitFor(predicate, timeout = 10000) {
  const started = performance.now()
  while (!await predicate()) { assert.ok(performance.now() - started < timeout, '联合测试等待超时'); await delay(10) }
}
async function cleanupRuntime() {
  const outcomes = await Promise.allSettled([api?.closeAsync(), worker?.close(), audio?.run('音频联合资源', async () => {
    await Promise.allSettled([audioWork, receiveWork]); await workspace?.close()
  })])
  api = undefined; worker = undefined; audio = undefined; workspace = undefined
  releaseGates()
  await Promise.allSettled(work); work = []
  const errors = outcomes.filter(row => row.status === 'rejected').map(row => row.reason)
  if (errors.length) throw new AggregateError(errors, '联合运行时回收失败')
}
try {
  await new Promise(resolve => storage.listen(0, '127.0.0.1', resolve))
  process.env.ISOLATED_ALLOWED_PORTS += ',' + storage.address().port
  require(join(projectRoot, 'scripts/isolated-network-guard.cjs'))
  // Only the harness itself may call its subsequently allocated loopback API ports.
  const guardedFetch = globalThis.fetch
  assert.equal((await observer.query('SHOW cluster_name')).rows[0].cluster_name, instance.cluster)
  await observer.query('CREATE DATABASE "' + instance.database + '"'); created = true
  databasePool = new Pool({ ...instance.connection, database: instance.database })
  const { runMigrations } = await load('api', 'db/migrations')
  report.migrations = (await runMigrations(databasePool, join(projectRoot, 'db/migrations'))).applied.length
  const { hashPassword } = await load('api', 'auth/password')
  const companies = []
  for (let index = 0; index < 2; index++) {
    const company = { id: randomUUID(), userId: randomUUID(), jobId: randomUUID(), password: randomUUID() }
    company.email = company.userId + '@example.invalid'
    await databasePool.query('INSERT INTO users(id,email,display_name,password_hash,is_active) VALUES($1,$2,$3,$4,true)', [company.userId, company.email, '合成普通用户', await hashPassword(company.password)])
    await databasePool.query("INSERT INTO organizations(id,name,kind,service_status) VALUES($1,'合成公司','test','enabled')", [company.id])
    await databasePool.query("INSERT INTO organization_members(organization_id,user_id,role,business_role) VALUES($1,$2,'member','recruiter')", [company.id, company.userId])
    await databasePool.query("INSERT INTO jobs(id,organization_id,job_no,title,headcount,status) VALUES($1,$2,$3,'合成资源验收岗位',1,'published')", [company.jobId, company.id, 'JOB-' + randomUUID()])
    company.schema = (await databasePool.query('SELECT public.initialize_organization_schema($1) AS schema', [company.id])).rows[0].schema
    companies.push(company)
  }
  const { startServer } = await load('api', 'server'), { loadConfig } = await load('api', 'config')
  const { createDatabasePool } = await load('api', 'db/connection')
  const { startWorker } = await load('worker', 'worker'), { loadConfig: workerConfig } = await load('worker', 'config')
  const { AudioWorkspace, runAudioProcess, audioResourceSnapshot } = await load('api', 'interviews/audio-resources')
  const { request: httpRequest } = await import('node:http')
  // HTTP requests use the already-created server's loopback listener, not a remote URL.
  async function request(port, company, method, path, body) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173',
        ...(company.token ? { authorization: 'Bearer ' + company.token, cookie: 'smartrecruit_csrf=' + company.csrf, 'x-csrf-token': company.csrf, 'x-workspace-id': company.id } : {}) } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject)
        res.once('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()), cookies: res.headers['set-cookie'] ?? [] }) } catch (error) { reject(error) } })
      })
      req.once('error', reject); req.setTimeout(6000, () => req.destroy(new Error('真实业务请求超时')))
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }
  for (const max of [1, 2]) {
    const record = { poolMax: max, checks: {} }; report.checks.push(record)
    Object.assign(process.env, { DB_POOL_MAX: String(max), PGCONNECT_TIMEOUT_MS: '4000', S3_ENDPOINT: 'http://127.0.0.1:' + storage.address().port,
      S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: 'synthetic-access', S3_SECRET_ACCESS_KEY: randomUUID(), S3_QUARANTINE_BUCKET: 'isolated-resumes', S3_FORCE_PATH_STYLE: 'true',
      WORKER_SHARED_CONCURRENCY: '2', WORKER_WORKSPACE_CONCURRENCY: '1', RESUME_UPLOAD_CONCURRENCY: '8', RESUME_UPLOAD_WORKSPACE_CONCURRENCY: '4' })
    let sharedPool
    api = await startServer(loadConfig({ ...process.env, HOST: '127.0.0.1', PORT: '0' }), { poolFactory: () => sharedPool = createDatabasePool() })
    const port = api.address().port
    // Authorize only the exact newly allocated loopback port.
    require(join(projectRoot, 'scripts/isolated-network-guard.cjs')).allowLoopbackPort(port)
    assert.equal(globalThis.fetch, guardedFetch)
    for (const company of companies) {
      const login = await request(port, company, 'POST', '/api/v1/auth/login', { email: company.email, password: company.password })
      assert.equal(login.status, 200, JSON.stringify(login.body))
      company.token = decodeURIComponent(login.cookies.find(value => value.startsWith('smartrecruit_session=')).split(';')[0].slice('smartrecruit_session='.length))
      company.csrf = decodeURIComponent(login.cookies.find(value => value.startsWith('smartrecruit_csrf=')).split(';')[0].slice('smartrecruit_csrf='.length))
      await databasePool.query('UPDATE sessions SET active_organization_id=$1 WHERE user_id=$2', [company.id, company.userId])
    }
    const content = Buffer.from('姓名：合成同名人员' + String.fromCharCode(10) + '本科，五年软件开发经验，Java PostgreSQL Vue')
    async function batch(company, count) {
      const response = await request(port, company, 'POST', '/api/v1/resume-import-batches', { jobId: company.jobId, files: Array.from({ length: count }, () => ({ clientFileId: randomUUID(), originalFilename: 'synthetic.txt', mimeType: 'text/plain', sizeBytes: content.length })) })
      assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.data
    }
    const upload = (company, batch, item) => request(port, company, 'POST', '/api/v1/resume-import-batches/' + batch.id + '/items/' + item.id + '/content', { content: content.toString('base64'), encoding: 'base64' })
    const fixture = await batch(companies[0], 1)
    assert.equal((await upload(companies[0], fixture, fixture.items[0])).status, 200)
    holdGet = true
    worker = await startWorker({ ...workerConfig({ ...process.env, WORKER_HEALTH_PORT: '0', WORKER_DB_POLL: 'true', WORKER_POLL_INTERVAL_MS: '25' }), leaseDurationMs: 1200 })
    await waitFor(() => counts.blockedGets > 0)
    const taskId = (await databasePool.query('SELECT id FROM "' + companies[0].schema + '".analysis_tasks WHERE status=$1', ['processing'])).rows[0].id
    const initialExpiry = (await databasePool.query('SELECT expires_at FROM public.analysis_execution_leases WHERE task_id=$1', [taskId])).rows[0].expires_at
    const slow = await batch(companies[1], max)
    holdPut = true
    const putStart = counts.blockedPuts
    work = slow.items.map(item => upload(companies[1], slow, item))
    for (const pending of work) pending.catch(() => undefined)
    await waitFor(() => counts.blockedPuts >= putStart + max)
    audio = createShutdownBudget(2000)
    workspace = await AudioWorkspace.create('transcription')
    const audioError = runWithRuntimeSignal(audio.signal, () => runAudioProcess(process.argv[audioArgument + 1], ['-re', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '30', '-f', 'null', '-']))
    audioWork = audioError.catch(error => error)
    const stream = new Readable({ read() { if (!this.started) { this.started = true; this.push(Buffer.from('audio-part')) } } })
    receiveWork = runWithRuntimeSignal(audio.signal, () => workspace.receive('synthetic.wav', stream, 1024)).catch(error => error)
    await waitFor(() => audioResourceSnapshot().childPids.length === 1)
    const began = performance.now()
    const probe = sharedPool.query('SELECT 1 AS n')
    work.push(probe)
    await Promise.race([probe, delay(750).then(() => { throw new Error('慢对象上传占满共享数据库池，查询超过750毫秒预算') })])
    record.checks.sharedQueryMs = performance.now() - began
    assert.equal(sharedPool.options.max, max)
    assert.equal((await request(port, companies[0], 'GET', '/api/v1/jobs')).status, 200)
    await delay(1500)
    const renewed = (await databasePool.query('SELECT expires_at FROM public.analysis_execution_leases WHERE task_id=$1', [taskId])).rows[0]?.expires_at
    assert.ok(renewed > initialExpiry, '慢存储期间Worker必须真实续租')
    record.checks.workerLease = { renewed: true, syntheticLeaseMs: 1200, productionLeaseChanged: false }
    const shutdownStarted = performance.now()
    await cleanupRuntime()
    record.checks.shutdownMs = performance.now() - shutdownStarted
    await waitFor(() => requests.size === 0)
    assert.deepEqual(audioResourceSnapshot(), { temporaryReservedBytes: 0, temporaryDirectories: [], childPids: [] })
    assert.equal(sharedPool.totalCount, 0); assert.equal(sharedPool.waitingCount, 0)
    record.checks.audioResourcesDrained = true
    record.checks.noSharedPoolResidue = true
    const states = (await databasePool.query('SELECT status,storage_key FROM public.object_write_intents WHERE parent_id IN (SELECT id FROM "' + companies[1].schema + '".candidates) AND status<>$1', ['bound'])).rows
    assert.ok(states.length >= max, '关停后必须保留未确认对象的恢复意图')
    for (const state of states) {
      assert.ok(['writing', 'unknown'].includes(state.status), '响应未知对象不得伪装为已绑定或可直接删除')
      assert.ok(objects.has('/isolated-resumes/' + state.storage_key), '未确认对象不能提前删除')
    }
    record.checks.retainedIntentStates = states.map(row => row.status)
    record.checks.uncertainWritesProtected = true
    const remaining = (await databasePool.query('SELECT status,attempts,available_at FROM "' + companies[0].schema + '".analysis_tasks WHERE id=$1', [taskId])).rows[0]
    assert.equal(remaining.status, 'processing', '关停后的在途任务必须留待租约恢复，不能伪装为已完成')
    await waitFor(async () => (await databasePool.query('SELECT available_at<=clock_timestamp() AS expired FROM "' + companies[0].schema + '".analysis_tasks WHERE id=$1', [taskId])).rows[0].expired)
    worker = await startWorker({ ...workerConfig({ ...process.env, WORKER_HEALTH_PORT: '0', WORKER_DB_POLL: 'true', WORKER_POLL_INTERVAL_MS: '25' }), leaseDurationMs: 1200 })
    await waitFor(async () => (await databasePool.query('SELECT status FROM "' + companies[0].schema + '".analysis_tasks WHERE id=$1', [taskId])).rows[0].status === 'completed')
    await worker.close(); worker = undefined
    const recovered = (await databasePool.query('SELECT attempts FROM "' + companies[0].schema + '".analysis_tasks WHERE id=$1', [taskId])).rows[0]
    assert.equal(recovered.attempts, remaining.attempts + 1)
    assert.equal((await databasePool.query('SELECT count(*)::int AS n FROM "' + companies[0].schema + '".analysis_results WHERE analysis_task_id=$1', [taskId])).rows[0].n, 1)
    assert.equal((await databasePool.query('SELECT count(*)::int AS n FROM public.analysis_execution_leases WHERE task_id=$1', [taskId])).rows[0].n, 0)
    record.checks.naturalLeaseRecovery = { completed: true, attemptsBefore: remaining.attempts, attemptsAfter: recovered.attempts, results: 1, activeLeases: 0, clockAltered: false }
    record.passed = true
    console.log('慢存储联合测试通过：连接池 ' + max)
    counts.blockedGets = 0
    // Remove only this scenario's synthetic queue before the next scenario.
    for (const company of companies) await databasePool.query('UPDATE "' + company.schema + '".analysis_tasks SET status=$1 WHERE status IN ($2,$3)', ['failed', 'queued', 'processing'])
    await writeFile(output, JSON.stringify(report, null, 2))
  }
  report.passed = true
} catch (error) { report.passed = false; report.failures.push({ message: error.message, stack: error.stack }); process.exitCode = 1 }
finally {
  const errors = []
  try { await cleanupRuntime() } catch (error) { errors.push(error.message); releaseGates() }
  storage.closeAllConnections(); await new Promise(resolve => storage.close(resolve))
  try { await databasePool?.end() } catch (error) { errors.push(error.message) }
  if (created) { try { await observer.query('DROP DATABASE "' + instance.database + '" WITH (FORCE)'); report.cleanup.databaseDropped = true } catch (error) { errors.push(error.message) } }
  try { await observer.end() } catch (error) { errors.push(error.message) }
  try { await instance.stop(); report.cleanup.postgresStopped = true } catch (error) { errors.push(error.message) }
  if (errors.length) { report.cleanup.errors = errors; report.passed = false; process.exitCode = 1 }
  report.finishedAt = new Date().toISOString()
  await writeFile(output, JSON.stringify(report, null, 2))
}
console.log(JSON.stringify({ passed: report.passed, report: output, failures: report.failures.map(row => row.message), cleanup: report.cleanup }))
