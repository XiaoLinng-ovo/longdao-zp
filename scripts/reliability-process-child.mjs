import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

// This child is deliberately unusable against a business database.
assert.match(process.env.PGDATABASE ?? '', /^schema_verify_[a-f0-9]{32}$/)
assert.ok(['127.0.0.1','localhost','::1'].includes(process.env.PGHOST))
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/'+process.env.PGDATABASE)
assert.equal(new URL(process.env.DATABASE_URL).hostname, process.env.PGHOST)
assert.equal(new URL(process.env.DATABASE_URL).port, process.env.PGPORT)
assert.equal(process.env.WORKER_USE_LLM_ANALYSIS,'false')
assert.equal(process.env.INTERVIEW_AUDIO_POLL,'off')
assert.equal(process.env.SMTP_HOST,'')
const root=resolve(import.meta.dirname,'..')
const load=(app,file)=>import(pathToFileURL(join(root,'apps',app,'dist/src',file+'.js')).href)
const require=createRequire(join(root,'apps/api/package.json'))
const {Pool}=require('pg'),pools=new Set(),connect=Pool.prototype.connect
Pool.prototype.connect=function(...args){pools.add(this);return connect.apply(this,args)}
let runtime,closing=false
async function close(){
  if(closing)return;closing=true
  if(process.argv[2]==='api' && runtime) {
    runtime.closeIdleConnections();await new Promise(resolve=>runtime.close(resolve))
  } else await runtime?.close()
  await Promise.all([...pools].map(pool=>pool.end().catch(()=>undefined)))
  process.exit(0)
}
process.on('message',message=>{if(message?.type==='stop')void close()})
if(process.argv[2]==='api') {
  const {startServer}=await load('api','server'),{loadConfig}=await load('api','config')
  runtime=await startServer(loadConfig({...process.env,HOST:'127.0.0.1',PORT:'0'}))
  process.send?.({type:'ready',port:runtime.address().port})
} else if(process.argv[2]==='object-write') {
  const {createLocalObjectStorage}=await import(pathToFileURL(join(root,'packages/object-storage/dist/index.js')).href)
  const {bindTenantSearchPath}=await load('api','db/connection')
  const {runWithTenantContext}=await load('api','db/tenant-context')
  const {managedInterviewAudioStorage}=await load('api','interviews/managed-audio-storage')
  const {NormalizedRecruitingRepository}=await load('api','recruiting/repositories/postgres-repository')
  const input=JSON.parse(process.env.RELIABILITY_OBJECT_INPUT)
  assert.ok(['before-put','after-put','before-bind-commit','after-bind','before-parent-delete-commit','before-cleanup-commit','after-physical-delete'].includes(input.stopAt))
  assert.ok(['interview','resume'].includes(input.kind))
  assert.match(input.schemaName,/^company_[a-f0-9]{32}$/)
  const storage=createLocalObjectStorage(process.env.RECRUITING_QUARANTINE_ROOT)
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2})
  bindTenantSearchPath(pool)
  const pause=async()=>{process.send?.({type:'ready',stage:input.stopAt});await new Promise(()=>{})}
  const stopCommit=input.stopAt==='before-bind-commit'?2:['before-parent-delete-commit','before-cleanup-commit'].includes(input.stopAt)?1:0
  if(stopCommit) {
    let commits=0
    const acquire=pool.connect.bind(pool),wrapped=new WeakSet()
    pool.connect=async()=>{
      const client=await acquire()
      if(!wrapped.has(client)) {
        wrapped.add(client)
        const query=client.query.bind(client)
        client.query=async(sql,...args)=>{if(sql==='COMMIT' && ++commits===stopCommit)await pause();return query(sql,...args)}
      }
      return client
    }
  }
  const body=Buffer.from('synthetic hard-stop object')
  await runWithTenantContext({organizationId:input.organizationId,schemaName:input.schemaName},async()=>{
    if(input.stopAt==='before-parent-delete-commit') {
      const repository=new NormalizedRecruitingRepository(pool).withOrganization(input.organizationId)
      if(input.kind==='resume')await repository.deleteCandidate(input.candidateId)
      else await repository.deleteInterview(input.interviewId)
      throw Error('parent delete did not stop before commit')
    }
    if(['before-cleanup-commit','after-physical-delete'].includes(input.stopAt)) {
      const {ObjectCleanupService}=await load('api','recruiting/object-cleanup')
      const raw={...storage,async delete(key){assert.equal(key,input.key);await storage.delete(key);if(input.stopAt==='after-physical-delete')await pause()}}
      await new ObjectCleanupService(pool,raw,raw).processPending()
      throw Error('cleanup did not reach the requested crash stage')
    }
    if(input.kind==='interview') {
      const managed=managedInterviewAudioStorage(pool,{...storage,async put(...args){
        if(input.stopAt==='before-put')await pause()
        await storage.put(...args)
        if(input.stopAt==='after-put')await pause()
      }})
      await managed.put(input.key,body,'audio/wav')
    } else {
      const {createHash}=await import('node:crypto')
      const repository=new NormalizedRecruitingRepository(pool).withOrganization(input.organizationId)
      const contentHash=createHash('sha256').update(body).digest('hex')
      const attempt=await repository.registerResumeWrite(input.candidateId,input.key,storage.locationId,contentHash)
      if(input.stopAt==='before-put')await pause()
      await storage.put(input.key,body,'text/plain')
      if(input.stopAt==='after-put')await pause()
      await repository.createResumeWithAnalysisTask({candidateId:input.candidateId,storageKey:input.key,originalFilename:'synthetic.txt',mimeType:'text/plain',sizeBytes:body.length,contentHash},{attempt,locationId:storage.locationId})
    }
    assert.equal(input.stopAt,'after-bind')
    await pause()
  })
} else {
  assert.equal(process.argv[2],'worker')
  const {startWorker}=await load('worker','worker'),{loadConfig}=await load('worker','config')
  const {createTaskExecutor}=await load('worker','runner')
  const executor=createTaskExecutor()
  runtime=await startWorker(loadConfig({...process.env,WORKER_HEALTH_PORT:'0',WORKER_CONCURRENCY:'3',WORKER_DB_POLL:'true',WORKER_POLL_INTERVAL_MS:'50'}),{
    executor:{async execute(task){
      process.send?.({type:'executing',id:task.id})
      if(process.env.RELIABILITY_CRASH_ON_TASK==='true') await new Promise(()=>{})
      await delay(150);return executor.execute(task)
    }},
  })
  process.send?.({type:'ready',healthPort:runtime.healthServer.address().port})
}
