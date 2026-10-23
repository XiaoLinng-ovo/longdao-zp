import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AdminConflictError, AdminService, AdminValidationError } from './service.js'
import { verifyPassword } from '../auth/password.js'

const organizationId = '10000000-0000-4000-8000-000000000001'
const input = { email: ' Colleague@Example.com ', displayName: ' 同部门同事 ', organizationId, departmentCode: 'dept-tech', role: 'recruiter' }

function fixture(options: { missing?: 'organization' | 'department' | 'role'; duplicate?: boolean; failure?: string } = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  let released = false
  let connected = false
  let inserted: unknown[] = []
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, ...(values === undefined ? {} : { values }) })
      if (sql.startsWith('SELECT id FROM organizations')) return { rows: options.missing === 'organization' ? [] : [{ id: organizationId }] }
      if (sql.startsWith('SELECT id FROM departments')) return { rows: options.missing === 'department' ? [] : [{ id: 'department-1' }] }
      if (sql.startsWith('SELECT id FROM roles')) return { rows: options.missing === 'role' ? [] : [{ id: 'role-1' }] }
      if (sql.startsWith('SELECT id FROM users')) return { rows: options.duplicate ? [{ id: 'existing' }] : [] }
      if (sql.startsWith('INSERT INTO users')) {
        if (options.failure === '23505') throw Object.assign(new Error('duplicate'), { code: options.failure })
        inserted = values ?? []
      }
      if (sql.startsWith('INSERT INTO organization_members') && options.failure === 'P5501') throw Object.assign(new Error('seats'), { code: options.failure })
      if (sql.includes('INSERT INTO audit_logs') && options.failure === 'audit') throw new Error('audit unavailable')
      if (sql.includes('WHERE u.id = $1')) return { rows: [{ id: inserted[0], email: inserted[1], display_name: inserted[2], department_code: 'dept-tech', role: 'recruiter', is_active: true, last_login_at: null, created_at: '2026-10-22T00:00:00.000Z' }] }
      return { rows: [] }
    },
    release: () => { released = true },
  }
  const pool = { connect: async () => { connected = true; return client } } as never
  return { service: new AdminService(pool), calls, get released() { return released }, get connected() { return connected } }
}

describe('AdminService account creation', () => {
  it('generates a secure initial password, hashes it, and atomically assigns membership', async () => {
    const f = fixture()
    const result = await f.service.createUser(input, 'actor-1', 'request-1')
    assert.equal(result.generatedPassword, true)
    assert.equal(result.initialPassword.length, 16)
    for (const pattern of [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/]) assert.match(result.initialPassword, pattern)
    assert.equal(result.user.email, 'colleague@example.com')
    assert.equal(result.user.displayName, '同部门同事')
    const insert = f.calls.find(call => call.sql.startsWith('INSERT INTO users'))!
    assert.equal(await verifyPassword(result.initialPassword, String(insert.values?.[3])), true)
    assert.equal(insert.values?.[4], 'department-1')
    const membership = f.calls.find(call => call.sql.startsWith('INSERT INTO organization_members'))!
    assert.deepEqual(membership.values, [organizationId, result.user.id, 'recruiter', 'department-1'])
    const assignment = f.calls.find(call => call.sql.startsWith('INSERT INTO user_roles'))!
    assert.deepEqual(assignment.values, [result.user.id, 'role-1'])
    const audit = f.calls.find(call => call.sql.includes('INSERT INTO audit_logs'))!
    assert.deepEqual(audit.values?.slice(0, 5), ['actor-1', 'admin.user.create', 'user', result.user.id, 'request-1'])
    const metadata = JSON.parse(String(audit.values?.[5])) as Record<string, unknown>
    assert.deepEqual(metadata, { email: 'colleague@example.com', organizationId, departmentCode: 'dept-tech', role: 'recruiter', generatedPassword: true })
    assert.equal(JSON.stringify(result.user).includes(result.initialPassword), false)
    assert.equal(JSON.stringify(audit.values).includes(result.initialPassword), false)
    assert.equal(f.calls.at(-1)?.sql, 'COMMIT')
    assert.equal(f.released, true)
  })

  it('preserves a custom password exactly, including spaces', async () => {
    const f = fixture()
    const password = '  My custom Password!  '
    const result = await f.service.createUser({ ...input, password }, 'actor-1')
    assert.equal(result.initialPassword, password)
    assert.equal(result.generatedPassword, false)
    const insert = f.calls.find(call => call.sql.startsWith('INSERT INTO users'))!
    assert.equal(await verifyPassword(password, String(insert.values?.[3])), true)
  })

  it('rejects malformed fields and platform roles before opening a transaction', async () => {
    for (const patch of [{ role: 'platform_admin' }, { role: 'platform_operator' }, { role: 'unknown' }, { email: 'invalid' }, { displayName: ' ' }, { organizationId: 'invalid' }, { departmentCode: '' }, { password: 'short' }, { password: '        ' }, { password: 'x'.repeat(129) }]) {
      const f = fixture()
      await assert.rejects(() => f.service.createUser({ ...input, ...patch }, 'actor-1'), AdminValidationError)
      assert.equal(f.connected, false)
    }
  })

  it('rejects unavailable organizations, inactive departments and missing roles with rollback', async () => {
    for (const missing of ['organization', 'department', 'role'] as const) {
      const f = fixture({ missing })
      await assert.rejects(() => f.service.createUser(input, 'actor-1'), AdminValidationError)
      assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK')
      assert.equal(f.calls.some(call => call.sql.startsWith('INSERT INTO users')), false)
      assert.equal(f.released, true)
    }
  })

  it('returns conflicts for existing email, concurrent duplicate email and exhausted seats', async () => {
    for (const options of [{ duplicate: true }, { failure: '23505' }, { failure: 'P5501' }]) {
      const f = fixture(options)
      await assert.rejects(() => f.service.createUser(input, 'actor-1'), AdminConflictError)
      assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK')
      assert.equal(f.calls.some(call => call.sql === 'COMMIT'), false)
      assert.equal(f.released, true)
    }
  })

  it('rolls back account and membership when audit fails', async () => {
    const f = fixture({ failure: 'audit' })
    await assert.rejects(() => f.service.createUser(input, 'actor-1'), /audit unavailable/)
    assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK')
    assert.equal(f.released, true)
  })
})
