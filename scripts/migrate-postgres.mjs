import '../apps/api/dist/src/env.js'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDatabaseConfig, createDatabasePool, checkDatabaseReady, runMigrations } from '../apps/api/dist/src/db/index.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const migrationDirectory = resolve(root, 'db', 'migrations')
const config = loadDatabaseConfig()
const pool = createDatabasePool(config)

try {
  await checkDatabaseReady(pool)
  const result = await runMigrations(pool, migrationDirectory)
  console.log(`PostgreSQL ready at ${config.target}`)
  if (result.applied.length) console.log(`Applied migrations: ${result.applied.join(', ')}`)
  else console.log('Migrations are up to date')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await pool.end()
}
