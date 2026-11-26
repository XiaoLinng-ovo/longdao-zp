import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdir,copyFile } from 'node:fs/promises'
import { listMigrationFiles } from '../packages/database-readiness/index.js'
import { pathToFileURL } from 'node:url'
import { projectRoot as root, startIsolatedPostgres } from './isolated-environment.mjs'
assert.ok(process.argv[2], 'Explicit PostgreSQL bin directory required; no business database fallback')
const instance=await startIsolatedPostgres(process.argv[2])
for(const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env,instance.env,{NODE_ENV:'test'})
const load=file=>import(pathToFileURL(join(root,'apps/api/dist/src',file+'.js')).href)
const require=createRequire(join(root,'apps/api/package.json'))
require(join(root,'scripts/isolated-network-guard.cjs'))
const {Pool}=require('pg')
const options=instance.connection
const database='invitation_verify_'+randomUUID().replaceAll('-','')
const admin=new Pool({...options,database:'postgres',max:1})
let pool,created=false
try {
 assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name,instance.cluster)
 await admin.query('CREATE DATABASE "'+database+'"');created=true
 pool=new Pool({...options,database,max:2})
 const {runMigrations}=await load('db/migrations')
 const migrations=join(root,'db/migrations'),baseline=join(instance.directory,'baseline-migrations')
 await mkdir(baseline)
 for(const migration of await listMigrationFiles(migrations)) if(migration.version<'0109') await copyFile(migration.path,join(baseline,migration.name))
 await runMigrations(pool,baseline)
 const legacyOrg=randomUUID(),legacyUser=randomUUID(),pending=randomUUID(),accepted=randomUUID()
 await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,'legacy@example.invalid','legacy')",[legacyUser])
 await pool.query("INSERT INTO organizations(id,name,kind,created_by) VALUES($1,'legacy-company','test',$2)",[legacyOrg,legacyUser])
 await pool.query("INSERT INTO organization_invitations(id,organization_id,code,email,membership_role,business_role,created_by,expires_at,accepted_at,accepted_by) VALUES ($1,$3,'111111111111111111111111','recipient@example.invalid','admin','recruiter',$4,now()+interval '7 days',NULL,NULL),($2,$3,'222222222222222222222222',NULL,'member','recruiter',$4,now()+interval '7 days',now(),$4)",[pending,accepted,legacyOrg,legacyUser])
 await runMigrations(pool,migrations)
 const legacy=await pool.query('SELECT id,is_shared,revoked_at,accepted_by FROM organization_invitations WHERE id=ANY($1::uuid[])',[[pending,accepted]])
 assert.ok(legacy.rows.every(row=>row.is_shared===false))
 assert.ok(legacy.rows.find(row=>row.id===pending).revoked_at)
 assert.equal(legacy.rows.find(row=>row.id===accepted).accepted_by,legacyUser)
 console.log('PASS legacy single-recipient invitations revoked without changing historical acceptance')
 await pool.end();pool=undefined
 const databaseUrl=new URL('postgresql://localhost')
 databaseUrl.username=options.user
 databaseUrl.password=options.password
 databaseUrl.hostname=options.host
 databaseUrl.port=String(options.port)
 databaseUrl.pathname='/'+database
 const env={...process.env,NODE_ENV:'test',TENANT_SCHEMA_ROUTING:'on',INVITATION_TEST_DATABASE:database,PGDATABASE:database,
  DATABASE_URL:databaseUrl.href}
 const code=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--require',join(root,'scripts/isolated-network-guard.cjs'),'--test',join(root,'apps/api/dist/tests/workspace-invitations.postgres.integration.test.js')],{cwd:root,env,stdio:'inherit',windowsHide:true,timeout:180000})
  child.on('error',reject);child.on('close',resolve)
 })
 if(code!==0)process.exitCode=1
} finally {
 try {
  if(pool)await pool.end()
  if(created) {await admin.query('DROP DATABASE "'+database+'" WITH (FORCE)');console.log('Removed isolated invitation test database')}
 } finally {await admin.end();await instance.stop()}
}
