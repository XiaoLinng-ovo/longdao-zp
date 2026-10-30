import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { createConnection } from 'node:net'

export function localOcrEndpoint(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined
    return { healthUrl: `${url.origin}/health`, port: Number(url.port || 80) }
  } catch { return undefined }
}

async function occupied(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (value) => { socket.destroy(); done(value) }
    socket.setTimeout(1000)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

export async function ensureLocalOcr(root, env, { dryRun = false, log = console.log, warn = console.warn } = {}) {
  const configured = env.get('OCR_SERVICE_URL')?.trim() || process.env.OCR_SERVICE_URL?.trim()
  const endpoint = localOcrEndpoint(configured)
  if (!endpoint) return
  try {
    const response = await fetch(endpoint.healthUrl, { signal: AbortSignal.timeout(1500) })
    const health = response.ok ? await response.json() : undefined
    if (health?.engine === 'PP-StructureV3' && health.status === 'ok') {
      log('OCR is already running')
      return
    }
  } catch { /* Startup below is only allowed on an unoccupied local port. */ }
  if (await occupied(endpoint.port)) {
    warn(`OCR port ${endpoint.port} is occupied by another service; not starting OCR`)
    return
  }
  const cwd = resolve(root, 'ocr-service')
  const python = resolve(cwd, '.venv', 'Scripts', 'python.exe')
  if (!existsSync(python) || !existsSync(resolve(cwd, 'main.py'))) {
    warn('Local OCR environment is missing; image resumes cannot be parsed until OCR is installed')
    return
  }
  if (dryRun) { log(`Would start local OCR on port ${endpoint.port}`); return }
  const logs = resolve(root, '.codex-logs')
  mkdirSync(logs, { recursive: true })
  const stamp = Date.now()
  const out = openSync(resolve(logs, `ocr-${stamp}.stdout.log`), 'a')
  const err = openSync(resolve(logs, `ocr-${stamp}.stderr.log`), 'a')
  try {
    const child = spawn(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(endpoint.port)], {
      cwd, detached: true, windowsHide: true, stdio: ['ignore', out, err], env: { ...process.env, PYTHONUTF8: '1' },
    })
    child.on('error', () => warn('OCR startup failed; check the OCR environment and startup logs'))
    child.unref()
    log(`Started local OCR on port ${endpoint.port}; models may take a few minutes to initialize`)
    return endpoint.healthUrl
  } finally { closeSync(out); closeSync(err) }
}
