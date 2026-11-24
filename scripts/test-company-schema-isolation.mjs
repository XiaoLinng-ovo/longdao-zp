import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { fork } from 'node:child_process'

// Only a random, disposable database on localhost is ever migrated or written.
const root = resolve(import.meta.dirname, '..')
const companyCount=Number(process.env.RELIABILITY_COMPANIES || 2),perCompany=Number(process.env.RELIABILITY_RESUMES_PER_COMPANY || 24)
assert.ok(Number.isInteger(companyCount) && companyCount>=2 && companyCount<=10)
assert.ok(Number.isInteger(perCompany) && perCompany>=1 && perCompany<=200)
const queueLimit=companyCount*perCompany
const apiPoolMax = Number(process.env.RELIABILITY_API_POOL_MAX || 5)
assert.ok(Number.isInteger(apiPoolMax) && apiPoolMax >= 1 && apiPoolMax <= 5)
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
const children=[]
let leaseMonitor
const report = { startedAt: new Date().toISOString(), database, apiPoolMax, checks: {}, companies: [] }
async function childProcess(mode,extra={}) {
  const child=fork(join(root,'scripts/reliability-process-child.mjs'),[mode],{cwd:root,env:{...process.env,...extra},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']})
  const record={child,events:[],output:'',exited:false}
  children.push(record)
  child.stdout.on('data',data=>{record.output+=data.toString()})
  child.stderr.on('data',data=>{record.output+=data.toString()})
  child.on('message',message=>record.events.push(message))
  record.exit=new Promise(resolve=>child.once('exit',(code,signal)=>{record.exited=true;resolve({code,signal})}))
  await Promise.race([
    new Promise((resolve,reject)=>{child.on('message',message=>{if(message.type==='ready')resolve()});child.once('error',reject);child.once('exit',()=>reject(Error(record.output || '测试子进程提前退出')))}),
    delay(30000).then(()=>{if(!record.events.some(item=>item.type==='ready'))throw Error('测试进程启动超时')})
  ])
  return record
}
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
    PGPASSWORD: options.password ?? '', PGDATABASE: database, DB_POOL_MAX: String(apiPoolMax), TENANT_SCHEMA_ROUTING: 'on',
    DATABASE_URL: `postgresql://${encodeURIComponent(options.user)}:${encodeURIComponent(options.password ?? '')}@${host}:${options.port}/${database}`,
    REQUIRE_CSRF: 'true', ALLOWED_ORIGINS: 'http://127.0.0.1:5173', ALLOW_DEV_BOOTSTRAP_AUTH: 'false',
    RESUME_VIRUS_SCAN_ENABLED: 'false', WORKER_USE_LLM_ANALYSIS: 'false', QUESTION_SHEET_POLL: 'off',
    RESUME_UPLOAD_CONCURRENCY: '64', RESUME_UPLOAD_WORKSPACE_CONCURRENCY: '24',
    RESUME_ANALYSIS_QUEUE_LIMIT: String(queueLimit), RESUME_ANALYSIS_WORKSPACE_QUEUE_LIMIT: '500',
    WORKER_SHARED_CONCURRENCY:'3', WORKER_WORKSPACE_CONCURRENCY:'2',
    S3_ENDPOINT: '', OPENAI_BASE_URL: '', OPENAI_API_KEY: '', OPENAI_MODEL: '',
    RESUME_LOCAL_OCR_ENABLED: 'false', RECRUITING_QUARANTINE_ROOT: storageRoot,
    INTERVIEW_AUDIO_POLL:'off', INTERVIEW_QUESTION_PREPARATION_POLL:'off', INTERVIEW_TRANSCRIPT_POSTPROCESS_POLL:'off', INTERVIEW_SUMMARY_POLL:'off', OBJECT_CLEANUP_POLL:'off',
    SMTP_HOST:'', SMTP_USER:'', SMTP_PASSWORD:'', FUNASR_HTTP_URL:'', FASTER_WHISPER_BASE_URL:'',
    WORKER_DB_POLL:'true', CLAMAV_HOST:'',
    OBJECT_CLEANUP_POLL:'off',
  })
  assert.equal(loadDatabaseConfig().target, `${host}:${options.port}/${database}`)
  await mkdir(storageRoot, { recursive: true })
  pool = new Pool({ ...options, database, max: 5 })
  const { runMigrations } = await load('api', 'db/migrations')
  report.checks.migrationsApplied = (await runMigrations(pool, join(root, 'db/migrations'))).applied.length
  const { hashPassword } = await load('api', 'auth/password')
  const companies = []
  for (let index = 0; index < companyCount; index++) {
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
  const { startServer } = await load('api', 'server')
  const { loadConfig } = await load('api', 'config')
  server = await startServer(loadConfig({ ...process.env, HOST: '127.0.0.1', PORT: '0' }))
  report.checks.apiStartupReadOnlyGate = true
  const base = `http://127.0.0.1:${server.address().port}`
  const secondApi=await childProcess('api')
  const bases=[base,'http://127.0.0.1:'+secondApi.events.find(item=>item.type==='ready').port]
  let apiIndex=0
  async function request(company, method, path, body, workspaceId = company.id) {
    const response = await fetch(bases[apiIndex++ % bases.length] + path, {
      method, headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173',
        authorization: `Bearer ${company.token}`, cookie: `smartrecruit_csrf=${company.csrf}`,
        'x-csrf-token': company.csrf, 'x-workspace-id': workspaceId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    })
    return { status: response.status, body: await response.json(), retryAfter:response.headers.get('retry-after') }
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
  const tasks = []
  for (const company of companies) {
    const content = Buffer.from('姓名：同名候选人\n学历：本科\n经验：5年软件研发，Java、PostgreSQL、Vue\n')
    const batch = await request(company, 'POST', '/api/v1/resume-import-batches', { jobId: company.jobId,
      files: Array.from({ length: perCompany }, () => ({ clientFileId: randomUUID(), originalFilename: '同名候选人.txt', mimeType: 'text/plain', sizeBytes: content.length })) })
    assert.equal(batch.status, 201, JSON.stringify(batch.body))
    company.batch = batch.body.data
    for (const item of company.batch.items) tasks.push({ company, item, content })
  }
  const results=[],latencies=[],uploadStarted=Date.now()
  let nextUpload=0
  const uploadLanes=queueLimit<=60?queueLimit:16
  await Promise.all(Array.from({length:uploadLanes},async()=>{
    while(nextUpload<tasks.length) {
      const index=nextUpload++,{company,item,content}=tasks[index],started=performance.now()
      results[index]=await request(company,'POST','/api/v1/resume-import-batches/'+company.batch.id+'/items/'+item.id+'/content',{content:content.toString('base64'),encoding:'base64'})
      latencies.push(performance.now()-started)
    }
  }))
  assert.ok(results.every(result => result.status === 200), JSON.stringify(results.filter(result => result.status !== 200)))
  latencies.sort((a,b)=>a-b)
  report.checks.concurrentUploads = { total: results.length, success: results.filter(result => result.status === 200).length, perCompany, companies:companyCount, clientConcurrency:uploadLanes, durationMs:Date.now()-uploadStarted, p50Ms:latencies[Math.ceil(latencies.length*.5)-1], p95Ms:latencies[Math.ceil(latencies.length*.95)-1], p99Ms:latencies[Math.ceil(latencies.length*.99)-1], syntheticTextOnly:true }
  const overflow=[]
  for(const company of companies) {
    const content=Buffer.from('synthetic queue boundary sample')
    const batch=await request(company,'POST','/api/v1/resume-import-batches',{jobId:company.jobId,files:Array.from({length:8},()=>({clientFileId:randomUUID(),originalFilename:'overflow.txt',mimeType:'text/plain',sizeBytes:content.length}))})
    assert.equal(batch.status,201,JSON.stringify(batch.body))
    for(const item of batch.body.data.items) overflow.push({company,batch:batch.body.data.id,item:item.id,content})
  }
  const rejected=await Promise.all(overflow.map(({company,batch,item,content})=>request(company,'POST','/api/v1/resume-import-batches/'+batch+'/items/'+item+'/content',{content:content.toString('base64'),encoding:'base64'})))
  assert.ok(rejected.every(result=>result.status===429 && Number(result.retryAfter)>0),JSON.stringify(rejected))
  report.checks.sharedQueueCapacity={apiProcesses:2,limit:queueLimit,accepted:results.length,rejected:rejected.length,retryAfter:true}
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
  const crashed=await childProcess('worker',{RELIABILITY_CRASH_ON_TASK:'true'})
  await waitFor(()=>crashed.events.some(item=>item.type==='executing'))
  crashed.child.kill('SIGKILL');await crashed.exit
  const interrupted=[]
  // No other workers exist yet: every processing lease belongs to the killed child.
  for(const company of companies) {
    const expired=await pool.query('UPDATE "'+company.schema+'".analysis_tasks SET available_at=now()-interval \'1 second\' WHERE status=\'processing\' RETURNING id')
    interrupted.push(...expired.rows.map(row=>row.id))
  }
  assert.ok(interrupted.length>0)
  await pool.query("UPDATE public.analysis_execution_leases SET expires_at=now()-interval '1 second' WHERE task_id=ANY($1::uuid[])",[interrupted])
  const observed={platform:0,workspace:0,samples:0}
  let sampling=false
  leaseMonitor=setInterval(()=>{if(sampling)return;sampling=true;void pool.query('SELECT organization_id,count(*)::int AS n FROM public.analysis_execution_leases WHERE expires_at>now() GROUP BY organization_id').then(({rows})=>{
    observed.samples++;observed.platform=Math.max(observed.platform,rows.reduce((total,row)=>total+row.n,0));observed.workspace=Math.max(observed.workspace,0,...rows.map(row=>row.n))
  }).finally(()=>{sampling=false})},10)
  const runningWorkers=await Promise.all(Array.from({length:3},()=>childProcess('worker')))
  const workerStarted=Date.now()
  await waitFor(async () => {
    const counts = await Promise.all(companies.map(async company => (await pool.query(`SELECT count(*)::int AS count FROM "${company.schema}".analysis_tasks WHERE status='completed'`)).rows[0].count))
    return counts.every(count => count === perCompany)
  },Math.max(90000,queueLimit*500))
  for (const company of companies) {
    const count = (await pool.query(`SELECT count(*)::int AS count FROM "${company.schema}".analysis_results`)).rows[0].count
    assert.equal(count, perCompany)
  }
  report.checks.workerCompleted = perCompany * companies.length
  report.checks.workerDrainDurationMs=Date.now()-workerStarted
  clearInterval(leaseMonitor);leaseMonitor=undefined
  assert.ok(observed.samples>0 && observed.platform>0 && observed.platform<=3 && observed.workspace<=2,JSON.stringify(observed))
  report.checks.multiProcessWorkers={workers:3,interruptedTasks:interrupted.length,crashedProcessRecovered:true,simulatedLeaseExpiry:true,observed}
  const healthUrls=runningWorkers.map(record=>'http://127.0.0.1:'+record.events.find(item=>item.type==='ready').healthPort)
  const readiness=()=>Promise.all(healthUrls.map(url=>fetch(url+'/ready',{signal:AbortSignal.timeout(5000)})))
  await pool.query('ALTER TABLE "'+first.schema+'".resumes RENAME COLUMN original_filename TO temporarily_missing_filename')
  try {
    await waitFor(async()=> (await readiness()).every(response=>response.status===503),15000)
    const states=await Promise.all((await readiness()).map(response=>response.json()))
    assert.ok(states.every(state=>state.status==='degraded' && state.externalDependencies.postgres==='error'))
    assert.ok((await Promise.all(healthUrls.map(url=>fetch(url+'/health')))).every(response=>response.status===200))
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.analysis_execution_leases')).rows[0].n,0)
  } finally {
    await pool.query('ALTER TABLE "'+first.schema+'".resumes RENAME COLUMN temporarily_missing_filename TO original_filename')
  }
  await waitFor(async()=> (await readiness()).every(response=>response.status===200),15000)
  report.checks.workerRuntimeReadiness={workers:3,damagedCompanyDegraded:true,claimantsStopped:true,livenessRetained:true,structureRecoveryReady:true}
  if(process.env.VERIFY_REAL_BROWSER === 'on') {
    const {verifyResumeUploadBrowser}=await import('./resume-upload-browser-check.mjs')
    report.checks.realBrowserUploads=[]
    for(const loseResponse of [false,true]) {
      const browser=await verifyResumeUploadBrowser({root,baseUrl:base,token:first.token,csrf:first.csrf,jobId:first.jobId,reportDirectory:directory,loseResponse})
      const batch=await request(first,'GET','/api/v1/resume-import-batches/'+browser.batchId)
      assert.equal(batch.status,200,JSON.stringify(batch.body))
      const item=batch.body.data.items[0]
      assert.ok(item.candidateId && item.analysisTaskId)
      await waitFor(async()=> (await pool.query('SELECT status FROM "'+first.schema+'".analysis_tasks WHERE id=$1',[item.analysisTaskId])).rows[0]?.status==='completed')
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM "'+first.schema+'".analysis_results WHERE analysis_task_id=$1',[item.analysisTaskId])).rows[0].n,1)
      const original=await request(first,'GET','/api/v1/candidates/'+item.candidateId+'/resumes/'+item.resumeId+'/original')
      assert.equal(original.status,200,JSON.stringify(original.body))
      assert.equal((await request(second,'GET','/api/v1/candidates/'+item.candidateId)).status,404)
      assert.equal((await request(first,'DELETE','/api/v1/candidates/'+item.candidateId)).status,200)
      report.checks.realBrowserUploads.push({...browser,workerCompleted:true,resultCount:1,originalReadable:true,crossCompanyBlocked:true,deleted:true})
    }
  }
  const candidate = results[0].body.data.candidateId
  assert.equal((await request(second, 'GET', `/api/v1/candidates/${candidate}`)).status, 404)
  const deleted = await request(first, 'DELETE', `/api/v1/candidates/${candidate}`)
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
  const remaining = (await pool.query(`SELECT (SELECT count(*)::int FROM "${first.schema}".resumes WHERE candidate_id=$1) AS resumes, (SELECT count(*)::int FROM "${first.schema}".analysis_tasks t JOIN "${first.schema}".resumes r ON r.id=t.resume_id WHERE r.candidate_id=$1) AS tasks`, [candidate])).rows[0]
  assert.deepEqual(remaining, { resumes: 0, tasks: 0 })
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM "${second.schema}".candidates`)).rows[0].count, perCompany)
  report.checks.candidateDeletionIsolated = true
  const { createLocalObjectStorage } = await import(pathToFileURL(join(root, 'packages/object-storage/dist/index.js')).href)
  const { verifyReliability } = await import('./reliability-scenarios.mjs')
  await verifyReliability({ pool, companies, load, request, storage: createLocalObjectStorage(storageRoot), report, childProcess })
  const {verifyObjectWrites}=await import('./object-write-reliability.mjs')
  await verifyObjectWrites({pool,companies,load,storage:createLocalObjectStorage(storageRoot),report,childProcess})
  for(const record of children) if(!record.exited) {
    record.child.send({type:'stop'});await Promise.race([record.exit,delay(10000)])
    if(!record.exited){record.child.kill('SIGKILL');await record.exit}
  }
  const {verifyIsolatedBackup}=await import('./verify-isolated-backup.mjs')
  await verifyIsolatedBackup({pool,admin,Pool,options,database,directory,storageRoot,companies,report})
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = { message: error.message, stack: error.stack }
  process.exitCode = 1
} finally {
  if(leaseMonitor)clearInterval(leaseMonitor)
  for(const record of children) {
    if(!record.exited) {
      record.child.send({type:'stop'})
      await Promise.race([record.exit,delay(10000)])
      if(!record.exited){record.child.kill('SIGKILL');await record.exit}
    }
  }
  await mkdir(directory,{recursive:true})
  await Promise.all(children.map((record,index)=>writeFile(join(directory,'process-'+index+'.log'),record.output)))
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
