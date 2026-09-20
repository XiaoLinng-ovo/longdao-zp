import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AdminService, AdminNotFoundError, AdminValidationError } from './service.js'

function row(overrides: Record<string, unknown> = {}) {
  return { id: 'd1', code: 'dept-tech', name: '技术部', is_active: true, created_at: '2026-09-18T00:00:00.000Z', updated_at: '2026-09-18T00:00:00.000Z', ...overrides }
}

describe('AdminService departments', () => {
  it('lists active departments for selectors', async () => {
    const pool = { query: async (sql: string) => ({ rows: sql.includes('is_active = true') ? [row()] : [] }) } as never
    const departments = await new AdminService(pool).listDepartments(true)
    assert.deepEqual(departments[0], { id: 'd1', code: 'dept-tech', name: '技术部', isActive: true, createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z' })
  })

  it('creates a department from its name with a generated unique code', async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, ...(values === undefined ? {} : { values }) })
        if (sql.startsWith('INSERT INTO departments')) return { rows: [row({ code: values?.[0], name: values?.[1] })] }
        return { rows: [] }
      },
    } as never
    const service = new AdminService(pool)
    const created = await service.createDepartment({ name: ' 运营部 ' }, 'admin-1', 'req-1')
    assert.match(created.code, /^dept-[0-9a-f]{12}$/)
    assert.equal(created.name, '运营部')
    const insert = calls.find((call) => call.sql.startsWith('INSERT INTO departments'))
    assert.deepEqual(insert?.values?.slice(0, 2), [created.code, '运营部'])
    await assert.rejects(() => service.createDepartment({ name: ' ' }, 'admin-1'), AdminValidationError)
  })

  it('retries department code generation after a unique-key collision', async () => {
    let attempts = 0
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        if (!sql.startsWith('INSERT INTO departments')) return { rows: [] }
        attempts += 1
        if (attempts === 1) throw Object.assign(new Error('duplicate'), { code: '23505' })
        return { rows: [row({ code: values?.[0], name: values?.[1] })] }
      },
    } as never
    const created = await new AdminService(pool).createDepartment({ name: '运营部' }, 'admin-1')
    assert.equal(attempts, 2)
    assert.match(created.code, /^dept-[0-9a-f]{12}$/)
  })

  it('renames and deactivates without changing the stable code', async () => {
    const pool = { query: async (sql: string) => ({ rows: [row({ name: sql.includes('UPDATE departments') ? '研发部' : '技术部', is_active: false })] }) } as never
    const result = await new AdminService(pool).updateDepartment('d1', { name: '研发部', isActive: false }, 'admin-1')
    assert.equal(result.code, 'dept-tech')
    assert.equal(result.name, '研发部')
    assert.equal(result.isActive, false)
  })

  it('physically deletes an unreferenced department and audits it', async () => {
    const calls: { sql: string; values?: unknown[] | undefined }[] = []
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values })
        if (sql.startsWith('SELECT id, code, name, is_active')) return { rows: [row({ code: 'dept-qa', name: '质量部' })] }
        if (sql.includes('FROM users WHERE department_id')) return { rows: [{ users: 0, requests: 0, jobs: 0, children: 0 }] }
        if (sql.includes('FROM department_approval_policies')) return { rows: [{ count: 2 }] }
        return { rows: [] }
      },
    } as never
    const result = await new AdminService(pool).deleteDepartment('d1', 'admin-1', 'req-1')
    assert.deepEqual(result, { id: 'd1', code: 'dept-qa', name: '质量部', removedApprovalPolicies: 2 })
    const deletion = calls.find((call) => call.sql.startsWith('DELETE FROM departments'))
    assert.ok(deletion, 'expected a physical DELETE on departments')
    assert.deepEqual(deletion.values, ['d1'])
    const audit = calls.find((call) => call.sql.includes('INSERT INTO audit_logs'))
    assert.equal(audit?.values?.[1], 'admin.department.delete')
    assert.deepEqual(audit?.values?.[5], JSON.stringify({ code: 'dept-qa', name: '质量部', removedApprovalPolicies: 2 }))
  })

  it('refuses physical deletion while users, requests, jobs or child departments still reference it', async () => {
    const calls: { sql: string }[] = []
    const pool = {
      query: async (sql: string) => {
        calls.push({ sql })
        if (sql.startsWith('SELECT id, code, name, is_active')) return { rows: [row({ code: 'dept-tech', name: '技术部' })] }
        return { rows: [{ users: 2, requests: 1, jobs: 3, children: 1 }] }
      },
    } as never
    await assert.rejects(
      () => new AdminService(pool).deleteDepartment('d1', 'admin-1'),
      (error: unknown) =>
        error instanceof AdminValidationError &&
        /2 个用户/.test((error as Error).message) &&
        /1 个招聘需求/.test((error as Error).message) &&
        /3 个岗位/.test((error as Error).message) &&
        /1 个子部门/.test((error as Error).message)
    )
    assert.equal(calls.some((call) => call.sql.startsWith('DELETE FROM departments')), false)
  })

  it('reports a missing department instead of deleting nothing', async () => {
    const pool = { query: async () => ({ rows: [] }) } as never
    await assert.rejects(() => new AdminService(pool).deleteDepartment('missing', 'admin-1'), AdminNotFoundError)
  })
})
