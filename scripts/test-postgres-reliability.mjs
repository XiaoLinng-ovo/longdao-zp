import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const load = file => import(pathToFileURL(join(root, 'apps/api/dist/src', file + '.js')).href)
await load('env')
const { loadDatabaseConfig } = await load('db/config')
const config = loadDatabaseConfig(), url = config.connectionString ? new URL(config.connectionString) : undefined
const host = url?.hostname ?? config.host
assert.ok(['localhost','127.0.0.1','::1','[::1]'].includes(host), '只允许连接本地测试数据库')
const options = { host, port: Number(url?.port || config.port || 5432), user: url ? decodeURIComponent(url.username) : config.user, password: url ? decodeURIComponent(url.password) : config.password }
const require = createRequire(join(root, 'apps/api/package.json'))
const { Pool } = require('pg')
const { runMigrations } = await load('db/migrations')
const admin = new Pool({ ...options, database: 'postgres', max: 1 })
const suites = ['payments','payments.http','payment-product-versions','configurable-billing','enterprise-continuity','alipay-bills','payment-cancellation','payment-order-environment','migrations','release-readiness']
const report = { startedAt: new Date().toISOString(), suites: [] }
const directory = join(root, 'tmp', 'payment_verify_' + randomUUID().replaceAll('-', ''))
await mkdir(directory, { recursive: true })
try {
  for (const suite of suites) {
    const database = 'reliability_verify_' + randomUUID().replaceAll('-', '')
    assert.match(database, /^reliability_verify_[a-f0-9]{32}$/)
    let pool, created = false
    const result = { suite, database }
    try {
      await admin.query('CREATE DATABASE "' + database + '"'); created = true
      pool = new Pool({ ...options, database, max: 2 })
      await runMigrations(pool, join(root, 'db/migrations'))
      await pool.end(); pool = undefined
      const env = { ...process.env, NODE_ENV: 'test', PGHOST: host, PGPORT: String(options.port), PGUSER: options.user, PGPASSWORD: options.password ?? '', PGDATABASE: database,
        DATABASE_URL: 'postgresql://' + encodeURIComponent(options.user) + ':' + encodeURIComponent(options.password ?? '') + '@' + host + ':' + options.port + '/' + database,
        RELIABILITY_TEST_DATABASE: database, TENANT_SCHEMA_ROUTING: 'off', QUESTION_SHEET_POLL: 'off',
        PAYMENT_MIGRATION_PROBE: ['payment-cancellation','payment-order-environment'].includes(suite) ? 'true' : 'false', OPENAI_API_KEY: '', OPENAI_BASE_URL: '', OPENAI_MODEL: '' }
      const execution = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--test', '--test-reporter=spec', join(root, 'apps/api/dist/tests', suite + '.postgres.integration.test.js')], { cwd: root, env, windowsHide: true, stdio: ['ignore','pipe','pipe'], timeout: 180_000 })
        let output = ''
        child.stdout.on('data', data => { output += data.toString() })
        child.stderr.on('data', data => { output += data.toString() })
        child.on('error', reject)
        child.on('close', (code, signal) => resolve({ code, signal, output }))
      })
      await writeFile(join(directory, suite + '.log'), execution.output)
      result.exitCode = execution.code; result.signal = execution.signal
      result.passed = execution.code === 0
      console.log(suite + ': ' + (result.passed ? '通过' : '失败'))
      if (!result.passed) { process.exitCode = 1; console.log(execution.output) }
    } catch (error) {
      result.passed = false; result.error = error.stack; process.exitCode = 1
    } finally {
      if (pool) await pool.end()
      if (created) { await admin.query('DROP DATABASE "' + database + '" WITH (FORCE)'); result.scratchDatabaseRemoved = true }
      report.suites.push(result)
    }
  }
} finally {
  await admin.end()
  report.finishedAt = new Date().toISOString()
  report.passed = report.suites.length === suites.length && report.suites.every(suite => suite.passed)
  const reportPath = join(directory, 'report.json')
  await writeFile(reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
}
