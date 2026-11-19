import { Pool } from 'pg'
import { bindPoolCancellation } from '@smartrecruit-pro/runtime-lifecycle'

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
  return bindPoolCancellation(new Pool(options))
}

export function createWorkerTenantPool(options: WorkerPoolOptions, schemaName: string, sharedPool?: Pool): Pool {
  if (!/^company_[0-9a-f]{32}$/.test(schemaName)) throw new Error('INVALID_TENANT_SCHEMA')
  const base = sharedPool ?? createWorkerPool(options)
  const pool: Pool = sharedPool ? Object.create(base) : base
  if (sharedPool) pool.end = (async () => undefined) as Pool['end']
  const connect = base.connect.bind(base)
  const acquire = async () => {
    const client = await connect()
    try {
      await client.query('SELECT set_config($1,$2,false)', ['search_path', `"${schemaName}",public`])
      const release = client.release.bind(client)
      let released = false
      client.release = ((error?: Error | boolean) => {
        if (released) throw new Error('Database client has already been released')
        released = true
        if (error) { release(error); return }
        void client.query('RESET search_path').then(() => release(), () => release(true))
      }) as typeof client.release
      return client
    } catch (error) {
      client.release(true)
      throw error
    }
  }
  pool.connect = ((callback?: (error: Error | undefined, client: import('pg').PoolClient, release: (error?: Error | boolean) => void) => void) => {
    if (!callback) return acquire()
    void acquire().then(client => {
      callback(undefined, client, client.release)
    }, error => callback(error, undefined as never, undefined as never))
  }) as Pool['connect']
  pool.query = ((...args: unknown[]) => {
    const callback = typeof args.at(-1) === 'function' ? args.pop() as (...callbackArgs: unknown[]) => void : undefined
    const run = async () => {
      const client = await (pool.connect as () => Promise<import('pg').PoolClient>)()
      try { return await (client.query as (...queryArgs: unknown[]) => Promise<unknown>)(...args) }
      finally { client.release() }
    }
    if (callback) { void run().then(result => callback(null, result), error => callback(error)); return undefined }
    return run()
  }) as typeof pool.query
  return pool
}
