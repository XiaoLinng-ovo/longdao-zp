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
    assert.equal(connection.database, postgresPoolConfig().database ?? 'smartrecruit')
    assert.deepEqual(connection.normalizedTables, ['applications', 'candidates', 'jobs', 'recruitment_requests'])
    assert.match(connection.serverVersion, /^17\./, 'expected the configured PostgreSQL 17 server')
  } finally {
    await pool.end().catch(() => undefined)
  }
})
