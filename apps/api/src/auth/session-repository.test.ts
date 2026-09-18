import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SessionUser } from './types.js'
import { PostgresSessionRepository } from './session-repository.js'

class FakePool {
  calls: Array<{ sql: string; values: unknown[] }> = []
  responses: unknown[]
  constructor(responses: unknown[] = []) { this.responses = responses }
  async query<T extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ sql, values })
    return { rows: (this.responses.shift() ?? []) as T[] }
  }
}

const user: SessionUser = { id: '11111111-1111-4111-8111-111111111111', name: 'Admin', email: 'admin@example.com', role: 'admin', departmentId: '22222222-2222-4222-8222-222222222222' }

describe('PostgresSessionRepository', () => {
  it('creates a session with hashed token and parameterized SQL', async () => {
    const pool = new FakePool([[{ id: '33333333-3333-4333-8333-333333333333', user_id: user.id, token_hash: 'hash', csrf_token_hash: 'csrf', created_at: new Date(), expires_at: new Date(Date.now() + 1000), last_seen_at: new Date() }]])
    const repository = new PostgresSessionRepository(pool)
    const result = await repository.createSession(user, 1000)
    assert.ok(result.token)
    assert.equal(result.session.userId, user.id)
    assert.match(pool.calls[0]!.sql, /INSERT INTO sessions/i)
    assert.equal(pool.calls[0]!.values.length, 8)
    assert.ok(!pool.calls[0]!.sql.includes(result.token))
  })

  it('finds a non-expired session by token hash and touches last_seen_at', async () => {
    const row = { id: '33333333-3333-4333-8333-333333333333', user_id: user.id, token_hash: 'x', created_at: new Date(), expires_at: new Date(Date.now() + 100000), last_seen_at: new Date(), name: user.name, email: user.email, role: user.role, department_id: user.departmentId }
    const pool = new FakePool([[row], []])
    const repository = new PostgresSessionRepository(pool)
    const session = await repository.findSessionByToken('secret')
    assert.equal(session?.sessionId, row.id)
    assert.match(pool.calls[0]!.sql, /token_hash = \$1/i)
    assert.match(pool.calls[0]!.sql, /u\.is_active = true/i)
    assert.match(pool.calls[1]!.sql, /UPDATE sessions SET last_seen_at/i)
  })

  it('revokes sessions and removes expired or revoked rows', async () => {
    const pool = new FakePool([[], [{ count: '3' }]])
    const repository = new PostgresSessionRepository(pool)
    await repository.revokeSession('33333333-3333-4333-8333-333333333333')
    const removed = await repository.cleanupExpiredSessions()
    assert.equal(removed, 3)
    assert.match(pool.calls[0]!.sql, /UPDATE sessions SET revoked_at/i)
    assert.match(pool.calls[1]!.sql, /DELETE FROM sessions/i)
  })
})

it('loads a user by email and verifies a database password hash', async () => {
  const { hashPassword } = await import('./password.js')
  const passwordHash = await hashPassword('secret')
  const pool = new FakePool([[{ id: user.id, display_name: user.name, email: user.email, password_hash: passwordHash, department_id: user.departmentId, role: user.role }]])
  const repository = new PostgresSessionRepository(pool)
  const found = await repository.findUserByEmailPassword(user.email, 'secret')
  assert.deepEqual(found, user)
  assert.match(pool.calls[0]!.sql, /FROM users/i)
})

it('exposes a unified auth session store factory for postgres environments', async () => {
  const { createAuthSessionStore } = await import('./auth-service.js')
  const store = createAuthSessionStore({ DATABASE_URL: 'postgres://localhost/smartrecruit', NODE_ENV: 'production' })
  assert.equal(store.constructor.name, 'PostgresSessionRepository')
})

it('uses PostgreSQL sessions in development when database credentials are configured', async () => {
  const { createAuthSessionStore } = await import('./auth-service.js')
  const store = createAuthSessionStore({ PGPASSWORD: 'development-password', NODE_ENV: 'development' })
  assert.equal(store.constructor.name, 'PostgresSessionRepository')
})

it('refuses local session fallback in production without database configuration', async () => {
  const { createAuthSessionStore } = await import('./auth-service.js')
  assert.throws(() => createAuthSessionStore({ NODE_ENV: 'production' }), /database configuration/i)
})
