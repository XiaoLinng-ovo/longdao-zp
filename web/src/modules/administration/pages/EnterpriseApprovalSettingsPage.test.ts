// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApp } from 'vue'
import EnterpriseApprovalSettingsPage from './EnterpriseApprovalSettingsPage.vue'

describe('历史审批设置入口', () => {
  it('不再提供审批配置或调用旧接口', () => {
    const root = document.createElement('div')
    const app = createApp(EnterpriseApprovalSettingsPage)
    app.component('RouterLink', { template: '<a><slot /></a>' })
    app.mount(root)
    try {
      expect(root.textContent).toContain('招聘需求审批已停用')
      expect(root.querySelector('select')).toBeNull()
      expect(root.querySelector('button')).toBeNull()
    } finally { app.unmount() }
  })
})
