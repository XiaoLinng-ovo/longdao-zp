import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { buildCompanyPlan, executeCompanyPlan, validateCompanyPlan } from './company-data-maintenance.mjs'
import { inspectCompanySchemas } from './check-company-schemas.mjs'
import { companySchema } from './company-data-model.mjs'
import { companyDataMaintenance } from './maintenance-company-data.mjs'
import { diagnose } from './runtime-doctor.mjs'
import { assertStructureContract } from '../packages/database-readiness/structure-contract.js'

assert.ok(process.argv[2], 'Explicit isolated PostgreSQL bin directory required; no business fallback')
const instance = await startIsolatedPostgres(process.argv[2])
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, instance.env)
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
require(join(projectRoot, 'scripts/isolated-network-guard.cjs'))
const { Pool } = require('pg'), admin = new Pool(instance.connection)
const report = { passed: false, boundary: 'random dedicated synthetic PostgreSQL; no business access', checks: [], cleanup: {} }
let pool, created = false
const contract = JSON.parse(await readFile(join(projectRoot, 'packages/database-readiness/structure-contract.json'), 'utf8'))
const org = randomUUID(), other = randomUUID(), schema = companySchema(org)
const q = (table, scope = schema) => '"' + scope + '"."' + table + '"'
const context = { backupSha256: 'a'.repeat(64), purpose: 'synthetic-isolated-test' }
async function check(name, action) { console.log('CHECK ' + name); await action(); report.checks.push(name) }
function approve(plan) {
  plan.approval = { reviewedBy: 'synthetic-test-only', snapshotSha256: plan.snapshotSha256, approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    evidenceReferences: Object.fromEntries(['writersDrained','backupRestored','objectsReviewed','configReviewed','rehearsalPassed','businessSmokePassed','dataReconciled'].map(name => [name, 'synthetic-only-' + name])) }
  return plan
}
const build = (intent = 'reconcile') => buildCompanyPlan(pool, { organizationId: org, intent, context, contract })
const execute = (plan, options = {}) => executeCompanyPlan(pool, plan, { contract, ...options })
async function audit() { return inspectCompanySchemas(pool, { compareLegacy: true, includeEntries: true, organizationId: org }) }
try {
  assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name, instance.cluster)
  await admin.query('CREATE DATABASE "' + instance.database + '"'); created = true
  pool = new Pool({ ...instance.connection, database: instance.database, max: 3 })
  const { runMigrations } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/db/migrations.js')))
  report.migrations = (await runMigrations(pool, join(projectRoot, 'db/migrations'))).applied.length
  await pool.query("INSERT INTO public.organizations(id,name,kind,service_status) VALUES($1,'synthetic-recovery','test','enabled'),($2,'synthetic-other','test','enabled')", [org, other])
  const actor = randomUUID(), sharedJob = randomUUID(), department = randomUUID(), otherDepartment = randomUUID(), policy = randomUUID()
  await pool.query("INSERT INTO public.users(id,email,display_name) VALUES($1,$2,'synthetic')", [actor, actor + '@example.invalid'])
  await pool.query('INSERT INTO public.organization_members(organization_id,user_id) VALUES($1,$2)', [org, actor])
  await pool.query("INSERT INTO public.departments(id,organization_id,code,name) VALUES($1::uuid,$2,$1::text,'synthetic')", [department, org])
  await pool.query("INSERT INTO public.departments(id,organization_id,code,name) VALUES($1::uuid,$2,$1::text,'synthetic-other')", [otherDepartment, other])
  await pool.query("INSERT INTO public.department_approval_policies(id,department_id,process_code) VALUES($1,$2,'synthetic')", [policy,department])
  await pool.query("INSERT INTO public.jobs(id,organization_id,job_no,title,headcount) VALUES($1::uuid,$2,$1::text,'shared',1)", [sharedJob, org])
  await pool.query('SELECT public.initialize_organization_schema($1)', [org])
  await pool.query('SELECT public.initialize_organization_schema($1)', [other])
  const jobs = [randomUUID(),randomUUID(),randomUUID()]
  for (const id of jobs) await pool.query('INSERT INTO ' + q('jobs') + "(id,organization_id,job_no,title,headcount) VALUES($1::uuid,$2,$1::text,'company-only',1)", [id, org])
  for (let n = 1; n <= 7; n++) await pool.query('INSERT INTO ' + q('job_spec_versions') + '(job_id,organization_id,version) VALUES($1,$2,$3)', [jobs[0], org, n])
  for (let n = 1; n <= 4; n++) await pool.query('INSERT INTO ' + q('job_description_versions') + "(job_id,organization_id,version,title) VALUES($1,$2,$3,'synthetic')", [jobs[0], org, n])
  const eventIds = []
  for (let n = 0; n < 9; n++) {
    const id = randomUUID(); eventIds.push(id)
    await pool.query("INSERT INTO public.workflow_events(id,organization_id,subject_type,subject_id,event_type,actor_user_id,reason,created_at) VALUES($1,$2,'job',$3,'synthetic-history',$4,$5,'2026-01-01 01:02:03.123456+00')", [id,org,sharedJob,actor,'event-' + n])
  }
  let plan
  await check('plan is read-only, unapproved, exactly 14 preservations and 9 original imports', async () => {
    plan = await build()
    assert.equal(plan.approval, null); assert.equal(plan.snapshot.entries.length, 23)
    assert.equal(plan.snapshot.entries.filter(e => e.action === 'preserve-company').length, 14)
    assert.equal(plan.snapshot.entries.filter(e => e.action === 'copy-original-event' && e.importCheck.ready).length, 9)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ' + q('workflow_events'))).rows[0].n, 0)
    await assert.rejects(execute(plan, { apply: true }), /DATA_APPROVAL_REQUIRED/)
    approve(plan); assert.equal((await execute(plan)).readOnly, true)
    const prematureSeal = approve(await build('seal'))
    assert.throws(() => validateCompanyPlan(prematureSeal), /DATA_PLAN_REVIEW_REQUIRED/)
    const ordinaryPrecheck = await diagnose(projectRoot,{env:instance.env})
    assert.equal(ordinaryPrecheck.dataAudit.ready,false)
    assert.ok(ordinaryPrecheck.checks.some(item=>item.name==='companyDataConsistency' && item.message.includes('DATA_PATH_CONFLICT')))
  })
  await check('CLI plan/check binds files and effective configuration without writes', async () => {
    const backup = join(instance.directory,'synthetic-backup-marker'), file = join(instance.directory,'cli-plan.json')
    await writeFile(backup,'synthetic marker, not a business backup',{flag:'wx'})
    const args = {action:'plan',profile:instance.env.ENV_FILE_PATH,backup,organization:org,intent:'reconcile',plan:file}
    const result = await companyDataMaintenance(args)
    assert.equal(result.readOnly,true); assert.equal(result.entries,23)
    await assert.rejects(companyDataMaintenance(args),{code:'EEXIST'})
    const generated = approve(JSON.parse(await readFile(file,'utf8')))
    await writeFile(file,JSON.stringify(generated))
    assert.equal((await companyDataMaintenance({...args,action:'check'})).approvedSnapshotMatches,true)
    await writeFile(backup,'changed synthetic marker')
    await assert.rejects(companyDataMaintenance({...args,action:'check'}),/DATA_PLAN_CONTEXT_CHANGED/)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM recovery_control.maintenance_receipts')).rows[0].n,0)
  })
  await check('target drift and conflicting same-key rows reject before writes', async () => {
    await pool.query('UPDATE ' + q('jobs') + " SET title='changed' WHERE id=$1", [jobs[0]])
    await assert.rejects(execute(plan, { apply: true }), /DATA_SNAPSHOT_CHANGED/)
    await pool.query('UPDATE ' + q('jobs') + " SET title='company-only' WHERE id=$1", [jobs[0]])
    await pool.query('INSERT INTO ' + q('workflow_events') + ' SELECT * FROM public.workflow_events WHERE id=$1', [eventIds[0]])
    await pool.query('UPDATE ' + q('workflow_events') + " SET reason='conflict' WHERE id=$1", [eventIds[0]])
    const blocked = approve(await build()); assert.throws(() => validateCompanyPlan(blocked), /DATA_PLAN_REVIEW_REQUIRED/)
    await pool.query('DELETE FROM ' + q('workflow_events') + ' WHERE id=$1', [eventIds[0]])
  })
  await check('new imports reject unknown subject, absent subject, duplicate body and unsafe trigger', async () => {
    await pool.query("UPDATE public.workflow_events SET subject_type='unknown' WHERE id=$1", [eventIds[0]])
    assert.equal((await build()).snapshot.entries.find(e => e.primaryKey[0] === eventIds[0]).importCheck.code, 'EVENT_SUBJECT_UNSUPPORTED')
    await pool.query("UPDATE public.workflow_events SET subject_type='job',subject_id=$2 WHERE id=$1", [eventIds[0],randomUUID()])
    assert.equal((await build()).snapshot.entries.find(e => e.primaryKey[0] === eventIds[0]).importCheck.code, 'EVENT_SUBJECT_MISSING')
    await pool.query('UPDATE public.workflow_events SET subject_id=$2 WHERE id=$1', [eventIds[0],sharedJob])
    await pool.query('UPDATE public.workflow_events t SET reason=s.reason FROM public.workflow_events s WHERE t.id=$1 AND s.id=$2', [eventIds[1],eventIds[0]])
    assert.equal((await build()).snapshot.entries.find(e => e.primaryKey[0] === eventIds[0]).importCheck.code, 'EVENT_SEMANTIC_DUPLICATE')
    await pool.query("UPDATE public.workflow_events SET reason='event-1' WHERE id=$1", [eventIds[1]])
    await pool.query('CREATE TRIGGER synthetic_unsafe BEFORE INSERT ON ' + q('workflow_events') + ' FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()')
    await assert.rejects(build(), /结构契约/)
    await pool.query('DROP TRIGGER synthetic_unsafe ON ' + q('workflow_events'))
  })
  await check('failure on fourth insert rolls back all events and receipt', async () => {
    plan = approve(await build()); let inserts = 0
    const faultPool = { async connect() {
      const client = await pool.connect()
      return { query(sql, args) { if (sql.startsWith('INSERT INTO ' + q('workflow_events')) && ++inserts === 4) throw Error('SYNTHETIC_FAILURE'); return client.query(sql,args) }, release() { client.release() } }
    } }
    await assert.rejects(executeCompanyPlan(faultPool, plan, { apply: true, contract }), /SYNTHETIC_FAILURE/)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ' + q('workflow_events'))).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM recovery_control.maintenance_receipts')).rows[0].n, 0)
  })
  await check('concurrent maintenance lock and active writer refuse without partial writes', async () => {
    const holder = await pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('smartrecruit:company-data-maintenance'))")
      await assert.rejects(execute(plan,{apply:true}), /DATA_MAINTENANCE_BUSY/)
      await holder.query('ROLLBACK')
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE ' + q('workflow_events') + ' IN ROW EXCLUSIVE MODE')
      await assert.rejects(execute(plan,{apply:true}), /lock timeout/)
    } finally { await holder.query('ROLLBACK'); holder.release() }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ' + q('workflow_events'))).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM recovery_control.maintenance_receipts')).rows[0].n, 0)
  })
  await check('approval expiry immediately before commit rolls back data and receipt', async () => {
    let expired = false
    const expiringPool = { async connect() {
      const client = await pool.connect()
      return { async query(sql,args) {
        const result = await client.query(sql,args)
        if (sql.startsWith('INSERT INTO recovery_control.maintenance_receipts')) expired = true
        return result
      }, release(broken) { client.release(broken) } }
    } }
    await assert.rejects(executeCompanyPlan(expiringPool,plan,{apply:true,contract,clock:()=>expired ? new Date(plan.approval.expiresAt) : new Date()}), /DATA_APPROVAL_WINDOW_INVALID/)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ' + q('workflow_events'))).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM recovery_control.maintenance_receipts')).rows[0].n, 0)
  })
  await check('apply copies nine originals, preserves fourteen, no replay or other table changes, idempotent retry', async () => {
    const before = plan.snapshot.companyBaseline
    const result = await execute(plan, { apply: true }); assert.equal(result.copied, 9); assert.equal(result.preserved, 14)
    assert.equal((await execute(plan, { apply: true })).alreadyApplied, true)
    const next = await build()
    assert.deepEqual(next.snapshot.companyBaseline.filter(t => t.table !== 'workflow_events'), before.filter(t => t.table !== 'workflow_events'))
    assert.deepEqual(next.snapshot.legacyBaseline, plan.snapshot.legacyBaseline)
    assert.equal(next.snapshot.entries.length, 14)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ' + q('workflow_events',companySchema(other)))).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM recovery_control.company_data_cutovers')).rows[0].n, 0)
  })
  let seal
  await check('seal is separate, requires extra evidence, records immutable database cutover', async () => {
    seal = approve(await build('seal')); delete seal.approval.evidenceReferences.businessSmokePassed
    await assert.rejects(execute(seal,{apply:true}), /DATA_EVIDENCE_REQUIRED/)
    approve(seal); assert.equal((await execute(seal,{apply:true})).companyAuthoritative,true)
    assert.equal((await execute(seal,{apply:true})).alreadyApplied,true)
    await assert.rejects(pool.query('DELETE FROM recovery_control.company_data_cutovers'), /MAINTENANCE_RECORD_IMMUTABLE/)
    await assert.rejects(pool.query('UPDATE recovery_control.maintenance_receipts SET approved_by=approved_by'), /MAINTENANCE_RECORD_IMMUTABLE/)
    await assert.rejects(pool.query('TRUNCATE recovery_control.company_data_cutovers'), /MAINTENANCE_RECORD_IMMUTABLE/)
    assert.equal((await audit()).ready,true)
  })
  await check('post-cutover company CRUD remains valid even when historical subjects are deleted', async () => {
    const id=randomUUID()
    await pool.query('INSERT INTO ' + q('jobs') + "(id,organization_id,job_no,title,headcount) VALUES($1::uuid,$2,$1::text,'new',1)",[id,org])
    await pool.query('UPDATE ' + q('jobs') + " SET title='newer' WHERE id=$1",[id])
    await pool.query('DELETE FROM ' + q('jobs') + ' WHERE id=ANY($1::uuid[])',[[id,sharedJob]])
    const result=await audit(); assert.equal(result.ready,true); assert.equal(result.companies[0].phase,'company-authoritative')
    const ordinaryPrecheck = await diagnose(projectRoot,{env:instance.env})
    assert.equal(ordinaryPrecheck.dataAudit.ready,true)
    assert.ok(!ordinaryPrecheck.checks.some(item=>item.name==='companyDataConsistency'))
  })
  await check('post-cutover invitations and member settings audit in the target company only', async () => {
    const { WorkspaceInvitationsService } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/auth/workspace-invitations.js')))
    const count = async (table, clause, values) => (await pool.query('SELECT count(*)::int AS n FROM ' + table + ' WHERE ' + clause, values)).rows[0].n
    const inviteCount = () => count('public.organization_invitations', 'organization_id=$1', [org])
    // Reproduce the old failure and check that it did not leave a pending invitation.
    await assert.rejects(new WorkspaceInvitationsService(pool, false).create(org, actor, {departmentId:department}), /LEGACY_SNAPSHOT_READ_ONLY/)
    assert.equal(await inviteCount(), 0)

    const service = new WorkspaceInvitationsService(pool)
    const joiner = randomUUID()
    await pool.query('INSERT INTO public.users(id,email,display_name) VALUES($1,$2,$3)', [joiner, joiner+'@example.invalid', 'synthetic-joiner'])
    await assert.rejects(service.create(org, actor, {departmentId:otherDepartment}), {code:'VALIDATION_ERROR'})
    const invite = await service.create(org, actor, {departmentId:department})
    assert.equal(await inviteCount(), 1)
    assert.equal((await service.preview(invite.code, joiner)).departmentId, department)
    await service.accept(invite.code, joiner)
    assert.equal((await service.members(org, actor)).find(member=>member.id===joiner).departmentId, department)
    await service.updateMember(org, actor, joiner, {departmentId:null})
    assert.equal((await service.members(org, actor)).find(member=>member.id===joiner).departmentId, null)
    const pending = await service.create(org, actor, {})
    await service.revoke(org, actor, pending.id)
    const actions = await pool.query('SELECT action FROM ' + q('audit_logs') + " WHERE organization_id=$1 AND action LIKE 'workspace.%' ORDER BY action", [org])
    assert.deepEqual(actions.rows.map(row=>row.action), ['workspace.invitation.accept','workspace.invitation.create','workspace.invitation.create','workspace.invitation.revoke','workspace.member.update'])
    for (const table of ['public.audit_logs', q('audit_logs',companySchema(other))]) {
      assert.equal(await count(table, "action LIKE 'workspace.%'", []), 0)
    }
    assert.equal((await audit()).ready,true)
  })
  await check('public direct/indirect/owner-changing writes and truncate blocked, platform and other org allowed', async () => {
    await assert.rejects(pool.query("UPDATE public.jobs SET title='forbidden' WHERE id=$1",[sharedJob]),/LEGACY_SNAPSHOT_READ_ONLY/)
    await assert.rejects(pool.query('UPDATE public.jobs SET organization_id=$2 WHERE id=$1',[sharedJob,other]),/LEGACY_SNAPSHOT_READ_ONLY/)
    await assert.rejects(pool.query('DELETE FROM public.jobs WHERE id=$1',[sharedJob]),/LEGACY_SNAPSHOT_READ_ONLY/)
    await assert.rejects(pool.query("INSERT INTO public.jobs(id,organization_id,job_no,title,headcount) VALUES($1::uuid,$2,$1::text,'forbidden',1)",[randomUUID(),org]),/LEGACY_SNAPSHOT_READ_ONLY/)
    await assert.rejects(pool.query("UPDATE public.department_approval_policies SET process_code='forbidden' WHERE id=$1",[policy]),/LEGACY_SNAPSHOT_READ_ONLY/)
    await assert.rejects(pool.query('UPDATE public.department_approval_policies SET department_id=$2 WHERE id=$1',[policy,otherDepartment]),/LEGACY_SNAPSHOT_READ_ONLY/)
    await assert.rejects(pool.query('DELETE FROM public.department_approval_policies WHERE id=$1',[policy]),/LEGACY_SNAPSHOT_READ_ONLY/)
    await assert.rejects(pool.query("INSERT INTO public.department_approval_policies(department_id,subject_type,process_code) VALUES($1,'job','forbidden')",[department]),/LEGACY_SNAPSHOT_READ_ONLY/)
    await assert.rejects(pool.query('TRUNCATE public.workflow_events'),/LEGACY_SNAPSHOT_READ_ONLY/)
    await pool.query("UPDATE public.departments SET name='metadata-allowed' WHERE id=$1",[department])
    await assert.rejects(pool.query('UPDATE public.departments SET organization_id=$2 WHERE id=$1',[department,other]),/LEGACY_SNAPSHOT_READ_ONLY/)
    await assert.rejects(pool.query('DELETE FROM public.departments WHERE id=$1',[department]),/LEGACY_SNAPSHOT_READ_ONLY/)
    await pool.query("UPDATE public.organizations SET name='platform-allowed' WHERE id=$1",[org])
    await pool.query("INSERT INTO public.jobs(id,organization_id,job_no,title,headcount) VALUES($1::uuid,$2,$1::text,'other-allowed',1)",[randomUUID(),other])
    assert.equal((await audit()).ready,true)
  })
  await check('new company after cutover inherits guards and valid contract', async () => {
    const fresh = randomUUID(), freshSchema = companySchema(fresh)
    await pool.query("INSERT INTO public.organizations(id,name,kind,service_status) VALUES($1,'synthetic-fresh','test','enabled')",[fresh])
    await pool.query('SELECT public.initialize_organization_schema($1)',[fresh])
    await assertStructureContract(pool,contract,[{organization_id:fresh,schema_name:freshSchema}])
    await pool.query('INSERT INTO ' + q('jobs',freshSchema) + "(id,organization_id,job_no,title,headcount) VALUES($1::uuid,$2,$1::text,'allowed',1)",[randomUUID(),fresh])
  })
  await check('post-cutover indirect foreign-company ownership is detected', async () => {
    await pool.query('UPDATE ' + q('department_approval_policies') + ' SET department_id=$2 WHERE id=$1',[policy,otherDepartment])
    const result = await audit()
    assert.equal(result.ready,false)
    assert.ok(result.companies[0].integrity.issues.some(issue=>issue.code==='COMPANY_OWNER_MISMATCH' && issue.table==='department_approval_policies'))
    await pool.query('UPDATE ' + q('department_approval_policies') + ' SET department_id=$2 WHERE id=$1',[policy,department])
    assert.equal((await audit()).ready,true)
  })
  await check('control ACL drift and owner-bypassed legacy tampering are detected, no equality false positive', async () => {
    await pool.query('GRANT SELECT ON recovery_control.company_data_cutovers TO PUBLIC')
    await assert.rejects(assertStructureContract(pool,contract,[]),/DATA_CONTROL_ACCESS_UNSAFE/)
    await pool.query('REVOKE SELECT ON recovery_control.company_data_cutovers FROM PUBLIC')
    await pool.query('GRANT USAGE ON SCHEMA recovery_control TO PUBLIC')
    await assert.rejects(assertStructureContract(pool,contract,[]),/DATA_CONTROL_ACCESS_UNSAFE/)
    await pool.query('REVOKE USAGE ON SCHEMA recovery_control FROM PUBLIC')
    await pool.query('GRANT EXECUTE ON FUNCTION recovery_control.guard_maintenance_record() TO PUBLIC')
    await assert.rejects(assertStructureContract(pool,contract,[]),/DATA_CONTROL_ACCESS_UNSAFE/)
    await pool.query('REVOKE EXECUTE ON FUNCTION recovery_control.guard_maintenance_record() FROM PUBLIC')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DROP TABLE recovery_control.company_data_cutovers')
      await assert.rejects(assertStructureContract(client,contract,[]),/结构契约/)
    } finally { await client.query('ROLLBACK'); client.release() }
    await pool.query('ALTER TABLE public.workflow_events DISABLE TRIGGER company_legacy_snapshot_guard')
    await pool.query("UPDATE public.workflow_events SET reason='owner-bypassed' WHERE id=$1",[eventIds[0]])
    await pool.query('ALTER TABLE public.workflow_events ENABLE TRIGGER company_legacy_snapshot_guard')
    const result=await audit(); assert.equal(result.ready,false); assert.equal(result.companies[0].differences[0].code,'LEGACY_SNAPSHOT_CHANGED')
  })
  report.passed=true
} catch (error) { report.failure=error.message; process.exitCode=1; console.error(error) }
finally {
  try { await pool?.end(); if(created) await admin.query('DROP DATABASE "' + instance.database + '" WITH (FORCE)'); report.cleanup.databaseDropped=true }
  finally { await admin.end(); await instance.stop(); report.cleanup.clusterStopped=true; await writeFile(join(instance.directory,'company-maintenance-report.json'),JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify({ ...report, directory: instance.directory },null,2)) }
}
