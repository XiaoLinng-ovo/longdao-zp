import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { join } from 'node:path'
import { isolatedEnvironment, projectRoot } from './isolated-environment.mjs'

export function browserWorkerEnvironment(instance, runtimeEnv, ocr) {
  assert.equal(runtimeEnv.PGDATABASE, instance.database)
  assert.equal(runtimeEnv.ISOLATED_TEST_CLUSTER, instance.cluster)
  assert.equal(runtimeEnv.RECRUITING_QUARANTINE_ROOT, join(instance.directory, 'storage'))
  assert.equal(runtimeEnv.INTERVIEW_STORAGE_ROOT, join(instance.directory, 'interviews'))
  const model = new URL(runtimeEnv.OPENAI_BASE_URL)
  assert.equal(model.protocol, 'http:'); assert.equal(model.hostname, '127.0.0.1')
  assert.equal(model.pathname, '/v1'); assert.equal(model.username + model.password + model.search + model.hash, '')
  assert.ok(Number(model.port) > 0 && Number(model.port) <= 65535)
  assert.equal(runtimeEnv.OPENAI_MODEL, 'isolated-synthetic-model')
  assert.ok(runtimeEnv.OPENAI_API_KEY)
  assert.equal(runtimeEnv.DB_POOL_MAX, '2'); assert.equal(runtimeEnv.PGCONNECT_TIMEOUT_MS, '1000')
  if (ocr) assert.ok(Number.isInteger(ocr.port) && ocr.port > 0 && ocr.port <= 65535, 'OCR 必须使用显式本机端口')
  return isolatedEnvironment({ ...instance.env, PGAPPNAME: 'closure-browser-worker',
    WORKER_USE_LLM_ANALYSIS: 'true', WORKER_DB_POLL: 'true', WORKER_HEALTH_PORT: '0', WORKER_POLL_INTERVAL_MS: '25',
    OPENAI_BASE_URL: model.href, OPENAI_API_KEY: runtimeEnv.OPENAI_API_KEY, OPENAI_MODEL: runtimeEnv.OPENAI_MODEL,
    OPENAI_TIMEOUT_MS: '10000', ...(ocr ? { OCR_SERVICE_URL: 'http://127.0.0.1:' + ocr.port } : {}),
    ISOLATED_ALLOWED_PORTS: [instance.port, Number(model.port), ...(ocr ? [ocr.port] : [])].join(','),
  }, instance.env)
}

async function within(promise, milliseconds, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

export async function startBrowserWorker({ instance, runtimeEnv, ocr, faultProbe = false, onDiagnostic = () => {} }) {
  const env = browserWorkerEnvironment(instance, runtimeEnv, ocr)
  const child = fork(join(projectRoot, 'scripts/browser-worker-process-child.mjs'), faultProbe ? ['--fault-probe'] : [], {
    cwd: projectRoot, env, windowsHide: true, execArgv: ['--require', join(projectRoot, 'scripts/isolated-network-guard.cjs')],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const evidence = { pid: child.pid, independentProcess: true, events: [], stdout: '', stderr: '' }
  const measurements = new Map()
  let sequence = 0
  const append = (key, value) => { evidence[key] = (evidence[key] + String(value)).slice(-65536) }
  child.stdout.on('data', value => append('stdout', value)); child.stderr.on('data', value => append('stderr', value))
  const exited = new Promise(resolve => child.once('exit', (code, signal) => { evidence.exit = { code, signal }; resolve() }))
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.on('message', message => {
      if (message.type === 'measurement') { measurements.get(message.sequence)?.(message); return }
      if (evidence.events.length < 1000) evidence.events.push(message)
      if (message.type === 'ready') resolve(message)
      if (message.type === 'diagnostic') onDiagnostic(message)
      if (message.type === 'failure') reject(new Error(message.message))
    })
  })
  const forceStop = async () => {
    if (!evidence.exit) { evidence.forcedKill = true; child.kill(); await within(exited, 10000, '隔离 Worker 强制关停未完成') }
  }
  try {
    const message = await within(Promise.race([ready, exited.then(() => { throw new Error('隔离 Worker 提前退出：' + evidence.stderr) })]), 30000, '隔离 Worker 启动超时')
    assert.equal(message.pid, child.pid); assert.notEqual(child.pid, process.pid)
    return { evidence, port: message.port, ...(faultProbe ? { async crash() {
      assert.ok(!evidence.exit && child.kill('SIGKILL'), '无法终止本轮隔离 Worker')
      await within(exited, 10000, '故障注入进程未退出')
      assert.deepEqual(evidence.exit, { code: null, signal: 'SIGKILL' })
      assert.ok(!evidence.events.some(item => item.type === 'closed'))
    } } : {}), async measure() {
      assert.ok(!evidence.exit, '隔离 Worker 已退出')
      const id = ++sequence
      try {
        const measured = new Promise(resolve => measurements.set(id, resolve))
        child.send({ type: 'measure', sequence: id })
        return await within(measured, 5000, '隔离 Worker 采样超时')
      } finally { measurements.delete(id) }
    }, async close({ expectedDiagnostics = [] } = {}) {
      try {
        if (!evidence.exit) { child.send({ type: 'stop' }); await within(exited, 10000, '隔离 Worker 未自然退出') }
        assert.deepEqual(evidence.exit, { code: 0, signal: null })
        assert.equal(evidence.events.filter(item => item.type === 'closed').length, 1)
        assert.deepEqual(evidence.events.filter(item => item.type === 'failure'), [])
        assert.deepEqual(evidence.events.filter(item => item.type === 'diagnostic'), expectedDiagnostics)
      } finally { await forceStop() }
    } }
  } catch (error) {
    await forceStop(); error.workerEvidence = evidence; throw error
  }
}
