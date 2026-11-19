import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, access, symlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { files, verifyIsolatedBackup, assertBackupIsolation, matchesPostgresDataDirectory, sharedInterviewInventory } from '../verify-isolated-backup.mjs'
import { projectRoot } from '../isolated-environment.mjs'

test('backup manifest hashes nested object paths without recursing the root again',async()=>{
  const root=await mkdtemp(join(tmpdir(),'recruitment-backup-test-'))
  try {
    await mkdir(join(root,'interviews','session'),{recursive:true})
    await writeFile(join(root,'resume.txt'),'resume')
    await writeFile(join(root,'interviews','session','audio.wav'),'audio')
    const rows=await files(root)
    assert.deepEqual(rows.map(row=>row.key).sort(),[join('interviews','session','audio.wav'),'resume.txt'].sort())
    assert.ok(rows.every(row=>/^[a-f0-9]{64}$/.test(row.hash)))
  } finally { await rm(root,{recursive:true,force:true}) }
})
test('backup verification refuses business database names before using any resources',async()=>{
  for(const database of ['postgres','business','schema_verify_unsafe']) {
    await assert.rejects(verifyIsolatedBackup({database}),/closure_verify/)
  }
})
test('a random database name alone never authorizes a backup',async()=>{
  await assert.rejects(verifyIsolatedBackup({database:'closure_verify_'+'a'.repeat(32)}),/所有权/)
})
async function fixture(action) {
  const suffix=randomUUID().replaceAll('-',''),database='closure_verify_'+suffix
  const directory=join(projectRoot,'tmp',database),data=join(directory,'postgres-data'),storageRoot=join(directory,'storage')
  await mkdir(directory)
  try {
    await mkdir(data);await mkdir(storageRoot)
    const owner={cluster:'closure_'+suffix,purpose:'isolated-acceptance',pid:process.pid}
    const ownerPath=join(directory,'owner.json')
    await writeFile(ownerPath,JSON.stringify(owner))
    const options={host:'127.0.0.1',port:32491,user:'closure_owner',password:randomUUID()}
    const identity={role:'closure_owner',cluster:owner.cluster,data_hex:Buffer.from(data).toString('hex'),host:'127.0.0.1',port:options.port}
    const statements=[]
    const connection=db=>({query:async sql=>{statements.push(sql);return {rows:[{...identity,database:db}]}}})
    const input={database,directory,storageRoot,options,postgresBin:projectRoot,pool:connection(database),admin:connection('postgres'),
      isolation:{database,directory,data,cluster:owner.cluster,port:options.port,connection:options}}
    await action({input,identity,statements,owner,ownerPath})
  } finally {
    assert.equal(directory,join(projectRoot,'tmp',database));await rm(directory,{recursive:true,force:true})
  }
}
test('backup ownership validation only reads identities and creates no output',()=>fixture(async({input,statements})=>{
  await assertBackupIsolation(input)
  assert.equal(statements.length,2)
  assert.ok(statements.every(sql=>sql.startsWith('SELECT current_database()')))
  await assert.rejects(access(join(input.directory,'backup')), {code:'ENOENT'})
  await assert.rejects(access(join(input.directory,'restored')), {code:'ENOENT'})
}))
test('owner mismatch is rejected before contacting a database',()=>fixture(async({input,statements,owner,ownerPath})=>{
  for(const changed of [{pid:process.pid+1},{purpose:'business'},{cluster:'business'}]) {
    await writeFile(ownerPath,JSON.stringify({...owner,...changed}))
    await assert.rejects(assertBackupIsolation(input))
    assert.equal(statements.length,0)
  }
}))
test('actual connection identity mismatches fail closed before any backup',()=>fixture(async({input,identity})=>{
  for(const changed of [{role:'business_owner'},{cluster:'business'},{data_hex:Buffer.from(projectRoot).toString('hex')},{host:'::1'},{port:1}]) {
    const original={...identity};Object.assign(identity,changed)
    await assert.rejects(assertBackupIsolation(input))
    Object.assign(identity,original)
  }
  await assert.rejects(assertBackupIsolation({...input,pool:input.admin}))
  await assert.rejects(assertBackupIsolation({...input,admin:input.pool}))
  await assert.rejects(access(join(input.directory,'backup')), {code:'ENOENT'})
}))
test('connection and object paths cannot escape the owned cluster',()=>fixture(async({input,statements})=>{
  for(const changed of [
    {options:{...input.options,host:'localhost'}}, {options:{...input.options,connectionString:'postgres://example.invalid/business'}},
    {options:{...input.options,password:'different'}}, {storageRoot:projectRoot}, {postgresBin:'.'},
  ]) await assert.rejects(assertBackupIsolation({...input,...changed}))
  assert.equal(statements.length,0)
}))
test('object tree rejects directory junctions rather than copying outside files',()=>fixture(async({input})=>{
  const link=join(input.storageRoot,'outside')
  await symlink(input.isolation.data,link,process.platform==='win32'?'junction':'dir')
  await assert.rejects(files(input.storageRoot),/符号链接/)
  await assert.rejects(assertBackupIsolation(input),/符号链接/)
  await assert.rejects(access(join(input.directory,'backup')), {code:'ENOENT'})
}))
test('录音根只能使用本轮独立目录，并拒绝缺失目录或目录联接',()=>fixture(async({input,statements})=>{
  for(const interviewStorageRoot of [projectRoot,input.storageRoot,join(input.directory,'missing')]) {
    await assert.rejects(assertBackupIsolation({...input,interviewStorageRoot}))
    assert.equal(statements.length,0)
  }
  const root=join(input.directory,'interviews')
  await mkdir(root)
  await writeFile(join(root,'synthetic.webm'),'audio')
  await assertBackupIsolation({...input,interviewStorageRoot:root})
  await symlink(input.isolation.data,join(root,'outside'),process.platform==='win32'?'junction':'dir')
  await assert.rejects(assertBackupIsolation({...input,interviewStorageRoot:root}),/符号链接/)
}))
test('existing evidence is never overwritten',()=>fixture(async({input})=>{
  const backup=join(input.directory,'backup');await mkdir(backup)
  await writeFile(join(backup,'sentinel'),'unchanged')
  await assert.rejects(verifyIsolatedBackup({...input,companies:[{id:randomUUID()}]}), {code:'EEXIST'})
  await assert.rejects(access(join(input.directory,'restored')), {code:'ENOENT'})
}))
test('共享对象目录按数据库物理键单独核对录音，不把简历计入录音', async()=>{
  const objects=[{key:'resume.txt',hash:'resume'},{key:join('interviews','session','audio.wav'),hash:'audio'}]
  const database=keys=>({async query(sql){
    assert.match(sql, /COALESCE\(physical_key,storage_key\)/)
    return {rows:keys.map(key=>({key}))}
  }})
  const key='interviews/session/audio.wav'
  assert.deepEqual(await sharedInterviewInventory(database([key]),objects),[{key,hash:'audio'}])
  await assert.rejects(sharedInterviewInventory(database([]),objects),/必须有真实录音/)
  await assert.rejects(sharedInterviewInventory(database(['missing']),objects),/缺少数据库已登记/)
  await assert.rejects(sharedInterviewInventory(database([key,key]),objects),/物理键不能重复/)
})
test('native Windows path bytes are decoded exactly, not fuzzily matched',()=>{
  const utf8=Buffer.from('D:/中/data').toString('hex')
  const gbk=Buffer.concat([Buffer.from('D:/'),Buffer.from('d6d0','hex'),Buffer.from('/data')]).toString('hex')
  assert.equal(matchesPostgresDataDirectory(utf8,'D:/中/data','win32'),true)
  assert.equal(matchesPostgresDataDirectory(gbk,'D:/中/data','win32'),true)
  assert.equal(matchesPostgresDataDirectory(gbk,'D:/中/data','linux'),false)
  for(const bad of [gbk,utf8,'ff','xyz','',null]) assert.equal(matchesPostgresDataDirectory(bad,'D:/other/data','win32'),false)
})
