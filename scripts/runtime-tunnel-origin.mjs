import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { control } from './runtime-control.mjs'
import { parseRuntimeEnv, readRuntimeConfig } from './runtime-config.mjs'

export function validateTunnelOrigin(origin) {
  if (typeof origin !== 'string' || !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/u.test(origin)) {
    throw new Error('TUNNEL_ORIGIN: Expected the exact HTTPS origin reported by the recruitment tunnel')
  }
  return origin
}

function setProfileValue(content, key, value) {
  const line = new RegExp('^([\\uFEFF \\t]*' + key + '[ \\t]*=)[^\\r\\n]*', 'gm')
  if (line.test(content)) return content.replace(line, (_match, prefix) => prefix + value)
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  return content + (content && !content.endsWith('\n') ? newline : '') + key + '=' + value + newline
}

export function planTunnelOrigin(content, env, origin) {
  validateTunnelOrigin(origin)
  if (env.REQUIRE_CSRF === 'false') throw new Error('TUNNEL_CSRF: Enable CSRF protection before publishing the tunnel')
  const profile = parseRuntimeEnv(content)
  const origins = [...new Set([env.ALLOWED_ORIGINS, profile.ALLOWED_ORIGINS, origin]
    .flatMap(value => (value || '').split(',').map(item => item.trim()).filter(Boolean)))]
  if (origins.some(value => value.includes('*'))) throw new Error('TUNNEL_ORIGIN: Wildcard origins are not supported')
  const allowed = origins.join(',')
  const nextEnv = { ...env, ALLOWED_ORIGINS: allowed, RESUME_UPLOAD_RELAX_ORIGIN: 'false' }
  const nextContent = setProfileValue(setProfileValue(content, 'ALLOWED_ORIGINS', allowed), 'RESUME_UPLOAD_RELAX_ORIGIN', 'false')
  return { env: nextEnv, content: nextContent,
    reload: allowed !== env.ALLOWED_ORIGINS || env.RESUME_UPLOAD_RELAX_ORIGIN !== 'false' }
}

export function selectTunnelRuntime(root, base, active, processes) {
  const state = resolve(base.RUNTIME_HOME || join(root, 'logs/runtime'))
  const id = 'recruit-' + createHash('sha256').update(state.toLowerCase()).digest('hex').slice(0, 12)
  const owned = processes.filter(item => item.name?.startsWith(id + '-'))
  if (!active?.directory || owned.length !== 3) throw new Error('TUNNEL_RUNTIME: Start the complete managed recruitment runtime first')
  for (const role of ['api', 'worker', 'web']) {
    const item = owned.find(value => value.name === id + '-' + role)
    if (!item || !(item.pid > 0) || item.pm2_env.status !== 'online' || item.pm2_env.RUNTIME_ROLE !== role ||
        item.pm2_env.RUNTIME_INSTANCE_ID !== id || resolve(item.pm2_env.pm_exec_path) !== join(active.directory, 'scripts/runtime-role.mjs')) {
      throw new Error('TUNNEL_IDENTITY: Refusing an offline, partial or unrelated runtime')
    }
  }
  const api = owned.find(item => item.pm2_env.RUNTIME_ROLE === 'api')
  const env = { ...base, ...api.pm2_env.env }
  const configuration = readRuntimeConfig(root, env)
  for (const item of owned) {
    for (const key of ['ALLOWED_ORIGINS', 'RESUME_UPLOAD_RELAX_ORIGIN', 'WEB_PORT', 'ENV_FILE_PATH']) {
      if (item.pm2_env.env?.[key] !== api.pm2_env.env?.[key]) throw new Error('TUNNEL_RUNTIME_CONFIG: Managed roles have different configuration')
    }
  }
  return { env: configuration.env, ports: configuration.ports, active, state }
}

export async function loadTunnelRuntime(root, base = process.env) {
  const state = resolve(base.RUNTIME_HOME || join(root, 'logs/runtime'))
  const active = JSON.parse(await readFile(join(state, 'active-release.json'), 'utf8'))
  const pm2Home = resolve(base.LOCALAPPDATA || homedir(), 'SmartRecruit', 'pm2')
  if (!existsSync(join(pm2Home, 'pm2.pid'))) throw new Error('TUNNEL_RUNTIME: No managed daemon; start recruitment first')
  const require = createRequire(join(root, 'package.json'))
  const pm2 = new (require('pm2').custom)({ pm2_home: pm2Home })
  try {
    if (!await new Promise(yes => pm2.Client.pingDaemon(yes))) throw new Error('TUNNEL_RUNTIME: Managed daemon is offline')
    pm2.Client.start = callback => callback(new Error('TUNNEL_RUNTIME: Refusing to create a daemon'))
    await new Promise((yes, no) => {
      const timer = setTimeout(() => no(new Error('TUNNEL_RUNTIME: Existing daemon is unreachable')), 5000)
      pm2.Client.launchRPC(error => { clearTimeout(timer); error ? no(error) : yes() })
    })
    const processes = await new Promise((yes, no) => pm2.list((error, list) => error ? no(error) : yes(list)))
    return selectTunnelRuntime(root, base, active, processes)
  } finally { pm2.disconnect() }
}

export async function verifyTunnelIdentity(origin, runtime, request = fetch) {
  let sameOrigin = true
  for (const base of ['http://127.0.0.1:' + runtime.ports.web, origin]) {
    const response = await request(base + '/api/v1/health', { signal: AbortSignal.timeout(15000), redirect: 'error' })
    const body = await response.json()
    if (response.status !== 200 || body.data?.service !== 'smartrecruit-pro-api' || body.data?.version !== runtime.active.id) {
      throw new Error('TUNNEL_IDENTITY: Public and local endpoints must serve the active recruitment release')
    }
    sameOrigin = sameOrigin && body.data.originPolicy === 'same-origin'
  }
  return { originPolicy: sameOrigin ? 'same-origin' : undefined }
}

export const tunnelWritePaths = ['/api/v1/workspaces', '/api/v1/candidates', '/api/v1/applications',
  '/api/v1/resumes', '/api/v1/resume-import-batches',
  '/api/v1/resume-import-batches/origin-probe/items/origin-probe/content',
  '/api/v1/resume-import-batches/origin-probe/cancel']

export async function verifyTunnelWrites(origin, request = fetch) {
  const token = randomUUID()
  for (const path of tunnelWritePaths) {
    for (const [source, csrf, status, code] of [
      [origin, true, 401, 'AUTHENTICATION_REQUIRED'],
      [origin, false, 403, 'CSRF_TOKEN_INVALID'],
      ['https://untrusted-origin.invalid', true, 403, 'CSRF_ORIGIN_MISMATCH'],
    ]) {
      // No session cookie: successful origin checks must stop at authentication, never write business data.
      const headers = { 'content-type': 'application/json', origin: source }
      if (csrf) Object.assign(headers, { cookie: '__Host-smartrecruit_csrf=' + token, 'x-csrf-token': token })
      const response = await request(origin + path, { method: 'POST', headers, body: '{}',
        signal: AbortSignal.timeout(15000), redirect: 'error' })
      const body = await response.json()
      if (response.status !== status || body.error?.code !== code) throw new Error('TUNNEL_WRITE_CHECK: ' + path + ' did not enforce ' + code)
    }
  }
}

export async function synchronizeTunnelOrigin(root, runtime, origin, { manage = control, identity = verifyTunnelIdentity, verify = verifyTunnelWrites } = {}) {
  validateTunnelOrigin(origin)
  const lockPath = join(runtime.state, 'tunnel-origin.lock')
  const lock = await open(lockPath, 'wx', 0o600)
  let restartAttempted = false
  const profile = runtime.env.ENV_FILE_PATH
  const temporary = profile + '.tunnel-' + randomUUID() + '.tmp'
  try {
    const content = await readFile(profile, 'utf8')
    await lock.writeFile(JSON.stringify({ pid: process.pid, origin, startedAt: new Date().toISOString() }))
    const plan = planTunnelOrigin(content, runtime.env, origin)
    const capabilities = await identity(origin, runtime)
    if (capabilities?.originPolicy === 'same-origin' && runtime.env.RESUME_UPLOAD_RELAX_ORIGIN !== 'true'
        && parseRuntimeEnv(content).RESUME_UPLOAD_RELAX_ORIGIN !== 'true') {
      await verify(origin)
      return { ready: true, origin, port: runtime.ports.web, reloaded: false, checkedWritePaths: tunnelWritePaths.length }
    }
    if (plan.reload) {
      const doctor = await manage('doctor', { root, env: plan.env, args: ['--release', runtime.active.directory] })
      if (!doctor.ready) throw new Error('TUNNEL_PRECHECK: Active release checks failed; running services unchanged')
      // Preflight profile write permission before stopping services, without changing the selected file.
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(plan.content) } finally { await file.close() }
      restartAttempted = true
      await manage('stop', { root, env: runtime.env })
      const result = await manage('start', { root, env: plan.env, args: ['--release', runtime.active.directory] })
      if (!result.ready) throw new Error('TUNNEL_RELOAD: Updated runtime did not become ready')
    }
    await verify(origin)
    if (plan.content !== content) {
      if (await readFile(profile, 'utf8') !== content) throw new Error('TUNNEL_PROFILE_CHANGED: Profile changed concurrently; refusing to overwrite it')
      if (!existsSync(temporary)) {
        const file = await open(temporary, 'wx', 0o600)
        try { await file.writeFile(plan.content) } finally { await file.close() }
      }
      await rename(temporary, profile)
    }
    return { ready: true, origin, port: runtime.ports.web, reloaded: plan.reload, checkedWritePaths: tunnelWritePaths.length }
  } catch (error) {
    if (restartAttempted) {
      try {
        await manage('stop', { root, env: runtime.env })
        const restored = await manage('start', { root, env: runtime.env, args: ['--release', runtime.active.directory] })
        if (!restored.ready) throw new Error('Original runtime did not become ready')
      } catch (rollback) { throw new AggregateError([error, rollback], 'TUNNEL_ROLLBACK_FAILED: Inspect runtime status; tunnel is not ready') }
    }
    throw error
  } finally {
    try { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    finally { await lock.close(); await unlink(lockPath) }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = resolve(import.meta.dirname, '..')
    const runtime = await loadTunnelRuntime(root)
    const args = process.argv.slice(2)
    if (args.length === 1 && args[0] === '--port') console.log(runtime.ports.web)
    else {
      if (args.length !== 4 || args[0] !== '--origin' || args[2] !== '--port' || Number(args[3]) !== runtime.ports.web) {
        throw new Error('TUNNEL_ARGUMENTS: Use --port, or --origin <exact-origin> --port <managed-web-port>')
      }
      console.log(JSON.stringify(await synchronizeTunnelOrigin(root, runtime, args[1])))
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
