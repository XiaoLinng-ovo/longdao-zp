import { Pool, type PoolConfig } from 'pg'

/** Tables required by the normalized recruiting repository. */
export const REQUIRED_RECRUITING_TABLES = [
  'recruitment_requests',
  'jobs',
  'candidates',
  'applications',
] as const

export interface PostgresConnectionInfo {
  database: string
  serverVersion: string
  normalizedTables: string[]
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '')
}

function databaseUrlHasPassword(databaseUrl: string): boolean {
  try {
    return Boolean(new URL(databaseUrl).password)
  } catch {
    return false
  }
}

/**
 * Integration checks require an explicit password so local trust-authenticated
 * PostgreSQL installations do not turn a missing secret into a test failure.
 */
export function hasPostgresPassword(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PGPASSWORD?.trim()) return true
  const databaseUrl = env.DATABASE_URL?.trim()
  return databaseUrl ? databaseUrlHasPassword(databaseUrl) : false
}

export function shouldSkipPostgresIntegration(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthy(env.POSTGRES_INTEGRATION_SKIP) || !hasPostgresPassword(env)
}

export function postgresPoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  if (env.DATABASE_URL?.trim()) {
    return {
      connectionString: env.DATABASE_URL.trim(),
      max: 4,
      connectionTimeoutMillis: 5000,
    }
  }

  return {
    host: env.PGHOST?.trim() || '127.0.0.1',
    port: Number(env.PGPORT || 5432),
    user: env.PGUSER?.trim() || 'postgres',
    password: env.PGPASSWORD,
    database: env.PGDATABASE?.trim() || 'smartrecruit',
    max: 4,
    connectionTimeoutMillis: 5000,
  }
}

export function createPostgresHealthPool(env: NodeJS.ProcessEnv = process.env): Pool {
  return new Pool(postgresPoolConfig(env))
}

export async function checkPostgresConnection(pool: Pool): Promise<PostgresConnectionInfo> {
  const connection = await pool.query<{ database: string; server_version: string }>(
    'SELECT current_database() AS database, current_setting(\'server_version\') AS server_version',
  )
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name`,
    [REQUIRED_RECRUITING_TABLES],
  )
  const row = connection.rows[0]
  const normalizedTables = tables.rows.map((table) => table.table_name)
  const missing = REQUIRED_RECRUITING_TABLES.filter((table) => !normalizedTables.includes(table))
  if (!row || missing.length) {
    throw new Error(`PostgreSQL is reachable but normalized recruiting tables are missing: ${missing.join(', ')}`)
  }
  return {
    database: row.database,
    serverVersion: row.server_version,
    normalizedTables,
  }
}
