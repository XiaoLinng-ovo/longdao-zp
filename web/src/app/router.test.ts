// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { createAppRouter, installAuthGuard, navigationItems, getNavigationItemsForRole } from './router'
import { authSession } from '../modules/auth/session'

const expectedRoutes = [
  {
    path: '/',
    title: '招聘工作台',
    navLabel: '招聘工作台',
    icon: '◈',
  },
  {
    path: '/requisitions',
    title: '需求管理 · 审批',
    navLabel: '需求管理',
    icon: '①',
  },
  {
    path: '/jobs',
    title: '岗位管理',
    navLabel: '岗位管理',
    icon: '②',
  },
  {
    path: '/candidates',
    title: '简历库 · AI 评分',
    navLabel: '简历库 · AI 评分',
    icon: '③',
  },
  {
    path: '/interviews',
    title: '面试中心',
    navLabel: '面试中心',
    icon: '④',
  },
  {
    path: '/offers',
    title: '录用审批与 Offer',
    navLabel: '录用审批与 Offer',
    icon: '⑥',
  },
  {
    path: '/onboarding',
    title: '入职归档',
    navLabel: '入职归档',
    icon: '⑦',
  },
  {
    path: '/reports',
    title: '招聘数据看板',
    navLabel: '招聘数据看板',
    icon: '▦',
  },
  {
    path: '/administration',
    title: '系统配置',
    navLabel: '系统配置',
    icon: '⚙',
  },
] as const

describe('application router', () => {
  beforeEach(() => {
    authSession.ready = true
    authSession.user = null
    authSession.loading = false
  })
  it('exposes every recruiting route with navigation metadata', () => {
    const router = createAppRouter()
    const routeByPath = new Map(router.getRoutes().map((route) => [route.path, route]))

    expect(navigationItems).toHaveLength(expectedRoutes.length)

    for (const expected of expectedRoutes) {
      const route = routeByPath.get(expected.path)

      expect(route).toBeDefined()
      expect(route?.meta).toMatchObject({
        title: expected.title,
        navLabel: expected.navLabel,
        icon: expected.icon,
      })
      expect(route?.components?.default).toBeTypeOf('function')
    }
  })

  it('redirects unknown paths to the dashboard', async () => {
    const router = createAppRouter()

    await router.push('/this-route-does-not-exist')

    expect(router.currentRoute.value.path).toBe('/')
  })

  it('marks administration as admin-only and hides it for non-admin navigation', () => {
    const router = createAppRouter()
    const adminRoute = router.getRoutes().find((route) => route.name === 'administration')
    expect(adminRoute?.meta.adminOnly).toBe(true)
    expect(getNavigationItemsForRole('recruiter').some((item) => item.name === 'administration')).toBe(false)
    expect(getNavigationItemsForRole('admin').some((item) => item.name === 'administration')).toBe(true)
  })

  it('redirects unauthenticated users to login and preserves the destination', async () => {
    const router = createAppRouter()
    installAuthGuard(router)

    await router.push('/reports')

    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe('/reports')
  })

  it('shows a dedicated forbidden page when an authenticated user lacks access', async () => {
    authSession.user = { id: 'u1', name: '招聘专员', email: 'recruiter@example.com', role: 'recruiter', departmentId: 'd1' }
    const router = createAppRouter()
    installAuthGuard(router)

    await router.push('/administration')

    expect(router.currentRoute.value.name).toBe('forbidden')
    expect(router.currentRoute.value.query.from).toBe('/administration')
  })
})
