import { Pool, type PoolClient } from 'pg'
import { loadDatabaseConfig, type DatabaseConfig } from './config.js'

export function createDatabasePool(config: DatabaseConfig = loadDatabaseConfig()): Pool {
  const { target: _target, ...poolConfig } = config
  return new Pool(poolConfig)
}

export async function checkDatabaseReady(pool: Pool | PoolClient): Promise<void> {
  await pool.query('SELECT 1 AS ready')
}

export async function assertDatabaseReady(config: DatabaseConfig = loadDatabaseConfig()): Promise<void> {
  const pool = createDatabasePool(config)
  try {
    await checkDatabaseReady(pool)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`PostgreSQL is not ready at ${config.target}: ${reason}`)
  } finally {
    await pool.end()
  }
}
