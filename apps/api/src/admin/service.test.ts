import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AdminService, AdminValidationError } from './service.js'

function row(overrides: Record<string, unknown> = {}) {
  return { id: 'd1', code: 'dept-tech', name: '技术部', is_active: true, created_at: '2026-09-18T00:00:00.000Z', updated_at: '2026-09-18T00:00:00.000Z', ...overrides }
}

describe('AdminService departments', () => {
  it('lists active departments for selectors', async () => {
    const pool = { query: async (sql: string) => ({ rows: sql.includes('is_active = true') ? [row()] : [] }) } as never
    const departments = await new AdminService(pool).listDepartments(true)
    assert.deepEqual(departments[0], { id: 'd1', code: 'dept-tech', name: '技术部', isActive: true, createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z' })
  })

  it('creates a department and rejects blank code or name', async () => {
    const calls: string[] = []
    const pool = { query: async (sql: string) => { calls.push(sql); return { rows: [row({ code: 'dept-ops', name: '运营部' })] } } } as never
    const service = new AdminService(pool)
    const created = await service.createDepartment({ code: ' dept-ops ', name: ' 运营部 ' }, 'admin-1', 'req-1')
    assert.equal(created.code, 'dept-ops')
    await assert.rejects(() => service.createDepartment({ code: '', name: '运营部' }, 'admin-1'), AdminValidationError)
    assert.ok(calls.some((sql) => sql.includes('INSERT INTO departments')))
  })

  it('renames and deactivates without changing the stable code', async () => {
    const pool = { query: async (sql: string) => ({ rows: [row({ name: sql.includes('UPDATE departments') ? '研发部' : '技术部', is_active: false })] }) } as never
    const result = await new AdminService(pool).updateDepartment('d1', { name: '研发部', isActive: false }, 'admin-1')
    assert.equal(result.code, 'dept-tech')
    assert.equal(result.name, '研发部')
    assert.equal(result.isActive, false)
  })
})
