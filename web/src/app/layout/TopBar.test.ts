// @vitest-environment jsdom
import { createApp, type App } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import TopBar from './TopBar.vue'

vi.mock('../../modules/auth/session', () => ({ authSession: { user: { name: '用户' } } }))
let app: App | undefined
let root: HTMLDivElement | undefined
afterEach(() => { app?.unmount(); root?.remove() })
it('顶部只保留页面标题，不重复展示用户信息入口', () => {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(TopBar, { title: '招聘工作台', crumb: '首页 / 招聘工作台' })
  app.component('router-link', { props: ['to'], template: '<a :href="to"><slot /></a>' })
  app.mount(root)
  expect(root.querySelector('h1')?.textContent).toBe('招聘工作台')
  expect(root.querySelector('.crumb')?.textContent).toBe('首页 / 招聘工作台')
  expect(root.querySelector('.account-trigger')).toBeNull()
  expect(root.querySelector('.workspace-switcher')).toBeNull()
})
