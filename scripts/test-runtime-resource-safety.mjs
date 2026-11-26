import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { bindPoolCancellation, createShutdownBudget, runWithRuntimeSignal } from '../packages/runtime-lifecycle/index.js'

const argument = process.argv.indexOf('--postgres-bin')
assert.ok(argument >= 0 && process.argv[argument + 1], '必须显式指定 --postgres-bin，禁止读取业务配置')
const sslArgument = process.argv.indexOf('--openssl')
const instance = await startIsolatedPostgres(process.argv[argument + 1], { openssl: sslArgument < 0 ? undefined : process.argv[sslArgument + 1] })
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, instance.env)
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
const { Pool } = require('pg')
const pools = new Set()
const own = options => { const pool = new Pool({ ...instance.connection, ...options }); pools.add(pool); return pool }
const observer = own({ application_name: 'closure-resource-observer' })
const report = { startedAt: new Date().toISOString(), checks: {}, cleanup: {}, failures: [] }
const output = join(instance.directory, 'resource-safety-report.json')
let created = false
async function waitFor(predicate, timeout = 2000) {
  const start = performance.now()
  while (!await predicate()) { assert.ok(performance.now() - start < timeout, '真实资源未按时回收'); await delay(10) }
}
const noSession = async pid => (await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0].n === 0
async function check(name, operation) {
  const start = performance.now()
  try { report.checks[name] = { passed: true, ...await operation(), elapsedMs: performance.now() - start }; console.log('资源测试通过：' + name) }
  catch(error) { report.failures.push({ name, message: error.message, stack: error.stack }); throw error }
  finally { await writeFile(output, JSON.stringify(report, null, 2)) }
}
try {
  require(join(projectRoot, 'scripts/isolated-network-guard.cjs'))
  assert.equal((await observer.query('SHOW cluster_name')).rows[0].cluster_name, instance.cluster)
  await observer.query('CREATE DATABASE "' + instance.database + '"'); created = true
  const { bindTenantSearchPath } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/db/connection.js')).href)
  const { runWithTenantContext } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/db/tenant-context.js')).href)
  await check('活动查询取消与实例隔离', async () => {
    const cancellation = new AbortController()
    const pool = bindPoolCancellation(own({ max: 1, application_name: 'closure-active-query' }), cancellation.signal)
    const other = own({ max: 1, application_name: 'closure-unaffected' })
    const client = await pool.connect()
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const query = client.query('SELECT pg_sleep(30)').then(() => { throw new Error('长查询意外完成') }, error => error)
    await waitFor(async () => (await observer.query("SELECT state FROM pg_stat_activity WHERE pid=$1 AND wait_event='PgSleep'", [pid])).rows.length === 1)
    cancellation.abort(new Error('synthetic-shutdown'))
    assert.ok((await query) instanceof Error)
    client.release()
    await waitFor(() => noSession(pid))
    assert.equal((await other.query('SELECT 42 AS n')).rows[0].n, 42)
    assert.equal(pool.totalCount, 0)
    return { serverQueryEnded: true, otherPoolUnaffected: true }
  })
  await check('排队连接取消与晚到回收', async () => {
    const cancellation = new AbortController()
    const pool = bindPoolCancellation(own({ max: 1, application_name: 'closure-queued-client' }), cancellation.signal)
    const holder = await pool.connect()
    const waiting = pool.connect().then(() => { throw new Error('已取消等待者拿到连接') }, error => error)
    await waitFor(() => pool.waitingCount === 1)
    cancellation.abort(new Error('synthetic-queued-abort'))
    assert.equal((await waiting).message, 'synthetic-queued-abort')
    holder.release()
    await waitFor(() => pool.waitingCount === 0 && pool.totalCount === 0)
    return { waitingRejected: true, lateClientDestroyed: true }
  })
  if (instance.certificate) for (const sslnegotiation of ['postgres', 'direct']) {
    await check('真实加密查询取消：' + sslnegotiation, async () => {
      const cancellation = new AbortController()
      const pool = bindPoolCancellation(own({ max: 1, ssl: { ca: await readFile(instance.certificate, 'utf8') }, sslnegotiation }), cancellation.signal)
      const client = await pool.connect()
      const pid = client.processID
      assert.equal((await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl, true)
      const query = client.query('SELECT pg_sleep(30)').catch(error => error)
      await waitFor(async () => (await observer.query("SELECT pid FROM pg_stat_activity WHERE pid=$1 AND wait_event='PgSleep'", [pid])).rowCount === 1)
      cancellation.abort(new Error('synthetic-ssl-abort'))
      assert.equal((await query).code, '57014')
      client.release()
      pools.delete(pool)
      await pool.end()
      await waitFor(() => noSession(pid))
      return { encrypted: true, serverConfirmedCancellation: true, certificateVerified: true }
    })
  }
  await check('租户重置期间取消竞争', async () => {
    const cancellation = new AbortController()
    const pool = bindTenantSearchPath(bindPoolCancellation(own({ max: 1, application_name: 'closure-reset-race' }), cancellation.signal))
    const client = await pool.connect()
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const query = client.query.bind(client)
    let resetting = false
    client.query = (...args) => { if (args[0] === 'RESET search_path') { resetting = true; return query('SELECT pg_sleep(30)') } return query(...args) }
    client.release()
    await waitFor(() => resetting)
    cancellation.abort(new Error('synthetic-reset-abort'))
    await waitFor(() => noSession(pid))
    await waitFor(() => pool.totalCount === 0)
    return { resetCancelled: true, clientActuallyDestroyed: true }
  })
  await check('租户连接复用不串库', async () => {
    const pool = bindTenantSearchPath(own({ database: instance.database, max: 1 }))
    const organizations = ['a'.repeat(32), 'b'.repeat(32)]
    const expected = organizations.map(id => 'company_' + id).concat('public')
    for (const schema of expected.slice(0, 2)) await pool.query('CREATE SCHEMA ' + schema)
    for (let iteration = 0; iteration < 30; iteration++) {
      const schema = expected[iteration % 3]
      const operation = async () => assert.equal((await pool.query('SELECT current_schema() AS schema')).rows[0].schema, schema)
      if (schema === 'public') await operation()
      else await runWithTenantContext({ organizationId: organizations[iteration % 3], schemaName: schema }, operation)
    }
    return { queries: 30, maxConnections: 1 }
  })
  await check('统一期限取消真实数据库操作', async () => {
    const budget = createShutdownBudget(500)
    const pool = runWithRuntimeSignal(budget.signal, () => bindPoolCancellation(own({ max: 1 })))
    const client = await pool.connect()
    const work = client.query('SELECT pg_sleep(30)').finally(() => client.release())
    const observed = work.catch(error => error)
    await budget.run('real-postgres-query', async () => { await observed; pools.delete(pool); await pool.end() })
    assert.ok((await observed) instanceof Error)
    assert.equal(pool.totalCount, 0)
    return { budgetMs: 500, queryCancelled: true, poolDrained: true }
  })
  report.passed = true
} catch(error) { report.passed = false; report.failure = error.message; process.exitCode = 1 }
finally {
  const cleanupErrors = []
  for (const pool of pools) { try { await pool.end() } catch(error) { cleanupErrors.push({ message: error.message, causes: error.errors?.map(cause => ({ code: cause.code, reasonCode: cause.reasonCode })) }) } }
  if (created) {
    const admin = new Pool(instance.connection)
    try { await admin.query('DROP DATABASE "' + instance.database + '" WITH (FORCE)'); report.cleanup.databaseDropped = true }
    catch(error) { cleanupErrors.push(error.message) }
    finally { await admin.end() }
  }
  try { await instance.stop(); report.cleanup.postgresStopped = true } catch(error) { cleanupErrors.push(error.message) }
  if (cleanupErrors.length) { report.passed = false; report.cleanup.errors = cleanupErrors; process.exitCode = 1 }
  report.finishedAt = new Date().toISOString()
  await writeFile(output, JSON.stringify(report, null, 2))
}
console.log(JSON.stringify({ passed: report.passed, report: output, cleanup: report.cleanup, failure: report.failure }))
