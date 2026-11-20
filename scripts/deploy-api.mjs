import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startProductionApi } from './start-api-production.mjs'
import { assertReleaseCredentials } from './check-release-credentials.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Explicit release operation. Ordinary production restarts remain read-only. */
export async function deployProductionApi({ env = process.env, spawnProcess = spawn, startApi = startProductionApi, checkBuild = access, checkCredentials = assertReleaseCredentials } = {}) {
  checkCredentials()
  try {
    await checkBuild(resolve(root, 'apps/api/dist/src/index.js'))
  } catch (error) {
    throw new Error('Prebuilt API is unavailable. Run pnpm --filter @smartrecruit-pro/api build before deploying.', { cause: error })
  }
  const productionEnv = { ...env, NODE_ENV: 'production' }
  console.log('[deploy] Applying pending database migrations before starting the API')
  await new Promise((resolveMigration, reject) => {
    const child = spawnProcess(process.execPath, [resolve(root, 'scripts/migrate-postgres.mjs')], {
      cwd: root, stdio: 'inherit', env: productionEnv,
    })
    let cancelled = false
    const stopInt = () => { cancelled = true; child.kill('SIGINT') }
    const stopTerm = () => { cancelled = true; child.kill('SIGTERM') }
    process.once('SIGINT', stopInt)
    process.once('SIGTERM', stopTerm)
    const cleanup = () => {
      process.removeListener('SIGINT', stopInt)
      process.removeListener('SIGTERM', stopTerm)
    }
    child.once('error', error => { cleanup(); reject(error) })
    child.once('exit', (code, signal) => {
      cleanup()
      if (cancelled || signal || code !== 0) reject(new Error('Database upgrade failed or was interrupted; the new API was not started.'))
      else resolveMigration()
    })
  })
  console.log('[deploy] Database is up to date; starting the prebuilt API')
  return startApi({ env: productionEnv, spawnProcess })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deployProductionApi().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
