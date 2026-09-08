// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { createAppRouter, navigationItems } from './router'

const expectedRoutes = [
  {
    path: '/',
    title: '招聘概览',
    navLabel: '仪表盘',
    icon: 'layout-dashboard',
  },
  {
    path: '/requisitions',
    title: '招聘需求',
    navLabel: '招聘需求',
    icon: 'clipboard-list',
  },
  {
    path: '/jobs',
    title: '岗位管理',
    navLabel: '岗位',
    icon: 'briefcase-business',
  },
  {
    path: '/candidates',
    title: '候选人',
    navLabel: '候选人',
    icon: 'users',
  },
  {
    path: '/interviews',
    title: '面试管理',
    navLabel: '面试',
    icon: 'calendar-days',
  },
  {
    path: '/offers',
    title: 'Offer 管理',
    navLabel: 'Offer',
    icon: 'file-check-2',
  },
  {
    path: '/reports',
    title: '招聘报表',
    navLabel: '报表',
    icon: 'chart-no-axes-combined',
  },
  {
    path: '/administration',
    title: '管理后台',
    navLabel: '管理',
    icon: 'settings-2',
  },
] as const

describe('application router', () => {
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
})
