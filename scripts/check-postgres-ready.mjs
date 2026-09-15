import { assertDatabaseReady, loadDatabaseConfig } from '../apps/api/dist/src/db/index.js'

try {
  const config = loadDatabaseConfig()
  await assertDatabaseReady(config)
  console.log(`PostgreSQL ready at ${config.target}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
