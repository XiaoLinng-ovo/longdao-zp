import { Pool, type PoolConfig } from 'pg'
import { hasPostgresPassword } from './db-health.js'
import { createSeedState, LocalRecruitingStore } from './store.js'
import type { RecruitingStoreState } from './types.js'

function clone<T>(value: T): T {
  return structuredClone(value)
}

function poolConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  if (env.DATABASE_URL?.trim()) return { connectionString: env.DATABASE_URL.trim(), max: 10 }
  return {
    host: env.PGHOST?.trim() || '127.0.0.1',
    port: Number(env.PGPORT || 5432),
    user: env.PGUSER?.trim() || 'postgres',
    password: env.PGPASSWORD,
    database: env.PGDATABASE?.trim() || 'smartrecruit',
    max: 10,
  }
}

/**
 * PostgreSQL-backed state bridge used while the normalized repositories are
 * being introduced. The state is still serialized as JSON, but persistence,
 * locking and commit/rollback are real PostgreSQL operations.
 */
export class PostgresRecruitingStore {
  readonly pool: Pool

  constructor(config: PoolConfig = poolConfigFromEnv()) {
    this.pool = new Pool(config)
  }

  async read(): Promise<RecruitingStoreState> {
    const result = await this.pool.query<{ state: RecruitingStoreState }>(
      'SELECT state FROM recruiting_state WHERE id = $1',
      ['singleton'],
    )
    if (!result.rows[0]) {
      const seed = createSeedState()
      await this.pool.query(
        'INSERT INTO recruiting_state (id, state) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING',
        ['singleton', JSON.stringify(seed)],
      )
      return clone(seed)
    }
    return clone(result.rows[0].state)
  }

  async transaction<T>(operation: (draft: RecruitingStoreState) => Promise<T> | T): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT pg_advisory_xact_lock(hashtext('smartrecruit:recruiting-state'))")
      const result = await client.query<{ state: RecruitingStoreState }>(
        'SELECT state FROM recruiting_state WHERE id = $1 FOR UPDATE',
        ['singleton'],
      )
      const draft = clone(result.rows[0]?.state ?? createSeedState())
      const value = await operation(draft)
      await client.query(
        `INSERT INTO recruiting_state (id, state, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
        ['singleton', JSON.stringify(draft)],
      )
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

export function createRecruitingStore(): PostgresRecruitingStore | LocalRecruitingStore {
  if (!hasPostgresPassword(process.env) && process.env.RECRUITING_STORE !== 'postgres') {
    return new LocalRecruitingStore()
  }
  const testMode = process.env.NODE_ENV === 'test' || Boolean(process.env.RECRUITING_STORE_PATH)
  if (testMode || process.env.RECRUITING_STORE === 'local') {
    // Keep unit/API tests deterministic; production has no file-store fallback.
    return new LocalRecruitingStore()
  }
  return new PostgresRecruitingStore()
}

