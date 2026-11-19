import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'

const argument = process.argv.indexOf('--postgres-bin')
assert.ok(argument >= 0 && process.argv[argument + 1], '必须指定专用 PostgreSQL，禁止回退业务连接')
const instance = await startIsolatedPostgres(process.argv[argument + 1])
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, instance.env, { DB_POOL_MAX: '1' })
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
require(join(projectRoot, 'scripts/isolated-network-guard.cjs'))
const { Pool } = require('pg')
const load = file => import(pathToFileURL(join(projectRoot, 'apps/api/dist/src', file + '.js')).href)
const observer = new Pool(instance.connection)
const report = { startedAt: new Date().toISOString(), scope: '真实隔离PostgreSQL、生产导入服务及仓储，只有对象存储替身', checks: [], cleanup: {}, failures: [] }
const output = join(instance.directory, 'upload-fencing-report.json')
let database, shared, created = false
const objects = new Map(), pending = new Map(), uploads = new Set()
let blockWrites = false, fault
const storage = {
  async put(key, body) {
    objects.set(key, Buffer.from(body))
    if (blockWrites) await new Promise(resolve => pending.set(key, resolve))
  },
  async get(key) { assert.ok(objects.has(key)); return objects.get(key) },
  async delete(key) { objects.delete(key) },
}
const release = key => { const done = pending.get(key); pending.delete(key); done?.() }
const releaseAll = () => { blockWrites = false; for (const key of [...pending.keys()]) release(key) }
const track = promise => { uploads.add(promise); promise.catch(() => undefined); promise.finally(() => uploads.delete(promise)).catch(() => undefined); return promise }
async function check(name, operation) {
  const began = performance.now()
  try { const details = await operation(); report.checks.push({ name, passed: true, elapsedMs: performance.now() - began, ...details }); console.log('上传竞态测试通过：' + name) }
  catch (error) { report.failures.push({ name, message: error.message, stack: error.stack }); throw error }
  finally { await writeFile(output, JSON.stringify(report, null, 2)) }
}
try {
  assert.equal((await observer.query('SHOW cluster_name')).rows[0].cluster_name, instance.cluster)
  await observer.query('CREATE DATABASE "' + instance.database + '"'); created = true
  database = new Pool({ ...instance.connection, database: instance.database })
  const { runMigrations } = await load('db/migrations')
  await runMigrations(database, join(projectRoot, 'db/migrations'))
  const { createDatabasePool } = await load('db/connection')
  const { runWithTenantContext } = await load('db/tenant-context')
  const { NormalizedRecruitingRepository } = await load('recruiting/repositories/postgres-repository')
  const { RecruitingService } = await load('recruiting/service')
  const { PostgresResumeImportStore, ResumeImportService } = await load('recruiting/resume-import')
  const userId = randomUUID(), organizationId = randomUUID(), jobId = randomUUID()
  await database.query("INSERT INTO users(id,email,display_name) VALUES($1,'upload-fencing@example.invalid','合成普通用户')", [userId])
  await database.query("INSERT INTO organizations(id,name,kind,service_status) VALUES($1,'合成公司','test','enabled')", [organizationId])
  await database.query("INSERT INTO organization_members(organization_id,user_id,role,business_role) VALUES($1,$2,'member','recruiter')", [organizationId, userId])
  await database.query("INSERT INTO jobs(id,organization_id,job_no,title,headcount,status) VALUES($1,$2,$3,'合成上传岗位',1,'published')", [jobId, organizationId, 'JOB-' + randomUUID()])
  const schemaName = (await database.query('SELECT public.initialize_organization_schema($1) AS schema', [organizationId])).rows[0].schema
  shared = createDatabasePool()
  const repository = new NormalizedRecruitingRepository(shared).withOrganization(organizationId)
  const recruiting = new RecruitingService(undefined, undefined, storage, repository)
  const store = new PostgresResumeImportStore(shared, organizationId)
  const facade = {
    forUploadConnection(client) {
      const scoped = recruiting.forUploadConnection(client)
      return { ...scoped, async completeResumeUpload(plan, checkpoint) {
        const mode = fault; fault = undefined
        const result = await scoped.completeResumeUpload(plan, async (transaction, value) => {
          await checkpoint(transaction, value)
          if (mode === 'rollback') throw new Error('synthetic-rollback-after-checkpoint')
        })
        if (mode === 'lost-commit-response') throw new Error('synthetic-lost-commit-response')
        return result
      } }
    },
  }
  const service = new ResumeImportService(store, facade)
  const context = operation => runWithTenantContext({ organizationId, schemaName }, operation)
  const db = (sql, values) => context(() => shared.query(sql, values))
  const bytes = Buffer.from('姓名：合成同名人员；本科，五年软件开发经验。')
  const input = { content: bytes.toString('base64'), encoding: 'base64' }
  const batch = () => context(() => service.createBatch({ jobId, files: [{ clientFileId: randomUUID(), originalFilename: 'synthetic.txt', mimeType: 'text/plain', sizeBytes: bytes.length }] }, userId))
  const upload = value => track(context(() => service.uploadItem(value.id, value.items[0].id, input, userId)))
  async function blocked() {
    const deadline = performance.now() + 3000
    while (pending.size === 0) { assert.ok(performance.now() < deadline, '上传未到达对象边界'); await new Promise(resolve => setTimeout(resolve, 5)) }
    assert.equal(shared.totalCount, shared.idleCount, '慢写不能持有数据库连接')
    return [...pending.keys()][0]
  }
  const get = value => context(() => service.getBatch(value.id))
  const counts = async candidateId => (await db('SELECT (SELECT count(*)::int FROM resumes WHERE candidate_id=$1) AS resumes,(SELECT count(*)::int FROM analysis_tasks t JOIN resumes r ON r.id=t.resume_id WHERE r.candidate_id=$1) AS tasks', [candidateId])).rows[0]

  await check('重复上传被拒绝，过期尝试迟到不能覆盖新尝试', async () => {
    const value = await batch(); blockWrites = true
    const first = upload(value), firstKey = await blocked()
    await assert.rejects(upload(value), { code: 'UPLOAD_IN_PROGRESS' })
    await assert.rejects(context(() => service.detachJob(value.id)), { code: 'BATCH_IN_PROGRESS' })
    const fixture = await database.connect()
    try {
      await fixture.query('BEGIN')
      // Only this isolated fixture bypasses the timestamp trigger; production clocks stay unchanged.
      await fixture.query('SET LOCAL session_replication_role=replica')
      await fixture.query('UPDATE "' + schemaName + '".resume_import_items SET updated_at=now()-$2::interval WHERE id=$1', [value.items[0].id, '3 minutes'])
      await fixture.query('COMMIT')
    } catch (error) { await fixture.query('ROLLBACK'); throw error }
    finally { fixture.release() }
    blockWrites = false
    const second = await upload(value)
    release(firstKey)
    await assert.rejects(first, { code: 'UPLOAD_SUPERSEDED' })
    const saved = (await get(value)).items[0]
    assert.equal(saved.attempts, 2); assert.equal(saved.resumeId, second.resumeId); assert.equal(saved.analysisTaskId, second.analysisTaskId)
    assert.deepEqual(await counts(saved.candidateId), { resumes: 1, tasks: 1 })
    const intent = (await database.query('SELECT status FROM public.object_write_intents WHERE storage_key=$1', [firstKey])).rows[0]
    assert.equal(intent.status, 'cleanup_pending')
    return { attempts: saved.attempts, records: await counts(saved.candidateId) }
  })
  await check('文件绑定和导入检查点一并回滚，重试复用人员与申请', async () => {
    const value = await batch(); fault = 'rollback'
    await assert.rejects(upload(value), /synthetic-rollback-after-checkpoint/)
    const failed = (await get(value)).items[0]
    assert.equal(failed.status, 'failed'); assert.equal(failed.resumeId, undefined)
    assert.deepEqual(await counts(failed.candidateId), { resumes: 0, tasks: 0 })
    const retried = await upload(value)
    assert.equal(retried.candidateId, failed.candidateId); assert.equal(retried.applicationId, failed.applicationId)
    assert.deepEqual(await counts(failed.candidateId), { resumes: 1, tasks: 1 })
  })
  await check('提交响应丢失不降级已提交记录，重试不重复入队', async () => {
    const value = await batch(); fault = 'lost-commit-response'
    await assert.rejects(upload(value), /synthetic-lost-commit-response/)
    const saved = (await get(value)).items[0]
    assert.equal(saved.status, 'queued')
    const retried = await upload(value)
    assert.equal(retried.resumeId, saved.resumeId); assert.equal(retried.analysisTaskId, saved.analysisTaskId)
    assert.deepEqual(await counts(saved.candidateId), { resumes: 1, tasks: 1 })
    assert.equal((await database.query('SELECT status FROM public.object_write_intents WHERE storage_key=(SELECT storage_key FROM "' + schemaName + '".resumes WHERE id=$1)', [saved.resumeId])).rows[0].status, 'bound')
  })
  await check('取消批次保留已开始上传的既有语义', async () => {
    const value = await batch(); blockWrites = true
    const work = upload(value), key = await blocked()
    await context(() => service.cancelBatch(value.id))
    release(key); blockWrites = false
    assert.equal((await work).status, 'queued')
    assert.equal((await get(value)).status, 'cancelled')
  })
  await check('慢写期间删除父人员，迟到文件不能复活人员或任务', async () => {
    const value = await batch(); blockWrites = true
    const work = upload(value), key = await blocked()
    const candidateId = (await get(value)).items[0].candidateId
    await context(() => recruiting.deleteCandidate(candidateId, userId))
    release(key); blockWrites = false
    await assert.rejects(work, { code: 'UPLOAD_SUPERSEDED' })
    assert.equal((await db('SELECT count(*)::int AS n FROM candidates WHERE id=$1', [candidateId])).rows[0].n, 0)
    assert.deepEqual(await counts(candidateId), { resumes: 0, tasks: 0 })
    assert.equal((await database.query('SELECT status FROM public.object_write_intents WHERE storage_key=$1', [key])).rows[0].status, 'cleanup_pending')
  })
  const setTrialUsage = async count => {
    await database.query("UPDATE public.organizations SET service_status='trial', trial_ends_at=now()+interval '14 days' WHERE id=$1", [organizationId])
    await database.query('INSERT INTO public.organization_trial_usage(organization_id,resume_uploads) VALUES($1,$2) ON CONFLICT(organization_id) DO UPDATE SET resume_uploads=excluded.resume_uploads', [organizationId, count])
  }
  const candidateCount = async () => (await db('SELECT count(*)::int AS n FROM candidates')).rows[0].n
  await check('额度拒绝回收未修改占位，保留文件清理账本且允许额度恢复后重试', async () => {
    await setTrialUsage(3)
    const before = await candidateCount(), value = await batch()
    await assert.rejects(upload(value), /TRIAL_RESUME_LIMIT_REACHED/)
    const saved = (await get(value)).items[0]
    assert.equal(saved.status, 'failed'); assert.equal(saved.candidateId, undefined); assert.equal(saved.applicationId, undefined)
    assert.equal(await candidateCount(), before)
    assert.equal((await database.query('SELECT resume_uploads FROM public.organization_trial_usage WHERE organization_id=$1', [organizationId])).rows[0].resume_uploads, 3)
    await database.query("UPDATE public.organizations SET service_status='enabled' WHERE id=$1", [organizationId])
    const retried = await upload(value)
    assert.equal(retried.status, 'queued'); assert.equal(retried.attempts, 2)
    assert.deepEqual(await counts(retried.candidateId), { resumes: 1, tasks: 1 })
    return { candidateDeltaOnRejection: 0, retryAttempts: retried.attempts }
  })
  await check('仅剩一个额度时三个真实并发上传只能成功一个，无额外人员或申请', async () => {
    await setTrialUsage(2)
    const before = await candidateCount(), values = await Promise.all([batch(), batch(), batch()])
    blockWrites = true
    const work = values.map(upload)
    const deadline = performance.now() + 5000
    while (pending.size < 3) { assert.ok(performance.now() < deadline, '三个并发上传未进入存储边界'); await new Promise(resolve => setTimeout(resolve, 5)) }
    assert.equal(shared.totalCount, shared.idleCount)
    releaseAll()
    const results = await Promise.allSettled(work)
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
    assert.equal(results.filter(row => row.status === 'rejected' && row.reason.message === 'TRIAL_RESUME_LIMIT_REACHED').length, 2)
    assert.equal(await candidateCount(), before + 1)
    for (const value of values) {
      const item = (await get(value)).items[0]
      if (item.status === 'failed') { assert.equal(item.candidateId, undefined); assert.equal(item.applicationId, undefined) }
    }
    assert.equal((await database.query('SELECT resume_uploads FROM public.organization_trial_usage WHERE organization_id=$1', [organizationId])).rows[0].resume_uploads, 3)
    return { accepted: 1, rejected: 2, candidateDelta: 1 }
  })
  for (const mode of ['candidate-edited', 'application-edited', 'new-cascade-reference']) {
    await check('额度拒绝不能误删已有业务变更：' + mode, async () => {
      await setTrialUsage(3)
      const value = await batch(); blockWrites = true
      const work = upload(value), key = await blocked()
      const item = (await get(value)).items[0]
      if (mode === 'candidate-edited') await context(() => repository.updateCandidate(item.candidateId, { name: '用户已修改的姓名' }))
      if (mode === 'application-edited') await context(() => repository.updateApplication(item.applicationId, { source: '用户已修改的申请' }))
      if (mode === 'new-cascade-reference') {
        await db('CREATE TABLE synthetic_candidate_notes(id uuid PRIMARY KEY, candidate_id uuid REFERENCES candidates(id) ON DELETE CASCADE)')
        await db('INSERT INTO synthetic_candidate_notes VALUES($1,$2)', [randomUUID(), item.candidateId])
      }
      release(key); blockWrites = false
      await assert.rejects(work, /TRIAL_RESUME_LIMIT_REACHED/)
      const failed = (await get(value)).items[0]
      assert.equal(failed.status, 'failed'); assert.equal(failed.candidateId, item.candidateId); assert.equal(failed.applicationId, item.applicationId)
      assert.equal((await db('SELECT count(*)::int AS n FROM candidates WHERE id=$1', [item.candidateId])).rows[0].n, 1)
      if (mode === 'new-cascade-reference') assert.equal((await db('SELECT count(*)::int AS n FROM synthetic_candidate_notes WHERE candidate_id=$1', [item.candidateId])).rows[0].n, 1)
      return { preservedCandidate: true, preservedApplication: true }
    })
  }
  await database.query("UPDATE public.organizations SET service_status='enabled' WHERE id=$1", [organizationId])
  const foreignOrganization = randomUUID()
  await database.query("INSERT INTO public.organizations(id,name,kind,service_status) VALUES($1,'合成隔离对照公司','test','enabled')", [foreignOrganization])
  for (const targetSchema of ['public', schemaName]) {
    await check('录音引用按会话确定归属且保留删除栅栏：' + targetSchema, async () => {
      const candidate = randomUUID(), application = randomUUID(), interview = randomUUID(), session = randomUUID()
      const query = (sql, values) => {
        const run = () => shared.query(sql.replaceAll('TARGET.', '"' + targetSchema + '".'), values)
        return targetSchema === 'public' ? run() : context(run)
      }
      await query("INSERT INTO TARGET.candidates(id,candidate_no,name,organization_id) VALUES($1,$2,'合成录音人员',$3)", [candidate, 'CAN-' + candidate, organizationId])
      await query('INSERT INTO TARGET.applications(id,application_no,candidate_id,job_id,organization_id) VALUES($1,$2,$3,$4,$5)', [application, 'APP-' + application, candidate, jobId, organizationId])
      await query("INSERT INTO TARGET.interviews(id,interview_no,application_id,round,type,title,organization_id) VALUES($1,$2,$3,1,'onsite','合成录音面试',$4)", [interview, 'INT-' + interview, application, organizationId])
      await query('INSERT INTO TARGET.interview_live_sessions(id,interview_id,created_by) VALUES($1,$2,$3)', [session, interview, userId])
      const mapping = async () => {
        const logical = 'synthetic/audio/' + randomUUID(), physical = 'synthetic/physical/' + randomUUID()
        await database.query('INSERT INTO public.interview_stored_objects(organization_id,session_id,storage_key,schema_name,physical_key) VALUES($1,$2,$3,$4,$5)', [organizationId, session, logical, targetSchema, physical])
        return { logical, physical }
      }
      const record = value => query("INSERT INTO TARGET.interview_audio_recordings(session_id,object_key,content_type,offset_ms) VALUES($1,$2,'audio/webm',0) RETURNING id", [session, value.logical])
      const valid = await mapping()
      await database.query("INSERT INTO public.object_write_intents(attempt_id,organization_id,schema_name,storage_kind,parent_id,logical_key,storage_key,content_version,status) VALUES($1,$2,$3,'interview',$4,$5,$6,'v1','bound')", [randomUUID(), organizationId, targetSchema, session, valid.logical, valid.physical])
      const saved = (await record(valid)).rows[0]
      await query('UPDATE TARGET.interview_audio_recordings SET end_ms=1000 WHERE id=$1', [saved.id])
      await database.query("INSERT INTO public.object_deletion_fences(storage_kind,storage_key,organization_id,schema_name,location_id) VALUES('interview',$1,$2,$3,$4)", [valid.physical, organizationId, targetSchema, 'a'.repeat(64)])
      await assert.rejects(query('UPDATE TARGET.interview_audio_recordings SET end_ms=2000 WHERE id=$1', [saved.id]), /OBJECT_REFERENCE_DELETION_FENCED/)
      const fenced = await mapping()
      await database.query("INSERT INTO public.object_deletion_fences(storage_kind,storage_key,organization_id,schema_name,location_id) VALUES('interview',$1,$2,$3,$4)", [fenced.physical, organizationId, targetSchema, 'b'.repeat(64)])
      await assert.rejects(record(fenced), /OBJECT_REFERENCE_DELETION_FENCED/)
      const foreign = await mapping()
      await database.query("INSERT INTO public.stored_object_locations(organization_id,storage_kind,storage_key,location_id) VALUES($1,'interview',$2,$3)", [foreignOrganization, foreign.physical, 'c'.repeat(64)])
      await assert.rejects(record(foreign), /OBJECT_REFERENCE_OWNER_MISMATCH/)
      const wrongParent = await mapping()
      await database.query("INSERT INTO public.object_write_intents(attempt_id,organization_id,schema_name,storage_kind,parent_id,logical_key,storage_key,content_version,status) VALUES($1,$2,$3,'interview',$4,$5,$6,'v1','bound')", [randomUUID(), organizationId, targetSchema, randomUUID(), wrongParent.logical, wrongParent.physical])
      await assert.rejects(record(wrongParent), /OBJECT_REFERENCE_INTENT_MISMATCH/)
      await assert.rejects(query("INSERT INTO TARGET.interview_audio_recordings(session_id,object_key,content_type,offset_ms) VALUES($1,$2,'audio/webm',0)", [randomUUID(), 'missing/' + randomUUID()]), /OBJECT_REFERENCE_OWNER_MISSING/)
      return { validInsertAndUpdate: true, fencedInsertRejected: true, fencedUpdateRejected: true, foreignOwnerRejected: true, wrongParentRejected: true, missingSessionRejected: true }
    })
  }
  report.passed = true
} catch (error) { report.passed = false; if (!report.failures.length) report.failures.push({ message: error.message, stack: error.stack }); process.exitCode = 1 }
finally {
  releaseAll(); await Promise.allSettled([...uploads])
  const errors = []
  try { await shared?.end() } catch (error) { errors.push(error.message) }
  try { await database?.end() } catch (error) { errors.push(error.message) }
  if (created) { try { await observer.query('DROP DATABASE "' + instance.database + '" WITH (FORCE)'); report.cleanup.databaseDropped = true } catch (error) { errors.push(error.message) } }
  try { await observer.end() } catch (error) { errors.push(error.message) }
  try { await instance.stop(); report.cleanup.postgresStopped = true } catch (error) { errors.push(error.message) }
  if (errors.length) { report.cleanup.errors = errors; report.passed = false; process.exitCode = 1 }
  report.finishedAt = new Date().toISOString()
  await writeFile(output, JSON.stringify(report, null, 2))
}
console.log(JSON.stringify({ passed: report.passed, report: output, failures: report.failures.map(row => row.message), cleanup: report.cleanup }))
