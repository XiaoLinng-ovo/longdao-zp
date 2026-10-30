import { Pool } from 'pg'

export interface WorkerPoolOptions {
  connectionString?: string
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  max?: number
  connectionTimeoutMillis?: number
}

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

/**
 * Builds a PostgreSQL pool for the analysis worker without logging credentials.
 * DATABASE_URL takes precedence; the PG* variables mirror the API configuration.
 */
export function loadWorkerPoolConfig(env: NodeJS.ProcessEnv = process.env): WorkerPoolOptions {
  const connectionString = env.DATABASE_URL?.trim()
  if (connectionString) {
    return {
      connectionString,
      max: positiveInteger(env.DB_POOL_MAX, 'DB_POOL_MAX') ?? 10,
      connectionTimeoutMillis: positiveInteger(env.PGCONNECT_TIMEOUT_MS, 'PGCONNECT_TIMEOUT_MS') ?? 5000,
    }
  }

  const port = positiveInteger(env.PGPORT, 'PGPORT')
  return {
    host: env.PGHOST?.trim() || '127.0.0.1',
    port: port ?? 5432,
    user: env.PGUSER?.trim() || 'postgres',
    ...(env.PGPASSWORD === undefined ? {} : { password: env.PGPASSWORD }),
    database: env.PGDATABASE?.trim() || 'smartrecruit',
    max: positiveInteger(env.DB_POOL_MAX, 'DB_POOL_MAX') ?? 10,
    connectionTimeoutMillis: positiveInteger(env.PGCONNECT_TIMEOUT_MS, 'PGCONNECT_TIMEOUT_MS') ?? 5000,
  }
}

export function createWorkerPool(options: WorkerPoolOptions = loadWorkerPoolConfig()): Pool {
  return new Pool(options)
}