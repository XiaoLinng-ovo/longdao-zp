import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkPostgresConnection,
  createPostgresHealthPool,
  deleteRecruitingState,
  hasPostgresPassword,
  postgresPoolConfig,
  readRecruitingState,
  shouldSkipPostgresIntegration,
  writeRecruitingStateInTransaction,
} from '../src/recruiting/db-health.js'

const skipReason = !hasPostgresPassword()
  ? 'PGPASSWORD or a password-bearing DATABASE_URL is not configured'
  : ['1', 'true', 'yes', 'on'].includes(process.env.POSTGRES_INTEGRATION_SKIP?.trim().toLowerCase() ?? '')
    ? 'POSTGRES_INTEGRATION_SKIP is enabled'
    : undefined

test('PostgreSQL recruiting_state connection, transactions, and restart persistence', async (context) => {
  if (shouldSkipPostgresIntegration()) {
    context.skip(skipReason ?? 'PostgreSQL integration checks are disabled')
    return
  }

  const stateId = `db-health-${process.pid}-${randomUUID()}`
  let pool = createPostgresHealthPool()
  try {
    const connection = await checkPostgresConnection(pool)
    assert.equal(connection.database, postgresPoolConfig().database ?? 'smartrecruit')
    assert.equal(connection.recruitingStateTable, 'recruiting_state')
    assert.match(connection.serverVersion, /^17\./, 'expected the configured PostgreSQL 17 server')

    const initial = { marker: 'initial', writtenAt: new Date().toISOString() }
    const rolledBack = { marker: 'rolled-back', writtenAt: new Date().toISOString() }
    const committed = { marker: 'committed', writtenAt: new Date().toISOString() }

    await writeRecruitingStateInTransaction(pool, stateId, initial, 'commit')
    await writeRecruitingStateInTransaction(pool, stateId, rolledBack, 'rollback')
    assert.deepEqual(await readRecruitingState(pool, stateId), initial)

    await writeRecruitingStateInTransaction(pool, stateId, committed, 'commit')
    assert.deepEqual(await readRecruitingState(pool, stateId), committed)

    await pool.end()
    pool = createPostgresHealthPool()
    assert.deepEqual(await readRecruitingState(pool, stateId), committed)
  } finally {
    await deleteRecruitingState(pool, stateId).catch(() => undefined)
    await pool.end().catch(() => undefined)
  }
})
