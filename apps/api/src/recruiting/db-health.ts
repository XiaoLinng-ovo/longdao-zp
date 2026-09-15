import { Pool, type PoolClient, type PoolConfig } from 'pg'

export interface RecruitingStateValue {
  marker: string
  writtenAt: string
}

export interface PostgresConnectionInfo {
  database: string
  serverVersion: string
  recruitingStateTable: string
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
  const table = await pool.query<{ table_name: string | null }>(
    "SELECT to_regclass('public.recruiting_state') AS table_name",
  )
  const row = connection.rows[0]
  const tableName = table.rows[0]?.table_name
  if (!row || tableName !== 'recruiting_state') {
    throw new Error('PostgreSQL is reachable but public.recruiting_state is missing; run migration 0006')
  }
  return {
    database: row.database,
    serverVersion: row.server_version,
    recruitingStateTable: tableName,
  }
}

export async function readRecruitingState(
  pool: Pool,
  id: string,
): Promise<RecruitingStateValue | null> {
  const result = await pool.query<{ state: RecruitingStateValue }>(
    'SELECT state FROM recruiting_state WHERE id = $1',
    [id],
  )
  return result.rows[0]?.state ?? null
}

async function writeState(client: PoolClient, id: string, state: RecruitingStateValue): Promise<void> {
  await client.query(
    `INSERT INTO recruiting_state (id, state, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [id, JSON.stringify(state)],
  )
}

/** Runs one real PostgreSQL transaction and explicitly commits or rolls back it. */
export async function writeRecruitingStateInTransaction(
  pool: Pool,
  id: string,
  state: RecruitingStateValue,
  outcome: 'commit' | 'rollback',
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await writeState(client, id, state)
    await client.query(outcome === 'commit' ? 'COMMIT' : 'ROLLBACK')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function deleteRecruitingState(pool: Pool, id: string): Promise<void> {
  await pool.query('DELETE FROM recruiting_state WHERE id = $1', [id])
}
