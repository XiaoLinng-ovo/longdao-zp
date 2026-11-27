import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { snapshotDigest } from './migration-approval.mjs'
import { PlatformAiMaintenance, PlatformAiStore, EnterpriseAiStore, encryptApiKey } from '../packages/enterprise-ai/index.js'

assert.ok(process.argv[2], 'Explicit isolated PostgreSQL bin directory required')
const instance = await startIsolatedPostgres(process.argv[2])
const require = createRequire(join(projectRoot,'apps/api/package.json')), { Pool } = require('pg')
const admin = new Pool(instance.connection), master = randomBytes(32).toString('base64')
const org = randomUUID(), actor = randomUUID(), outsider = randomUUID(), secret = 'synthetic-legacy-private-secret'
const previous = process.env
process.env = {...instance.env,AI_CONFIG_ENCRYPTION_KEY:master,NODE_ENV:'production',AI_ALLOWED_BASE_URL_ORIGINS:'https://provider.example'}
let pool,tenant,created=false,checks=0
async function check(name, action) { await action(); checks++; console.log('PASS '+name) }
try {
  await admin.query('CREATE DATABASE "'+instance.database+'"'); created=true
  pool = new Pool({...instance.connection,database:instance.database})
  const {runMigrations} = await import(pathToFileURL(join(projectRoot,'apps/api/dist/src/db/migrations.js')))
  await runMigrations(pool,join(projectRoot,'db/migrations'))
  await pool.query("INSERT INTO public.users(id,email,display_name) VALUES($1,'migration@example.invalid','synthetic'),($2,'outsider@example.invalid','synthetic')",[actor,outsider])
  process.env.SYSTEM_ADMIN_USER_NO=(await pool.query('SELECT user_no FROM public.users WHERE id=$1',[actor])).rows[0].user_no
  await pool.query("INSERT INTO public.platform_operators(user_id,role) VALUES($1,'admin')",[actor])
  await pool.query("INSERT INTO public.organizations(id,name,kind,service_status,use_platform_ai,ai_model_source) VALUES($1,'migration-source','test','enabled',true,'platform')",[org])
  await pool.query("INSERT INTO public.organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",[org,actor])
  const schema = (await pool.query('SELECT public.initialize_organization_schema($1) AS name',[org])).rows[0].name
  tenant=new Pool({...instance.connection,database:instance.database,options:'-c search_path='+schema+',public'})
  await tenant.query("INSERT INTO enterprise_ai_settings(organization_id,base_url,api_key_ciphertext,model,updated_by) VALUES($1,'https://provider.example/v1',$2,'model-a',$3)",[org,encryptApiKey(secret,org,master),actor])
  const sourceBefore=(await tenant.query('SELECT * FROM enterprise_ai_settings')).rows[0]
  const store=new PlatformAiMaintenance(pool,master), platform=new PlatformAiStore(pool,master)
  let preview,receipt
  await check('diagnoses saved legacy settings without borrowing them at runtime',async()=>{
    const d=await store.diagnose(org)
    assert.equal(d.source,'platform'); assert.equal(d.errorCode,'PLATFORM_AI_NOT_CONFIGURED')
    assert.equal(d.candidates.length,1);assert.equal(d.candidates[0].decryptable,true)
    assert.equal(JSON.stringify(d).includes(secret),false);assert.equal(JSON.stringify(d).includes(sourceBefore.api_key_ciphertext),false)
    await assert.rejects(new EnterpriseAiStore(tenant,master).runtimeEnv(org),{code:'PLATFORM_AI_NOT_CONFIGURED'})
    preview=d.candidates[0]
    assert.equal(snapshotDigest({preview}),snapshotDigest(JSON.parse(JSON.stringify({preview}))))
  })
  await check('rejects non-operators, stale snapshots, wrong encryption key and private enterprise sources',async()=>{
    await assert.rejects(store.migrate(preview,outsider),{code:'FORBIDDEN'})
    await assert.rejects(store.migrate({...preview,sourceDigest:'0'.repeat(64)},actor),{code:'AI_CONFIGURATION_CHANGED'})
    assert.equal((await new PlatformAiMaintenance(pool,randomBytes(32).toString('base64')).preview(org)).errorCode,'AI_SECRET_DECRYPTION_FAILED')
    await tenant.query('UPDATE enterprise_ai_settings SET self_service_enabled=true')
    await assert.rejects(store.preview(org),{code:'AI_LEGACY_SOURCE_UNAVAILABLE'})
    await tenant.query('UPDATE enterprise_ai_settings SET self_service_enabled=false')
    preview=await store.preview(org)
  })
  await check('audit failure rolls back the entire promotion',async()=>{
    await pool.query(`CREATE FUNCTION public.reject_ai_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='admin.ai_settings.import' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_ai_import BEFORE INSERT ON public.platform_audit_logs FOR EACH ROW EXECUTE FUNCTION public.reject_ai_import()`)
    try {await assert.rejects(store.migrate(preview,actor),/synthetic audit failure/)}
    finally {await pool.query('DROP TRIGGER reject_ai_import ON public.platform_audit_logs; DROP FUNCTION public.reject_ai_import()')}
    assert.equal((await platform.get()).configured,false)
  })
  await check('concurrent imports re-encrypt once, retain source and leave authorizations unchanged',async()=>{
    const before=(await pool.query('SELECT use_platform_ai,ai_model_source,platform_ai_source_organization_id FROM public.organizations WHERE id=$1',[org])).rows[0]
    const receipts=await Promise.all([store.migrate(preview,actor),store.migrate(preview,actor)])
    receipt=receipts.find(row=>row.migrated);assert.ok(receipt);assert.equal(receipts.filter(row=>row.migrated).length,1)
    assert.equal(receipts[0].migrationId,receipts[1].migrationId)
    assert.equal((await platform.runtimeEnv()).OPENAI_API_KEY,secret)
    assert.equal((await new EnterpriseAiStore(tenant,master).runtimeEnv(org)).OPENAI_MODEL,'model-a')
    assert.notEqual((await pool.query('SELECT api_key_ciphertext FROM public.platform_ai_settings')).rows[0].api_key_ciphertext,sourceBefore.api_key_ciphertext)
    assert.deepEqual((await tenant.query('SELECT * FROM enterprise_ai_settings')).rows[0],sourceBefore)
    assert.deepEqual((await pool.query('SELECT use_platform_ai,ai_model_source,platform_ai_source_organization_id FROM public.organizations WHERE id=$1',[org])).rows[0],before)
    assert.equal((await store.diagnose(org)).effective,true)
    const audit=JSON.stringify((await pool.query("SELECT metadata FROM public.platform_audit_logs WHERE action='admin.ai_settings.import'")).rows)
    assert.equal(audit.includes(secret),false);assert.equal(audit.includes(sourceBefore.api_key_ciphertext),false)
  })
  await check('does not overwrite later edits or roll them back',async()=>{
    await platform.save({OPENAI_MODEL:'model-b'},actor)
    await assert.rejects(store.migrate(preview,actor),{code:'AI_CONFIGURATION_CHANGED'})
    await assert.rejects(store.rollback(receipt.migrationId,actor),{code:'AI_CONFIGURATION_CHANGED'})
    assert.equal((await platform.runtimeEnv()).OPENAI_MODEL,'model-b')
  })
  await check('exact-revision rollback preserves original source and audits recovery',async()=>{
    await pool.query('DELETE FROM public.platform_ai_settings')
    preview=await store.preview(org);receipt=await store.migrate(preview,actor)
    await store.rollback(receipt.migrationId,actor)
    assert.equal((await platform.get()).configured,false)
    assert.deepEqual((await tenant.query('SELECT * FROM enterprise_ai_settings')).rows[0],sourceBefore)
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.platform_audit_logs WHERE action='admin.ai_settings.import_rollback'")).rows[0].n,1)
  })
  await check('legacy endpoint correction is explicit and does not weaken the production allowlist',async()=>{
    await tenant.query("UPDATE enterprise_ai_settings SET base_url='https://legacy.invalid/v1'")
    assert.equal((await store.preview(org)).errorCode,'AI_ENDPOINT_NOT_ALLOWED')
    await assert.rejects(store.preview(org,'https://user:secret@provider.example'),{code:'VALIDATION_ERROR'})
    const denied=await store.preview(org,'https://attacker.invalid/v1');assert.equal(denied.canMigrate,false)
    const corrected=await store.preview(org,'https://provider.example/v1')
    assert.equal(corrected.canMigrate,true);assert.equal(corrected.originalBaseUrl,'https://legacy.invalid/v1')
    assert.equal((await store.sourceEnv(org,corrected.sourceDigest,corrected.baseUrl)).OPENAI_API_KEY,secret)
    await store.migrate(corrected,actor)
    assert.equal((await platform.runtimeEnv()).OPENAI_BASE_URL,'https://provider.example/v1')
    assert.equal((await tenant.query('SELECT base_url FROM enterprise_ai_settings')).rows[0].base_url,'https://legacy.invalid/v1')
    assert.equal(process.env.AI_ALLOWED_BASE_URL_ORIGINS,'https://provider.example')
  })
  console.log(JSON.stringify({passed:true,checks,isolated:true}))
} finally {
  await tenant?.end();await pool?.end()
  if(created)await admin.query('DROP DATABASE "'+instance.database+'" WITH (FORCE)')
  await admin.end();await instance.stop();process.env=previous
}
