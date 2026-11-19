import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readdir, readFile, writeFile, cp, rm, lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createSyntheticKeyRecovery } from './verify-synthetic-key-recovery.mjs'
import { isolatedEnvironment, projectRoot } from './isolated-environment.mjs'

const run=promisify(execFile)
const digest=data=>createHash('sha256').update(data).digest('hex')
export function matchesPostgresDataDirectory(hex,expected,platform=process.platform) {
  if(typeof hex!=='string' || !/^(?:[a-f0-9]{2})+$/.test(hex)) return false
  // Windows PostgreSQL may expose its native ANSI path bytes even with a UTF-8 database.
  // Compare losslessly decoded paths, never a replacement-character or fuzzy match.
  for(const encoding of platform==='win32'?['utf-8','gb18030']:['utf-8']) {
    try { if(resolve(new TextDecoder(encoding,{fatal:true}).decode(Buffer.from(hex,'hex')))===resolve(expected))return true }
    catch {}
  }
  return false
}
export async function files(directory,prefix='') {
  assert.ok((await lstat(join(directory,prefix))).isDirectory(), '备份根目录不能是符号链接或特殊文件')
  const rows=[]
  for(const entry of await readdir(join(directory,prefix),{withFileTypes:true})) {
    const key=join(prefix,entry.name)
    if(entry.isDirectory())rows.push(...await files(directory,key))
    else if(entry.isFile()) rows.push({key,hash:digest(await readFile(join(directory,key)))})
    else throw Error('备份不接受符号链接或特殊文件')
  }
  return rows.sort((a,b)=>a.key.localeCompare(b.key))
}
async function snapshot(pool) {
  const tables=await pool.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname='public' OR schemaname ~ '^company_[a-f0-9]{32}$' ORDER BY schemaname,tablename")
  const rows=[]
  for(const table of tables.rows) {
    const quote=value=>'"'+value.replaceAll('"','""')+'"'
    const result=await pool.query('SELECT to_jsonb(t)::text AS body FROM '+quote(table.schemaname)+'.'+quote(table.tablename)+' t ORDER BY to_jsonb(t)::text')
    rows.push({table:table.schemaname+'.'+table.tablename,count:result.rows.length,hash:digest(result.rows.map(row=>row.body).join('\n'))})
  }
  return rows
}
export async function assertBackupIsolation({pool,admin,options,database,directory,storageRoot,interviewStorageRoot,isolation,postgresBin}) {
  assert.match(database,/^closure_verify_[a-f0-9]{32}$/, '备份只接受专用 closure_verify 数据库')
  assert.ok(isolation, '备份必须提供专用集群所有权信息')
  assert.ok(isAbsolute(postgresBin ?? ''), '备份必须显式指定 PostgreSQL 工具绝对目录')
  assert.equal(database,isolation.database)
  assert.equal(resolve(directory),resolve(isolation.directory))
  assert.equal(dirname(resolve(directory)),join(projectRoot,'tmp'))
  assert.equal(basename(directory),database)
  assert.equal(await realpath(directory),resolve(directory), '备份目录不能经过符号链接')
  assert.ok((await lstat(join(directory,'owner.json'))).isFile(), '集群所有权文件不能是符号链接')
  const owner=JSON.parse(await readFile(join(directory,'owner.json'),'utf8'))
  assert.equal(owner.purpose,'isolated-acceptance')
  assert.equal(owner.pid,process.pid)
  assert.equal(owner.cluster,isolation.cluster)
  assert.equal(owner.cluster,'closure_'+database.slice('closure_verify_'.length))
  assert.equal(options.host,'127.0.0.1')
  assert.equal(options.port,isolation.port)
  assert.equal(options.user,'closure_owner')
  assert.ok(!options.connectionString, '备份禁止覆盖连接身份')
  assert.ok(options.password === isolation.connection.password, '备份连接必须属于专用集群')
  assert.equal(resolve(isolation.data),join(resolve(directory),'postgres-data'))
  assert.equal(await realpath(isolation.data),resolve(isolation.data))
  assert.equal(resolve(storageRoot),join(resolve(directory),'storage'))
  assert.equal(await realpath(storageRoot),resolve(storageRoot), '对象目录不能经过符号链接')
  if(interviewStorageRoot !== undefined) {
    assert.equal(resolve(interviewStorageRoot),join(resolve(directory),'interviews'))
    assert.equal(await realpath(interviewStorageRoot),resolve(interviewStorageRoot), '录音目录不能经过符号链接')
    await files(interviewStorageRoot)
  }
  const identitySql=`SELECT current_database() AS database,current_user AS role,current_setting('cluster_name') AS cluster,
    encode(pg_catalog.textsend(current_setting('data_directory')),'hex') AS data_hex,
    host(inet_server_addr()) AS host,inet_server_port() AS port`
  for(const [connection,expected] of [[pool,database],[admin,'postgres']]) {
    const identity=(await connection.query(identitySql)).rows[0]
    assert.equal(identity.database,expected)
    assert.equal(identity.role,'closure_owner')
    assert.equal(identity.cluster,owner.cluster)
    assert.ok(matchesPostgresDataDirectory(identity.data_hex,isolation.data), '数据库实际数据目录与专用目录不匹配')
    assert.equal(identity.host,'127.0.0.1')
    assert.equal(identity.port,isolation.port)
  }
  // Validate the complete object tree before creating any backup or restore output.
  await files(storageRoot)
}
export async function sharedInterviewInventory(pool, objects) {
  const index=new Map(objects.map(object=>[object.key.replaceAll('\\','/'),object]))
  const keys=(await pool.query(`SELECT COALESCE(physical_key,storage_key) AS key
    FROM public.interview_stored_objects ORDER BY 1`)).rows.map(row=>row.key)
  assert.ok(keys.length>0, '完整业务恢复必须有真实录音对象')
  assert.equal(new Set(keys).size,keys.length,'录音物理键不能重复')
  return keys.map(key=>{
    const object=index.get(key)
    assert.ok(object,'共享对象目录缺少数据库已登记的录音文件')
    return {...object,key}
  })
}
export async function verifyIsolatedBackup({pool,admin,Pool,options,database,directory,storageRoot,interviewStorageRoot,sharedInterviewStorage=false,companies,report,isolation,postgresBin,verifyRestored}) {
  assert.ok(!sharedInterviewStorage || interviewStorageRoot===undefined, '共享与独立录音备份模式不能并用')
  await assertBackupIsolation({pool,admin,options,database,directory,storageRoot,interviewStorageRoot,isolation,postgresBin})
  assert.ok(companies.length>0, '备份必须包含公司数据')
  const backup=join(directory,'backup'),restored=join(directory,'restored')
  await mkdir(backup,{recursive:false});await mkdir(restored,{recursive:false})
  const target='restore_verify_'+randomUUID().replaceAll('-','')
  const env=isolatedEnvironment({PGHOST:options.host,PGPORT:String(options.port),PGUSER:options.user,PGPASSWORD:options.password,PGDATABASE:database,PGOPTIONS:''})
  const executable=name=>join(postgresBin,name+(process.platform==='win32'?'.exe':''))
  const before=await snapshot(pool),started=Date.now()
  const recovery=createSyntheticKeyRecovery(companies[0].id)
  const config={synthetic:true,tenantRouting:'on',storage:{kind:'local',relativeRoot:'objects',...(sharedInterviewStorage?{interviewRelativeRoot:'objects'}:interviewStorageRoot?{interviewRelativeRoot:'interviews'}:{})},companies:companies.map(company=>({id:company.id,schema:company.schema})),credentialsIncluded:false,syntheticEncryptedSetting:recovery.fixture}
  await writeFile(join(backup,'config.json'),JSON.stringify(config,null,2),{flag:'wx'})
  await cp(storageRoot,join(backup,'objects'),{recursive:true,errorOnExist:true,force:false})
  if(interviewStorageRoot) await cp(interviewStorageRoot,join(backup,'interviews'),{recursive:true,errorOnExist:true,force:false})
  await run(executable('pg_dump'),['--no-password','--format=custom','--file',join(backup,'database.dump'),'--dbname',database],{env,windowsHide:true,timeout:120000})
  let created=false,restoredPool
  try {
    await admin.query('CREATE DATABASE "'+target+'"');created=true
    await run(executable('pg_restore'),['--no-password','--exit-on-error','--no-owner','--no-acl','--dbname',target,join(backup,'database.dump')],{env,windowsHide:true,timeout:120000})
    restoredPool=new Pool({...options,database:target,max:2})
    assert.deepEqual(await snapshot(restoredPool),before)
    await cp(join(backup,'objects'),join(restored,'objects'),{recursive:true,errorOnExist:true,force:false})
    await cp(join(backup,'config.json'),join(restored,'config.json'),{errorOnExist:true,force:false})
    const objects=await files(storageRoot)
    const restoredObjects=await files(join(restored,'objects'))
    assert.deepEqual(restoredObjects,objects)
    const interviewObjects=sharedInterviewStorage?await sharedInterviewInventory(pool,objects):interviewStorageRoot?await files(interviewStorageRoot):[]
    if(sharedInterviewStorage) assert.deepEqual(await sharedInterviewInventory(restoredPool,restoredObjects),interviewObjects)
    if(interviewStorageRoot) {
      await cp(join(backup,'interviews'),join(restored,'interviews'),{recursive:true,errorOnExist:true,force:false})
      assert.deepEqual(await files(join(restored,'interviews')),interviewObjects)
    }
    const restoredConfig=JSON.parse(await readFile(join(restored,'config.json'),'utf8'))
    assert.deepEqual(restoredConfig,config)
    report.checks.syntheticKeyRecovery=recovery.verify(restoredConfig.syntheticEncryptedSetting)
    if(verifyRestored) report.checks.restoredValidation=await verifyRestored({pool:restoredPool,database:target,storageRoot:join(restored,'objects'),interviewObjects})
    await writeFile(join(backup,'manifest.json'),JSON.stringify({tables:before,objects,interviewObjects,configHash:digest(await readFile(join(backup,'config.json')))},null,2),{flag:'wx'})
    report.checks.backupRestore={tables:before.length,rows:before.reduce((sum,row)=>sum+row.count,0),objects:objects.length,interviewObjects:interviewObjects.length,interviewStorageIncluded:sharedInterviewStorage||Boolean(interviewStorageRoot),sharedInterviewStorage,durationMs:Date.now()-started,databaseHashesMatched:true,objectHashesMatched:true,configurationMatched:true,syntheticOnly:true}
  } finally {
    await restoredPool?.end()
    if(created){assert.match(target,/^restore_verify_[a-f0-9]{32}$/);await admin.query('DROP DATABASE "'+target+'" WITH (FORCE)')}
    // Only the newly created restore tree is removed; the synthetic backup and manifest remain as evidence.
    assert.equal(await realpath(restored),join(await realpath(directory),'restored'));await rm(restored,{recursive:true,force:true})
  }
}
