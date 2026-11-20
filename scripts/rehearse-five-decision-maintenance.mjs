import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { buildConflictPlan, executeConflictPlan, validateConflictPlan } from './company-conflict-repair.mjs'
import { buildCompanyPlan, executeCompanyPlan } from './company-data-maintenance.mjs'
import { protectRecoveryPath, verifyRecoveryPath, writePrivateRecoveryFile } from './private-recovery-files.mjs'
import { captureMigrationBaseline, fingerprintTables, verifyTableFingerprints, verifyRecoveryMigrationScope, verifyMigratedRecoverySnapshot } from './recovery-snapshot.mjs'
import { listMigrationFiles } from '../packages/database-readiness/index.js'
import { assertStructureContract, readStructureContract } from '../packages/database-readiness/structure-contract.js'

// Only restores an explicit backup into a new private cluster. No business connection or production approvals.
const [directory,binaries,clusterParent,candidate] = process.argv.slice(2)
assert.ok(isAbsolute(directory || '') && isAbsolute(binaries || ''),'Explicit absolute backup and PostgreSQL tool paths required')
if (clusterParent) await verifyRecoveryPath(clusterParent)
if (candidate) assert.ok(isAbsolute(candidate),'Candidate path must be absolute')
await verifyRecoveryPath(directory)
const previous = JSON.parse(await readFile(join(directory,'rehearsal-report.json'),'utf8'))
assert.equal(previous.snapshotRestoreVerified,true)
const dump = join(directory,'database.dump'), digest = createHash('sha256')
await verifyRecoveryPath(dump)
for await (const bytes of createReadStream(dump)) digest.update(bytes)
assert.equal(digest.digest('hex'),previous.dumpSha256)
const original = JSON.parse(await readFile(join(directory,'table-fingerprints.json'),'utf8'))
const report = {format:'five-decision-maintenance-rehearsal/v1',startedAt:new Date().toISOString(),dumpSha256:previous.dumpSha256,
  passed:false,businessDatabaseWritten:false,businessRecoveryVerified:false,sourceConnectionUsed:false,syntheticApprovalOnly:true,checks:[],cleanup:{}}
const output = join(directory,'formal-five-decisions-clone-' + randomUUID() + '.json')
const instance = await startIsolatedPostgres(binaries,clusterParent ? {directoryParent:clusterParent} : {})
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env,instance.env)
const require = createRequire(join(projectRoot,'apps/api/package.json'))
require(join(projectRoot,'scripts/isolated-network-guard.cjs'))
const { Pool } = require('pg'), admin = new Pool(instance.connection)
const execute = promisify(execFile), org = 'abb8445c-d068-47ee-b2f0-45010a886629', schema = 'company_' + org.replaceAll('-','')
const context = {backupSha256:previous.dumpSha256,purpose:'isolated-rehearsal-only-not-production-approval'}
let pool, contract, plan
let cliPlanPath, cliPlanHash
async function candidateCli(action,extra=[]) {
  try {
    const {stdout}=await execute(process.execPath,[join(candidate,'scripts/maintenance-five-decisions.mjs'),action,
      '--profile',instance.env.ENV_FILE_PATH,'--backup',dump,'--organization',org,'--release',candidate,'--plan',cliPlanPath,...extra],
      {env:{...instance.env,NODE_OPTIONS:'--require='+JSON.stringify(join(projectRoot,'scripts/isolated-network-guard.cjs'))},windowsHide:true,timeout:600000,maxBuffer:1024*1024})
    return JSON.parse(stdout)
  } catch(error) {
    const code=error.stderr?.trim()
    throw Error(/^REPAIR_[A-Z_]+$/.test(code || '')?code:'ISOLATED_CANDIDATE_CLI_FAILED')
  }
}
const q = table => '"' + schema + '"."' + table + '"'
async function check(name,action) { report.stage=name;console.log('CHECK ' + name);await action();report.checks.push(name) }
function approve(p) {
  p.approval = {reviewedBy:'synthetic-isolated-rehearsal-only',snapshotSha256:p.snapshotSha256,approvedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),
    evidenceReferences:Object.fromEntries(['writersDrained','backupRestored','objectsReviewed','configReviewed','rehearsalPassed'].map(name=>[name,'synthetic-isolated-only-'+name]))}
  return p
}
const build = () => buildConflictPlan(pool,{organizationId:org,context,contract})
const apply = (p=plan,extra={}) => executeConflictPlan(pool,p,{apply:true,contract,...extra})
async function unchanged() { verifyTableFingerprints(plan.snapshot.tables,await fingerprintTables(pool)) }
function intercept(handler) {
  return { async connect() { const client=await pool.connect();return {query:(sql,args)=>handler(client,sql,args),release:broken=>client.release(broken)} } }
}
try {
  await protectRecoveryPath(instance.directory)
  report.isolatedDirectory=instance.directory
  assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name,instance.cluster)
  await admin.query('CREATE DATABASE "' + instance.database + '"')
  await check('restore verified backup without business connection',async()=>{
    await execute(join(binaries,'pg_restore'+(process.platform==='win32'?'.exe':'')),['--no-password','--no-owner','--no-acl','--no-tablespaces','--exit-on-error','--single-transaction','--dbname='+instance.database,dump],
      {env:{...instance.env,PGOPTIONS:'-c timezone=UTC'},windowsHide:true,timeout:600000,maxBuffer:1024*1024})
    pool=new Pool({...instance.connection,database:instance.database,max:3,options:'-c timezone=UTC -c search_path=public -c statement_timeout=60s -c lock_timeout=5s'})
    verifyTableFingerprints(original,await fingerprintTables(pool))
  })
  await check('0101-0104 migrate first with old business fields unchanged',async()=>{
    const {inspectMigrationApproval,runMigrations}=await import(pathToFileURL(join(projectRoot,'apps/api/dist/src/db/migrations.js')).href)
    const migrations=join(projectRoot,'db/migrations'),approval=await inspectMigrationApproval(pool,migrations)
    verifyRecoveryMigrationScope(approval)
    const baseline=await captureMigrationBaseline(pool)
    contract=await readStructureContract(await listMigrationFiles(migrations))
    report.stage='execute approved clone migrations'
    report.migrations=(await runMigrations(pool,migrations,{approval})).applied
    report.stage='verify full migrated clone snapshot'
    report.migrationDataChecks=await verifyMigratedRecoverySnapshot(pool,baseline,original,contract)
  })
  await check('clone-only timestamp precision probe',async()=>{
    const client=await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('ALTER TABLE '+q('offer_templates')+' DISABLE TRIGGER offer_templates_set_updated_at')
      const changed=await client.query('UPDATE '+q('offer_templates')+' c SET updated_at=GREATEST(c.updated_at,s.updated_at)+interval \'1 microsecond\' FROM public.offer_templates s WHERE c.id=s.id AND c.updated_at IS DISTINCT FROM s.updated_at')
      assert.equal(changed.rowCount,1)
      await client.query('ALTER TABLE '+q('offer_templates')+' ENABLE TRIGGER offer_templates_set_updated_at')
      await client.query('COMMIT')
      report.cloneOnlyTimestampProbe=true
    }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  })
  await check('plan binds five rows, six missing dependencies and twenty-three exact remaining differences',async()=>{
    if(candidate) {
      await protectRecoveryPath(instance.env.ENV_FILE_PATH)
      cliPlanPath=join(instance.directory,'candidate-unapproved-plan.json')
      const generated=await candidateCli('plan')
      assert.equal(generated.readOnly,true);assert.equal(generated.approvalRequired,true)
      plan=JSON.parse(await readFile(cliPlanPath,'utf8'))
    } else plan=await build()
    assert.equal(plan.approval,null)
    assert.equal(plan.snapshot.entries.length,5);assert.equal(plan.snapshot.dependencies.filter(row=>row.targetHash===null).length,6)
    assert.equal(plan.snapshot.remaining.length,23);assert.equal(plan.snapshot.offerContentVersion,6)
    await assert.rejects(apply(),/REPAIR_APPROVAL_REQUIRED/)
    approve(plan);validateConflictPlan(plan)
    if(candidate) {
      cliPlanPath=join(instance.directory,'candidate-synthetic-approved-plan.json')
      const bytes=JSON.stringify(plan,null,2)+'\n'
      await writePrivateRecoveryFile(cliPlanPath,bytes)
      cliPlanHash=createHash('sha256').update(bytes).digest('hex')
      assert.equal((await candidateCli('check',['--sha256',cliPlanHash])).readOnly,true)
      await assert.rejects(candidateCli('check',['--sha256','0'.repeat(64)]),/REPAIR_PLAN_FILE_CHANGED/)
      report.candidateCli={candidate,planPassed:true,checkPassed:true,tamperedFileRejected:true,syntheticApprovalOnly:true}
    }
    assert.equal((await executeConflictPlan(pool,plan,{contract})).readOnly,true)
    await unchanged()
  })
  await check('snapshot drift refuses before writes',async()=>{
    const changed=structuredClone(plan);changed.snapshot.identity.database='different-clone'
    const {snapshotDigest}=await import('./migration-approval.mjs')
    changed.snapshotSha256=snapshotDigest({format:changed.format,createdAt:changed.createdAt,snapshot:changed.snapshot,context:changed.context});approve(changed)
    await assert.rejects(apply(changed),/REPAIR_SNAPSHOT_CHANGED/);await unchanged()
  })
  await check('failure on third row update rolls back dependencies, rows and triggers',async()=>{
    let updates=0
    const failing=intercept((client,sql,args)=>{if(sql.startsWith('UPDATE "'+schema+'".')&&++updates===3)throw Error('SYNTHETIC_THIRD_UPDATE_FAILURE');return client.query(sql,args)})
    await assert.rejects(executeConflictPlan(failing,plan,{apply:true,contract}),/SYNTHETIC_THIRD_UPDATE_FAILURE/)
    assert.equal(updates,3);await unchanged();await assertStructureContract(pool,contract,[{organization_id:org,schema_name:schema}])
  })
  await check('maintenance lock and active writer refuse without partial writes',async()=>{
    const holder=await pool.connect()
    try {
      await holder.query('BEGIN');await holder.query("SELECT pg_advisory_xact_lock(hashtext('smartrecruit:company-data-maintenance'))")
      await assert.rejects(apply(),/REPAIR_MAINTENANCE_BUSY/);await holder.query('ROLLBACK')
      await holder.query('BEGIN');await holder.query('LOCK TABLE '+q('offers')+' IN ROW EXCLUSIVE MODE')
      await assert.rejects(apply(),/lock timeout/)
    }finally{await holder.query('ROLLBACK');holder.release()}
    await unchanged()
  })
  await check('expiry after receipt insert rolls back all data and receipt',async()=>{
    let expired=false
    const expiring=intercept(async(client,sql,args)=>{const result=await client.query(sql,args);if(sql.startsWith('INSERT INTO recovery_control.maintenance_receipts'))expired=true;return result})
    await assert.rejects(executeConflictPlan(expiring,plan,{apply:true,contract,clock:()=>expired?new Date(plan.approval.expiresAt):new Date()}),/REPAIR_APPROVAL_WINDOW_INVALID/)
    assert.equal(expired,true);await unchanged()
  })
  await check('apply updates exactly approved rows and dependencies plus one immutable receipt',async()=>{
    report.result=candidate?await candidateCli('apply',['--sha256',cliPlanHash]):await apply()
    if(candidate) {
      report.candidateCli.applyPassed=true
      await assert.rejects(candidateCli('apply',['--sha256',cliPlanHash]),/REPAIR_ALREADY_RECORDED/)
      report.candidateCli.retryRefused=true
    }
    assert.equal(report.result.repaired,5);assert.equal(report.result.dependenciesCopied,6);assert.equal(report.result.remainingDifferences,23)
    assert.equal(report.result.preservedTimestampDifferences.length,1)
    assert.equal(report.result.preservedTimestampDifferences[0].table,'offer_templates')
    const current=await fingerprintTables(pool),withoutReceipt=rows=>rows.filter(row=>row.schema!=='recovery_control'||row.name!=='maintenance_receipts')
    verifyTableFingerprints(withoutReceipt(plan.snapshot.expectedTables),withoutReceipt(current))
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM recovery_control.maintenance_receipts')).rows[0].n,1)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM recovery_control.company_data_cutovers')).rows[0].n,0)
    const timestamp=await pool.query('SELECT c.updated_at>s.updated_at AS later,extract(microseconds FROM c.updated_at)::int%1000<>0 AS precise FROM '+q('offer_templates')+' c JOIN public.offer_templates s USING(id) WHERE c.id=$1',[plan.snapshot.entries.find(row=>row.table==='offer_templates').id])
    assert.equal(timestamp.rows[0].later,true);assert.equal(timestamp.rows[0].precise,true)
    await assert.rejects(apply(),/REPAIR_ALREADY_RECORDED/)
    await assert.rejects(pool.query('UPDATE recovery_control.maintenance_receipts SET approved_by=approved_by'),/MAINTENANCE_RECORD_IMMUTABLE/)
  })
  await check('later reconcile preserves approved timestamp and imports nine original events without replay',async()=>{
    const next=approve(await buildCompanyPlan(pool,{organizationId:org,intent:'reconcile',context,contract}))
    assert.equal(next.snapshot.entries.length,23);assert.equal(next.snapshot.approvedTimestampPreservations.length,1)
    assert.equal((await executeCompanyPlan(pool,next,{contract})).readOnly,true)
    const result=await executeCompanyPlan(pool,next,{apply:true,contract})
    assert.equal(result.copied,9);assert.equal(result.preserved,14);assert.equal(result.preservedApprovedTimestamps,1)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM recovery_control.company_data_cutovers')).rows[0].n,0)
    report.followupReconcile=result
  })
  await check('historical completed session retains real sixty-nine unresolved roles',async()=>{
    const {LiveInterviewSessionRepository}=await import(pathToFileURL(join(projectRoot,'apps/api/dist/src/interviews/live-session-repository.js')).href)
    const client=await pool.connect()
    try {
      await client.query('SET search_path="'+schema+'",public')
      const view=await new LiveInterviewSessionRepository(client).get(plan.snapshot.entries.find(row=>row.table==='interview_live_sessions').id)
      assert.equal(view.session.status,'completed');assert.equal(view.completionReview.phase,'completed');assert.equal(view.completionReview.unresolvedCount,69)
      assert.equal(view.completionReview.versionId,plan.snapshot.correctedVersionId)
      report.historicalReview={completedPreserved:true,unresolvedCount:69,noHumanConfirmationsFabricated:true}
    }finally{await client.query('SET search_path=pg_catalog,public');client.release()}
  })
  report.passed=true
}catch(error){
  report.failure={code:typeof error.code==='string'?error.code:/^(REPAIR|MIGRATION)_[A-Z_]+/.exec(error.message || '')?.[0] || 'ISOLATED_VERIFICATION_FAILED'}
  if (error.code === 'ERR_ASSERTION') {
    report.failure.operator=error.operator
    if(error.actual instanceof Error) report.failure.actualCode=typeof error.actual.code==='string'?error.actual.code:/^[A-Z][A-Z_]+/.exec(error.actual.message || '')?.[0] || 'REDACTED_ERROR'
  }
}finally{
  try{await pool?.end();report.cleanup.cloneClosed=true}catch{report.cleanup.cloneClosed=false;report.passed=false}
  try{await admin.end();report.cleanup.adminClosed=true}catch{report.cleanup.adminClosed=false;report.passed=false}
  try{await instance.stop();report.cleanup.postgresStopped=true}catch{report.cleanup.postgresStopped=false;report.passed=false}
  report.finishedAt=new Date().toISOString()
  await writePrivateRecoveryFile(output,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({passed:report.passed,checks:report.checks,stage:report.stage,failure:report.failure,businessDatabaseWritten:false,businessRecoveryVerified:false,cleanup:report.cleanup,output},null,2))
  if(!report.passed)process.exitCode=1
}
