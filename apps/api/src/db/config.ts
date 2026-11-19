import type { PoolConfig } from 'pg'

export interface DatabaseConfig extends PoolConfig {
  target: string
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 5432
const DEFAULT_USER = 'postgres'
const DEFAULT_DATABASE = 'smartrecruit'

function valueOf(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

function readPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PGPORT must be an integer between 1 and 65535')
  }
  return port
}

function readPositiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function validateConnectionString(value: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must use the postgres:// or postgresql:// scheme')
  }
  if (!parsed.hostname) throw new Error('DATABASE_URL must include a database host')
  if (!parsed.pathname || parsed.pathname === '/') throw new Error('DATABASE_URL must include a database name')
}

function safeTarget(connectionString: string): string {
  try {
    const parsed = new URL(connectionString)
    const host = parsed.hostname || 'unknown-host'
    const port = parsed.port || String(DEFAULT_PORT)
    const database = parsed.pathname.replace(/^\//, '') || 'unknown-database'
    return `${host}:${port}/${decodeURIComponent(database)}`
  } catch {
    return 'configured PostgreSQL database'
  }
}

/** Reads and validates PostgreSQL settings without logging credentials. */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const connectionString = valueOf(env, 'DATABASE_URL')
  if (connectionString) {
    validateConnectionString(connectionString)
    return {
      connectionString,
      max: readPositiveInteger(valueOf(env, 'DB_POOL_MAX'), 'DB_POOL_MAX', 10),
      connectionTimeoutMillis: readPositiveInteger(valueOf(env, 'PGCONNECT_TIMEOUT_MS'), 'PGCONNECT_TIMEOUT_MS', 5000),
      target: safeTarget(connectionString),
    }
  }

  const host = valueOf(env, 'PGHOST') || DEFAULT_HOST
  const user = valueOf(env, 'PGUSER') || DEFAULT_USER
  const database = valueOf(env, 'PGDATABASE') || DEFAULT_DATABASE
  if (!host) throw new Error('PGHOST must not be empty')
  if (!user) throw new Error('PGUSER must not be empty')
  if (!database) throw new Error('PGDATABASE must not be empty')

  const port = readPort(valueOf(env, 'PGPORT'))
  return {
    host,
    port,
    user,
    ...(env.PGPASSWORD === undefined ? {} : { password: env.PGPASSWORD }),
    database,
    max: readPositiveInteger(valueOf(env, 'DB_POOL_MAX'), 'DB_POOL_MAX', 10),
    connectionTimeoutMillis: readPositiveInteger(valueOf(env, 'PGCONNECT_TIMEOUT_MS'), 'PGCONNECT_TIMEOUT_MS', 5000),
    target: `${host}:${port}/${database}`,
  }
}
