import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

export async function migratePostgres({ args = [], database, log = console.log } = {}) {
  if (args.length > 1 || (args.length === 1 && !['--status', '--check'].includes(args[0])))
    throw new Error('Usage: node scripts/migrate-postgres.mjs [--status | --check]')
  if (!database) {
    await import('../apps/api/dist/src/env.js')
    database = await import('../apps/api/dist/src/db/index.js')
  }
  const config = database.loadDatabaseConfig()
  const pool = database.createDatabasePool(config)
  try {
    await database.checkDatabaseReady(pool)
    log('PostgreSQL ready at ' + config.target)
    if (args.length) {
      const status = await database.inspectMigrations(pool, resolve(root, 'db/migrations'))
      log('Applied migrations: ' + status.applied.length + '; pending: ' + status.pending.length)
      if (!status.ledgerExists) log('Migration ledger does not exist; status inspection has not created it.')
      if (status.pending.length) {
        log('Pending migrations: ' + status.pending.join(', '))
        if (args[0] === '--check') throw new Error('Database upgrade required. Run npm run db:migrate or npm run deploy:api before serving the new API.')
      } else log('Migrations are up to date')
      return status
    }
    const result = await database.runMigrations(pool, resolve(root, 'db/migrations'))
    if (result.applied.length) log('Applied migrations: ' + result.applied.join(', '))
    else log('Migrations are up to date')
    return result
  } finally { await pool.end() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migratePostgres({ args: process.argv.slice(2) }).catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
