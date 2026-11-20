import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { startLocalModelBoundary } from './local-model-boundary.mjs'
import { startBrowserWorker } from './isolated-browser-worker.mjs'
import { testCodeFingerprint } from './test-code-fingerprint.mjs'

const argument = process.argv.indexOf('--postgres-bin')
assert.ok(argument >= 0 && process.argv[argument + 1])
const fingerprint = await testCodeFingerprint(projectRoot)
const instance = await startIsolatedPostgres(process.argv[argument + 1])
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, instance.env)
const require = createRequire(join(projectRoot, 'apps/api/package.json')), { Pool } = require('pg')
const admin = new Pool(instance.connection)
const report = { startedAt: new Date().toISOString(), failures: [], diagnostics: [], cleanup: {}, passed: false, codeFingerprint: fingerprint.sha256 }
let created = false, pool, model, worker
try {
  assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name, instance.cluster)
  await admin.query('CREATE DATABASE "' + instance.database + '"'); created = true
  pool = new Pool({ ...instance.connection, database: instance.database })
  const { runMigrations } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/db/migrations.js')).href)
  report.migrations = (await runMigrations(pool, join(projectRoot, 'db/migrations'))).applied.length
  await mkdir(join(instance.directory, 'storage'))
  model = await startLocalModelBoundary({ apiKey: 'isolated-process-proof' })
  worker = await startBrowserWorker({ instance, runtimeEnv: { ...instance.env,
    OPENAI_BASE_URL: 'http://127.0.0.1:' + model.port + '/v1', OPENAI_API_KEY: 'isolated-process-proof', OPENAI_MODEL: 'isolated-synthetic-model',
  }, onDiagnostic(message) { report.diagnostics.push(message) } })
  report.workerProcess = worker.evidence
  assert.notEqual(worker.evidence.pid, process.pid)
  await delay(150)
  const start = performance.now()
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1800)
  report.parentBlockedMs = performance.now() - start
  assert.ok(report.parentBlockedMs >= 1800)
  await delay(200)
  await worker.close(); worker = undefined
  assert.deepEqual(report.diagnostics, [])
  const closed = report.workerProcess.events.find(item => item.type === 'closed')
  assert.ok(closed.pools >= 2)
  assert.ok(closed.eventLoopMaxMs < 1000, '父进程阻塞不能延迟独立Worker事件循环超过连接时限')
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='closure-browser-worker'")).rows[0].n, 0)
  report.passed = true
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack, workerEvidence: error.workerEvidence }); process.exitCode = 1
} finally {
  const clean = async (name, action) => { try { await action(); report.cleanup[name] = true } catch (error) { report.failures.push({ cleanup: name, message: error.message }); report.passed = false; process.exitCode = 1 } }
  await clean('workerClosed', () => worker?.close())
  await clean('modelClosed', () => model?.close())
  await clean('testPoolClosed', () => pool?.end())
  if (created) await clean('databaseDropped', () => admin.query('DROP DATABASE "' + instance.database + '" WITH (FORCE)'))
  await clean('adminPoolClosed', () => admin.end())
  await clean('postgresStopped', () => instance.stop())
  await clean('codeUnchangedDuringRun', async () => assert.equal((await testCodeFingerprint(projectRoot)).sha256, fingerprint.sha256))
  report.finishedAt = new Date().toISOString()
  const output = join(instance.directory, 'browser-worker-process-report.json')
  await writeFile(output, JSON.stringify(report, null, 2)); console.log('报告：' + output)
}
