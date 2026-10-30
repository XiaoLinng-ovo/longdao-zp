// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import EnterpriseApprovalSettingsPage from './EnterpriseApprovalSettingsPage.vue'
import { getRecruitmentApprovalSettings, updateRecruitmentApprovalSettings } from '../api'

vi.mock('../api', () => ({ getRecruitmentApprovalSettings: vi.fn(), updateRecruitmentApprovalSettings: vi.fn() }))
const mockedGet = vi.mocked(getRecruitmentApprovalSettings)
const mockedUpdate = vi.mocked(updateRecruitmentApprovalSettings)

let app: App | undefined
let root: HTMLDivElement | undefined
async function flush() { for (let i = 0; i < 5; i++) { await Promise.resolve(); await nextTick() } }

beforeEach(() => {
  mockedGet.mockResolvedValue({ mode: 'platform' })
  mockedUpdate.mockResolvedValue({ mode: 'dingtalk' })
})
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); root = undefined; vi.clearAllMocks() })

function mount() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: EnterpriseApprovalSettingsPage }] })
  app = createApp(EnterpriseApprovalSettingsPage)
  app.use(router)
  root = document.createElement('div')
  document.body.append(root)
  app.mount(root)
}

describe('EnterpriseApprovalSettingsPage', () => {
  it('loads the enterprise-wide approval mode and explains that platform mode needs no DingTalk binding', async () => {
    mount()
    await flush()

    expect(mockedGet).toHaveBeenCalledOnce()
    expect(root?.textContent).toContain('企业内所有成员提交招聘需求时使用相同方式')
    expect(root?.textContent).toContain('不需要绑定钉钉')
    expect(root?.querySelector('select')?.value).toBe('platform')
  })

  it('saves the selected mode for the enterprise', async () => {
    mount()
    await flush()
    const select = root!.querySelector('select')!
    select.value = 'dingtalk'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    root!.querySelector('button')!.click()
    await flush()

    expect(mockedUpdate).toHaveBeenCalledWith('dingtalk')
    expect(root?.textContent).toContain('已更新企业统一审批方式')
    expect(root?.textContent).toContain('当前生效：钉钉审批')
  })
  it('disables editing after a load failure and allows retrying', async () => {
    mockedGet.mockRejectedValueOnce(new Error('API unavailable'))
    mount()
    await flush()
    expect(root?.querySelector('select')?.disabled).toBe(true)
    expect(root?.querySelector<HTMLButtonElement>('.btn-primary')?.disabled).toBe(true)
    expect(root?.textContent).not.toContain('当前生效：')
    root!.querySelector<HTMLButtonElement>('.error-note button')!.click()
    await flush()
    expect(root?.querySelector('select')?.disabled).toBe(false)
    expect(mockedGet).toHaveBeenCalledTimes(2)
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

})
