import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { verifyIsolatedBackup } from './verify-isolated-backup.mjs'
import { testCodeFingerprint } from './test-code-fingerprint.mjs'

const argument=process.argv.indexOf('--postgres-bin')
assert.ok(argument>=0 && process.argv[argument+1], '必须显式指定专用 PostgreSQL 工具目录')
const fingerprint=await testCodeFingerprint(projectRoot)
const instance=await startIsolatedPostgres(process.argv[argument+1])
for(const key of Object.keys(process.env))delete process.env[key]
Object.assign(process.env,instance.env)
const require=createRequire(join(projectRoot,'apps/api/package.json'))
require(join(projectRoot,'scripts/isolated-network-guard.cjs'))
const {Pool}=require('pg'),admin=new Pool(instance.connection)
const report={startedAt:new Date().toISOString(),checks:{},failures:[],cleanup:{},codeFingerprint:fingerprint.sha256,
  boundary:'仅使用专用随机集群和合成表、文件、配置；这不是浏览器全业务备份恢复验收'}
let pool,created=false
try {
  await admin.query('CREATE DATABASE "'+instance.database+'"');created=true
  pool=new Pool({...instance.connection,database:instance.database})
  await pool.query('CREATE TABLE public.synthetic_backup(id uuid PRIMARY KEY, value text)')
  await pool.query('INSERT INTO public.synthetic_backup VALUES($1,$2)',[randomUUID(),'合成备份内容'])
  await mkdir(join(instance.directory,'storage'))
  await writeFile(join(instance.directory,'storage','synthetic.txt'),'synthetic-only')
  await verifyIsolatedBackup({pool,admin,Pool,options:instance.connection,database:instance.database,directory:instance.directory,
    storageRoot:join(instance.directory,'storage'),companies:[{id:randomUUID(),schema:'public'}],report,isolation:instance,postgresBin:process.argv[argument+1]})
  report.passed=true
} catch(error) {
  report.passed=false;process.exitCode=1;report.failures.push({name:error.name,message:error.message,stack:error.stack})
  console.error('备份聚焦测试失败：'+error.message)
} finally {
  const clean=async(name,action)=>{try{await action();report.cleanup[name]=true}catch(error){report.failures.push({cleanup:name,message:error.message});report.passed=false;process.exitCode=1}}
  await clean('poolClosed',()=>pool?.end())
  if(created)await clean('databaseDropped',()=>admin.query('DROP DATABASE "'+instance.database+'" WITH (FORCE)'))
  await clean('adminClosed',()=>admin.end())
  await clean('postgresStopped',()=>instance.stop())
  await clean('codeUnchanged',async()=>assert.equal((await testCodeFingerprint(projectRoot)).sha256,fingerprint.sha256))
  report.finishedAt=new Date().toISOString()
  const output=join(instance.directory,'backup-isolation-report.json')
  await writeFile(output,JSON.stringify(report,null,2));console.log('报告：'+output)
}
