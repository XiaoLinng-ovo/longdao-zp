import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

// Only a random, disposable database on localhost is ever migrated or written.
const root = resolve(import.meta.dirname, '..')
const load = (app, file) => import(pathToFileURL(join(root, `apps/${app}/dist/src/${file}.js`)).href)
const require = createRequire(join(root, 'apps/api/package.json'))
const { Pool } = require('pg')
const pools = new Set()
const connect = Pool.prototype.connect
Pool.prototype.connect = function (...args) { pools.add(this); return connect.apply(this, args) }
await load('api', 'env')
const { loadDatabaseConfig } = await load('api', 'db/config')
const { target: _target, ...original } = loadDatabaseConfig()
const url = original.connectionString ? new URL(original.connectionString) : undefined
const host = url?.hostname ?? original.host
assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(host), '只允许连接本地 PostgreSQL')
const database = `schema_verify_${randomUUID().replaceAll('-', '')}`
const directory = join(root, 'tmp', database)
const storageRoot = join(directory, 'storage')
const options = {
  host, port: Number(url?.port || original.port || 5432),
  user: url ? decodeURIComponent(url.username) : original.user,
  password: url ? decodeURIComponent(url.password) : original.password,
}
const admin = new Pool({ ...options, database: 'postgres', max: 1 })
let created = false, server, worker, pool
const report = { startedAt: new Date().toISOString(), database, checks: {}, companies: [] }
async function waitFor(predicate, timeout = 90_000) {
  const started = Date.now()
  while (!await predicate()) {
    if (Date.now() - started > timeout) throw new Error('等待后台处理超时')
    await delay(50)
  }
}
try {
  assert.match(database, /^schema_verify_[a-f0-9]{32}$/)
  await admin.query(`CREATE DATABASE "${database}"`)
  created = true
  delete process.env.DATABASE_URL
  Object.assign(process.env, {
    NODE_ENV: 'development', PGHOST: host, PGPORT: String(options.port), PGUSER: options.user,
    PGPASSWORD: options.password ?? '', PGDATABASE: database, DB_POOL_MAX: '5', TENANT_SCHEMA_ROUTING: 'on',
    DATABASE_URL: `postgresql://${encodeURIComponent(options.user)}:${encodeURIComponent(options.password ?? '')}@${host}:${options.port}/${database}`,
    REQUIRE_CSRF: 'true', ALLOWED_ORIGINS: 'http://127.0.0.1:5173', ALLOW_DEV_BOOTSTRAP_AUTH: 'false',
    RESUME_VIRUS_SCAN_ENABLED: 'false', WORKER_USE_LLM_ANALYSIS: 'false', QUESTION_SHEET_POLL: 'off',
    RESUME_UPLOAD_CONCURRENCY: '64', RESUME_UPLOAD_WORKSPACE_CONCURRENCY: '24',
    RESUME_ANALYSIS_QUEUE_LIMIT: '2000', RESUME_ANALYSIS_WORKSPACE_QUEUE_LIMIT: '500',
    S3_ENDPOINT: '', OPENAI_BASE_URL: '', OPENAI_API_KEY: '', OPENAI_MODEL: '',
    RESUME_LOCAL_OCR_ENABLED: 'false', RECRUITING_QUARANTINE_ROOT: storageRoot,
  })
  assert.equal(loadDatabaseConfig().target, `${host}:${options.port}/${database}`)
  await mkdir(storageRoot, { recursive: true })
  pool = new Pool({ ...options, database, max: 5 })
  const { runMigrations } = await load('api', 'db/migrations')
  report.checks.migrationsApplied = (await runMigrations(pool, join(root, 'db/migrations'))).applied.length
  const { hashPassword } = await load('api', 'auth/password')
  const companies = []
  for (let index = 0; index < 2; index++) {
    const id = randomUUID(), userId = randomUUID(), jobId = randomUUID(), password = randomUUID()
    const email = `${userId}@example.invalid`
    await pool.query('INSERT INTO users(id,email,display_name,password_hash,is_active) VALUES($1,$2,$3,$4,true)', [userId, email, '同名测试用户', await hashPassword(password)])
    await pool.query("INSERT INTO organizations(id,name,kind,service_status) VALUES($1,'同名测试企业','test','enabled')", [id])
    await pool.query("INSERT INTO organization_members(organization_id,user_id,role,business_role) VALUES($1,$2,'member','recruiter')", [id, userId])
    await pool.query("INSERT INTO jobs(id,organization_id,job_no,title,headcount,status) VALUES($1,$2,$3,'软件工程师',1,'published')", [jobId, id, `JOB-${randomUUID()}`])
    const schema = (await pool.query('SELECT public.initialize_organization_schema($1) AS schema', [id])).rows[0].schema
    assert.equal(schema, `company_${id.replaceAll('-', '')}`)
    companies.push({ id, userId, jobId, email, password, schema })
  }
  const { createHttpServer } = await load('api', 'server')
  const { loadConfig } = await load('api', 'config')
  server = createHttpServer(loadConfig({ ...process.env, PORT: '0' }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  async function request(company, method, path, body, workspaceId = company.id) {
    const response = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173',
        authorization: `Bearer ${company.token}`, cookie: `smartrecruit_csrf=${company.csrf}`,
        'x-csrf-token': company.csrf, 'x-workspace-id': workspaceId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    })
    return { status: response.status, body: await response.json() }
  }
  for (const company of companies) {
    const login = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: company.email, password: company.password }) })
    assert.equal(login.status, 200, await login.clone().text())
    const cookies = login.headers.getSetCookie()
    company.token = decodeURIComponent(cookies.find(value => value.startsWith('smartrecruit_session=')).split(';')[0].slice('smartrecruit_session='.length))
    company.csrf = decodeURIComponent(cookies.find(value => value.startsWith('smartrecruit_csrf=')).split(';')[0].slice('smartrecruit_csrf='.length))
    const session = await login.json()
    assert.equal(session.data.user.role, 'recruiter')
    assert.equal(session.data.user.platformRole, undefined)
    await pool.query('UPDATE sessions SET active_organization_id=$1 WHERE user_id=$2', [company.id, company.userId])
    const listed = await request(company, 'GET', '/api/v1/jobs')
    assert.equal(listed.status, 200, JSON.stringify(listed.body))
    assert.deepEqual(listed.body.data.map(job => job.id), [company.jobId])
  }
  const perCompany = 24
  const tasks = []
  for (const company of companies) {
    const content = Buffer.from('姓名：同名候选人\n学历：本科\n经验：5年软件研发，Java、PostgreSQL、Vue\n')
    const batch = await request(company, 'POST', '/api/v1/resume-import-batches', { jobId: company.jobId,
      files: Array.from({ length: perCompany }, () => ({ clientFileId: randomUUID(), originalFilename: '同名候选人.txt', mimeType: 'text/plain', sizeBytes: content.length })) })
    assert.equal(batch.status, 201, JSON.stringify(batch.body))
    company.batch = batch.body.data
    for (const item of company.batch.items) tasks.push({ company, item, content })
  }
  const results = await Promise.all(tasks.map(({ company, item, content }) => request(company, 'POST',
    `/api/v1/resume-import-batches/${company.batch.id}/items/${item.id}/content`, { content: content.toString('base64'), encoding: 'base64' })))
  assert.ok(results.every(result => result.status === 200), JSON.stringify(results.filter(result => result.status !== 200)))
  report.checks.concurrentUploads = { total: results.length, success: results.filter(result => result.status === 200).length, perCompany }
  for (const company of companies) {
    const counts = (await pool.query(`SELECT (SELECT count(*)::int FROM "${company.schema}".candidates) AS candidates, (SELECT count(*)::int FROM "${company.schema}".resumes) AS resumes, (SELECT count(*)::int FROM "${company.schema}".analysis_tasks) AS tasks`)).rows[0]
    assert.deepEqual(counts, { candidates: perCompany, resumes: perCompany, tasks: perCompany })
    report.companies.push({ schema: company.schema, ...counts })
  }
  const [first, second] = companies
  const publicRows = (await pool.query('SELECT count(*)::int AS count FROM public.resumes WHERE organization_id=ANY($1::uuid[])', [companies.map(company => company.id)])).rows[0].count
  assert.equal(publicRows, 0)
  assert.equal((await request(first, 'GET', `/api/v1/resume-import-batches/${second.batch.id}`)).status, 404)
  assert.equal((await request(first, 'GET', '/api/v1/jobs', undefined, second.id)).status, 409)
  assert.equal((await request(first, 'GET', '/api/v1/platform/customers')).status, 403)
  report.checks.crossCompanyAccessBlocked = true
  const { loadConfig: loadWorkerConfig } = await load('worker', 'config')
  const { startWorker } = await load('worker', 'worker')
  worker = await startWorker(loadWorkerConfig({ ...process.env, PORT: '0', WORKER_HEALTH_PORT: '0', WORKER_POLL_POSTGRES: 'true', WORKER_CONCURRENCY: '3', WORKER_POLL_INTERVAL_MS: '50' }))
  await waitFor(async () => {
    const counts = await Promise.all(companies.map(async company => (await pool.query(`SELECT count(*)::int AS count FROM "${company.schema}".analysis_tasks WHERE status='completed'`)).rows[0].count))
    return counts.every(count => count === perCompany)
  })
  for (const company of companies) {
    const count = (await pool.query(`SELECT count(*)::int AS count FROM "${company.schema}".analysis_results`)).rows[0].count
    assert.equal(count, perCompany)
  }
  report.checks.workerCompleted = perCompany * companies.length
  const candidate = results[0].body.data.candidateId
  assert.equal((await request(second, 'GET', `/api/v1/candidates/${candidate}`)).status, 404)
  const deleted = await request(first, 'DELETE', `/api/v1/candidates/${candidate}`)
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
  const remaining = (await pool.query(`SELECT (SELECT count(*)::int FROM "${first.schema}".resumes WHERE candidate_id=$1) AS resumes, (SELECT count(*)::int FROM "${first.schema}".analysis_tasks t JOIN "${first.schema}".resumes r ON r.id=t.resume_id WHERE r.candidate_id=$1) AS tasks`, [candidate])).rows[0]
  assert.deepEqual(remaining, { resumes: 0, tasks: 0 })
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM "${second.schema}".candidates`)).rows[0].count, perCompany)
  report.checks.candidateDeletionIsolated = true
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = { message: error.message, stack: error.stack }
  process.exitCode = 1
} finally {
  if (worker) await worker.close()
  if (server) { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)) }
  await Promise.all([...pools].filter(item => item !== admin).map(item => item.end().catch(() => undefined)))
  if (created) {
    assert.match(database, /^schema_verify_[a-f0-9]{32}$/)
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
    report.checks.scratchDatabaseRemoved = true
  }
  await admin.end()
  Pool.prototype.connect = connect
  assert.equal(resolve(storageRoot, '..'), directory)
  await rm(storageRoot, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  const reportPath = join(directory, 'report.json')
  await writeFile(reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
}
