import { Pool, type PoolClient } from 'pg'

// DATE 列按字面返回：PG 的 date 无时区，驱动默认按本地午夜解析成 Date，再序列化会因时区偏移差一天
// （例如 2026-10-08 → 2026-10-07）。这里统一按 'YYYY-MM-DD' 字符串处理。
import { types as pgTypes } from 'pg'
pgTypes.setTypeParser(1082, (value: string) => value)
import { loadDatabaseConfig, type DatabaseConfig } from './config.js'
import { currentTenantContext } from './tenant-context.js'

export function bindTenantSearchPath(pool: Pool): Pool {
  const connect = pool.connect.bind(pool)
  type Callback = (error: Error | undefined, client: PoolClient, release: (error?: Error | boolean) => void) => void
  pool.connect = ((callback?: Callback) => {
    const tenant = currentTenantContext()
    const searchPath = tenant ? `"${tenant.schemaName}",public` : 'public'
    // Set the path on the leased connection before either pg query API can use it.
    const acquire = async (): Promise<PoolClient> => {
      const client = await connect()
      try {
        await client.query('SELECT set_config($1, $2, false)', ['search_path', searchPath])
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
    if (!callback) return acquire()
    void acquire().then(client => {
      callback(undefined, client, client.release)
    }, error => callback(error, undefined as never, undefined as never))
  }) as Pool['connect']
  pool.query = ((...args: unknown[]) => {
    const callback = typeof args.at(-1) === 'function' ? args.pop() as (...callbackArgs: unknown[]) => void : undefined
    const run = async () => {
      const client = await (pool.connect as () => Promise<PoolClient>)()
      try { return await (client.query as (...queryArgs: unknown[]) => Promise<unknown>)(...args) }
      finally { client.release() }
    }
    if (callback) {
      void run().then(result => callback(null, result), error => callback(error))
      return undefined
    }
    return run()
  }) as typeof pool.query
  return pool
}

export function createDatabasePool(config: DatabaseConfig = loadDatabaseConfig()): Pool {
  const { target: _target, ...poolConfig } = config
  return bindTenantSearchPath(new Pool(poolConfig))
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
