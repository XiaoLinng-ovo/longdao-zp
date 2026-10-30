// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { createAppRouter } from '../app/router'
import { navigationItems } from '../app/navigation'

describe('navigation integration', () => {
  it('resolves every navigation item to a route component', async () => {
    const router = createAppRouter()

    for (const item of navigationItems) {
      await router.push(item.path)
      expect(router.currentRoute.value.path).toBe(item.path)
      expect(router.currentRoute.value.meta.title).toBe(item.title)
      expect(router.currentRoute.value.matched[0]?.components?.default).toBeDefined()
    }
  })

  it('keeps navigation metadata unique and complete', () => {
    expect(new Set(navigationItems.map((item) => item.path)).size).toBe(navigationItems.length)
    expect(navigationItems.every((item) => item.title && item.navLabel && item.icon)).toBe(true)
  })
})
