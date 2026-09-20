import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dryRun = process.argv.includes('--dry-run')

function log(message) {
  console.log(`[start-all] ${message}`)
}

function warn(message) {
  console.warn(`[start-all] ${message}`)
}

function parseEnvFile(file) {
  const values = new Map()
  const content = readFileSync(file, 'utf8')
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1)
    }
    values.set(key, value)
  }
  return values
}

function upsertEnv(content, key, value) {
  const line = `${key}=${value}`
  const matcher = new RegExp(`^${key}=.*$`, 'm')
  if (matcher.test(content)) return content.replace(matcher, line)
  return `${content.trimEnd()}\n${line}\n`
}

function applySourceModeDefaults(envFile) {
  const before = parseEnvFile(envFile)
  let content = readFileSync(envFile, 'utf8')
  const dockerMinioDefault = before.get('S3_ENDPOINT')?.trim() === 'http://minio:9000'
  const missingQuarantineRoot = !before.get('RECRUITING_QUARANTINE_ROOT')?.trim()
  const workerPollDisabled = before.get('WORKER_DB_POLL')?.trim() !== 'true'

  if (dockerMinioDefault) {
    content = upsertEnv(content, 'S3_ENDPOINT', '')
    content = upsertEnv(content, 'S3_ACCESS_KEY_ID', '')
    content = upsertEnv(content, 'S3_SECRET_ACCESS_KEY', '')
  }
  if (missingQuarantineRoot) {
    content = upsertEnv(content, 'RECRUITING_QUARANTINE_ROOT', resolve(root, 'data', 'resumes', 'quarantine'))
  }
  if (workerPollDisabled) content = upsertEnv(content, 'WORKER_DB_POLL', 'true')

  if (content !== readFileSync(envFile, 'utf8')) {
    writeFileSync(envFile, content)
    if (dockerMinioDefault) log('Switched S3 storage to the local source-mode directory')
    if (workerPollDisabled) log('Enabled WORKER_DB_POLL for background resume analysis')
  }
}

function ensureLocalEnv() {
  const envFile = resolve(root, '.env')
  const exampleFile = resolve(root, '.env.example')
  if (existsSync(envFile)) {
    log('Using existing .env')
    applySourceModeDefaults(envFile)
    return parseEnvFile(envFile)
  }

  if (!existsSync(exampleFile)) {
    warn('.env and .env.example are both missing; using process environment only')
    return new Map()
  }

  copyFileSync(exampleFile, envFile)
  applySourceModeDefaults(envFile)
  log('Created .env from .env.example with local source-mode defaults')
  return parseEnvFile(envFile)
}

function commandExists(command) {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = spawnSync(probe, [command], { stdio: 'ignore' })
  return result.status === 0
}

function postgresPortFromEnv(env) {
  const databaseUrl = env.get('DATABASE_URL')?.trim()
  if (databaseUrl) {
    try {
      const parsed = new URL(databaseUrl)
      if (parsed.port) return Number(parsed.port)
    } catch {
      // Let the API report invalid DATABASE_URL values with its own validation.
    }
  }
  const configured = Number(env.get('PGPORT') || '5432')
  return Number.isInteger(configured) && configured > 0 ? configured : 5432
}

function isPortOpen(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host, port })
    const done = (result) => {
      socket.destroy()
      resolvePort(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function postgresServiceNames() {
  if (process.platform !== 'win32') return []
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "Get-Service -Name '*postgres*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name",
    ],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) return []
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
}

function startPostgresService(name) {
  if (dryRun) {
    log(`Would start PostgreSQL service: ${name}`)
    return true
  }
  const escaped = name.replaceAll("'", "''")
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Start-Service -Name '${escaped}'`],
    { encoding: 'utf8' },
  )
  if (result.status === 0) {
    log(`Started PostgreSQL service: ${name}`)
    return true
  }
  warn(`Could not start PostgreSQL service ${name}: ${(result.stderr || result.stdout).trim()}`)
  return false
}

async function ensurePostgres(env) {
  const port = postgresPortFromEnv(env)
  if (await isPortOpen(port)) {
    log(`PostgreSQL already accepts connections on 127.0.0.1:${port}`)
    return true
  }

  const services = postgresServiceNames()
  if (services.length === 0) {
    warn(`PostgreSQL port ${port} is not open and no Windows PostgreSQL service was found`)
    return false
  }

  for (const service of services) startPostgresService(service)

  if (dryRun) return true
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await isPortOpen(port)) {
      log(`PostgreSQL is ready on 127.0.0.1:${port}`)
      return true
    }
    await delay(1000)
  }

  warn(`PostgreSQL service was started, but port ${port} is still not reachable`)
  return false
}

function openCommandWindow(component) {
  if (dryRun) {
    log(`Would start ${component.name}: cd /d "${component.cwd}" && ${component.command}`)
    return
  }
  log(`Starting ${component.name}`)
  const child = spawn('cmd.exe', ['/c', 'start', component.title, '/D', component.cwd, 'cmd.exe', '/k', component.command], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
}

async function waitForHttp(url, timeoutMs) {
  if (dryRun) return true
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (response.ok) return true
    } catch {
      // Service is still starting.
    }
    await delay(500)
  }
  return false
}

function openUrl(url) {
  if (dryRun) {
    log(`Would open ${url}`)
    return
  }
  const child = spawn('cmd.exe', ['/c', 'start', '', url], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
}

async function main() {
  if (process.platform !== 'win32') {
    warn('This launcher is intended for Windows. Use the documented commands on other platforms.')
    process.exitCode = 1
    return
  }

  if (!commandExists('node')) {
    warn('Node.js is not installed or not on PATH')
    process.exitCode = 1
    return
  }
  if (!commandExists('npm')) {
    warn('npm is not installed or not on PATH')
    process.exitCode = 1
    return
  }

  const env = ensureLocalEnv()
  mkdirSync(resolve(root, 'data', 'resumes', 'quarantine'), { recursive: true })
  const postgresReady = await ensurePostgres(env)
  if (!postgresReady) {
    warn('PostgreSQL was not reachable. API startup may fail until the database service is running.')
  }

  const components = [
    {
      name: 'API',
      title: 'SmartRecruit API',
      port: 3100,
      cwd: root,
      command: 'npm start',
      healthUrl: 'http://127.0.0.1:3100/health',
    },
    {
      name: 'Worker',
      title: 'SmartRecruit Worker',
      port: 4001,
      cwd: resolve(root, 'apps', 'worker'),
      command: 'npm start',
      healthUrl: 'http://127.0.0.1:4001/health',
    },
    {
      name: 'Web',
      title: 'SmartRecruit Web',
      port: 5174,
      cwd: resolve(root, 'web'),
      command: 'npm run dev',
      healthUrl: 'http://127.0.0.1:5174/',
    },
  ]

  for (const component of components) {
    const alreadyRunning = await isPortOpen(component.port)
    if (alreadyRunning) {
      log(`${component.name} already appears to be running on port ${component.port}`)
      continue
    }
    openCommandWindow(component)
  }

  const checks = [
    ['API', 'http://127.0.0.1:3100/health', 90_000],
    ['Worker', 'http://127.0.0.1:4001/health', 30_000],
    ['Web', 'http://127.0.0.1:5174/', 30_000],
  ]
  for (const [name, url, timeoutMs] of checks) {
    const ready = await waitForHttp(url, timeoutMs)
    if (ready) log(`${name} is ready: ${url}`)
    else warn(`${name} did not become ready within ${Math.round(timeoutMs / 1000)} seconds: ${url}`)
  }

  openUrl('http://127.0.0.1:5174')
  log('Startup request complete. Keep the three service windows open.')
}

await main()
