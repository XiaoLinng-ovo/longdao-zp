import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readRuntimeConfig } from './runtime-config.mjs'
import { preparePrivateRecoveryDirectory, verifyRecoveryPath, writePrivateRecoveryFile } from './private-recovery-files.mjs'
import { snapshotDigest } from './migration-approval.mjs'
import { PlatformAiMaintenance, PlatformAiStore } from '../packages/enterprise-ai/index.js'

const root=resolve(import.meta.dirname,'..'),args=process.argv.slice(2),action=args[0]
const option=name=>{const i=args.indexOf(name);return i<0 ? undefined : args[i+1]}
const profile=readRuntimeConfig(root,{...process.env,...(option('--profile') ? {ENV_FILE_PATH:resolve(option('--profile'))} : {})}).env
const {loadDatabaseConfig}=await import(pathToFileURL(join(root,'apps/api/dist/src/db/config.js')))
const {testAiGeneration}=await import(pathToFileURL(join(root,'apps/api/dist/src/admin/ai-settings.js')))
const {target,...connection}=loadDatabaseConfig(profile)
const {Pool}=createRequire(join(root,'apps/api/package.json'))('pg')
const db=new Pool({...connection,max:2,application_name:'ai-configuration-maintenance',...(action==='preview' ? {options:'-c default_transaction_read_only=on'} : {})})
Object.assign(process.env,profile)
const store=new PlatformAiMaintenance(db,profile.AI_CONFIG_ENCRYPTION_KEY)
const identity=async()=> (await db.query('SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,inet_server_addr()::text AS host,inet_server_port() AS port')).rows[0]
const output=option('--output')
try {
  assert.ok(['preview','apply','rollback'].includes(action),'Use preview, apply or rollback')
  assert.ok(output && isAbsolute(output),'A new absolute --output JSON path is required')
  await preparePrivateRecoveryDirectory(dirname(output))
  if(action==='preview') {
    const preview=await store.preview(option('--organization'),option('--base-url'))
    const plan={format:'ai-configuration-plan/v1',createdAt:new Date().toISOString(),identity:await identity(),preview}
    await writePrivateRecoveryFile(output,JSON.stringify({...plan,sha256:snapshotDigest(plan)},null,2))
    console.log(JSON.stringify({target,output,preview}))
    if(!preview.canMigrate)process.exitCode=1
  } else {
    const file=resolve(option(action==='apply' ? '--plan' : '--receipt') ?? '')
    await verifyRecoveryPath(file)
    const saved=JSON.parse(await readFile(file,'utf8'))
    assert.deepEqual(saved.identity,await identity(),'Database identity differs; no writes performed')
    if(action==='rollback') {
      const result=await store.rollback(saved.receipt.migrationId,option('--actor'),'operator-ai-config-rollback')
      await writePrivateRecoveryFile(output,JSON.stringify({identity:saved.identity,result,at:new Date().toISOString()},null,2))
      console.log(JSON.stringify({target,...result,output}))
    } else {
      const {sha256,...plan}=saved
      assert.equal(sha256,snapshotDigest(plan),'Migration plan changed')
      const age=Date.now()-Date.parse(plan.createdAt)
      assert.ok(age>=0 && age<4*60*60*1000,'Migration plan must be less than four hours old')
      assert.equal(plan.format,'ai-configuration-plan/v1')
      const p=plan.preview,current=await store.preview(p.sourceOrganizationId,p.baseUrl)
      assert.ok(current.canMigrate && current.sourceDigest===p.sourceDigest && current.targetDigest===p.targetDigest,'Configuration changed; preview again')
      const env=await store.sourceEnv(p.sourceOrganizationId,p.sourceDigest,p.baseUrl)
      const probe=await testAiGeneration(env)
      assert.equal(probe.ok,true,'Persisted credentials failed real generation; no writes performed')
      // The retained source is the primary rollback input; also preserve an owner-only encrypted snapshot.
      const source=await store.source(p.sourceOrganizationId)
      await writePrivateRecoveryFile(output+'.before.json',JSON.stringify({identity:plan.identity,source,platform:(await db.query('SELECT * FROM public.platform_ai_settings')).rows},null,2))
      const receipt=await store.migrate(p,option('--actor'),'operator-ai-config-import')
      // Persist the receipt before any post-commit checks so recovery remains available on probe failure.
      await writePrivateRecoveryFile(output,JSON.stringify({format:'ai-configuration-receipt/v1',identity:plan.identity,receipt,probe,at:new Date().toISOString()},null,2))
      const resolved=await store.effectiveEnv(p.sourceOrganizationId)
      assert.equal(resolved.OPENAI_API_KEY,env.OPENAI_API_KEY)
      assert.equal((await new PlatformAiStore(db,profile.AI_CONFIG_ENCRYPTION_KEY).runtimeEnv()).OPENAI_BASE_URL,env.OPENAI_BASE_URL)
      console.log(JSON.stringify({target,receipt,probe,enterpriseResolved:true,output}))
    }
  }
} catch(error) {
  // Do not echo provider errors, database parameters or encrypted snapshots.
  console.error(JSON.stringify({failed:true,code:error.code ?? 'AI_MAINTENANCE_FAILED',reason:error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Maintenance failed; inspect the protected plan and configuration diagnostics'}))
  process.exitCode=1
} finally {await db.end()}
