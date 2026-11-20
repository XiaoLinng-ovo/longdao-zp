import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { projectRoot } from './isolated-environment.mjs'

async function waitFor(read, label, ms = 15000) {
  const deadline = performance.now() + ms
  while (true) {
    const result = await read()
    if (result) return result
    assert.ok(performance.now() < deadline, label)
    await delay(25)
  }
}

export async function proveDatabaseReconnect({ instance, pool, company, request, expect }) {
  assert.match(company.schema, /^company_[a-f0-9]{32}$/)
  const before = await expect(company, 'GET', '/jobs')
  const lock = await pool.connect()
  let pending, backend
  try {
    await lock.query('BEGIN')
    await lock.query(`LOCK TABLE "${company.schema}".jobs IN ACCESS EXCLUSIVE MODE`)
    pending = request(company, 'GET', '/jobs'); void pending.catch(() => {})
    const observed = await waitFor(async () => (await pool.query(`SELECT pid,backend_start::text AS backend_start FROM pg_stat_activity
      WHERE datname=$1 AND application_name='closure-load-api' AND $2=ANY(pg_blocking_pids(pid))`, [instance.database, lock.processID])).rows[0], '未观察到本轮 API 查询等待隔离岗位表锁')
    backend = observed.pid
    const terminated = await pool.query(`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
      WHERE datname=$1 AND pid=$2 AND backend_start::text=$3 AND application_name='closure-load-api'`, [instance.database, backend, observed.backend_start])
    assert.deepEqual(terminated.rows, [{ terminated: true }])
  } finally {
    try { await lock.query('ROLLBACK') } finally { lock.release() }
  }
  const interrupted = await pending
  assert.equal(interrupted.status, 500)
  assert.equal((await pool.query('SELECT pid FROM pg_stat_activity WHERE pid=$1 AND datname=$2', [backend, instance.database])).rowCount, 0)
  assert.deepEqual(await expect(company, 'GET', '/jobs'), before)
  return { backend, interruptedHttpStatus: interrupted.status, sameApiRecovered: true, jobsUnchanged: true, oldBackendGone: true }
}

export async function proveWorkerCrash({ instance, pool, company, freshCompany, expect, content, worker, replaceWorker, model, gate, expectDiagnostic }) {
  assert.match(company.schema, /^company_[a-f0-9]{32}$/)
  assert.match(freshCompany.schema, /^company_[a-f0-9]{32}$/)
  const schema = '"' + company.schema + '"', callsBefore = model.requests.length
  async function submit(owner) {
    const batch = await expect(owner, 'POST', '/resume-import-batches', { jobId: owner.jobId,
      files: [{ clientFileId: randomUUID(), originalFilename: 'synthetic-fault.txt', mimeType: 'text/plain', sizeBytes: content.length }] }, 201)
    const upload = await expect(owner, 'POST', '/resume-import-batches/' + batch.id + '/items/' + batch.items[0].id + '/content', { encoding: 'base64', content: content.toString('base64') })
    return { upload, itemId: batch.items[0].id }
  }
  const { upload, itemId } = await submit(company)
  const id = upload.analysisTaskId
  const taskState = async () => (await pool.query(`SELECT t.status,t.attempts,t.last_error,l.expires_at,clock_timestamp() AS checked_at FROM ${schema}.analysis_tasks t
    LEFT JOIN public.analysis_execution_leases l ON l.task_id=t.id AND l.schema_name=$2 WHERE t.id=$1`, [id, company.schema])).rows[0]
  await waitFor(() => model.requests.length === callsBefore + 1, '真实任务未到达本机模型边界')
  const before = await taskState()
  assert.equal(before.status, 'processing'); assert.equal(before.attempts, 1); assert.ok(before.expires_at > before.checked_at)
  await worker.crash()
  const abandoned = await taskState()
  assert.equal(abandoned.status, 'processing'); assert.equal(abandoned.attempts, 1); assert.ok(abandoned.expires_at > abandoned.checked_at)
  await waitFor(async () => (await pool.query(`SELECT 1 FROM pg_stat_activity
    WHERE datname=$1 AND application_name='closure-browser-worker'`, [instance.database])).rowCount === 0, '被终止进程的数据库会话未释放')
  gate.release()
  const replacement = await replaceWorker()
  assert.notEqual(replacement.evidence.pid, worker.evidence.pid)
  const notYetExpired = await taskState()
  assert.ok(notYetExpired.checked_at < abandoned.expires_at, '替代 Worker 启动太晚，未覆盖租约到期前的保护')
  assert.equal(notYetExpired.attempts, 1); assert.equal(model.requests.length, callsBefore + 1)
  const recovered = await waitFor(async () => {
    const state = await taskState()
    if (state.checked_at < abandoned.expires_at) assert.equal(state.attempts, 1, '旧租约未到期便被重领')
    assert.notEqual(state.status, 'completed', '外部结果未知的任务不能伪装为已完成')
    return state.status === 'failed' && state
  }, '租约到期后未进入预期的待核对保护')
  assert.equal(recovered.attempts, 2); assert.equal(recovered.expires_at, null)
  assert.match(recovered.last_error, /待核对/)
  await expectDiagnostic(replacement, `[persisted-poll] task ${id} failed: ${recovered.last_error}`)
  assert.equal(model.requests.length - callsBefore, 1); assert.deepEqual(model.failures, [])
  const charges = await pool.query(`SELECT attempt,state,units::text FROM public.billing_tasks
    WHERE organization_id=$1 AND operation='resume_analysis' AND request_key=$2`, [company.id, 'resume:' + id])
  assert.deepEqual(charges.rows, [{ attempt: 1, state: 'reserved', units: '0' }])
  assert.equal((await pool.query(`SELECT 1 FROM ${schema}.analysis_results WHERE analysis_task_id=$1`, [id])).rowCount, 0)
  const associations = await pool.query(`SELECT r.storage_key FROM ${schema}.resumes r
    JOIN ${schema}.resume_import_items i ON i.resume_id=r.id AND i.candidate_id=r.candidate_id AND i.application_id=r.application_id
    WHERE i.analysis_task_id=$1 AND i.id=$2 AND r.id=$3 AND r.candidate_id=$4`, [id, itemId, upload.resumeId, upload.candidateId])
  assert.equal(associations.rowCount, 1)
  const file = await readFile(join(instance.directory, 'storage', associations.rows[0].storage_key))
  assert.deepEqual(file, content)
  assert.equal((await pool.query(`SELECT 1 FROM public.object_write_intents WHERE organization_id=$1 AND parent_id=$2 AND storage_key=$3 AND status='bound'`,
    [company.id, upload.candidateId, associations.rows[0].storage_key])).rowCount, 1)
  const fresh = (await submit(freshCompany)).upload
  await waitFor(async () => (await pool.query(`SELECT 1 FROM "${freshCompany.schema}".analysis_tasks WHERE id=$1 AND status='completed' AND attempts=1`,
    [fresh.analysisTaskId])).rowCount === 1, '替代 Worker 未完成新业务')
  assert.equal((await pool.query(`SELECT 1 FROM "${freshCompany.schema}".analysis_results WHERE analysis_task_id=$1`, [fresh.analysisTaskId])).rowCount, 1)
  assert.equal(model.requests.length - callsBefore, 2); assert.deepEqual(model.failures, [])
  return { taskId: id, killedWorker: worker.evidence, replacementPid: replacement.evidence.pid, oldSessionsGone: true,
    naturalExpiry: abandoned.expires_at, noEarlyReclaim: true, attempts: recovered.attempts, results: 0, externalCallsForCrashedTask: 1,
    reconciliationRequired: true, newTaskSucceeded: true, objectAndIntentMatched: true, activeLease: false }
}

export async function proveAudioResourceFaults({ instance, ffmpeg, record }) {
  const temporary = join(instance.directory, 'audio-temp')
  await mkdir(temporary)
  const env = { TEMP: temporary, TMP: temporary, TMPDIR: temporary, AUDIO_TEMP_TASK_MAX_BYTES: '16', AUDIO_TEMP_SHARED_MAX_BYTES: '24' }
  const original = new Map(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  try {
    const { AudioWorkspace, runAudioProcess, audioResourceSnapshot } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/interviews/audio-resources.js')).href)
    const baseline = audioResourceSnapshot()
    const workspace = await AudioWorkspace.create('transcription')
    try {
      const input = Readable.from([Buffer.alloc(17)])
      await assert.rejects(workspace.receive('input.wav', input, 17), /临时磁盘额度不足/)
      assert.ok(input.destroyed)
      assert.deepEqual(await readdir(workspace.directory), ['owner.json'])
      const retry = await workspace.receive('input.wav', Readable.from([Buffer.alloc(16)]), 16, undefined, 16)
      assert.equal((await stat(retry)).size, 16)
    } finally { await workspace.close() }
    assert.deepEqual(await readdir(join(temporary, 'smartrecruit-audio')), [])
    assert.deepEqual(audioResourceSnapshot(), baseline)
    record.storageQuota = { appTaskLimitBytes: 16, rejectedBytes: 17, retryBytes: 16, temporaryStorageDrained: true, physicalDiskNotFilled: true }

    const processWork = runAudioProcess(ffmpeg, ['-re', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '60', '-f', 'null', '-'], { timeoutMs: 350 })
    const timedOut = assert.rejects(processWork, /超时/)
    try {
      const [pid] = audioResourceSnapshot().childPids.filter(id => !baseline.childPids.includes(id))
      assert.ok(pid); process.kill(pid, 0)
      await timedOut
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
      assert.deepEqual(audioResourceSnapshot(), baseline)
      const recovered = await runAudioProcess(ffmpeg, ['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.05', '-f', 'wav', 'pipe:1'], { timeoutMs: 3000, maxOutputBytes: 4096 })
      assert.equal(recovered.toString('ascii', 0, 4), 'RIFF')
      assert.deepEqual(audioResourceSnapshot(), baseline)
      record.audioTimeout = { pid, timeoutMs: 350, processGone: true, nextAudioSucceeded: true }
    } finally { await timedOut }
  } finally {
    for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}
