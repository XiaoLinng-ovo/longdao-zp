import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const build = spawnSync(npm, ['--prefix', 'apps/api', 'run', 'build'], {
  cwd: root,
  stdio: 'inherit',
})
if (build.status !== 0) process.exit(build.status ?? 1)

const migration = spawnSync(process.execPath, [resolve(root, 'scripts', 'migrate-postgres.mjs')], {
  cwd: root,
  stdio: 'inherit',
})
if (migration.status !== 0) process.exit(migration.status ?? 1)

const api = spawn(npm, ['--prefix', 'apps/api', 'start'], {
  cwd: root,
  stdio: 'inherit',
})

const stop = (signal) => api.kill(signal)
process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))
api.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
