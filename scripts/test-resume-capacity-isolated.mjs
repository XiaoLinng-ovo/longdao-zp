import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { startLocalSmtpBoundary, verificationCodeFromMime } from './local-smtp-boundary.mjs'
import { startLocalModelBoundary, syntheticResumeEvidence } from './local-model-boundary.mjs'
import { startLoadApi, loadApiEnvironment } from './isolated-load-api.mjs'
import { startBrowserWorker } from './isolated-browser-worker.mjs'
import { testCodeFingerprint } from './test-code-fingerprint.mjs'
import { capacityPolicy as policy, retry429Milliseconds, latencySummary, concurrentLanes } from './capacity-load-policy.mjs'
import { capacityObjectInventory } from './capacity-object-inventory.mjs'
import { startLocalOcrBoundary } from './local-ocr-boundary.mjs'
import { runResumeFormatMatrix } from './resume-format-matrix.mjs'
import { openEvidenceJournal } from './bounded-evidence-journal.mjs'
import { startPostgresWaitSampler } from './postgres-wait-sampler.mjs'
import { measureIsolatedProcessTree } from './isolated-process-tree.mjs'
import { sustainedResumePolicy, sustainedMinutesFromArgs, runSustainedResumeCycles, checkSustainedResourceTrend } from './sustained-resume-policy.mjs'
import { proveAudioResourceFaults, proveDatabaseReconnect, proveWorkerCrash } from './resume-capacity-fault-probes.mjs'

const argument = process.argv.indexOf('--postgres-bin')
const formatMatrix = process.argv.includes('--format-matrix')
const sustainMinutes = sustainedMinutesFromArgs(process.argv.slice(2))
const faultProbes = process.argv.includes('--fault-probes')
const ffmpegArgument = process.argv.indexOf('--ffmpeg')
assert.ok(!faultProbes || (!formatMatrix && !sustainMinutes && ffmpegArgument >= 0 && process.argv[ffmpegArgument + 1]), '故障验证必须独立运行并显式指定 ffmpeg')
assert.ok(argument >= 0 && process.argv[argument + 1], '必须显式指定隔离 PostgreSQL 工具目录')
const require = createRequire(join(projectRoot, 'apps/api/package.json')), { Pool } = require('pg')
const code = await testCodeFingerprint(projectRoot)
const instance = await startIsolatedPostgres(process.argv[argument + 1])
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, instance.env)
const admin = new Pool(instance.connection)
const report = { startedAt: new Date().toISOString(), codeFingerprint: code.sha256, policy,
  scope: formatMatrix ? '四家公司、真实API/独立Worker/隔离PG格式矩阵；本机SMTP、模型与OCR替身，不代表OCR准确率或浏览器验收' : '四家公司、真实注册/API/独立Worker/隔离PG；仅本机SMTP和模型替身；TXT容量测试，不代表全部格式或长期混合负载',
  fixture: '只在隔离库将企业服务设为enabled；不修改默认上传/排队限流，计费策略保持关闭',
  tiers: [], samples: [], diagnostics: [], failures: [], cleanup: {}, passed: false }
if (sustainMinutes) {
  report.scope = '四家公司、同一真实API/独立Worker/隔离PG实例持续导入、读取、跨公司拒绝、同名独立和删除对账；仅SMTP/模型本机替身；不包含浏览器/音频/支付混合与故障矩阵'
  report.sustainedPolicy = sustainedResumePolicy
  report.sustained = { requestedMinutes: sustainMinutes, passed: false }
}
if (faultProbes) { report.scope = '真实API、独立Worker和专用PG的单故障注入，以及独立音频资源故障'; report.faults = {} }
const output = join(instance.directory, faultProbes ? 'resume-fault-report.json' : formatMatrix ? 'resume-format-report.json' : sustainMinutes ? 'resume-sustained-report.json' : 'resume-capacity-report.json')
const gate = faultProbes ? Promise.withResolvers() : undefined
const storage = join(instance.directory, 'storage')
let created = false, pool, smtp, model, ocr, api, worker, sampling, reading, stopping = false, backgroundFailure
let origin, activeTier
let resourceJournal, postgresJournal, treeJournal, waitSampler, postgresPid, sustainedStart, lastTreeAt = -Infinity
let lastPersistAt = 0
let trendSamples = []
const readHistogram = new Uint32Array(policy.requestTimeoutMs + 1)
let readCount = 0, maxReadMs = 0
const resourceSummary = { count: 0, maxApiRss: 0, maxWorkerRss: 0, maxRunnerRss: 0, maxTreeRss: 0, treeSamples: 0 }
const companies = [], cookies = new WeakMap()
const deletingKeys = new Set()
const expectedDiagnostics = []
const contentText = '姓名：合成同名人员\n邮箱：candidate@example.invalid\n学历：本科\n' + syntheticResumeEvidence + '\n'
const prefix = Buffer.from(contentText), content = Buffer.concat([prefix, Buffer.alloc(policy.fileBytes - prefix.length, 32)])
const contentHash = createHash('sha256').update(content).digest('hex')
let persistence = Promise.resolve(), persistenceFailure
const persist = () => {
  const operation = persistence.then(async () => {
    if (persistenceFailure) throw persistenceFailure
    await writeFile(output, JSON.stringify(report, null, 2))
  })
  persistence = operation.catch(error => { persistenceFailure ??= error })
  return operation
}
function healthy() {
  if (backgroundFailure) throw backgroundFailure
  assert.deepEqual(report.diagnostics, expectedDiagnostics); assert.deepEqual(model.failures, [])
  if (waitSampler) { assert.deepEqual(waitSampler.evidence.errors, []); assert.equal(waitSampler.evidence.dropped, 0) }
}
async function closeWorker() { await worker?.close({ expectedDiagnostics: expectedDiagnostics.filter(item => worker.evidence.events.includes(item)) }) }
async function request(company, method, path, body) {
  const jar = cookies.get(company) ?? new Map(), start = performance.now()
  const csrf = jar.get('smartrecruit_csrf')
  const response = await fetch(origin + '/api/v1' + path, { method, redirect: 'error', signal: AbortSignal.timeout(policy.requestTimeoutMs),
    headers: { origin: 'http://127.0.0.1:5173', cookie: [...jar].map(([key, value]) => key + '=' + value).join('; '),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {}),
      ...(company.id ? { 'x-workspace-id': company.id } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  for (const item of response.headers.getSetCookie()) {
    const [pair] = item.split(';'), index = pair.indexOf('=')
    assert.ok(index > 0); jar.set(pair.slice(0, index), pair.slice(index + 1))
  }
  cookies.set(company, jar)
  return { status: response.status, body: JSON.parse(text), retryAfter: response.headers.get('retry-after'), elapsedMs: performance.now() - start }
}
async function expect(company, method, path, body, status = 200) {
  const response = await request(company, method, path, body)
  assert.equal(response.status, status, method + ' ' + path + ': ' + JSON.stringify(response.body))
  return response.body.data
}
async function sample() {
  const [apiSample, workerSample, disk] = await Promise.all([api.measure(), worker.measure(), statfs(instance.directory)])
  const sample = { at: new Date().toISOString(), tier: activeTier?.count, api: apiSample, worker: workerSample, freeBytes: disk.bavail * disk.bsize }
  if (sustainMinutes) {
    sample.runner = { memory: process.memoryUsage(), handles: process._getActiveHandles().length, cpu: process.cpuUsage() }
    sample.elapsedMs = performance.now() - sustainedStart
    assert.ok(sample.runner.memory.rss <= sustainedResumePolicy.maxRunnerRssBytes, '验收进程RSS超过预算')
    await resourceJournal.append(sample)
    const trend = { elapsedMs: sample.elapsedMs, api: { rss: apiSample.memory.rss, handles: apiSample.handles },
      worker: { rss: workerSample.memory.rss, handles: workerSample.handles }, runner: { rss: sample.runner.memory.rss, handles: sample.runner.handles } }
    trendSamples.push(trend)
    trendSamples = trendSamples.filter(row => row.elapsedMs < sustainedResumePolicy.warmupMs + sustainedResumePolicy.trendWindowMs || row.elapsedMs >= sample.elapsedMs - sustainedResumePolicy.trendWindowMs)
    resourceSummary.count++; resourceSummary.maxApiRss = Math.max(resourceSummary.maxApiRss, apiSample.memory.rss)
    resourceSummary.maxWorkerRss = Math.max(resourceSummary.maxWorkerRss, workerSample.memory.rss)
    resourceSummary.maxRunnerRss = Math.max(resourceSummary.maxRunnerRss, sample.runner.memory.rss)
    if (sample.elapsedMs - lastTreeAt >= sustainedResumePolicy.processTreeIntervalMs) {
      const tree = await measureIsolatedProcessTree([process.pid, api.evidence.pid, worker.evidence.pid, postgresPid])
      await treeJournal.append(tree); lastTreeAt = sample.elapsedMs
      resourceSummary.treeSamples++; resourceSummary.maxTreeRss = Math.max(resourceSummary.maxTreeRss, tree.rssBytes)
      assert.ok(tree.rssBytes <= sustainedResumePolicy.maxProcessTreeRssBytes, '受测进程树总RSS超过预算')
    }
    report.resourceSummary = resourceSummary
  } else report.samples.push(sample)
  assert.ok(sample.freeBytes >= policy.minFreeBytes, '测试盘可用空间低于预算')
  assert.ok(apiSample.memory.rss <= policy.maxApiRssBytes, 'API RSS 超过预算')
  assert.ok(workerSample.memory.rss <= policy.maxWorkerRssBytes, 'Worker RSS 超过预算')
  for (const measured of [apiSample, workerSample]) for (const pool of measured.pools) assert.ok(pool.total <= 2, '生产连接池限制被突破')
  healthy()
}
const inventory = () => capacityObjectInventory(storage, deletingKeys)
async function setupCompany(index) {
  const company = { email: 'load-' + index + '@example.invalid' }, password = randomBytes(20).toString('base64url')
  await expect(company, 'GET', '/auth/csrf')
  await expect(company, 'POST', '/auth/registration/code', { email: company.email })
  const message = smtp.messages.findLast(item => item.recipients.includes(company.email))
  assert.ok(message, '必须从本机SMTP取得真实注册验证码')
  const result = await expect(company, 'POST', '/auth/register', { email: company.email, password,
    verificationCode: verificationCodeFromMime(message.raw), name: '容量普通用户' + index, companyName: '隔离容量公司' + index }, 201)
  assert.equal(result.user.role, 'recruiter'); assert.ok(!result.user.isSystemAdmin); assert.match(result.user.userNo, /^USR-[A-F0-9]{10}$/)
  company.id = result.workspace.id; company.schema = 'company_' + company.id.replaceAll('-', '')
  assert.match(company.schema, /^company_[a-f0-9]{32}$/)
  await pool.query("UPDATE public.organizations SET service_status='enabled' WHERE id=$1", [company.id])
  const department = await expect(company, 'POST', '/departments', { name: '合成研发部' }, 201)
  const job = await expect(company, 'POST', '/jobs', { title: '合成软件工程师', departmentId: department.code, headcount: 1 }, 201)
  company.jobId = job.id
  await expect(company, 'POST', '/jobs/' + job.id + '/spec', { title: '合成软件工程师', summary: '隔离测试的软件开发岗位',
    responsibilities: [], requirements: [{ label: '软件开发：具备软件研发经验', required: true }], skills: [] })
  await expect(company, 'POST', '/jobs/' + job.id + '/confirm-spec', {})
  assert.equal((await request(company, 'GET', '/platform/users')).status, 403)
  companies.push(company)
  return { id: company.id, schema: company.schema, userNo: result.user.userNo, jobId: job.id, ordinaryPlatformAccessDenied: true }
}
async function runTier(count) {
  const tier = { count, startedAt: new Date().toISOString(), uploads: [], limited: [], reads: [], companies: [], passed: false }
  report.tiers.push(tier); activeTier = tier
  const start = performance.now(), before = model.requests.length, items = []
  const perCompany = count / companies.length
  assert.ok(Number.isInteger(perCompany) && perCompany <= 500)
  for (const company of companies) {
    const batch = await expect(company, 'POST', '/resume-import-batches', { jobId: company.jobId,
      files: Array.from({ length: perCompany }, (_, index) => ({ clientFileId: randomUUID(), originalFilename: 'synthetic-' + count + '-' + index + '.txt', mimeType: 'text/plain', sizeBytes: content.length })) }, 201)
    assert.equal(batch.items.length, perCompany)
    company.currentBatch = batch
  }
  for (let index = 0; index < perCompany; index++) for (const company of companies) items.push({ company, item: company.currentBatch.items[index] })
  const deadline = Date.now() + policy.tierTimeoutMs
  await concurrentLanes(items, policy.uploadLanes, async ({ company, item }) => {
    for (let attempt = 0; ; attempt++) {
      healthy(); assert.ok(Date.now() < deadline, '容量档位上传超时')
      const response = await request(company, 'POST', '/resume-import-batches/' + company.currentBatch.id + '/items/' + item.id + '/content', { encoding: 'base64', content: content.toString('base64') })
      const retry = retry429Milliseconds(response, attempt)
      if (retry !== undefined) { tier.limited.push({ code: response.body.error.code, waitMs: retry }); await delay(retry); continue }
      assert.equal(response.status, 200, '真实上传失败：' + JSON.stringify(response.body))
      const uploaded = response.body.data
      assert.ok(uploaded.candidateId && uploaded.applicationId && uploaded.resumeId && uploaded.analysisTaskId)
      tier.uploads.push({ elapsedMs: response.elapsedMs, itemId: item.id }); return
    }
  })
  tier.uploadSeconds = (performance.now() - start) / 1000
  for (;;) {
    healthy(); assert.ok(Date.now() < deadline, '真实Worker未在档位预算内完成')
    let completed = 0
    for (const company of companies) {
      const tasks = (await pool.query('SELECT t.status,t.last_error FROM "' + company.schema + '".resume_import_items i JOIN "' + company.schema + '".analysis_tasks t ON t.id=i.analysis_task_id WHERE i.batch_id=$1', [company.currentBatch.id])).rows
      assert.deepEqual(tasks.filter(task => task.status === 'failed'), [], '真实Worker任务失败')
      completed += tasks.filter(task => task.status === 'completed').length
    }
    if (completed === count) break
    await delay(200)
  }
  assert.equal(model.requests.length - before, count, '本机模型请求数必须与真实Worker任务完全一致')
  for (const company of companies) {
    const schema = '"' + company.schema + '"'
    const rows = (await pool.query(`SELECT c.id,c.candidate_no,c.name,c.organization_id,r.id AS resume_id,r.storage_key,r.content_hash,
      a.id AS application_id,t.id AS task_id,t.status,z.id AS result_id,i.id AS item_id
      FROM ${schema}.resume_import_items i JOIN ${schema}.candidates c ON c.id=i.candidate_id
      JOIN ${schema}.applications a ON a.id=i.application_id AND a.candidate_id=c.id
      JOIN ${schema}.resumes r ON r.id=i.resume_id AND r.candidate_id=c.id AND r.application_id=a.id
      JOIN ${schema}.analysis_tasks t ON t.id=i.analysis_task_id AND t.resume_id=r.id AND t.application_id=a.id
      JOIN ${schema}.analysis_results z ON z.analysis_task_id=t.id AND z.resume_id=r.id AND z.application_id=a.id
      WHERE i.batch_id=$1`, [company.currentBatch.id])).rows
    assert.equal(rows.length, perCompany)
    for (const key of ['id', 'candidate_no', 'resume_id', 'application_id', 'task_id', 'result_id', 'item_id']) assert.equal(new Set(rows.map(row => row[key])).size, perCompany)
    assert.equal(new Set(rows.map(row => row.name)).size, 1); assert.equal(rows[0].name, '合成同名人员')
    for (const row of rows) { assert.equal(row.organization_id, company.id); assert.equal(row.status, 'completed'); assert.equal(row.content_hash, contentHash) }
    const files = await inventory()
    const byKey = new Map(files.map(file => [file.key, file]))
    for (const row of rows) { assert.ok(byKey.has(row.storage_key), '物理对象缺失：' + row.storage_key); assert.equal(byKey.get(row.storage_key).hash, contentHash) }
    const intents = (await pool.query("SELECT count(*)::int AS n FROM public.object_write_intents WHERE organization_id=$1 AND parent_id=ANY($2::uuid[]) AND status='bound'", [company.id, rows.map(row => row.id)])).rows[0].n
    assert.equal(intents, perCompany)
    const stranger = companies[(companies.indexOf(company) + 1) % companies.length]
    for (const method of ['GET', 'PATCH', 'DELETE']) assert.ok([403, 404].includes((await request(stranger, method, '/candidates/' + rows[0].id, method === 'PATCH' ? { name: '禁止跨公司改名' } : undefined)).status))
    deletingKeys.add(rows[0].storage_key)
    await expect(company, 'DELETE', '/candidates/' + rows[0].id)
    for (const table of ['candidates', 'applications', 'resumes', 'analysis_tasks', 'analysis_results']) {
      const key = { candidates: 'id', applications: 'candidate_id', resumes: 'candidate_id', analysis_tasks: 'resume_id', analysis_results: 'resume_id' }[table]
      const value = ['candidates', 'applications', 'resumes'].includes(table) ? rows[0].id : rows[0].resume_id
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.${table} WHERE ${key}=$1`, [value])).rows[0].n, 0, '删除后残留关联记录：' + table)
    }
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.candidates WHERE id=ANY($1::uuid[])`, [rows.slice(1).map(row => row.id)])).rows[0].n, perCompany - 1)
    company.deletedKey = rows[0].storage_key
    tier.companies.push({ id: company.id, batchId: company.currentBatch.id, imported: rows.length, sameNamesKeptDistinct: true, associationsMatched: true, crossCompanyDenied: true, deletionDatabaseConsistent: true })
  }
  for (;;) {
    healthy(); assert.ok(Date.now() < deadline, '删除物理对象未在预算内完成')
    const files = await inventory(), keys = new Set(files.map(file => file.key))
    assert.ok(files.reduce((sum, file) => sum + file.bytes, 0) <= policy.maxTierObjectBytes, '对象存储超过容量预算')
    if (companies.every(company => !keys.has(company.deletedKey))) {
      const referenced = []
      for (const company of companies) {
        const rows = (await pool.query('SELECT storage_key,content_hash FROM "' + company.schema + '".resumes')).rows
        referenced.push(...rows)
      }
      assert.equal(files.length, referenced.length, '磁盘存在无引用对象或有效对象缺失')
      const byKey = new Map(files.map(file => [file.key, file]))
      for (const row of referenced) { assert.ok(byKey.has(row.storage_key)); assert.equal(byKey.get(row.storage_key).hash, row.content_hash) }
      const locations = (await pool.query("SELECT storage_key FROM public.stored_object_locations WHERE storage_kind='resume'")).rows
      assert.deepEqual(locations.map(row => row.storage_key).sort(), referenced.map(row => row.storage_key).sort())
      tier.physicalDeletionVerified = true; tier.objectCountAfterDeletion = files.length; tier.completeObjectReferenceMatch = true; break
    }
    await delay(500)
  }
  tier.totalSeconds = (performance.now() - start) / 1000
  tier.throughputPerSecond = count / tier.totalSeconds
  tier.uploadLatency = latencySummary(tier.uploads.map(item => item.elapsedMs))
  tier.readLatency = latencySummary(tier.reads)
  assert.ok(tier.readLatency.count > 0 && tier.readLatency.p99Ms <= policy.maxReadP99Ms, '真实混合读取P99超过预算')
  tier.modelCalls = model.requests.length - before; tier.passed = true; tier.finishedAt = new Date().toISOString()
  console.log('档位通过：' + count + '份，耗时' + tier.totalSeconds.toFixed(1) + '秒，限流' + tier.limited.length + '次')
  await persist(); activeTier = undefined
}
try {
  const guard = require(join(projectRoot, 'scripts/isolated-network-guard.cjs'))
  assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name, instance.cluster)
  assert.ok((await statfs(instance.directory)).bavail * (await statfs(instance.directory)).bsize >= policy.minFreeBytes)
  await admin.query('CREATE DATABASE "' + instance.database + '"'); created = true
  pool = new Pool({ ...instance.connection, database: instance.database })
  const { runMigrations } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/db/migrations.js')).href)
  report.migrations = (await runMigrations(pool, join(projectRoot, 'db/migrations'))).applied.length
  await mkdir(storage)
  const password = randomBytes(24).toString('base64url'), apiKey = randomBytes(24).toString('base64url')
  smtp = await startLocalSmtpBoundary({ user: 'sender@example.invalid', password })
  model = await startLocalModelBoundary({ apiKey, beforeResumeReply: gate ? () => gate.promise : undefined })
  const boundaries = { smtp: { port: smtp.port, password }, model: { port: model.port, apiKey }, otpSecret: randomBytes(32).toString('base64url') }
  guard.allowLoopbackPort(smtp.port); guard.allowLoopbackPort(model.port)
  const runtimeEnv = loadApiEnvironment(instance, boundaries)
  api = await startLoadApi({ instance, ...boundaries }); report.apiProcess = api.evidence
  const launchWorker = (faultProbe = false) => startBrowserWorker({ instance, runtimeEnv, faultProbe, onDiagnostic(message) { report.diagnostics.push(message) } })
  worker = await launchWorker(faultProbes); report.workerProcess = worker.evidence
  guard.allowLoopbackPort(api.port); origin = 'http://127.0.0.1:' + api.port
  report.companies = []
  for (let index = 0; index < policy.companies; index++) report.companies.push(await setupCompany(index))
  assert.equal((await pool.query("SELECT config->>'enabled' AS enabled FROM public.billing_policy_versions ORDER BY id DESC LIMIT 1")).rows[0].enabled, 'false')
  if (sustainMinutes) {
    resourceJournal = await openEvidenceJournal(join(instance.directory, 'resource-samples.jsonl'), sustainedResumePolicy.resourceJournalBytes)
    postgresJournal = await openEvidenceJournal(join(instance.directory, 'postgres-waits.jsonl'), sustainedResumePolicy.postgresJournalBytes)
    treeJournal = await openEvidenceJournal(join(instance.directory, 'process-tree.jsonl'), sustainedResumePolicy.processTreeJournalBytes)
    postgresPid = Number((await readFile(join(instance.data, 'postmaster.pid'), 'utf8')).split(/\r?\n/)[0])
    assert.ok(Number.isSafeInteger(postgresPid) && postgresPid > 0)
    sustainedStart = performance.now()
    report.journals = { resources: resourceJournal.evidence, postgres: postgresJournal.evidence, processTree: treeJournal.evidence }
    waitSampler = await startPostgresWaitSampler(pool, instance.database, { intervalMs: sustainedResumePolicy.postgresIntervalMs,
      limit: 0, onSample: record => postgresJournal.append(record) })
    report.postgresWaits = waitSampler.evidence
  }
  if (faultProbes) {
    report.faults.databaseReconnect = await proveDatabaseReconnect({ instance, pool, company: companies[0], request, expect })
    report.faults.workerCrash = await proveWorkerCrash({ instance, pool, company: companies[0], freshCompany: companies[1], expect, content, worker, model,
      async expectDiagnostic(replacement, message) {
        const deadline = performance.now() + 3000
        while (performance.now() < deadline) {
          const event = replacement.evidence.events.find(event => event.type === 'diagnostic' && event.level === 'warn' && event.message === message)
          if (event) { expectedDiagnostics.push(event); return }
          await delay(20)
        }
        throw new Error('缺少被保护任务的精确诊断')
      },
      gate: { release: gate.resolve }, async replaceWorker() {
        worker = undefined
        worker = await launchWorker()
        report.replacementProcess = worker.evidence
        return worker
      } })
    await proveAudioResourceFaults({ instance, ffmpeg: process.argv[ffmpegArgument + 1], record: report.faults })
    healthy(); report.passed = true
  } else {
  await sample()
  if (formatMatrix) {
    ocr = await startLocalOcrBoundary(); guard.allowLoopbackPort(ocr.port)
    report.formatMatrix = {}; report.workerProcesses = [worker.evidence]
    await runResumeFormatMatrix({ companies, pool, request, expect, model, ocr, inventory, deletingKeys,
      diagnostics: report.diagnostics, expectedDiagnostics, result: report.formatMatrix, persist,
      async replaceWorker(ocrConfig) {
        await closeWorker()
        worker = await startBrowserWorker({ instance, runtimeEnv, ocr: ocrConfig, onDiagnostic(message) { report.diagnostics.push(message) } })
        report.workerProcesses.push(worker.evidence)
      } })
    await sample(); healthy(); report.passed = true
  } else {
  sampling = (async () => { while (!stopping) {
    await delay(policy.sampleIntervalMs)
    if (!stopping) {
      await sample()
      if (!sustainMinutes || performance.now() - lastPersistAt >= 30000) { await persist(); lastPersistAt = performance.now() }
    }
  } })().catch(error => { backgroundFailure ??= error })
  reading = (async () => {
    let index = 0
    while (!stopping) {
      if (activeTier || sustainMinutes) {
        const response = await request(companies[index++ % companies.length], 'GET', '/jobs')
        assert.equal(response.status, 200); activeTier?.reads.push(response.elapsedMs)
        if (sustainMinutes) { readHistogram[Math.min(policy.requestTimeoutMs, Math.ceil(response.elapsedMs))]++; readCount++; maxReadMs = Math.max(maxReadMs, response.elapsedMs) }
      }
      await delay(250)
    }
  })().catch(error => { backgroundFailure ??= error })
  if (sustainMinutes) {
    report.sustained = await runSustainedResumeCycles({ minutes: sustainMinutes, healthy, runCycle: runTier,
      async onProgress(progress) {
        report.sustained = { ...progress }
        // Raw per-request evidence is summarized after each checked cycle; resource/PG curves are streamed.
        for (const tier of report.tiers) if (tier.passed && tier.reads) {
          tier.limitedCount = tier.limited.length; delete tier.uploads; delete tier.reads; delete tier.limited
        }
        console.log('简历持续负载：' + progress.cycles + '周期，实际' + (progress.wallMs / 60000).toFixed(2) + '分钟')
        await persist()
      } })
    report.resourceTrend = checkSustainedResourceTrend(trendSamples, performance.now() - sustainedStart)
    if (sustainMinutes !== 1) assert.ok(report.resourceTrend.sufficient, '持续验收缺少预热后趋势证据')
    const percentile = ratio => { let cumulative = 0; for (let ms = 0; ms < readHistogram.length; ms++) { cumulative += readHistogram[ms]; if (cumulative >= Math.ceil(readCount * ratio)) return ms } }
    report.sustainedReadLatency = { count: readCount, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: maxReadMs, histogramResolutionMs: 1 }
    assert.ok(readCount > 0 && report.sustainedReadLatency.p99Ms <= policy.maxReadP99Ms)
  } else for (const count of [60, 500, 2000]) { healthy(); await runTier(count) }
  await sample(); healthy(); report.passed = true
  }
  }
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack, apiEvidence: error.apiEvidence, workerEvidence: error.workerEvidence }); process.exitCode = 1
} finally {
  stopping = true
  gate?.resolve()
  const clean = async (name, action) => { try { await action(); report.cleanup[name] = true } catch (error) { report.failures.push({ cleanup: name, message: error.message }); report.passed = false; process.exitCode = 1 } }
  await clean('backgroundTasksDrained', async () => { await Promise.all([sampling, reading]); if (backgroundFailure) throw backgroundFailure })
  if (waitSampler) await clean('postgresSamplerClosed', async () => { await waitSampler.stop(); assert.deepEqual(waitSampler.evidence.errors, []); assert.equal(waitSampler.evidence.dropped, 0) })
  await clean('workerClosed', async () => { if (worker?.evidence.exit?.signal !== 'SIGKILL' || !faultProbes) await closeWorker() })
  await clean('apiClosed', () => api?.close({ expectedDatabaseDisconnect: Boolean(report.faults?.databaseReconnect) }))
  await clean('smtpClosed', () => smtp?.close())
  await clean('modelClosed', () => model?.close())
  if (ocr) await clean('ocrClosed', () => ocr.close())
  await clean('testPoolClosed', () => pool?.end())
  if (created) await clean('databaseDropped', () => admin.query('DROP DATABASE "' + instance.database + '" WITH (FORCE)'))
  await clean('adminPoolClosed', () => admin.end())
  await clean('postgresStopped', () => instance.stop())
  for (const [name, journal] of [['resourceJournalClosed', resourceJournal], ['postgresJournalClosed', postgresJournal], ['processTreeJournalClosed', treeJournal]]) {
    if (journal) await clean(name, () => journal.close())
  }
  await clean('codeUnchangedDuringRun', async () => assert.equal((await testCodeFingerprint(projectRoot)).sha256, code.sha256))
  report.finishedAt = new Date().toISOString(); await persist(); console.log('报告：' + output)
}
