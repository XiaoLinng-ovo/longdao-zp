import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot } from './isolated-environment.mjs'
import { matchesPostgresDataDirectory } from './verify-isolated-backup.mjs'

assert.match(process.env.PGDATABASE ?? '', /^restore_verify_[a-f0-9]{32}$/)
assert.match(process.env.ISOLATED_TEST_CLUSTER ?? '', /^closure_[a-f0-9]{32}$/)
const directory = join(projectRoot, 'tmp', 'closure_verify_' + process.env.ISOLATED_TEST_CLUSTER.slice(8))
assert.equal(process.env.ISOLATED_TEST_ROOT, directory)
assert.equal(await realpath(directory), directory)
const owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'))
assert.equal(owner.pid, process.ppid)
assert.equal(owner.purpose, 'isolated-acceptance')
assert.equal(owner.cluster, process.env.ISOLATED_TEST_CLUSTER)
assert.equal(process.env.RECRUITING_QUARANTINE_ROOT, join(directory, 'storage'))
assert.equal(await realpath(process.env.RECRUITING_QUARANTINE_ROOT), process.env.RECRUITING_QUARANTINE_ROOT)
assert.equal(process.env.INTERVIEW_STORAGE_ROOT, join(directory, 'interviews'))
assert.equal(await realpath(process.env.INTERVIEW_STORAGE_ROOT), process.env.INTERVIEW_STORAGE_ROOT)
for (const key of ['SMTP_HOST', 'OPENAI_BASE_URL', 'S3_ENDPOINT', 'FUNASR_BASE_URL']) assert.equal(process.env[key], '')
assert.equal(process.env.WORKER_USE_LLM_ANALYSIS, 'false')
assert.ok(!process.env.DATABASE_URL && !process.env.NODE_OPTIONS)
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
const { Pool } = require('pg'), pools = new Set(), endings = new Map()
const connect = Pool.prototype.connect, end = Pool.prototype.end
Pool.prototype.connect = function (...args) { pools.add(this); return connect.apply(this, args) }
Pool.prototype.end = function (...args) { endings.set(this, (endings.get(this) ?? 0) + 1); return end.apply(this, args) }
const proof = new Pool()
try {
  const identity = (await proof.query(`SELECT current_database() AS database,current_user AS role,
    current_setting('cluster_name') AS cluster,encode(pg_catalog.textsend(current_setting('data_directory')),'hex') AS data_hex`)).rows[0]
  assert.equal(identity.database, process.env.PGDATABASE)
  assert.equal(identity.role, 'closure_owner')
  assert.equal(identity.cluster, owner.cluster)
  assert.ok(matchesPostgresDataDirectory(identity.data_hex, join(directory, 'postgres-data')))
} finally { await proof.end() }
const load = (app, file) => import(pathToFileURL(join(projectRoot, 'apps', app, 'dist/src', file + '.js')).href)
const mode = process.argv[2]
assert.ok(['api', 'worker'].includes(mode))
let runtime, closing
if (mode === 'api') {
  const { startServer } = await load('api', 'server'), { loadConfig } = await load('api', 'config')
  runtime = await startServer(loadConfig({ ...process.env, HOST: '127.0.0.1', PORT: '0' }))
} else {
  const { startWorker } = await load('worker', 'worker'), { loadConfig } = await load('worker', 'config')
  const logger = Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => {
    if (level !== 'log') process.send?.({ type: 'diagnostic', level, message: args.map(String).join(' ') })
  }]))
  runtime = await startWorker(loadConfig({ ...process.env, WORKER_HEALTH_PORT: '0', WORKER_DB_POLL: 'true', WORKER_POLL_INTERVAL_MS: '25' }), { logger })
}
process.on('message', message => {
  if (message?.type !== 'stop' || closing) return
  closing = (async () => {
    if (mode === 'api') await runtime.closeAsync()
    else await runtime.close()
    for (const pool of pools) {
      assert.equal(endings.get(pool), 1)
      assert.equal(pool.totalCount, 0)
      assert.equal(pool.waitingCount, 0)
    }
    assert.equal((mode === 'api' ? runtime : runtime.healthServer).listening, false)
    process.send?.({ type: 'closed', pools: pools.size, mode }, () => process.disconnect())
  })().catch(error => {
    process.exitCode = 1
    process.send?.({ type: 'failure', message: error.message }, () => process.disconnect())
  })
})
process.send?.({ type: 'ready', port: (mode === 'api' ? runtime : runtime.healthServer).address().port, pid: process.pid })
