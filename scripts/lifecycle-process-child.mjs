import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { projectRoot } from './isolated-environment.mjs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.match(process.env.PGDATABASE || '', /^closure_verify_[a-f0-9]{32}$/)
assert.equal(process.env.PGHOST, '127.0.0.1')
assert.equal(process.env.SMTP_HOST, '')
assert.equal(process.env.WORKER_USE_LLM_ANALYSIS, 'false')
assert.equal(process.env.S3_ENDPOINT, '')
assert.ok(!process.env.NODE_OPTIONS && !process.env.DATABASE_URL)
const started = performance.now(), before = process.memoryUsage()
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
const { Pool } = require('pg'), pools = new Set()
const connect = Pool.prototype.connect, end = Pool.prototype.end
const endings = new Map()
Pool.prototype.connect = function (...args) { pools.add(this); return connect.apply(this, args) }
Pool.prototype.end = function (...args) { endings.set(this, (endings.get(this) ?? 0) + 1); return end.apply(this, args) }
const proof = new Pool({ application_name: 'closure-identity-check' })
try {
  assert.equal((await proof.query('SHOW cluster_name')).rows[0].cluster_name, process.env.ISOLATED_TEST_CLUSTER)
  assert.equal((await proof.query('SELECT current_database() AS db')).rows[0].db, process.env.PGDATABASE)
} finally { await proof.end() }
const load = (app, file) => import(pathToFileURL(join(projectRoot, 'apps', app, 'dist/src', file + '.js')).href)
let runtime
const mode = process.argv[2]
if (mode === 'cleanup-location-fault') {
  const { checkReleaseReadiness } = await load('api', 'db/release-readiness')
  const { ObjectCleanupService } = await load('api', 'recruiting/object-cleanup')
  const { startBackgroundPoll } = await load('api', 'background-poll')
  assert.equal(process.env.ISOLATED_FAULT_ROOT, process.env.ISOLATED_TEST_ROOT)
  const { createLocalObjectStorage } = await import(pathToFileURL(join(projectRoot, 'packages/object-storage/dist/index.js')).href)
  const { createDatabasePool } = await load('api', 'db/connection')
  const pool = createDatabasePool()
  try { await checkReleaseReadiness(pool) } catch (error) { await pool.end(); throw error }
  // Inject only the storage boundary after proving the real environment is release-ready.
  const storage = createLocalObjectStorage(join(process.env.ISOLATED_FAULT_ROOT, 'different-empty-storage'))
  const cleanup = new ObjectCleanupService(pool, storage)
  const stop = startBackgroundPoll({ intervalMs: 10000, immediate: false,
    run: async () => { await cleanup.processPending() }, onError: error => {
      process.send?.({ type: 'failure', name: error.name, code: error.code, message: error.message })
      process.exitCode = 1
    } })
  let closing
  runtime = { close: () => closing ??= (async () => { try { await stop() } finally { await storage.close?.(); await pool.end() } })() }
} else if (mode === 'api') {
  const { startServer } = await load('api', 'server'), { loadConfig } = await load('api', 'config')
  runtime = await startServer(loadConfig({ ...process.env, HOST: '127.0.0.1', PORT: '0' }))
} else {
  assert.equal(mode, 'worker')
  const { startWorker } = await load('worker', 'worker'), { loadConfig } = await load('worker', 'config')
  runtime = await startWorker(loadConfig({ ...process.env, WORKER_HEALTH_PORT: '0', WORKER_DB_POLL: 'true', WORKER_POLL_INTERVAL_MS: '25' }))
}
const readyMs = performance.now() - started
process.send?.({ type: 'ready', pid: process.pid, readyMs, ...(mode === 'cleanup-location-fault' ? {} : { port: (mode === 'api' ? runtime : runtime.healthServer).address().port }) })
let closing = false
process.on('message', message => {
  if (message?.type !== 'stop' || closing) return
  closing = true
  void (async () => {
    const began = performance.now()
    if (mode === 'api') { const work = runtime.closeAsync(); assert.equal(runtime.closeAsync(), work); await work }
    else { const work = runtime.close(); assert.equal(runtime.close(), work); await work }
    await sleep(30)
    for (const pool of pools) {
      assert.equal(endings.get(pool), 1, '所有自建池必须恰好关闭一次')
      assert.equal(pool.totalCount, 0, '关停后不能保留数据库连接')
      assert.equal(pool.waitingCount, 0, '关停后不能保留连接等待者')
    }
    if (mode !== 'cleanup-location-fault') assert.equal((mode === 'api' ? runtime : runtime.healthServer).listening, false)
    process.send?.({ type: 'closed', mode, closeMs: performance.now() - began, readyMs,
      memoryBefore: before, memoryAfter: process.memoryUsage(), maxRssBytes: process.resourceUsage().maxRSS * 1024,
      resources: process.getActiveResourcesInfo(), pools: pools.size, poolEndCalls: [...endings.values()].reduce((a,b) => a+b, 0),
    }, () => process.disconnect())
  })().catch(error => {
    process.send?.({ type: 'failure', name: error.name, code: error.code, message: error.message })
    process.exitCode = 1
    process.disconnect()
  })
})
