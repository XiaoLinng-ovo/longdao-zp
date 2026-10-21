import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkPostgresConnection,
  createPostgresHealthPool,
  hasPostgresPassword,
  postgresPoolConfig,
  shouldSkipPostgresIntegration,
} from '../src/recruiting/db-health.js'

const skipReason = !hasPostgresPassword()
  ? 'PGPASSWORD or a password-bearing DATABASE_URL is not configured'
  : ['1', 'true', 'yes', 'on'].includes(process.env.POSTGRES_INTEGRATION_SKIP?.trim().toLowerCase() ?? '')
    ? 'POSTGRES_INTEGRATION_SKIP is enabled'
    : undefined

test('PostgreSQL connection exposes the normalized recruiting tables', async (context) => {
  if (shouldSkipPostgresIntegration()) {
    context.skip(skipReason ?? 'PostgreSQL integration checks are disabled')
    return
  }

  const pool = createPostgresHealthPool()
  try {
    const connection = await checkPostgresConnection(pool)
    const config = postgresPoolConfig()
    const expectedDatabase = config.connectionString
      ? decodeURIComponent(new URL(config.connectionString).pathname.slice(1))
      : config.database
    assert.equal(connection.database, expectedDatabase ?? 'smartrecruit')
    assert.deepEqual(connection.normalizedTables, ['applications', 'candidates', 'jobs', 'recruitment_requests'])
    assert.ok(Number.parseInt(connection.serverVersion.split('.')[0] ?? '0', 10) >= 16, `expected PostgreSQL 16 or newer, got ${connection.serverVersion}`)
  } finally {
    await pool.end().catch(() => undefined)
  }
})
