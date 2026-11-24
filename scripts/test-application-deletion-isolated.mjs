import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'

assert.ok(process.argv[2], 'Explicit isolated PostgreSQL binaries required')
const instance = await startIsolatedPostgres(process.argv[2])
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, instance.env)
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
require(join(projectRoot, 'scripts/isolated-network-guard.cjs'))
const { Pool } = require('pg')
const load = name => import(pathToFileURL(join(projectRoot, 'apps/api/dist/src', name + '.js')).href)
const { runMigrations } = await load('db/migrations')
const { NormalizedRecruitingRepository } = await load('recruiting/repositories/postgres-repository')
const admin = new Pool(instance.connection)
let pool, scoped, foreign
const checks = []
async function check(name, action) { await action(); checks.push(name); console.log('PASS ' + name) }
try {
  assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name, instance.cluster)
  await admin.query('CREATE DATABASE "' + instance.database + '"')
  const connection = { ...instance.connection, database: instance.database, max: 6 }
  pool = new Pool(connection)
  await runMigrations(pool, join(projectRoot, 'db/migrations'))
  const org = randomUUID(), other = randomUUID()
  await pool.query("INSERT INTO public.organizations(id,name,kind) VALUES($1,'synthetic-delete','test'),($2,'synthetic-other','test')", [org, other])
  for (const id of [org, other]) await pool.query('SELECT public.initialize_organization_schema($1)', [id])
  const schema = 'company_' + org.replaceAll('-', '')
  const otherSchema = 'company_' + other.replaceAll('-', '')
  scoped = new Pool({ ...connection, options: '-c search_path=' + schema + ',public' })
  foreign = new Pool({ ...connection, options: '-c search_path=' + otherSchema + ',public' })
  const repo = new NormalizedRecruitingRepository(scoped, { organizationId: org })
  const foreignRepo = new NormalizedRecruitingRepository(foreign, { organizationId: other })
  const jobs = [randomUUID(), randomUUID(), randomUUID()]
  for (const id of jobs) await scoped.query("INSERT INTO jobs(id,organization_id,job_no,title,headcount) VALUES($1,$2,$3,'synthetic-job',1)", [id, org, 'JOB-' + id])
  async function candidate() { return repo.createCandidate({ name: 'synthetic-candidate' }) }
  async function application(candidateId, jobId) { return repo.createApplication({ candidateId, jobId }) }
  async function resume(candidateId, applicationId = null) {
    const id = randomUUID()
    await scoped.query("INSERT INTO resumes(id,organization_id,candidate_id,application_id,storage_key,original_filename,mime_type,size_bytes,scan_status) VALUES($1,$2,$3,$4,$5,'synthetic.txt','text/plain',10,'clean')", [id, org, candidateId, applicationId, id + '.txt'])
    return id
  }
  async function task(resumeId, applicationId, status = 'completed') {
    const id = randomUUID()
    await scoped.query('INSERT INTO analysis_tasks(id,organization_id,resume_id,application_id,status,idempotency_key) VALUES($1::uuid,$2,$3,$4,$5,$1::uuid::text)', [id,org,resumeId,applicationId,status])
    return id
  }
  await check('exclusive data removed; sibling preserved; final deletion removes all candidate data and queues files', async () => {
    const c = await candidate(), a = await application(c.id, jobs[0]), b = await application(c.id, jobs[1])
    const own = await resume(c.id, a.id), ownTask = await task(own, a.id), shared = await resume(c.id, a.id)
    await task(shared, a.id); const siblingTask = await task(shared, b.id)
    await scoped.query("INSERT INTO analysis_results(organization_id,analysis_task_id,resume_id,application_id,result) VALUES($1,$2,$3,$4,'{}')", [org,siblingTask,shared,b.id])
    assert.deepEqual(await repo.deleteApplication(a.id), { candidateDeleted: false })
    assert.equal((await scoped.query('SELECT id FROM resumes WHERE id=$1',[own])).rows.length,0)
    assert.equal((await scoped.query('SELECT id FROM analysis_tasks WHERE id=$1',[ownTask])).rows.length,0)
    assert.equal((await scoped.query('SELECT application_id FROM resumes WHERE id=$1',[shared])).rows[0].application_id,null)
    assert.equal((await repo.getApplication(b.id)).id,b.id)
    const unbound = await resume(c.id); await task(unbound, null, 'queued')
    assert.deepEqual(await repo.deleteApplication(b.id), { candidateDeleted: true })
    await assert.rejects(repo.getCandidate(c.id), /not found/i)
    for (const table of ['applications','resumes','analysis_tasks','analysis_results']) assert.equal((await scoped.query('SELECT id FROM ' + table + ' WHERE organization_id=$1',[org])).rows.length,0,table)
    assert.equal((await pool.query('SELECT id FROM public.object_cleanup_tasks WHERE organization_id=$1',[org])).rows.length,3)
    assert.ok((await scoped.query("SELECT metadata FROM workflow_events WHERE subject_id=$1 AND event_type='delete'",[c.id])).rows.some(row => row.metadata.reason==='last_application_deleted'))
  })
  await check('cross-company deletion is refused', async () => {
    const c = await foreignRepo.createCandidate({ name: 'synthetic-foreign' })
    await assert.rejects(repo.deleteCandidate(c.id), /not found/i)
    assert.equal((await foreignRepo.getCandidate(c.id)).id,c.id)
  })
  await check('processing unbound task blocks final cleanup without partial deletion', async () => {
    const c = await candidate(), a = await application(c.id,jobs[0]), r = await resume(c.id)
    const t = await task(r,null,'processing')
    await assert.rejects(repo.deleteApplication(a.id), { code: 'APPLICATION_ANALYSIS_IN_PROGRESS' })
    assert.equal((await repo.getCandidate(c.id)).id,c.id)
    assert.equal((await repo.getApplication(a.id)).id,a.id)
    await scoped.query("UPDATE analysis_tasks SET status='completed' WHERE id=$1",[t])
    await repo.deleteApplication(a.id)
  })
  await check('concurrent sibling deletions serialize and leave no orphan candidate', async () => {
    const c = await candidate(), a = await application(c.id,jobs[0]), b = await application(c.id,jobs[1])
    const outcomes = await Promise.all([repo.deleteApplication(a.id),repo.deleteApplication(b.id)])
    assert.deepEqual(outcomes.map(value=>value.candidateDeleted).sort(),[false,true])
    await assert.rejects(repo.getCandidate(c.id), /not found/i)
  })
  await check('detached file is deleted once no remaining application uses it', async () => {
    const c = await candidate(), a = await application(c.id,jobs[0]), b = await application(c.id,jobs[1]), last = await application(c.id,jobs[2])
    const r = await resume(c.id,a.id); await task(r,a.id); await task(r,b.id)
    await repo.deleteApplication(a.id)
    assert.deepEqual(await repo.deleteApplication(b.id), { candidateDeleted: false })
    assert.equal((await scoped.query('SELECT id FROM resumes WHERE id=$1',[r])).rows.length,0)
    assert.equal((await repo.getCandidate(c.id)).id,c.id)
    await repo.deleteApplication(last.id)
  })
  console.log(JSON.stringify({ passed:true, checks, isolatedCluster:instance.cluster }))
} finally {
  await Promise.all([scoped?.end(),foreign?.end(),pool?.end()])
  await admin.end()
  await instance.stop()
}
