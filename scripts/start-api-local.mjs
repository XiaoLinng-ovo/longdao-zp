import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
if (process.env.NODE_ENV && process.env.NODE_ENV !== 'development') {
  console.error('start:dev requires NODE_ENV=development (or an unset NODE_ENV). Use npm start for production.')
  process.exit(1)
}
process.env.NODE_ENV = 'development'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const spawnOptions = { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }

const build = spawnSync(npm, ['--prefix', 'apps/api', 'run', 'build'], spawnOptions)
if (build.error) {
  console.error(`Failed to run npm build: ${build.error.message}`)
  process.exit(1)
}
if (build.status !== 0) process.exit(build.status ?? 1)

const migration = spawnSync(process.execPath, [resolve(root, 'scripts', 'migrate-postgres.mjs')], {
  cwd: root,
  stdio: 'inherit',
})
if (migration.status !== 0) process.exit(migration.status ?? 1)

if (process.env.ALLOW_DEV_SEED === 'true') {
  const seed = spawnSync(process.execPath, [resolve(root, 'scripts', 'seed-dev-postgres.mjs')], {
    cwd: root,
    stdio: 'inherit',
  })
  if (seed.status !== 0) process.exit(seed.status ?? 1)
}

const api = spawn(npm, ['--prefix', 'apps/api', 'start'], spawnOptions)
api.on('error', (error) => {
  console.error(`Failed to start API: ${error.message}`)
  process.exitCode = 1
})

const stop = (signal) => api.kill(signal)
process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))
api.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
