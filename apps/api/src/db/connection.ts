import { Pool, type PoolClient } from 'pg'

// DATE 列按字面返回：PG 的 date 无时区，驱动默认按本地午夜解析成 Date，再序列化会因时区偏移差一天
// （例如 2026-10-08 → 2026-10-07）。这里统一按 'YYYY-MM-DD' 字符串处理。
import { types as pgTypes } from 'pg'
pgTypes.setTypeParser(1082, (value: string) => value)
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
