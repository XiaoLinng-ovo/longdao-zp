// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import OfferListPage from './OfferListPage.vue'
import { loadApplicationsForOffer } from '../api'

vi.mock('../api', async importOriginal => ({ ...(await importOriginal<typeof import('../api')>()), listOfferContextRows: vi.fn(async () => []), loadApplicationsForOffer: vi.fn() }))
vi.mock('../../requisitions/api', () => ({ loadDepartments: vi.fn(async () => []) }))
vi.mock('../../jobs/api', () => ({ loadJobs: vi.fn(async () => []) }))
let app: App, root: HTMLDivElement
async function flush() { for (let i = 0; i < 10; i++) { await Promise.resolve(); await nextTick() } }
function button(text: string) { return [...root.querySelectorAll('button')].find(item => item.textContent?.trim() === text)! }
async function mount() { root = document.createElement('div'); document.body.appendChild(root); app = createApp(OfferListPage); app.mount(root); await flush() }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(loadApplicationsForOffer).mockImplementation(async eligible => eligible ? [{ id: 'passed', code: 'APP-1', candidateId: 'c', jobId: 'j', status: 'interviewing', candidateName: '复试通过者', jobTitle: '会计' }] : [{ id: 'initial', code: 'APP-2', candidateId: 'other', jobId: 'j', status: 'interviewing', candidateName: '仅初试者', jobTitle: '会计' }]) })
afterEach(() => { app?.unmount(); root?.remove() })
describe('Offer creation application picker', () => {
  it('only shows server-qualified applications and refreshes each opening', async () => {
    await mount(); button('新建 Offer').click(); await flush()
    const selector = root.querySelector('select')!
    expect([...selector.options].map(item => item.value)).toEqual(['', 'passed'])
    expect(selector.textContent).not.toContain('仅初试者')
    button('取消').click(); await flush()
    vi.mocked(loadApplicationsForOffer).mockImplementation(async () => [])
    button('新建 Offer').click(); await flush()
    expect(vi.mocked(loadApplicationsForOffer).mock.calls.filter(([eligible]) => eligible)).toHaveLength(2)
    expect(root.querySelector('select')?.textContent).toContain('暂无第二轮复试通过的申请')
    expect(button('创建草稿').disabled).toBe(true)
  })
  it('does not retain an old list when loading eligible applications fails', async () => {
    await mount(); button('新建 Offer').click(); await flush(); button('取消').click(); await flush()
    vi.mocked(loadApplicationsForOffer).mockImplementation(async eligible => { if (eligible) throw new Error('读取失败'); return [] })
    button('新建 Offer').click(); await flush()
    expect(root.querySelector('select')?.disabled).toBe(true)
    expect(root.querySelectorAll('select option[value=passed]')).toHaveLength(0)
    expect(root.textContent).toContain('读取失败')
  })
  it('ignores a delayed response after the creation dialog is closed', async () => {
    let finish!: (value: Awaited<ReturnType<typeof loadApplicationsForOffer>>) => void
    vi.mocked(loadApplicationsForOffer).mockImplementation(eligible => eligible ? new Promise(resolve => { finish = resolve }) : Promise.resolve([]))
    await mount(); button('新建 Offer').click(); await flush(); button('取消').click(); await flush()
    vi.mocked(loadApplicationsForOffer).mockResolvedValue([])
    button('新建 Offer').click(); await flush()
    finish([{ id: 'old', code: 'APP-old', candidateId: 'c', jobId: 'j', status: 'interviewing', candidateName: '旧申请' }]); await flush()
    expect(root.querySelector('select')?.textContent).not.toContain('旧申请')
  })
})
