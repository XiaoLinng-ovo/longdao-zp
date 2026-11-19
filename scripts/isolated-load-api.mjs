import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { join } from 'node:path'
import { isolatedEnvironment, projectRoot } from './isolated-environment.mjs'

export function loadApiEnvironment(instance, { smtp, model, otpSecret }) {
  assert.match(instance.database, /^closure_verify_[a-f0-9]{32}$/)
  for (const port of [instance.port, smtp.port, model.port]) assert.ok(Number.isInteger(port) && port > 0 && port <= 65535)
  assert.ok(smtp.password && model.apiKey && otpSecret)
  return isolatedEnvironment({ ...instance.env, PGAPPNAME: 'closure-load-api',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false',
    SMTP_USER: 'sender@example.invalid', SMTP_PASSWORD: smtp.password, SMTP_FROM: 'sender@example.invalid',
    AUTH_OTP_HMAC_SECRET: otpSecret,
    OPENAI_BASE_URL: 'http://127.0.0.1:' + model.port + '/v1', OPENAI_API_KEY: model.apiKey, OPENAI_MODEL: 'isolated-synthetic-model',
    OBJECT_CLEANUP_POLL: 'on',
    ISOLATED_ALLOWED_PORTS: [instance.port, smtp.port, model.port].join(','),
  }, instance.env)
}

async function within(promise, milliseconds, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

export async function startLoadApi({ instance, smtp, model, otpSecret }) {
  const env = loadApiEnvironment(instance, { smtp, model, otpSecret })
  const child = fork(join(projectRoot, 'scripts/load-api-process-child.mjs'), [], {
    cwd: projectRoot, env, windowsHide: true, execArgv: ['--require', join(projectRoot, 'scripts/isolated-network-guard.cjs')],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const evidence = { pid: child.pid, independentProcess: true, events: [], stdout: '', stderr: '' }
  const measurements = new Map()
  let sequence = 0
  for (const key of ['stdout', 'stderr']) child[key].on('data', value => { evidence[key] = (evidence[key] + String(value)).slice(-65536) })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => { evidence.exit = { code, signal }; resolve() }))
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.on('message', message => {
      if (message.type === 'measurement') { measurements.get(message.sequence)?.(message); return }
      if (evidence.events.length < 1000) evidence.events.push(message)
      if (message.type === 'ready') resolve(message)
      if (message.type === 'failure') reject(new Error(message.message))
    })
  })
  const forceStop = async () => {
    if (!evidence.exit) { evidence.forcedKill = true; child.kill(); await within(exited, 10000, '容量 API 强制关停未完成') }
  }
  try {
    const message = await within(Promise.race([ready, exited.then(() => { throw new Error('容量 API 提前退出：' + evidence.stderr) })]), 30000, '容量 API 启动超时')
    assert.equal(message.pid, child.pid)
    return { evidence, port: message.port, async measure() {
      assert.ok(!evidence.exit, '容量 API 已退出')
      const id = ++sequence
      try {
        const measured = new Promise(resolve => measurements.set(id, resolve))
        child.send({ type: 'measure', sequence: id })
        return await within(measured, 5000, '容量 API 采样超时')
      } finally { measurements.delete(id) }
    }, async close({ expectedDatabaseDisconnect = false } = {}) {
      try {
        if (!evidence.exit) { child.send({ type: 'stop' }); await within(exited, 10000, '容量 API 未自然退出') }
        assert.deepEqual(evidence.exit, { code: 0, signal: null })
        assert.equal(evidence.events.filter(item => item.type === 'closed').length, 1)
        assert.deepEqual(evidence.events.filter(item => ['diagnostic', 'failure'].includes(item.type)), [])
        if (expectedDatabaseDisconnect && evidence.stderr) {
          assert.equal(evidence.stderr.match(/unhandled request error/g)?.length, 1)
          assert.match(evidence.stderr, /code: '57P01'/)
        } else assert.equal(evidence.stderr, '', '容量 API 存在标准错误输出')
      } finally { await forceStop() }
    } }
  } catch (error) { await forceStop(); error.apiEvidence = evidence; throw error }
}
