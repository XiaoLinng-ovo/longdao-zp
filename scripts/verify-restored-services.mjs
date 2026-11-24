import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, readFile, realpath, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { files, matchesPostgresDataDirectory } from './verify-isolated-backup.mjs'
import { isolatedEnvironment, projectRoot } from './isolated-environment.mjs'

async function within(promise, milliseconds, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

async function startChild(mode, env) {
  const child = fork(join(projectRoot, 'scripts/recovery-process-child.mjs'), [mode], {
    cwd: projectRoot, env, windowsHide: true, execArgv: ['--require', join(projectRoot, 'scripts/isolated-network-guard.cjs')],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const evidence = { mode, pid: child.pid, events: [], stdout: '', stderr: '' }
  child.stdout.on('data', value => { evidence.stdout += String(value) })
  child.stderr.on('data', value => { evidence.stderr += String(value) })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => { evidence.exit = { code, signal }; resolve() }))
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.on('message', message => {
      evidence.events.push(message)
      if (message.type === 'ready') resolve(message)
      if (message.type === 'failure') reject(new Error(message.message))
    })
  })
  try {
    const message = await within(Promise.race([ready, exited.then(() => { throw new Error('恢复服务提前退出：' + evidence.stderr) })]), 30000, '恢复服务启动超时')
    return { evidence, port: message.port, async stop() {
      try {
        if (!evidence.exit) { child.send({ type: 'stop' }); await within(exited, 10000, '恢复服务未自然退出') }
        assert.deepEqual(evidence.exit, { code: 0, signal: null })
        assert.equal(evidence.events.filter(item => item.type === 'closed').length, 1)
        assert.deepEqual(evidence.events.filter(item => ['diagnostic', 'failure'].includes(item.type)), [])
      } finally { if (!evidence.exit) { evidence.forcedKill = true; child.kill(); await exited } }
    } }
  } catch (error) {
    if (!evidence.exit) { evidence.forcedKill = true; child.kill(); await exited }
    throw error
  }
}

export async function verifyRestoredServices({ instance, pool, database, storageRoot, interviewObjects, accounts, runtimeEnv }) {
  assert.match(database, /^restore_verify_[a-f0-9]{32}$/)
  assert.equal(resolve(instance.directory), join(projectRoot, 'tmp', instance.database))
  assert.equal(await realpath(instance.directory), resolve(instance.directory))
  const owner = JSON.parse(await readFile(join(instance.directory, 'owner.json'), 'utf8'))
  assert.equal(owner.pid, process.pid); assert.equal(owner.purpose, 'isolated-acceptance'); assert.equal(owner.cluster, instance.cluster)
  const identity = (await pool.query(`SELECT current_database() AS database,current_setting('cluster_name') AS cluster,
    encode(pg_catalog.textsend(current_setting('data_directory')),'hex') AS data_hex`)).rows[0]
  assert.equal(identity.database, database); assert.equal(identity.cluster, instance.cluster)
  assert.ok(matchesPostgresDataDirectory(identity.data_hex, instance.data))
  const source = join(instance.directory, 'storage'), parked = join(instance.directory, 'source-storage-during-recovery')
  assert.equal(resolve(storageRoot), join(instance.directory, 'restored', 'objects'))
  assert.equal(await realpath(storageRoot), resolve(storageRoot)); assert.equal(await realpath(source), source)
  await assert.rejects(access(parked), { code: 'ENOENT' })
  const originalFiles = await files(source)
  assert.deepEqual(await files(storageRoot), originalFiles)
  const audioFallback = join(instance.directory, 'interviews')
  assert.equal(runtimeEnv.INTERVIEW_STORAGE_ROOT, audioFallback)
  assert.equal(await realpath(audioFallback), audioFallback)
  assert.deepEqual(await files(audioFallback), [], '共享存储模式下独立回退目录应为空')
  assert.ok(interviewObjects.length > 0)
  assert.ok(accounts.length >= 2)
  for (const account of accounts) {
    assert.match(account.id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
    assert.equal(account.schema, 'company_' + account.id.replaceAll('-', ''))
  }
  const require = createRequire(join(projectRoot, 'apps/api/package.json'))
  const guard = require(join(projectRoot, 'scripts/isolated-network-guard.cjs'))
  const env = isolatedEnvironment({ ...instance.env, PGDATABASE: database, PGAPPNAME: 'closure-restored-services',
    SYSTEM_ADMIN_USER_NO: runtimeEnv.SYSTEM_ADMIN_USER_NO ?? '', AUTH_OTP_HMAC_SECRET: runtimeEnv.AUTH_OTP_HMAC_SECRET ?? '',
    PAYMENT_ENCRYPTION_KEY: runtimeEnv.PAYMENT_ENCRYPTION_KEY ?? '', ISOLATED_ALLOWED_PORTS: String(instance.port),
  }, instance.env)
  let parkedOriginal = false, mounted = false, api, worker
  const result = { serviceRestartVerified: false, processes: [], logins: [], crossCompanyRejected: false, sourceObjectsPreserved: false }
  try {
    // Mount the restored copy at the original identity, never rewrite location IDs to bypass preflight.
    await rename(source, parked); parkedOriginal = true
    await rename(storageRoot, source); mounted = true
    api = await startChild('api', env); result.processes.push(api.evidence); guard.allowLoopbackPort(api.port)
    worker = await startChild('worker', env); result.processes.push(worker.evidence); guard.allowLoopbackPort(worker.port)
    const response = await fetch('http://127.0.0.1:' + worker.port + '/ready', { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    const health = await response.json(); assert.equal(health.externalDependencies.postgres, 'ok')
    const clients = []
    for (const account of accounts) {
      const base = 'http://127.0.0.1:' + api.port + '/api/v1'
      const login = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: account.email, password: account.password }), signal: AbortSignal.timeout(5000) })
      assert.equal(login.status, 200, '恢复后真实登录失败')
      const loggedIn = (await login.json()).data
      assert.equal(loggedIn.user.id, account.userId); assert.equal(loggedIn.user.role, 'recruiter')
      assert.equal(Boolean(loggedIn.user.isSystemAdmin), account.userNo === env.SYSTEM_ADMIN_USER_NO)
      const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      const csrfPair = cookie.split('; ').find(value => value.startsWith('smartrecruit_csrf='))
      assert.ok(csrfPair, '恢复登录必须签发防伪令牌')
      const selected = await fetch(base + '/workspaces/' + account.id + '/select', {
        method: 'POST', headers: { cookie, origin: 'http://127.0.0.1:5173',
          'x-csrf-token': decodeURIComponent(csrfPair.slice('smartrecruit_csrf='.length)), 'content-type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(5000),
      })
      assert.equal(selected.status, 200, '恢复后真实切换公司失败')
      assert.equal((await selected.json()).data.user.workspaceId, account.id)
      const request = async path => fetch(base + path, { headers: { cookie, 'x-workspace-id': account.id }, signal: AbortSignal.timeout(5000) })
      const candidates = await request('/candidates'); assert.equal(candidates.status, 200)
      const rows = (await candidates.json()).data
      const expected = (await pool.query('SELECT id FROM "' + account.schema + '".candidates ORDER BY id')).rows.map(row => row.id)
      assert.deepEqual(rows.map(row => row.id).sort(), expected.sort())
      clients.push({ request, rows, account })
      result.logins.push({ userId: account.userId, candidates: rows.length, isSystemAdmin: Boolean(loggedIn.user.isSystemAdmin) })
    }
    const target = clients[0].rows[0]; assert.ok(target)
    assert.equal((await clients[1].request('/candidates/' + target.id)).status, 404)
    assert.equal((await clients[1].request('/admin/users')).status, 403)
    result.crossCompanyRejected = true
    const recorded = accounts.find(account => account.audio)
    assert.ok(recorded, '恢复应验证有录音的公司')
    const client = clients.find(item => item.account === recorded)
    const recordingBase = '/interviews/' + recorded.audio.interviewId + '/recordings'
    const listing = await client.request(recordingBase)
    assert.equal(listing.status, 200)
    const recordings = (await listing.json()).data
    assert.ok(recordings.length > 0)
    const recording = recordings[0]
    const downloaded = await client.request(recordingBase + '/' + recording.id)
    assert.equal(downloaded.status, 200)
    const bytes = Buffer.from(await downloaded.arrayBuffer())
    assert.ok(bytes.length > 0)
    const storedAudio = (await pool.query(`SELECT COALESCE(o.physical_key,o.storage_key) AS key
      FROM "${recorded.schema}".interview_audio_recordings r JOIN public.interview_stored_objects o
        ON o.storage_key=r.object_key AND o.session_id=r.session_id AND o.organization_id=$1 AND o.schema_name=$2
      WHERE r.id=$3`, [recorded.id, recorded.schema, recording.id])).rows[0]
    assert.ok(storedAudio)
    const expectedAudio = interviewObjects.find(item => item.key === storedAudio.key)
    assert.ok(expectedAudio)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedAudio.hash)
    const outsider = clients.find(item => item.account.id !== recorded.id)
    assert.equal((await outsider.request(recordingBase + '/' + recording.id)).status, 404)
    result.restoredAudio = { bytes: bytes.length, hashMatched: true, crossCompanyRejected: true, sourceUnavailableDuringRead: true }
    const schema = '"' + accounts[0].schema + '"', taskId = randomUUID()
    const task = await pool.query(`INSERT INTO ${schema}.analysis_tasks(id,resume_id,status,idempotency_key,organization_id)
      SELECT $1,r.id,'queued',$2,r.organization_id FROM ${schema}.resumes r WHERE r.candidate_id=$3 ORDER BY r.id LIMIT 1 RETURNING id`,
    [taskId, 'recovery-' + taskId, target.id])
    assert.equal(task.rowCount, 1)
    const deadline = Date.now() + 20000
    while (true) {
      const state = (await pool.query('SELECT status,last_error FROM ' + schema + '.analysis_tasks WHERE id=$1', [taskId])).rows[0]
      assert.notEqual(state.status, 'failed', '恢复后台任务失败：' + state.last_error)
      if (state.status === 'completed') break
      assert.ok(Date.now() < deadline, '恢复后的真实后台任务未完成'); await delay(25)
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ' + schema + '.analysis_results WHERE analysis_task_id=$1', [taskId])).rows[0].n, 1)
    result.restoredTaskCompleted = true
    result.taskUsesProductionLocalAnalyzer = true
    result.serviceRestartVerified = true
  } catch (error) {
    error.recoveryEvidence = result
    throw error
  } finally {
    const outcomes = await Promise.allSettled([worker?.stop(), api?.stop()])
    if (mounted) { assert.equal(await realpath(source), source); await rename(source, storageRoot) }
    if (parkedOriginal) { assert.equal(await realpath(parked), parked); await rename(parked, source) }
    assert.deepEqual(await files(source), originalFiles); result.sourceObjectsPreserved = true
    assert.deepEqual(await files(audioFallback), [])
    result.sourceAudioPreserved = true
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND application_name='closure-restored-services'", [database])).rows[0].n, 0)
    const errors = outcomes.filter(item => item.status === 'rejected').map(item => item.reason)
    if (errors.length) {
      const error = new AggregateError(errors, '恢复服务关停失败')
      error.recoveryEvidence = result
      throw error
    }
  }
  return result
}
