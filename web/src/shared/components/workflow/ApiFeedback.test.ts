// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import ApiFeedback from './ApiFeedback.vue'

let app: App | undefined
let root: HTMLDivElement | undefined
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); root = undefined })

function mount(message: string) {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(ApiFeedback, { tone: 'error', message })
  app.mount(root)
  return nextTick().then(() => root as HTMLDivElement)
}

describe('ApiFeedback', () => {
  it('uses a safe sign-in message for API 401 failures', async () => {
    const element = await mount('[401] AUTHENTICATION_REQUIRED · token expired')
    expect(element.textContent).toContain('登录状态已失效，请重新登录')
    expect(element.textContent).not.toContain('AUTHENTICATION_REQUIRED')
  })

  it('uses a safe permission message for API 403 failures', async () => {
    const element = await mount('[403] FORBIDDEN · internal policy detail')
    expect(element.textContent).toContain('当前账号没有执行此操作的权限')
    expect(element.textContent).not.toContain('internal policy detail')
  })
})
