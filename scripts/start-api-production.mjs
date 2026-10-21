import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

export function startProductionApi({ env = process.env, spawnProcess = spawn } = {}) {
  const api = spawnProcess(process.execPath, [resolve(root, 'apps/api/dist/src/index.js')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...env, NODE_ENV: 'production' },
  })
  api.on('error', () => {
    console.error('Failed to start the prebuilt production API. Build it before starting.')
    process.exitCode = 1
  })
  const stopInt = () => api.kill('SIGINT')
  const stopTerm = () => api.kill('SIGTERM')
  process.once('SIGINT', stopInt)
  process.once('SIGTERM', stopTerm)
  api.on('exit', (code, signal) => {
    process.removeListener('SIGINT', stopInt)
    process.removeListener('SIGTERM', stopTerm)
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
  return api
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startProductionApi()
}
