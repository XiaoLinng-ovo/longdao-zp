import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRuntimeLog } from './runtime-log.mjs'

const root = resolve(import.meta.dirname, '..')
const role = process.env.RUNTIME_ROLE
if (!['api', 'worker', 'web'].includes(role) || !process.env.RUNTIME_STATE_DIR || process.env.SMARTRECRUIT_MANAGED_ENV !== '1') throw new Error('Managed runtime environment required')
const state = resolve(process.env.RUNTIME_STATE_DIR)
mkdirSync(state, { recursive: true })
const log = createRuntimeLog(join(state, 'logs', role + '.jsonl'))
for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = (...args) => log(level, ...args)
let close, pool, timer, stopping = false, failures = 0
let finishStartup, startupError
const startupDone = new Promise(yes => { finishStartup = yes })
const stop = async (code = 0) => {
  if (stopping) return
  stopping = true
  clearInterval(timer)
  log('info', 'Graceful shutdown requested; exit=' + code)
  const deadline = setTimeout(() => { log('error', 'Graceful shutdown deadline exceeded'); process.exit(code || 1) }, 25000)
  try { await startupDone; clearInterval(timer); await close?.(); await pool?.end(); process.exitCode = code }
  catch (error) { log('error', error); process.exitCode = code || 1 }
  finally { clearTimeout(deadline); if (process.connected) process.disconnect() }
}
process.on('message', message => { if (message === 'shutdown') void stop() })
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
process.on('uncaughtException', error => { log('error', error); void stop(1) })
process.on('unhandledRejection', error => { log('error', error); void stop(1) })

try {
  // Bound crashes even after a long healthy run; PM2's unstable-start limit is additional protection.
  const budget = join(state, role + '-starts.json')
  let starts = []
  try { starts = JSON.parse(readFileSync(budget, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  starts = starts.filter(at => at > Date.now() - 10 * 60 * 1000)
  if (starts.length >= 3) throw new Error('RESTART_CIRCUIT_OPEN: Three starts within ten minutes. Run doctor, then explicitly start after remediation.')
  starts.push(Date.now())
  writeFileSync(budget, JSON.stringify(starts), { mode: 0o600 })
  const load = file => import(pathToFileURL(join(root, file)).href)
  if (role === 'web') {
    const { createProductionGateway } = await load('scripts/serve-web-production.mjs')
    const server = createProductionGateway()
    close = () => new Promise((yes, no) => { server.close(error => error ? no(error) : yes()); server.closeIdleConnections() })
    await new Promise((yes, no) => { server.once('error', no); server.listen(Number(process.env.WEB_PORT), process.env.WEB_HOST, yes) })
  } else {
    const require = createRequire(join(root, 'apps/api/package.json'))
    const { Pool } = require('pg')
    const { loadDatabaseConfig } = await load('apps/api/dist/src/db/config.js')
    const { target: _target, ...connection } = loadDatabaseConfig()
    pool = new Pool({ ...connection, max: 1, connectionTimeoutMillis: 3000, query_timeout: 3000, application_name: 'runtime-monitor-' + role })
    pool.on('error', error => { log('warn', 'Database monitor idle connection error', error) })
    const { checkReleaseReadiness } = await load('apps/api/dist/src/db/release-readiness.js')
    await checkReleaseReadiness(pool)
    if (stopping) throw new Error('Startup interrupted')
    if (role === 'api') {
      const { startServer } = await load('apps/api/dist/src/server.js')
      const server = await startServer()
      close = () => server.closeAsync()
    } else {
      const { startWorker, loadConfig } = await load('apps/worker/dist/src/index.js')
      const worker = await startWorker(loadConfig())
      close = () => worker.close()
    }
    let checking = false
    timer = setInterval(async () => {
      if (checking || stopping) return
      checking = true
      try { await pool.query('SELECT 1'); failures = 0 }
      catch { if (++failures >= 3) { log('error', 'DATABASE_CIRCUIT_OPEN: Three database probe failures; manual doctor/start required'); void stop(78) } }
      finally { checking = false }
    }, 10000)
  }
  if (!stopping) { process.send?.('ready'); log('info', 'Service ready; release=' + process.env.APP_VERSION) }
} catch (error) {
  log('error', error)
  startupError = error
} finally { finishStartup() }
if (startupError) await stop(78)
