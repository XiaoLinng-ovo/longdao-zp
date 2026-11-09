// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createAppRouter, getNavigationItemsForRole, installAuthGuard } from './router'
import { authSession } from '../modules/auth/session'

describe('system configuration is restricted to the bound system administrator', () => {
  beforeEach(() => {
    Object.assign(authSession, { ready: true, loading: false, workspaces: [], user: {
      id: 'system-admin', name: '系统管理员', email: 'admin@example.invalid', role: 'recruiter',
      departmentId: '', isSystemAdmin: true,
    } })
  })

  it.each(['/administration', '/administration?module=users', '/administration?module=settings', '/administration?module=smtp', '/enterprise/ai'])(
    'restores %s without a platform grant or selected enterprise', async path => {
      const router = createAppRouter()
      installAuthGuard(router)
      await router.push(path)
      expect(router.currentRoute.value.name).toBe('administration')
    },
  )

  it.each(['admin', 'hr_admin', 'recruiter'] as const)('does not promote legacy %s roles or enterprise owners', async role => {
    authSession.user = { id: 'ordinary', name: '企业用户', email: 'user@example.invalid', role, departmentId: '', workspaceId: 'w' }
    authSession.workspaces = [{ id: 'w', name: '企业', kind: 'test', status: 'active', role: 'owner', createdAt: '2026-11-07' }]
    const router = createAppRouter()
    installAuthGuard(router)
    await router.push('/administration?module=users')
    expect(router.currentRoute.value.name).toBe('forbidden')
    expect(getNavigationItemsForRole(role, 'owner').some(item => item.path === '/administration')).toBe(false)
  })

  it('does not grant platform operations to the system administrator', async () => {
    const items = getNavigationItemsForRole('recruiter', undefined, undefined, true)
    expect(items.some(item => item.path === '/administration')).toBe(true)
    expect(items.some(item => item.platformOnly)).toBe(false)
    const router = createAppRouter()
    installAuthGuard(router)
    await router.push('/platform/users')
    expect(router.currentRoute.value.name).toBe('forbidden')
  })

  it('keeps enterprise department management available to ordinary members', async () => {
    authSession.user = { id: 'ordinary', name: 'Member', email: 'member@example.invalid', role: 'recruiter', departmentId: '', workspaceId: 'w', isSystemAdmin: false }
    authSession.workspaces = [{ id: 'w', name: 'Enterprise', kind: 'test', status: 'active', role: 'member', createdAt: '2026-11-07' }]
    const router = createAppRouter()
    installAuthGuard(router)
    await router.push('/enterprise/departments')
    expect(router.currentRoute.value.name).toBe('enterprise-departments')
    const items = getNavigationItemsForRole('recruiter', 'member', undefined, false)
    expect(items.some(item => item.path === '/enterprise/departments')).toBe(true)
    expect(items.some(item => item.path === '/administration')).toBe(false)
  })
})
