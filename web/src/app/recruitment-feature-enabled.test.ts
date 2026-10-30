// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../shared/config/features', () => ({ recruitmentRequestsEnabled: true, externalJobPublishingEnabled: false }))
import { createAppRouter, installAuthGuard, getNavigationItemsForRole } from './router'
import { authSession } from '../modules/auth/session'

describe('explicitly enabled historical recruitment requests', () => {
  beforeEach(() => {
    Object.assign(authSession, {
      ready: true, loading: false,
      user: { id: 'u1', name: '测试', email: 'test@example.invalid', role: 'recruiter', departmentId: '', workspaceId: 'w1' },
      workspaces: [{ id: 'w1', name: '企业', kind: 'production', status: 'active', role: 'owner', createdAt: '2026-10-12' }],
    })
  })
  it('restores request navigation and detail routes when explicitly enabled', async () => {
    expect(getNavigationItemsForRole('recruiter', 'owner').some(item => item.path === '/requisitions')).toBe(true)
    const router = createAppRouter()
    installAuthGuard(router)
    await router.push('/requisitions/legacy-id')
    expect(router.currentRoute.value.name).toBe('requisition-detail')
    await router.push('/enterprise/approval-settings')
    expect(router.currentRoute.value.name).toBe('enterprise-approval-settings')
  })
  it('does not bypass enterprise administrator authorization when restored', async () => {
    authSession.workspaces[0]!.role = 'member'
    expect(getNavigationItemsForRole('recruiter', 'member').some(item => item.name === 'enterprise-approval-settings')).toBe(false)
    const router = createAppRouter()
    installAuthGuard(router)
    await router.push('/enterprise/approval-settings')
    expect(router.currentRoute.value.name).toBe('forbidden')
  })
})
