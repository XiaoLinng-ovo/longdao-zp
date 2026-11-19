import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { inspectCompanySchemas } from './check-company-schemas.mjs'

// Called only after the parent harness has created a random disposable database.
export async function verifyReliability({ pool, companies, load, request, storage, report }) {
  const { bindTenantSearchPath } = await load('api', 'db/connection')
  const { runWithTenantContext } = await load('api', 'db/tenant-context')
  const { NormalizedRecruitingRepository } = await load('api', 'recruiting/repositories/postgres-repository')
  const { OfferEmailDeliveryStore } = await load('api', 'integrations/email/delivery-store')
  const { ObjectCleanupService } = await load('api', 'recruiting/object-cleanup')
  bindTenantSearchPath(pool)
  const [company, other] = companies
  const inside = operation => runWithTenantContext({ organizationId: company.id, schemaName: company.schema }, operation)
  const repository = new NormalizedRecruitingRepository(pool).withOrganization(company.id)
  const deliveries = new OfferEmailDeliveryStore(pool)
  const schema = '"' + company.schema + '"'
  assert.equal((await inspectCompanySchemas(pool)).ready, true)
  const legacyComparison = await inspectCompanySchemas(pool, { compareLegacy: true })
  assert.equal(legacyComparison.ready, false)
  assert.ok(legacyComparison.companies.some(row => row.differences.length))
  for (const change of [
    ['ALTER TABLE ' + schema + '.onboarding_tasks RENAME TO reliability_hidden_tasks', 'ALTER TABLE ' + schema + '.reliability_hidden_tasks RENAME TO onboarding_tasks'],
    ['ALTER TABLE ' + schema + '.onboarding_materials RENAME COLUMN notes TO reliability_hidden_notes', 'ALTER TABLE ' + schema + '.onboarding_materials RENAME COLUMN reliability_hidden_notes TO notes'],
  ]) {
    await pool.query(change[0])
    try {
      assert.equal((await inspectCompanySchemas(pool)).ready, false)
      assert.equal((await request(company, 'GET', '/api/v1/candidates')).status, 503)
    } finally { await pool.query(change[1]) }
  }
  assert.equal((await inspectCompanySchemas(pool)).ready, true)
  report.checks.schemaPreflight = { structureChecked: true, missingTableRejected: true, missingColumnRejected: true, legacyDivergenceDetected: true }
  const applicationId = (await pool.query('SELECT id FROM ' + schema + '.applications ORDER BY id LIMIT 1')).rows[0].id
  const offerId = randomUUID(), versionId = randomUUID(), onboardingId = randomUUID()
  await pool.query('INSERT INTO ' + schema + '.offers(id,application_id,organization_id,status) VALUES($1,$2,$3,\'draft\')', [offerId,applicationId,company.id])
  await pool.query('INSERT INTO ' + schema + '.offer_versions(id,offer_id,version,position_title,employment_type,organization_id) VALUES($1,$2,1,\'工程师\',\'full_time\',$3)', [versionId,offerId,company.id])
  await pool.query('UPDATE ' + schema + '.offers SET current_version_id=$1 WHERE id=$2', [versionId,offerId])
  await pool.query('INSERT INTO ' + schema + '.onboarding_records(id,application_id,offer_id,organization_id) VALUES($1,$2,$3,$4)', [onboardingId,applicationId,offerId,company.id])
  const materialPath = '/api/v1/onboarding/' + onboardingId + '/materials'
  const created = await request(company, 'POST', materialPath, { code: 'identity', label: '身份材料' })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const materialId = created.body.data.id
  const edited = await request(company, 'PATCH', materialPath + '/' + materialId, { notes: '已人工核实' })
  assert.equal(edited.status, 200, JSON.stringify(edited.body))
  assert.equal((await request(other, 'PATCH', materialPath + '/' + materialId, { notes: '越权' })).status, 404)
  assert.equal((await request(company, 'POST', materialPath, { code: 'identity', label: '不得覆盖' })).status, 409)
  const audit = await pool.query('SELECT event_type FROM ' + schema + '.workflow_events WHERE subject_id=$1', [onboardingId])
  assert.ok(audit.rows.some(row => row.event_type === 'material_create'))
  assert.ok(audit.rows.some(row => row.event_type === 'material_update'))
  for (const status of ['cancelled', 'no_show']) {
    await pool.query('UPDATE ' + schema + '.onboarding_records SET status=$1 WHERE id=$2', [status,onboardingId])
    await assert.rejects(inside(() => repository.updateOnboardingMaterial(onboardingId, materialId, { notes: '禁止更新' }, company.userId)), { code: 'ONBOARDING_NOT_EDITABLE' })
  }
  await pool.query('UPDATE ' + schema + '.onboarding_records SET status=\'completed\' WHERE id=$1', [onboardingId])
  await inside(() => repository.updateOnboardingMaterial(onboardingId, materialId, { notes: '归档后补充' }, company.userId))
  const injectAuditFailure = async () => {
    await pool.query('CREATE FUNCTION ' + schema + '.reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'injected audit failure\'; END $$')
    await pool.query('CREATE TRIGGER reliability_audit_failure BEFORE INSERT ON ' + schema + '.workflow_events FOR EACH ROW EXECUTE FUNCTION ' + schema + '.reject_audit()')
  }
  const clearAuditFailure = async () => {
    await pool.query('DROP TRIGGER reliability_audit_failure ON ' + schema + '.workflow_events')
    await pool.query('DROP FUNCTION ' + schema + '.reject_audit()')
  }
  await injectAuditFailure()
  await assert.rejects(inside(() => repository.updateOnboardingMaterial(onboardingId, materialId, { notes: '不得残留' }, company.userId)), /injected audit failure/)
  await clearAuditFailure()
  assert.equal((await pool.query('SELECT notes FROM ' + schema + '.onboarding_materials WHERE id=$1', [materialId])).rows[0].notes, '归档后补充')
  report.checks.materials = { companyBoundary: true, duplicateRejected: true, terminalStates: true, archivedSupplement: true, auditAtomicity: true }

  const sendRequest = { action: 'send', metadata: { to: 'synthetic@example.invalid' } }
  const reservations = await Promise.allSettled(Array.from({ length: 8 }, () => inside(() => deliveries.begin(company.id, offerId, versionId, 1, sendRequest))))
  assert.equal(reservations.filter(result => result.status === 'fulfilled').length, 1)
  assert.ok(reservations.filter(result => result.status === 'rejected').every(result => result.reason.code === 'OFFER_EMAIL_STATUS_UNKNOWN'))
  const delivery = reservations.find(result => result.status === 'fulfilled').value
  await assert.rejects(inside(() => repository.updateOffer(offerId, { status: 'cancelled' })), { code: 'OFFER_EMAIL_STATUS_UNKNOWN' })
  await assert.rejects(deliveries.resolve(delivery.id, 'completed', company.userId, '测试仍在发送中'), { code: 'EMAIL_RESOLUTION_CONFLICT' })
  await deliveries.setStatus(delivery.id, 'unknown')
  await injectAuditFailure()
  await assert.rejects(deliveries.resolve(delivery.id, 'completed', company.userId, '已核对服务商记录'), /injected audit failure/)
  await clearAuditFailure()
  assert.equal((await pool.query('SELECT status FROM public.offer_email_deliveries WHERE id=$1', [delivery.id])).rows[0].status, 'unknown')
  assert.equal((await pool.query('SELECT status FROM ' + schema + '.offers WHERE id=$1', [offerId])).rows[0].status, 'draft')
  await pool.query('UPDATE public.offer_email_deliveries SET schema_name=\'public\' WHERE id=$1', [delivery.id])
  await assert.rejects(deliveries.resolve(delivery.id, 'completed', company.userId, '错误路径不得恢复'), { code: 'EMAIL_SCHEMA_CONFLICT' })
  await pool.query('UPDATE public.offer_email_deliveries SET schema_name=$2 WHERE id=$1', [delivery.id,company.schema])
  await deliveries.resolve(delivery.id, 'completed', company.userId, '已核对服务商记录')
  const recovered = (await pool.query('SELECT status,resolved_by,resolution_note FROM public.offer_email_deliveries WHERE id=$1', [delivery.id])).rows[0]
  assert.equal(recovered.status, 'completed'); assert.equal(recovered.resolved_by, company.userId)
  assert.equal((await pool.query('SELECT status FROM ' + schema + '.offers WHERE id=$1', [offerId])).rows[0].status, 'sent')
  assert.equal((await pool.query('SELECT status FROM ' + schema + '.applications WHERE id=$1', [applicationId])).rows[0].status, 'offer_sent')
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ' + schema + '.workflow_events WHERE subject_id=$1 AND metadata @> \'{"recovered":true}\'::jsonb', [offerId])).rows[0].n, 1)
  await assert.rejects(deliveries.resolve(delivery.id, 'completed', company.userId, '重复恢复不得执行'), { code: 'EMAIL_RESOLUTION_CONFLICT' })
  const retry = await inside(() => deliveries.begin(company.id, offerId, versionId, 2, { ...sendRequest, action: 'resend' }))
  await deliveries.setStatus(retry.id, 'unknown')
  await pool.query('UPDATE ' + schema + '.offers SET version=3 WHERE id=$1', [offerId])
  await assert.rejects(deliveries.resolve(retry.id, 'completed', company.userId, '旧版本不得恢复'), { code: 'OFFER_VERSION_CONFLICT' })
  await deliveries.resolve(retry.id, 'not_sent', company.userId, '已确认未发送到服务商')
  const retried = await inside(() => deliveries.begin(company.id, offerId, versionId, 3, { ...sendRequest, action: 'resend' }))
  assert.ok(retried.id !== retry.id)
  await deliveries.setStatus(retried.id, 'unknown')
  await deliveries.resolve(retried.id, 'not_sent', company.userId, '已确认测试未实际发送')
  report.checks.emailRecovery = { concurrentReservations: 8, successfulReservations: 1, mutationBlocked: true, auditAtomicity: true, businessStateRecovered: true, stalePathRejected: true, staleVersionRejected: true, retryAfterConfirmedNotSent: true }

  const queued = (await pool.query('SELECT * FROM public.object_cleanup_tasks WHERE organization_id=$1 ORDER BY created_at LIMIT 1', [company.id])).rows[0]
  assert.ok(queued, '删除简历必须生成持久化清理任务')
  await storage.get(queued.storage_key)
  await pool.query("UPDATE public.object_cleanup_tasks SET available_at='2000-01-01' WHERE id=$1",[queued.id])
  let failures = 0
  const flaky = { ...storage, delete: async key => { if(key===queued.storage_key){failures++;if(failures===1)throw Error('injected storage failure')} await storage.delete(key) } }
  const cleanup = new ObjectCleanupService(pool, flaky)
  await cleanup.processPending()
  const failed = (await pool.query('SELECT status,attempts FROM public.object_cleanup_tasks WHERE id=$1', [queued.id])).rows[0]
  assert.equal(failed.status, 'pending'); assert.equal(failed.attempts, 1)
  await storage.get(queued.storage_key)
  await pool.query("UPDATE public.object_cleanup_tasks SET available_at='2000-01-01' WHERE id=$1", [queued.id])
  await cleanup.processPending()
  await assert.rejects(storage.get(queued.storage_key), { code: 'ENOENT' })
  assert.equal((await pool.query('SELECT status FROM public.object_cleanup_tasks WHERE id=$1', [queued.id])).rows[0].status, 'completed')
  while(await cleanup.processPending()) {}
  const retained = (await pool.query('SELECT storage_key FROM ' + schema + '.resumes LIMIT 1')).rows[0].storage_key
  await pool.query('INSERT INTO public.object_cleanup_tasks(organization_id,storage_key,schema_name) VALUES($1,$2,$3)', [company.id,retained,company.schema])
  await cleanup.processPending()
  await storage.get(retained)
  assert.equal(failures, 2, '被引用文件不得进入删除调用')
  report.checks.fileCleanup = { persisted: true, failureRetried: true, physicalDeletion: true, retainedReferenceProtected: true }

  const { managedInterviewAudioStorage }=await load('api','interviews/managed-audio-storage')
  const { PersistentFullAudioTranscription }=await load('api','interviews/persistent-full-audio')
  const interviewId=randomUUID(),sessionId=randomUUID(),audioKey='interviews/'+sessionId+'/synthetic.wav'
  await inside(()=>pool.query("INSERT INTO interviews(id,application_id,organization_id,interview_no,round,stage,type,title,status) VALUES($1,$2,$3,$4,1,'initial','other','合成音频验收','scheduled')",[interviewId,applicationId,company.id,'INT-'+randomUUID()]))
  await inside(()=>pool.query("INSERT INTO interview_live_sessions(id,interview_id,created_by,organization_id,status) VALUES($1,$2,$3,$4,'completed')",[sessionId,interviewId,company.userId,company.id]))
  await pool.query('UPDATE '+schema+".interviews SET status='completed' WHERE id=$1",[interviewId])
  const managed=managedInterviewAudioStorage(pool,storage)
  await inside(()=>managed.put(audioKey,Buffer.from('synthetic audio'),'audio/wav'))
  const physicalKey=(await pool.query('SELECT physical_key FROM public.interview_stored_objects WHERE organization_id=$1 AND storage_key=$2',[company.id,audioKey])).rows[0].physical_key
  assert.notEqual(physicalKey,audioKey)
  assert.equal((await inside(()=>managed.get(audioKey))).toString(),'synthetic audio')
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.stored_object_locations WHERE organization_id=$1 AND storage_key=$2',[company.id,physicalKey])).rows[0].n,1)
  await pool.query('CREATE FUNCTION '+schema+".reject_interview_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected delete failure'; END $$")
  await pool.query('CREATE TRIGGER reject_interview_delete BEFORE DELETE ON '+schema+'.interviews FOR EACH ROW EXECUTE FUNCTION '+schema+'.reject_interview_delete()')
  try {await assert.rejects(inside(()=>repository.deleteInterview(interviewId)),/injected delete failure/)}
  finally {await pool.query('DROP TRIGGER reject_interview_delete ON '+schema+'.interviews');await pool.query('DROP FUNCTION '+schema+'.reject_interview_delete()')}
  await storage.get(physicalKey)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.object_cleanup_tasks WHERE storage_key=$1',[physicalKey])).rows[0].n,0)

  let calls=0
  const runtime=async()=>({load:async()=>Buffer.alloc(1),totalChunks:2,meter:async(_audio,_index,action)=>action()})
  const split=async function*(){yield Buffer.alloc(1);yield Buffer.alloc(1)}
  const persistent=new PersistentFullAudioTranscription(pool,runtime,async()=>{calls++;return [{text:'合成识别结果'}]},split)
  const input={organizationId:company.id,interviewId,sessionId,key:'interviews/'+sessionId+'/transcript-ok.json',source:'all',fingerprint:'synthetic-v1'}
  await Promise.all(Array.from({length:8},()=>inside(()=>persistent.enqueue(input))))
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.full_audio_transcription_tasks WHERE storage_key=$1',[input.key])).rows[0].n,1)
  await persistent.processPending()
  assert.equal(calls,2)
  assert.equal((await persistent.get(company.id,input.key)).status,'completed')
  const broken=new PersistentFullAudioTranscription(pool,runtime,async()=>{calls++;throw Error('injected uncertain inference')},split)
  const unknown={...input,key:'interviews/'+sessionId+'/transcript-unknown.json'}
  await inside(()=>broken.enqueue(unknown));await broken.processPending()
  const unknownRow=(await pool.query('SELECT id,status FROM public.full_audio_transcription_tasks WHERE storage_key=$1',[unknown.key])).rows[0]
  assert.equal(unknownRow.status,'unknown')
  assert.equal(await persistent.processPending(),false)
  assert.equal(calls,3)
  const { OperationalRecoveryService } = await load('api', 'admin/operational-recovery')
  const recovery = new OperationalRecoveryService(pool)
  const firstSnapshot = (await recovery.list()).audio.find(row => row.id === unknownRow.id)
  assert.match(firstSnapshot.recovery_version, /^[0-9]+$/)
  await pool.query('UPDATE public.full_audio_transcription_tasks SET updated_at=now() WHERE id=$1', [unknownRow.id])
  await assert.rejects(recovery.resolve('audio',unknownRow.id,'stop','旧页面核对依据',company.userId,firstSnapshot.recovery_version), {code:'RECOVERY_CONFLICT'})
  const freshSnapshot = (await recovery.list()).audio.find(row => row.id === unknownRow.id)
  await pool.query("CREATE FUNCTION public.reject_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected recovery audit failure'; END $$")
  await pool.query('CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON public.platform_audit_logs FOR EACH ROW EXECUTE FUNCTION public.reject_recovery_audit()')
  try {
    await assert.rejects(recovery.resolve('audio',unknownRow.id,'stop','合成审计失败回滚核对',company.userId,freshSnapshot.recovery_version), /injected recovery audit failure/)
    assert.equal((await pool.query('SELECT status FROM public.full_audio_transcription_tasks WHERE id=$1',[unknownRow.id])).rows[0].status,'unknown')
  } finally {
    await pool.query('DROP TRIGGER reject_recovery_audit ON public.platform_audit_logs')
    await pool.query('DROP FUNCTION public.reject_recovery_audit()')
  }
  const afterRollback = (await recovery.list()).audio.find(row => row.id === unknownRow.id)
  await recovery.resolve('audio',unknownRow.id,'stop','合成管理员已核对终止',company.userId,afterRollback.recovery_version)
  await assert.rejects(recovery.resolve('audio',unknownRow.id,'stop','重复提交同一核对决定',company.userId,afterRollback.recovery_version), {code:'RECOVERY_CONFLICT'})
  assert.equal(await persistent.processPending(),false)
  assert.equal(calls,3)
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.platform_audit_logs WHERE action='operations.task.resolve' AND metadata->>'id'=$1",[unknownRow.id])).rows[0].n,1)
  report.checks.recoveryConcurrency={staleVersionRejected:true,auditFailureRolledBack:true,duplicateStopRejected:true,oneAuditEvent:true,inferenceNotRepeated:true}
  const expired={...input,key:'interviews/'+sessionId+'/transcript-expired.json'}
  await inside(()=>persistent.enqueue(expired))
  await pool.query("UPDATE public.full_audio_transcription_tasks SET status='processing',inference_pending=true,lease_token=$2,lease_until=now()-interval '1 second' WHERE storage_key=$1",[expired.key,randomUUID()])
  assert.equal(await persistent.processPending(),false)
  assert.equal((await pool.query('SELECT status FROM public.full_audio_transcription_tasks WHERE storage_key=$1',[expired.key])).rows[0].status,'unknown')
  const changed=new PersistentFullAudioTranscription(pool,async()=>{throw Error('FULL_AUDIO_INPUT_CHANGED')},async()=>{throw Error('must not infer')},split)
  const stale={...input,key:'interviews/'+sessionId+'/transcript-stale.json'}
  await inside(()=>changed.enqueue(stale));await changed.processPending()
  assert.equal((await pool.query('SELECT status FROM public.full_audio_transcription_tasks WHERE storage_key=$1',[stale.key])).rows[0].status,'failed')
  report.checks.persistentAudio={concurrentEnqueues:8,oneTask:true,checkpointedChunks:2,unknownNotRetried:true,expiredInferenceNotRetried:true,changedInputRejectedBeforeInference:true,externalCalls:0}

  let releaseWrite,enteredWrite
  const writeGate=new Promise(resolve=>{releaseWrite=resolve}),entered=new Promise(resolve=>{enteredWrite=resolve})
  const inFlightKey='interviews/'+sessionId+'/in-flight.wav'
  const blocked=managedInterviewAudioStorage(pool,{...storage,async put(...args){enteredWrite();await writeGate;return storage.put(...args)}})
  const writing=assert.rejects(inside(()=>blocked.put(inFlightKey,Buffer.from('synthetic in-flight'),'audio/wav')),{status:404})
  await entered
  const inFlightPhysical=(await pool.query('SELECT storage_key FROM public.object_write_intents WHERE logical_key=$1',[inFlightKey])).rows[0].storage_key
  let timer
  try {
    await Promise.race([inside(()=>repository.deleteInterview(interviewId)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('删除不应等待物理上传')),3000)})])
  } finally {clearTimeout(timer);releaseWrite();await writing}
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.interview_stored_objects WHERE session_id=$1',[sessionId])).rows[0].n,0)
  const audioTasks=await pool.query("SELECT storage_location_id FROM public.object_cleanup_tasks WHERE organization_id=$1 AND storage_kind='interview'",[company.id])
  assert.equal(audioTasks.rows.length,2)
  assert.ok(audioTasks.rows.every(row=>row.storage_location_id===storage.locationId))
  const audioCleanup=new ObjectCleanupService(pool,storage,storage)
  for(let count=0;count<20 && await audioCleanup.processPending();count++){}
  await assert.rejects(storage.get(physicalKey),{code:'ENOENT'})
  await assert.rejects(storage.get(inFlightPhysical),{code:'ENOENT'})
  await assert.rejects(inside(()=>managed.put(audioKey,Buffer.alloc(1),'audio/wav')),{status:404})
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.full_audio_transcription_tasks WHERE interview_id=$1',[interviewId])).rows[0].n,0)
  report.checks.audioDeletion={rollbackRetainedObject:true,deletedBeforeInFlightWriteCompleted:true,exactKeys:2,originalLocationRecorded:true,physicalDeletion:true,deletedParentCannotResurrect:true,transcriptionTasksRemoved:true}
}
