import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { createServer as createListener } from 'node:net'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { startIsolatedPostgres, projectRoot } from './isolated-environment.mjs'

const option = name => process.argv[process.argv.indexOf(name) + 1]
assert.ok(process.argv.includes('--postgres-bin') && process.argv.includes('--release'))
const release = resolve(option('--release'))
const { control } = await import(pathToFileURL(join(release, 'scripts/runtime-control.mjs')).href)
const instance = await startIsolatedPostgres(option('--postgres-bin'))
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
const { Pool } = require('pg')
const admin = new Pool(instance.connection)
admin.on('error', () => {})
let pool, created = false, pm2, names = [], id, env
const report = { startedAt: new Date().toISOString(), scope: 'Synthetic independent PostgreSQL and sealed release; no business data or external services', checks: {}, samples: [], cleanup: {} }
const output = join(instance.directory, 'managed-runtime-report.json')
const stub = createServer((_req, res) => { res.writeHead(405); res.end() })
const freePort = async () => {
  const server = createListener()
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  const port = server.address().port
  await new Promise(yes => server.close(yes))
  return port
}
const invoke = (action, args = []) => control(action, { root: projectRoot, args, env })
const method = (name, ...args) => new Promise((yes, no) => pm2[name](...args, (error, value) => error ? no(error) : yes(value)))
const waitFor = async (operation, timeout = 60000) => {
  const until = Date.now() + timeout
  do { const value = await operation(); if (value) return value; await delay(1000) } while (Date.now() < until)
  throw new Error('Isolated acceptance deadline exceeded')
}
try {
  assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name, instance.cluster)
  await admin.query('CREATE DATABASE "' + instance.database + '"'); created = true
  pool = new Pool({ ...instance.connection, database: instance.database })
  const { runMigrations } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/db/migrations.js')).href)
  report.checks.migrations = (await runMigrations(pool, join(projectRoot, 'db/migrations'))).applied.length
  await pool.end(); pool = undefined
  await mkdir(instance.env.RECRUITING_QUARANTINE_ROOT, { recursive: true })
  await mkdir(instance.env.INTERVIEW_STORAGE_ROOT, { recursive: true })
  await new Promise(yes => stub.listen(0, '127.0.0.1', yes))
  const api = await freePort(), worker = await freePort(), web = await freePort()
  env = { ...instance.env, RUNTIME_HOME: join(instance.directory, 'managed-state'), NODE_ENV: 'production',
    PORT: String(api), WORKER_HEALTH_PORT: String(worker), WEB_PORT: String(web), WORKER_DB_POLL: 'true',
    AUTH_OTP_HMAC_SECRET: 'isolated-test-only-otp-secret-00000000000000', AUTH_MFA_ENCRYPTION_KEY: 'isolated-test-only-mfa-secret-00000000000000',
    FUNASR_BASE_URL: 'http://127.0.0.1:' + stub.address().port + '/transcribe', OCR_SERVICE_URL: 'http://127.0.0.1:' + stub.address().port,
    OPENAI_BASE_URL: 'http://127.0.0.1:' + stub.address().port + '/v1', OPENAI_API_KEY: 'isolated-test-only', OPENAI_MODEL: 'isolated-test-only',
  }
  const started = await invoke('start', ['--release', release])
  assert.equal(started.ready, true, JSON.stringify(started))
  report.checks.startAndProxy = started
  console.log('Isolated runtime ready: ' + started.url)
  if (process.argv.includes('--browser-node-modules')) {
    const runtimeRequire = createRequire(join(resolve(option('--browser-node-modules')), 'playwright/package.json'))
    const { chromium } = runtimeRequire('playwright')
    const browser = await chromium.launch({ channel: 'chrome', headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 1365, height: 900 } })
      const errors = []; page.on('pageerror', error => errors.push(error.message))
      await page.goto(started.url, { waitUntil: 'networkidle' })
      assert.ok((await page.locator('body').innerText()).trim().length > 20)
      assert.equal(await page.locator('vite-error-overlay').count(), 0)
      assert.deepEqual(errors, [])
      await page.screenshot({ path: join(instance.directory, 'managed-web-desktop.png'), fullPage: true })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.screenshot({ path: join(instance.directory, 'managed-web-mobile.png'), fullPage: true })
      report.checks.browser = { pageErrors: errors, url: page.url(), desktop: '1365x900', mobile: '390x844', textLength: (await page.locator('body').innerText()).length }
    } finally { await browser.close() }
  }
  const activeFile = join(env.RUNTIME_HOME, 'active-release.json'), before = await readFile(activeFile, 'utf8')
  const status = await invoke('status'); assert.equal(status.ready, true)
  id = status.processes[0] && (await import('node:crypto')).createHash('sha256').update(env.RUNTIME_HOME.toLowerCase()).digest('hex').slice(0, 12)
  names = ['api', 'worker', 'web'].map(role => 'recruit-' + id + '-' + role)
  const PM2 = require('pm2').custom
  pm2 = new PM2({ pm2_home: process.env.PM2_HOME }); await method('connect')
  const owned = async role => (await method('list')).find(item => item.name === 'recruit-' + id + '-' + role)
  // Only kill a process whose exact managed role, script and instance are proven.
  const crash = async role => {
    const item = await owned(role)
    assert.equal(resolve(item.pm2_env.pm_exec_path), join(release, 'scripts/runtime-role.mjs'))
    assert.equal(item.pm2_env.RUNTIME_INSTANCE_ID, 'recruit-' + id)
    assert.ok(item.pid > 0)
    process.kill(item.pid, 'SIGKILL')
    return item.pid
  }
  const oldPid = await crash('api')
  await waitFor(async () => { const item = await owned('api'); return item.pid !== oldPid && item.pm2_env.status === 'online' && (await invoke('status')).ready })
  report.checks.unexpectedExitRecovered = true
  // Sample actual PM2 RSS/CPU and connection counts under steady synthetic probes.
  for (let n = 0; n < 12; n++) {
    const sample = await invoke('status'); assert.equal(sample.ready, true)
    report.samples.push({ at: new Date().toISOString(), processes: sample.processes,
      databaseConnections: (await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [instance.database])).rows[0].n })
    await delay(5000)
  }
  report.checks.resourceObservationSeconds = 60
  for (let n = 0; n < 2; n++) {
    const pid = await crash('api')
    await waitFor(async () => { const item = await owned('api'); return n === 0 ? item.pid > 0 && item.pid !== pid && item.pm2_env.status === 'online' : (await invoke('status')).processes.some(value => value.role === 'api' && value.pid === 0 && value.status === 'circuit-open') })
  }
  const circuit = await owned('api'), restarts = circuit.pm2_env.restart_time
  const startsFile = join(env.RUNTIME_HOME, 'api-starts.json'), starts = await readFile(startsFile, 'utf8')
  await delay(Math.max(7000, (circuit.pm2_env.prev_restart_delay || 0) + 2000))
  const afterCircuit = await owned('api')
  assert.equal(afterCircuit.pid, 0)
  assert.equal(afterCircuit.pm2_env.restart_time, restarts)
  assert.equal(await readFile(startsFile, 'utf8'), starts)
  assert.equal((await invoke('status')).ready, false)
  report.checks.crashCircuitNoStorm = { noPid: true, restarts, starts: JSON.parse(starts).length, status: (await invoke('status')).processes.find(value => value.role === 'api') }
  await invoke('stop')
  // An occupied port must survive a refused start and keep the active pointer.
  const sentinel = createServer((_req, res) => res.end('sentinel'))
  await new Promise(yes => sentinel.listen(api, '127.0.0.1', yes))
  try {
    await assert.rejects(invoke('start', ['--release', release]), /PORT_CONFLICT/)
    assert.equal(await (await fetch('http://127.0.0.1:' + api)).text(), 'sentinel')
    assert.equal(await readFile(activeFile, 'utf8'), before)
    report.checks.portConflictNoKill = true
  } finally { await new Promise(yes => sentinel.close(yes)) }
  const invalid = join(instance.directory, 'failed-release'); await mkdir(invalid)
  await writeFile(join(invalid, 'release-manifest.json'), JSON.stringify({ format: 1, id: 'invalid', files: [], sha256: 'invalid' }))
  await assert.rejects(invoke('start', ['--release', invalid]), /RELEASE_CHANGED/)
  assert.equal(await readFile(activeFile, 'utf8'), before)
  report.checks.failedUpgradePreservesPointer = true
  // A valid artifact can still fail activation readiness; remove only the new owned registrations.
  await assert.rejects(control('start', { root: projectRoot, args: ['--release', release], env: { ...env, OCR_SERVICE_URL: '' } }), /STARTUP_NOT_READY/)
  assert.equal(await readFile(activeFile, 'utf8'), before)
  assert.equal((await method('list')).filter(item => names.includes(item.name)).length, 0)
  report.checks.failedActivationCleansNewProcesses = true
  assert.equal((await invoke('start', ['--release', release])).ready, true)
  await instance.stop()
  await waitFor(async () => {
    const items = (await invoke('status')).processes
    return ['api', 'worker'].every(role => items.some(item => item.role === role && item.pid === 0 && item.status === 'circuit-open'))
  }, 60000)
  assert.equal((await invoke('status')).ready, false)
  report.checks.databaseDisconnectCircuit = true
  report.passed = true
} catch (error) { report.passed = false; report.failure = { name: error.name, message: error.message }; process.exitCode = 1 }
finally {
  const clean = async (name, action) => { try { await action(); report.cleanup[name] = true } catch (error) { report.cleanup[name] = error.message; report.passed = false; process.exitCode = 1 } }
  if (env) await clean('managedStopped', () => invoke('stop'))
  if (pm2) {
    for (const name of names) await clean(name + '-deleted', async () => {
      const item = (await method('list')).find(value => value.name === name)
      if (!item) return
      assert.equal(item.pm2_env.RUNTIME_INSTANCE_ID, 'recruit-' + id)
      assert.equal(resolve(item.pm2_env.pm_exec_path), join(release, 'scripts/runtime-role.mjs'))
      await method('delete', item.pm_id)
    })
    pm2.disconnect()
  }
  await clean('migrationPool', async () => { await pool?.end() })
  await clean('adminPool', () => admin.end())
  await clean('stubClosed', async () => { if (stub.listening) await new Promise(yes => stub.close(yes)) })
  await clean('postgresStopped', () => instance.stop())
  report.cleanup.syntheticDatabaseRetainedInStoppedCluster = created
  report.finishedAt = new Date().toISOString()
  await writeFile(output, JSON.stringify(report, null, 2))
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks, failure: report.failure, report: output, cleanup: report.cleanup }, null, 2))
