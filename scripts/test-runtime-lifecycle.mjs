import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'

const bin = process.argv[process.argv.indexOf('--postgres-bin') + 1]
assert.ok(process.argv.includes('--postgres-bin') && bin, '用法：node scripts/test-runtime-lifecycle.mjs --postgres-bin <目录>')
const iterations = Number(process.env.ISOLATED_LIFECYCLE_ITERATIONS ?? 50)
assert.ok(Number.isInteger(iterations) && iterations >= 50 && iterations <= 200)
const instance = await startIsolatedPostgres(bin)
// Do not import application configuration until inherited service configuration is gone.
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, instance.env)
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
const { Pool } = require('pg')
const admin = new Pool(instance.connection)
let pool, created = false
const report = { startedAt: new Date().toISOString(), scope: '独立PostgreSQL、真实API/Worker进程、自然退出；不读取业务环境文件；无外部服务调用',
  database: instance.database, postgresPort: instance.port, iterationsPerRole: iterations, runs: [], checks: {}, cleanup: {} }
const output = join(instance.directory, 'lifecycle-report.json')
const git = args => execFileSync('git', args, { cwd: projectRoot, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
async function recordFingerprint() {
  const files = [...new Set([...git(['ls-files', '-z']).split(String.fromCharCode(0)), ...git(['ls-files', '--others', '--exclude-standard', '-z']).split(String.fromCharCode(0))])]
    .filter(file => new RegExp('^(?:apps/(?:api|worker)/(?:src|tests)/|packages/|scripts/)').test(file)).sort()
  const fingerprint = createHash('sha256')
  for (const file of files) { try { fingerprint.update(file); fingerprint.update(await readFile(resolve(projectRoot, file))) } catch(error) { if(error.code !== 'ENOENT') throw error } }
  report.code = { head: git(['rev-parse','HEAD']).trim(), sourceSha256: fingerprint.digest('hex'), sourceFiles: files.length, node: process.version }
}
async function child(mode, iteration) {
  const started = performance.now()
  const processChild = fork(join(projectRoot, 'scripts/lifecycle-process-child.mjs'), [mode], { cwd: projectRoot,
    env: { ...instance.env, PGAPPNAME: 'closure-' + mode + '-' + iteration }, execArgv: ['--require', join(projectRoot, 'scripts/isolated-network-guard.cjs')],
    windowsHide: true, stdio: ['ignore','pipe','pipe','ipc'] })
  const record = { mode, iteration, pid: processChild.pid, events: [], stderr: '', stdout: '' }
  report.runs.push(record)
  processChild.stdout.on('data', chunk => { record.stdout += chunk.toString() })
  processChild.stderr.on('data', chunk => { record.stderr += chunk.toString() })
  let timer
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => { record.forcedKill = true; processChild.kill(); reject(new Error('测试进程未在30秒内自然退出')) }, 30000)
      processChild.on('message', message => {
        record.events.push(message)
        if (message.type === 'ready') processChild.send({ type: 'stop' })
        if (message.type === 'failure') reject(new Error('子进程验收失败：' + message.message))
      })
      processChild.once('error', reject)
      processChild.once('exit', (code, signal) => {
        record.exit = { code, signal, elapsedMs: performance.now() - started }
        if (code === 0 && !signal) resolve()
        else reject(new Error('子进程退出失败：' + record.stderr))
      })
    })
  } finally { clearTimeout(timer); if (!record.exit) { processChild.kill(); await new Promise(resolve => processChild.once('exit', resolve)) } }
  assert.equal(record.events.filter(event => event.type === 'closed').length, 1)
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1', ['closure-' + mode + '-' + iteration])).rows[0].n, 0)
  await writeFile(output, JSON.stringify(report, null, 2))
}
try {
  await recordFingerprint()
  assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name, instance.cluster)
  await admin.query('CREATE DATABASE "' + instance.database + '"')
  created = true
  pool = new Pool({ ...instance.connection, database: instance.database })
  const { runMigrations } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/db/migrations.js')).href)
  const migrations = await runMigrations(pool, join(projectRoot, 'db/migrations'))
  report.checks.isolatedMigrations = { applied: migrations.applied.length }
  await pool.end(); pool = undefined
  for (let iteration = 1; iteration <= iterations; iteration++) {
    await child('api', iteration)
    await child('worker', iteration)
    if (iteration % 5 === 0) console.log('已完成真实自然启停：每种角色 ' + iteration + '/' + iterations)
  }
  report.checks.naturalExit = true
  report.checks.noRemainingSessions = true
  report.passed = true
} catch(error) { report.passed = false; report.failure = { name: error.name, message: error.message }; process.exitCode = 1 }
finally {
  const cleanupErrors = []
  const clean = async (label, action) => {
    try { await action() } catch(error) { cleanupErrors.push({ label, message: error.message }) }
  }
  await clean('migration-pool', async () => { await pool?.end() })
  if (created) {
    await clean('database', async () => {
      await admin.query('DROP DATABASE "' + instance.database + '" WITH (FORCE)')
      report.cleanup.databaseDropped = true
    })
  }
  await clean('admin-pool', () => admin.end())
  await clean('postgres', async () => { await instance.stop(); report.cleanup.postgresStopped = true })
  if (cleanupErrors.length) { report.cleanup.errors = cleanupErrors; report.passed = false; process.exitCode = 1 }
  report.finishedAt = new Date().toISOString()
  await writeFile(output, JSON.stringify(report, null, 2))
}
console.log(JSON.stringify({ passed: report.passed, measuredProcesses: report.runs.length, report: output, cleanup: report.cleanup }))
