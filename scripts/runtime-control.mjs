import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { diagnose } from './runtime-doctor.mjs'
import { readRuntimeConfig } from './runtime-config.mjs'
import { requireFreePorts, probeRuntime } from './runtime-probes.mjs'
import { verifyRelease } from './runtime-release.mjs'
import { createRuntimeLog } from './runtime-log.mjs'

export function processStatus(item) {
  const manager = item.pm2_env
  let status = manager.status, reason
  // Pinned PM2 sets waiting-restart after overlimit/stop-exit handling, even without a restart timer.
  if (!item.pid && ['waiting restart', 'errored', 'stopped'].includes(status)) {
    if (manager.exit_code === 78) { status = 'circuit-open'; reason = 'Configuration or dependency circuit opened; inspect logs and run doctor before stop/start.' }
    else if (manager.status === 'errored' || manager.created_at === null) { status = 'circuit-open'; reason = 'Unstable restart limit reached; inspect logs and run doctor before stop/start.' }
    else if (manager.exit_code === 0) status = 'stopped'
  }
  return { role: manager.RUNTIME_ROLE, pid: item.pid, status, managerStatus: manager.status, reason,
    exitCode: manager.exit_code, restarts: manager.restart_time, memoryBytes: item.monit?.memory, cpuPercent: item.monit?.cpu }
}

export function isProcessActive(item) {
  return ['online', 'launching', 'waiting restart'].includes(processStatus(item).status)
}

export function processSpec(role, { root, state, id, env, version }) {
  return {
    name: id + '-' + role, script: join(root, 'scripts/runtime-role.mjs'), cwd: join(root, 'apps/api'),
    exec_mode: 'fork', instances: 1, interpreter: process.execPath, watch: false, filter_env: true,
    wait_ready: true, listen_timeout: 45000, kill_timeout: 30000, shutdown_with_message: true,
    autorestart: true, min_uptime: 600000, max_restarts: 3, exp_backoff_restart_delay: 1000,
    stop_exit_codes: [0, 78], disable_logs: true,
    env: { ...env, RUNTIME_ROLE: role, RUNTIME_STATE_DIR: state, RUNTIME_INSTANCE_ID: id,
      APP_NAME: role === 'api' ? 'smartrecruit-pro-api' : role === 'worker' ? 'smartrecruit-pro-worker' : 'smartrecruit-pro-web', APP_VERSION: version },
  }
}

export async function control(action, { root = resolve(import.meta.dirname, '..'), args = [], env = process.env } = {}) {
  const state = resolve(env.RUNTIME_HOME || join(root, 'logs/runtime'))
  const id = 'recruit-' + createHash('sha256').update(state.toLowerCase()).digest('hex').slice(0, 12)
  const selected = args.indexOf('--release')
  if (selected >= 0 && !args[selected + 1]) throw new Error('RELEASE_REQUIRED: --release requires a directory')
  let active
  try { active = JSON.parse(readFileSync(join(state, 'active-release.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const release = selected >= 0 ? resolve(args[selected + 1]) : active?.directory
  if (action === 'doctor') return diagnose(release || root, { audit: args.includes('--audit'), env })
  if (action === 'logs') {
    const lines = {}
    for (const name of ['controller', 'api', 'worker', 'web']) {
      try { lines[name] = readFileSync(join(state, 'logs', name + '.jsonl'), 'utf8').trim().split(/\r?\n/u).slice(-40).map(line => JSON.parse(line)) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return lines
  }
  if (!['start', 'stop', 'status'].includes(action)) throw new Error('Usage: runtime-control.mjs start|stop|status|doctor|logs [--release <directory>] [--audit]')
  const configuration = action === 'stop' ? { env } : readRuntimeConfig(root, env)
  const pm2Home = resolve(env.LOCALAPPDATA || homedir(), 'SmartRecruit', 'pm2')
  if (action !== 'start' && !existsSync(join(pm2Home, 'pm2.pid'))) {
    const probes = action === 'status' ? await probeRuntime(configuration.ports) : undefined
    return { ready: false, managed: false, endpointsReady: probes?.ready, checks: probes?.checks, message: 'No managed runtime daemon recorded. Existing external processes are not owned or stopped.' }
  }
  let lock, pm2, log
  if (action !== 'status') {
    mkdirSync(state, { recursive: true })
    try { lock = openSync(join(state, 'operation.lock'), 'wx', 0o600) }
    catch (error) { if (error.code === 'EEXIST') throw new Error('INSTANCE_LOCK: Another operation or a stale operation.lock exists; verify its owner before removing.'); throw error }
    writeFileSync(lock, JSON.stringify({ pid: process.pid, action, startedAt: new Date().toISOString() }))
    log = createRuntimeLog(join(state, 'logs/controller.jsonl'), configuration.env)
  }
  const method = (name, ...params) => new Promise((yes, no) => pm2[name](...params, (error, value) => error ? no(error) : yes(value)))
  try {
    let manifest, configurationHash
    if (action === 'start') {
      if (!release) throw new Error('RELEASE_REQUIRED: Run npm run runtime:prepare, then runtime:start -- --release <candidate>. Startup never builds or migrates.')
      manifest = await verifyRelease(release)
      const report = await diagnose(release, { env: configuration.env })
      if (!report.ready) {
        log('error', 'PRECHECK_FAILED: ' + report.checks.filter(item => !item.ok).map(item => item.name + ': ' + item.message).join('; '))
        return report
      }
      configurationHash = createHash('sha256').update(JSON.stringify(Object.keys(configuration.env).sort().map(key => [key, configuration.env[key]]))).digest('hex')
    }
    // PM2 uses shared Windows named pipes. Scope every operation by instance and exact script; never stop/delete all or kill its shared daemon.
    process.env.PM2_HOME = pm2Home
    process.env.PM2_NO_INTERACTION = 'true'
    process.env.PM2_DISCRETE_MODE = 'true'
    process.env.PM2_SILENT = 'true'
    const require = createRequire(join(action === 'start' ? release : root, 'package.json'))
    const PM2 = require('pm2').custom
    pm2 = new PM2({ pm2_home: pm2Home })
    if (action === 'start') await method('connect')
    else {
      // PM2.connect() respawns a missing daemon. Observing/stopping must never do that.
      const alive = await new Promise(yes => pm2.Client.pingDaemon(yes))
      if (!alive) return { ready: false, managed: false, message: 'Runtime daemon is not running; no daemon was started.' }
      pm2.Client.start = callback => callback(new Error('DAEMON_OFFLINE: Refusing to create a daemon during status/stop.'))
      await new Promise((yes, no) => {
        const timeout = setTimeout(() => no(new Error('DAEMON_TIMEOUT: Existing runtime daemon is unreachable')), 5000)
        pm2.Client.launchRPC(error => { clearTimeout(timeout); error ? no(error) : yes() })
      })
    }
    const all = await method('list')
    const owned = all.filter(item => item.name?.startsWith(id + '-'))
    for (const item of owned) {
      const expected = active?.directory || release
      if (!expected || resolve(item.pm2_env.pm_exec_path) !== join(expected, 'scripts/runtime-role.mjs') || item.pm2_env.RUNTIME_INSTANCE_ID !== id) throw new Error('PROCESS_IDENTITY: Unexpected process identity; refusing to stop or replace it.')
    }
    if (action === 'status') {
      const probes = await probeRuntime(configuration.ports, active?.id)
      return { ...probes, endpointsReady: probes.ready, managed: owned.length === 3, release: active?.id, directory: active?.directory,
        processes: owned.map(processStatus),
        ready: probes.ready && owned.length === 3 && owned.every(item => item.pid > 0 && item.pm2_env.status === 'online') }
    }
    if (action === 'stop') {
      for (const role of ['web', 'worker', 'api']) {
        const item = owned.find(value => value.pm2_env.RUNTIME_ROLE === role)
        if (item) await method('stop', item.pm_id)
      }
      log('info', 'Managed instance stopped; external services untouched')
      return { stopped: true, processes: owned.length }
    }
    if (owned.some(isProcessActive)) {
      if (!active || active.directory !== release || active.configurationHash !== configurationHash) throw new Error('ACTIVE_INSTANCE: Stop the current instance before changing release or effective configuration.')
      if (owned.length !== 3 || owned.some(item => item.pm2_env.status !== 'online')) throw new Error('PARTIAL_INSTANCE: Check runtime:status and runtime:logs; stop the managed instance before a fresh start.')
      return { ...await probeRuntime(configuration.ports, manifest.id), managed: true, release: manifest.id, reused: true }
    }
    await requireFreePorts(configuration.ports)
    // No failed candidate can overwrite the pointer or silently replace an existing deployment.
    const started = []
    try {
      for (const item of owned) await method('delete', item.pm_id)
      for (const role of ['api', 'worker', 'web']) {
        const budget = join(state, role + '-starts.json')
        if (existsSync(budget)) unlinkSync(budget)
        const spec = processSpec(role, { root: release, state, id, env: configuration.env, version: manifest.id })
        started.push(spec.name)
        await method('start', spec)
      }
      let probes
      const deadline = Date.now() + 60000
      do { probes = await probeRuntime(configuration.ports, manifest.id); if (probes.ready) break; await delay(1000) } while (Date.now() < deadline)
      if (!probes.ready) throw new Error('STARTUP_NOT_READY: ' + Object.keys(probes.checks).filter(key => !probes.checks[key].ok).join(', ') + '. See runtime:logs; active release unchanged.')
      const next = { id: manifest.id, directory: release, configurationHash, activatedAt: new Date().toISOString() }
      const temporary = join(state, 'active-release.json.tmp')
      writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
      renameSync(temporary, join(state, 'active-release.json'))
      log('info', 'Activated release ' + manifest.id)
      return { ...probes, managed: true, release: manifest.id, url: 'http://127.0.0.1:' + configuration.ports.web }
    } catch (error) {
      for (const name of started.reverse()) await method('delete', name).catch(() => {})
      throw error
    }
  } catch (error) { log?.('error', error); throw error }
  finally {
    pm2?.disconnect()
    if (lock !== undefined) { closeSync(lock); unlinkSync(join(state, 'operation.lock')) }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await control(process.argv[2] || 'status', { args: process.argv.slice(3) })
    console.log(JSON.stringify(result, null, 2))
    if (result.ready === false && !['stop', 'logs'].includes(process.argv[2])) process.exitCode = 1
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
