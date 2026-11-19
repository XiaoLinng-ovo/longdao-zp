import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startIsolatedPostgres } from './isolated-environment.mjs'
import { writePrivateRecoveryFile, protectRecoveryPath } from './private-recovery-files.mjs'

const root = resolve(import.meta.dirname, '..')
const binary = process.argv[process.argv.indexOf('--postgres-bin') + 1]
assert.ok(process.argv.includes('--postgres-bin') && binary)
const { Pool } = createRequire(join(root, 'apps/api/package.json'))('pg')
const { runMigrations } = await import(pathToFileURL(join(root, 'apps/api/dist/src/db/migrations.js')).href)
const instance = await startIsolatedPostgres(binary)
await protectRecoveryPath(instance.directory)
const admin = new Pool(instance.connection)
const database = 'reliability_verify_' + instance.cluster.slice('closure_'.length)
const report = { startedAt: new Date().toISOString(), isolated: true, database, passed: false }
let pool
try {
  assert.match(database, /^reliability_verify_[a-f0-9]{32}$/)
  await admin.query('CREATE DATABASE "' + database + '"')
  pool = new Pool({ ...instance.connection, database, max: 2 })
  const result = await runMigrations(pool, join(root, 'db/migrations'))
  report.migrations = result.applied.length
  await pool.end(); pool = undefined
  const env = { ...instance.env, NODE_ENV: 'test', PGDATABASE: database, RELIABILITY_TEST_DATABASE: database,
    DB_POOL_MAX: '10', TENANT_SCHEMA_ROUTING: 'off', QUESTION_SHEET_POLL: 'off', OPENAI_API_KEY: '', OPENAI_BASE_URL: '', OPENAI_MODEL: '' }
  const execution = await new Promise((yes, no) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', join(root, 'apps/api/dist/tests/configurable-billing.postgres.integration.test.js')], { cwd: root, env, windowsHide: true, timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
    child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, output }))
  })
  await writePrivateRecoveryFile(join(instance.directory, 'test.log'), execution.output)
  report.exitCode = execution.code; report.signal = execution.signal; report.passed = execution.code === 0
  console.log(execution.output)
} finally {
  if (pool) await pool.end()
  await admin.end(); await instance.stop()
  report.stopped = true; report.finishedAt = new Date().toISOString()
  await writePrivateRecoveryFile(join(instance.directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, reportPath: join(instance.directory, 'report.json') }, null, 2))
}
if (!report.passed) process.exitCode = 1
