import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { testCodeFingerprint } from './test-code-fingerprint.mjs'

export function successfulTapSummary(output) {
  const summary = {}
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...output.matchAll(new RegExp('^# ' + name + ' (\\d+)\\s*$', 'gm'))]
    assert.equal(matches.length, 1, '测试统计缺失或重复：' + name)
    summary[name] = Number(matches[0][1])
  }
  assert.ok(summary.tests > 0, '不能将未执行测试当作通过')
  assert.equal(summary.pass, summary.tests)
  for (const name of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(summary[name], 0, '不能忽略失败、取消或跳过：' + name)
  return summary
}

function runSuite(suite, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', join(projectRoot, 'scripts/isolated-listener-ports.cjs'), '--test', '--test-isolation=none', '--test-reporter=tap',
      join(projectRoot, 'apps/api/dist/tests', suite + '.postgres.integration.test.js')], {
      cwd: projectRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
    })
    let output = '', overflow = false
    const capture = data => {
      if (overflow) return
      if (Buffer.byteLength(output) + data.length > 8 * 1024 * 1024) { overflow = true; child.kill(); return }
      output += data.toString()
    }
    child.stdout.on('data', capture); child.stderr.on('data', capture)
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, output, overflow }))
  })
}

export async function main(postgresBin) {
  assert.ok(postgresBin, '必须显式指定专用 PostgreSQL 工具目录，禁止读取业务连接')
  const fingerprint = await testCodeFingerprint(projectRoot)
  const instance = await startIsolatedPostgres(postgresBin)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, instance.env)
  const require = createRequire(join(projectRoot, 'apps/api/package.json'))
  require(join(projectRoot, 'scripts/isolated-network-guard.cjs'))
  const { Pool } = require('pg')
  const admin = new Pool(instance.connection)
  const suites = ['payments', 'payments.http', 'payment-product-versions', 'configurable-billing', 'enterprise-continuity',
    'alipay-bills', 'payment-cancellation', 'payment-order-environment', 'migrations', 'release-readiness']
  const report = { startedAt: new Date().toISOString(), suites: [], cleanup: {}, failures: [], codeFingerprint: fingerprint.sha256,
    boundary: '随机专用PG集群；每套独立数据库与无超级权限账号；禁止业务环境配置和外部网络；仅外部支付适配器为替身' }
  const output = join(instance.directory, 'business-postgres-report.json')
  try {
    assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name, instance.cluster)
    assert.equal(Number((await admin.query('SELECT inet_server_port() AS port')).rows[0].port), instance.port)
    assert.equal((await admin.query('SELECT current_user AS role')).rows[0].role, instance.connection.user)
    await admin.query('REVOKE CONNECT ON DATABASE postgres FROM PUBLIC; REVOKE CONNECT ON DATABASE template1 FROM PUBLIC')
    const { runMigrations } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/db/migrations.js')))
    for (const suite of suites) {
      const suffix = randomUUID().replaceAll('-', '')
      const database = 'reliability_verify_' + suffix, role = 'closure_suite_' + suffix
      assert.match(database, /^reliability_verify_[a-f0-9]{32}$/)
      assert.match(role, /^closure_suite_[a-f0-9]{32}$/)
      const password = randomBytes(32).toString('hex')
      let pool, created = false, roleCreated = false
      const result = { suite, database, startedAt: new Date().toISOString() }
      report.suites.push(result)
      console.log('验证：独立业务数据库 ' + suite)
      try {
        await admin.query('CREATE ROLE "' + role + '" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD \'' + password + '\''); roleCreated = true
        await admin.query('CREATE DATABASE "' + database + '" OWNER "' + role + '"'); created = true
        await admin.query('REVOKE CONNECT ON DATABASE "' + database + '" FROM PUBLIC')
        pool = new Pool({ ...instance.connection, user: role, password, database, max: 2 })
        const identity = (await pool.query(`SELECT current_database() AS database,current_user AS role,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
          FROM pg_roles WHERE rolname=current_user`)).rows[0]
        assert.equal(identity.database, database); assert.equal(identity.role, role)
        for (const permission of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls']) assert.equal(identity[permission], false)
        result.restrictedRoleVerified = true
        result.migrations = (await runMigrations(pool, join(projectRoot, 'db/migrations'))).applied.length
        await pool.end(); pool = undefined
        const execution = await runSuite(suite, { ...instance.env, NODE_ENV: 'test', PGUSER: role, PGPASSWORD: password, PGDATABASE: database,
          RELIABILITY_TEST_DATABASE: database, TENANT_SCHEMA_ROUTING: 'off',
          PAYMENT_MIGRATION_PROBE: ['payment-cancellation', 'payment-order-environment'].includes(suite) ? 'true' : 'false' })
        await writeFile(join(instance.directory, suite + '.tap.log'), execution.output)
        result.exitCode = execution.code; result.signal = execution.signal
        assert.equal(execution.overflow, false, '测试日志超过容量，已停止子进程')
        assert.equal(execution.code, 0, '业务集成测试失败，请查看本轮 TAP 日志：' + suite)
        assert.equal(execution.signal, null)
        result.summary = successfulTapSummary(execution.output)
        result.passed = true
      } catch (error) { result.passed = false; throw error }
      finally {
        try { await pool?.end() }
        finally {
          try {
            if (created) {
              await admin.query('DROP DATABASE "' + database + '" WITH (FORCE)')
              result.databaseRemoved = true
            }
          } finally {
            if (roleCreated) { await admin.query('DROP ROLE "' + role + '"'); result.roleRemoved = true }
          }
        }
        result.finishedAt = new Date().toISOString()
        await writeFile(output, JSON.stringify(report, null, 2))
      }
    }
    report.passed = report.suites.length === suites.length && report.suites.every(item => item.passed && item.databaseRemoved && item.roleRemoved)
  } catch (error) {
    report.passed = false; report.failures.push({ name: error.name, message: error.message, stack: error.stack }); process.exitCode = 1
    console.error('隔离业务数据库测试失败：' + error.message)
  } finally {
    const clean = async (name, action) => {
      try { await action(); report.cleanup[name] = true }
      catch (error) { report.passed = false; report.failures.push({ cleanup: name, message: error.message }); process.exitCode = 1 }
    }
    await clean('adminPoolClosed', () => admin.end())
    await clean('postgresStopped', () => instance.stop())
    await clean('codeUnchangedDuringRun', async () => assert.equal((await testCodeFingerprint(projectRoot)).sha256, fingerprint.sha256))
    report.finishedAt = new Date().toISOString()
    await writeFile(output, JSON.stringify(report, null, 2))
    console.log('报告：' + output)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = process.argv.indexOf('--postgres-bin')
  await main(argument < 0 ? undefined : process.argv[argument + 1])
}
