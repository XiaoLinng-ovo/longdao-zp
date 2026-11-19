import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

// The enclosing harness owns the random database, child processes and scratch storage.
export async function verifyObjectWrites({pool,companies,load,storage,report,childProcess}) {
  const company=companies[0],schema='"'+company.schema+'"'
  const {runWithTenantContext}=await load('api','db/tenant-context')
  const {NormalizedRecruitingRepository}=await load('api','recruiting/repositories/postgres-repository')
  const {managedInterviewAudioStorage}=await load('api','interviews/managed-audio-storage')
  const {ObjectCleanupService}=await load('api','recruiting/object-cleanup')
  const inside=action=>runWithTenantContext({organizationId:company.id,schemaName:company.schema},action)
  const repository=new NormalizedRecruitingRepository(pool).withOrganization(company.id)
  const application=(await pool.query('SELECT id,candidate_id FROM '+schema+'.applications LIMIT 1')).rows[0]
  const interviewId=randomUUID(),sessionId=randomUUID()
  await pool.query('INSERT INTO '+schema+".interviews(id,application_id,organization_id,interview_no,round,stage,type,title,status) VALUES($1,$2,$3,$4,1,'initial','other','合成文件中断测试','scheduled')",[interviewId,application.id,company.id,'INT-'+randomUUID()])
  await inside(()=>pool.query('INSERT INTO '+schema+".interview_live_sessions(id,interview_id,created_by,organization_id,status) VALUES($1,$2,$3,$4,'completed')",[sessionId,interviewId,company.userId,company.id]))
  await pool.query('UPDATE '+schema+".interviews SET status='completed' WHERE id=$1",[interviewId])
  const managed=managedInterviewAudioStorage(pool,storage)
  const cleanup=new ObjectCleanupService(pool,storage,storage)
  const resumeInput=key=>({candidateId:application.candidate_id,storageKey:key,originalFilename:'synthetic.txt',mimeType:'text/plain',sizeBytes:1,contentHash:'synthetic'})
  const interrupted=[]
  for(const kind of ['interview','resume']) for(const stopAt of ['before-put','after-put','before-bind-commit','after-bind']) {
    const key=kind==='interview'?'interviews/'+sessionId+'/hard-stop-'+stopAt+'.wav':'resumes/hard-stop/'+randomUUID()+'.txt'
    const record=await childProcess('object-write',{RELIABILITY_OBJECT_INPUT:JSON.stringify({kind,stopAt,key,organizationId:company.id,schemaName:company.schema,candidateId:application.candidate_id})})
    assert.equal(record.events.find(row=>row.type==='ready').stage,stopAt)
    assert.equal(record.child.kill('SIGKILL'),true)
    await record.exit
    const intent=(await pool.query('SELECT * FROM public.object_write_intents WHERE logical_key=$1',[key])).rows[0]
    assert.ok(intent)
    assert.equal(intent.status,stopAt==='after-bind'?'bound':'writing')
    if(stopAt==='before-put')await assert.rejects(storage.get(intent.storage_key),{code:'ENOENT'})
    else assert.equal((await storage.get(intent.storage_key)).toString(),'synthetic hard-stop object')
    if(stopAt!=='after-bind') {
      // Deliberate clock simulation; this is not reported as natural lease expiry.
      await pool.query("UPDATE public.object_write_intents SET lease_until=now()-interval '1 second' WHERE attempt_id=$1",[intent.attempt_id])
      await cleanup.processPending()
      assert.equal((await pool.query('SELECT status FROM public.object_write_intents WHERE attempt_id=$1',[intent.attempt_id])).rows[0].status,'unknown')
      await pool.query('INSERT INTO public.object_cleanup_tasks(organization_id,storage_key,schema_name,storage_kind,storage_location_id) VALUES($1,$2,$3,$4,$5)',[company.id,intent.storage_key,company.schema,kind,storage.locationId])
      await cleanup.processPending()
      assert.equal((await pool.query('SELECT status FROM public.object_cleanup_tasks WHERE storage_key=$1',[intent.storage_key])).rows[0].status,'failed')
      if(stopAt==='after-put')await storage.get(intent.storage_key)
      if(kind==='resume')await assert.rejects(inside(()=>repository.createResume(resumeInput(key))),/OBJECT_REFERENCE_INTENT_MISMATCH/)
    } else if(kind==='interview')assert.equal((await inside(()=>managed.get(key))).toString(),'synthetic hard-stop object')
    interrupted.push({kind,stage:stopAt,registered:true,filePresent:stopAt!=='before-put',finalState:stopAt==='after-bind'?'bound':'unknown',expiry:stopAt==='after-bind'?'not-applicable':'simulated'})
  }

  const naturalKey='resumes/natural-expiry/'+randomUUID()+'.txt'
  const naturalAttempt=await inside(()=>repository.registerResumeWrite(application.candidate_id,naturalKey,storage.locationId,'synthetic'))
  await pool.query("UPDATE public.object_write_intents SET lease_until=clock_timestamp()+interval '300 milliseconds' WHERE attempt_id=$1",[naturalAttempt])
  await delay(500)
  await cleanup.processPending()
  assert.equal((await pool.query('SELECT status FROM public.object_write_intents WHERE attempt_id=$1',[naturalAttempt])).rows[0].status,'unknown')

  const interruptedDeletion=[]
  const deleteCandidate=await inside(()=>repository.createCandidate({name:'合成删除中断候选人'}))
  for(const kind of ['interview','resume']) {
    const record=await childProcess('object-write',{RELIABILITY_OBJECT_INPUT:JSON.stringify({kind,stopAt:'before-parent-delete-commit',organizationId:company.id,schemaName:company.schema,candidateId:deleteCandidate.id,interviewId})})
    record.child.kill('SIGKILL');await record.exit
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+schema+(kind==='resume'?'.candidates':'.interviews')+' WHERE id=$1',[kind==='resume'?deleteCandidate.id:interviewId])).rows[0].n,1)
    interruptedDeletion.push({kind,rollbackAfterHardStop:true})
  }

  const duplicateKey='interviews/'+sessionId+'/concurrent.wav'
  let count=0,release
  const both=new Promise(resolve=>{release=resolve})
  const concurrent=managedInterviewAudioStorage(pool,{...storage,async put(...args){await storage.put(...args);if(++count===2)release();await both}})
  await Promise.all([inside(()=>concurrent.put(duplicateKey,Buffer.from('duplicate'),'audio/wav')),inside(()=>concurrent.put(duplicateKey,Buffer.from('duplicate'),'audio/wav'))])
  const versions=(await pool.query('SELECT storage_key,status FROM public.object_write_intents WHERE logical_key=$1',[duplicateKey])).rows
  assert.equal(versions.filter(row=>row.status==='bound').length,1)
  assert.equal(versions.filter(row=>row.status==='cleanup_pending').length,1)
  while(await cleanup.processPending()){}
  const removed=versions.find(row=>row.status==='cleanup_pending').storage_key
  await assert.rejects(storage.get(removed),{code:'ENOENT'})
  assert.equal((await inside(()=>managed.get(duplicateKey))).toString(),'duplicate')
  await assert.rejects(pool.query('INSERT INTO public.interview_stored_objects(organization_id,session_id,storage_key,schema_name,physical_key) VALUES($1,$2,$3,$4,$5)',[company.id,sessionId,'interviews/'+sessionId+'/resurrection.wav',company.schema,removed]),/OBJECT_REFERENCE_DELETION_FENCED/)

  let lateKey
  const uncertainKey='interviews/'+sessionId+'/response-lost.wav'
  const uncertain=managedInterviewAudioStorage(pool,{...storage,async put(key){lateKey=key;throw Error('synthetic PUT response lost')}})
  await assert.rejects(inside(()=>uncertain.put(uncertainKey,Buffer.from('late'),'audio/wav')),/response lost/)
  await storage.put(lateKey,Buffer.from('late'),'audio/wav')
  await cleanup.processPending()
  assert.equal((await pool.query('SELECT status FROM public.object_write_intents WHERE storage_key=$1',[lateKey])).rows[0].status,'unknown')
  assert.equal((await storage.get(lateKey)).toString(),'late')
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.object_cleanup_tasks WHERE storage_key=$1',[lateKey])).rows[0].n,0)
  const switched=managedInterviewAudioStorage(pool,{...storage,locationId:'f'.repeat(64)})
  await assert.rejects(inside(()=>switched.get(duplicateKey)),/LOCATION_CHANGED/)

  const legacyKey='resumes/legacy-fence/'+randomUUID()+'.txt'
  await storage.put(legacyKey,Buffer.from('legacy'),'text/plain')
  await pool.query('INSERT INTO public.object_cleanup_tasks(organization_id,storage_key,schema_name,storage_location_id) VALUES($1,$2,$3,$4)',[company.id,legacyKey,company.schema,storage.locationId])
  let entered,finish
  const deleting=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{finish=resolve})
  const slowCleanup=new ObjectCleanupService(pool,{...storage,async delete(key){entered();await gate;await storage.delete(key)}},storage)
  const cleanupWork=slowCleanup.processPending()
  await deleting
  try {await assert.rejects(inside(()=>repository.createResume(resumeInput(legacyKey))),/OBJECT_REFERENCE_DELETION_FENCED/)}
  finally {finish();await cleanupWork}
  await assert.rejects(inside(()=>repository.createResume(resumeInput(legacyKey))),/OBJECT_REFERENCE_DELETION_FENCED/)

  const interruptedCleanup=[]
  for(const stopAt of ['before-cleanup-commit','after-physical-delete']) {
    const key='resumes/cleanup-hard-stop/'+randomUUID()+'.txt'
    await storage.put(key,Buffer.from('cleanup crash'),'text/plain')
    await pool.query("INSERT INTO public.object_cleanup_tasks(organization_id,storage_key,schema_name,storage_location_id,available_at) VALUES($1,$2,$3,$4,'1999-01-01')",[company.id,key,company.schema,storage.locationId])
    const record=await childProcess('object-write',{RELIABILITY_OBJECT_INPUT:JSON.stringify({kind:'resume',stopAt,key,organizationId:company.id,schemaName:company.schema})})
    record.child.kill('SIGKILL');await record.exit
    if(stopAt==='before-cleanup-commit')await storage.get(key)
    else await assert.rejects(storage.get(key),{code:'ENOENT'})
    await pool.query("UPDATE public.object_cleanup_tasks SET available_at='1999-01-01' WHERE storage_key=$1",[key])
    await cleanup.processPending()
    assert.equal((await pool.query('SELECT status FROM public.object_cleanup_tasks WHERE storage_key=$1',[key])).rows[0].status,'completed')
    await assert.rejects(storage.get(key),{code:'ENOENT'})
    interruptedCleanup.push({stage:stopAt,recovered:true,leaseRecovery:'simulated'})
  }

  const candidate=await inside(()=>repository.createCandidate({name:'合成迟到上传候选人'}))
  const orphanKey='resumes/parent-deleted/'+randomUUID()+'.txt',body=Buffer.from('synthetic parent deleted')
  const contentHash=createHash('sha256').update(body).digest('hex')
  const attempt=await inside(()=>repository.registerResumeWrite(candidate.id,orphanKey,storage.locationId,contentHash))
  await inside(()=>repository.deleteCandidate(candidate.id))
  await storage.put(orphanKey,body,'text/plain')
  await assert.rejects(inside(()=>repository.createResumeWithAnalysisTask({...resumeInput(orphanKey),candidateId:candidate.id,contentHash},{attempt,locationId:storage.locationId})))
  await repository.recordResumeWriteFailure(attempt,true)
  while(await cleanup.processPending()){}
  await assert.rejects(storage.get(orphanKey),{code:'ENOENT'})
  report.checks.objectWriteReliability={hardStops:interrupted,parentDeletionHardStops:interruptedDeletion,cleanupHardStops:interruptedCleanup,naturalExpiry:{leaseMs:300,waitMs:500,status:'unknown',shortenedTestLease:true},duplicateWrites:2,effectiveBindings:1,surplusVersionDeleted:true,oldVersionCannotRebind:true,lateUncertainWriteRetained:true,locationSwitchRejected:true,legacyRebindDuringDeletionRejected:true,resumeParentDeletionRejected:true,externalCalls:0}
}
