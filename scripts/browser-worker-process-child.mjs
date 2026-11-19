import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, realpath } from 'node:fs/promises'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot } from './isolated-environment.mjs'
import { matchesPostgresDataDirectory } from './verify-isolated-backup.mjs'

let runtime, closing
const pools = new Set(), endings = new Map(), loop = monitorEventLoopDelay({ resolution: 20 })
loop.enable()
async function close() {
  if (closing) return closing
  closing = (async () => {
    await runtime?.close()
    for (const pool of pools) {
      assert.equal(endings.get(pool), 1); assert.equal(pool.totalCount, 0); assert.equal(pool.waitingCount, 0)
    }
    assert.equal(runtime?.healthServer.listening, false)
    loop.disable()
    if (process.connected) process.send({ type: 'closed', pools: pools.size, eventLoopMaxMs: loop.max / 1e6 }, () => process.disconnect())
  })()
  return closing
}
async function main() {
  assert.match(process.env.PGDATABASE ?? '', /^closure_verify_[a-f0-9]{32}$/)
  const directory = join(projectRoot, 'tmp', process.env.PGDATABASE)
  assert.equal(process.env.ISOLATED_TEST_ROOT, directory); assert.equal(await realpath(directory), directory)
  const owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'))
  assert.equal(owner.pid, process.ppid); assert.equal(owner.purpose, 'isolated-acceptance')
  assert.equal(owner.cluster, process.env.ISOLATED_TEST_CLUSTER)
  assert.equal(owner.cluster, 'closure_' + process.env.PGDATABASE.slice('closure_verify_'.length))
  assert.equal(process.env.RECRUITING_QUARANTINE_ROOT, join(directory, 'storage'))
  assert.equal(await realpath(process.env.RECRUITING_QUARANTINE_ROOT), process.env.RECRUITING_QUARANTINE_ROOT)
  assert.equal(process.env.INTERVIEW_STORAGE_ROOT, join(directory, 'interviews'))
  assert.equal(process.env.ENV_FILE_PATH, join(directory, 'isolated.env'))
  assert.equal(await readFile(process.env.ENV_FILE_PATH, 'utf8'), '# Isolated acceptance configuration only.\n')
  for (const key of ['SMTP_HOST', 'S3_ENDPOINT', 'FUNASR_BASE_URL', 'CLAMAV_HOST']) assert.equal(process.env[key], '')
  assert.ok(!process.env.DATABASE_URL && !process.env.NODE_OPTIONS)
  assert.equal(process.env.WORKER_USE_LLM_ANALYSIS, 'true'); assert.equal(process.env.OPENAI_MODEL, 'isolated-synthetic-model')
  assert.equal(process.env.PGHOST, '127.0.0.1'); assert.equal(process.env.DB_POOL_MAX, '2')
  assert.equal(process.env.PGCONNECT_TIMEOUT_MS, '1000')
  const model = new URL(process.env.OPENAI_BASE_URL)
  assert.equal(model.protocol, 'http:'); assert.equal(model.hostname, '127.0.0.1'); assert.equal(model.pathname, '/v1')
  assert.equal(model.username + model.password + model.search + model.hash, '')
  const ports = [Number(process.env.PGPORT), Number(model.port)]
  if (process.env.OCR_SERVICE_URL) {
    const ocr = new URL(process.env.OCR_SERVICE_URL)
    assert.equal(ocr.protocol, 'http:'); assert.equal(ocr.hostname, '127.0.0.1'); assert.equal(ocr.pathname, '/')
    assert.equal(ocr.username + ocr.password + ocr.search + ocr.hash, '')
    assert.ok(Number(ocr.port) > 0 && Number(ocr.port) <= 65535); ports.push(Number(ocr.port))
  }
  assert.deepEqual(process.env.ISOLATED_ALLOWED_PORTS.split(',').map(Number), ports)
  const require = createRequire(join(projectRoot, 'apps/api/package.json'))
  const { Pool } = require('pg'), connect = Pool.prototype.connect, end = Pool.prototype.end
  Pool.prototype.connect = function (...args) { pools.add(this); return connect.apply(this, args) }
  Pool.prototype.end = function (...args) { endings.set(this, (endings.get(this) ?? 0) + 1); return end.apply(this, args) }
  const proof = new Pool()
  try {
    const identity = (await proof.query(`SELECT current_database() AS database,current_user AS role,
      current_setting('cluster_name') AS cluster,encode(pg_catalog.textsend(current_setting('data_directory')),'hex') AS data_hex`)).rows[0]
    assert.equal(identity.database, process.env.PGDATABASE); assert.equal(identity.role, 'closure_owner')
    assert.equal(identity.cluster, owner.cluster)
    assert.ok(matchesPostgresDataDirectory(identity.data_hex, join(directory, 'postgres-data')))
  } finally { await proof.end() }
  const load = file => import(pathToFileURL(join(projectRoot, 'apps/worker/dist/src', file + '.js')).href)
  const { startWorker } = await load('worker'), { loadConfig } = await load('config')
  const logger = Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => {
    if (level !== 'log') process.send?.({ type: 'diagnostic', at: new Date().toISOString(), level, message: args.map(String).join(' ') })
  }]))
  const config = loadConfig()
  if (process.argv.includes('--fault-probe')) config.leaseDurationMs = 4000
  runtime = await startWorker(config, { logger })
  process.on('message', message => {
    if (message?.type === 'stop') void close().catch(fail)
    if (message?.type === 'measure' && !closing) {
      process.send?.({ type: 'measurement', sequence: message.sequence,
      at: new Date().toISOString(), memory: process.memoryUsage(), cpu: process.cpuUsage(),
      handles: process._getActiveHandles().length, eventLoopMaxMs: loop.max / 1e6,
      pools: [...pools].filter(pool => !endings.has(pool)).map(pool => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount })) })
      loop.reset()
    }
  })
  process.on('disconnect', () => { if (!closing) void close().catch(fail) })
  process.send?.({ type: 'ready', port: runtime.healthServer.address().port, pid: process.pid })
}
function fail(error) {
  process.exitCode = 1; loop.disable()
  if (process.connected) process.send({ type: 'failure', message: error.message }, () => process.disconnect())
  else console.error(error.message)
}
await main().catch(fail)
