// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import OfferListPage from './OfferListPage.vue'
import { createOffer, listOfferContextRows, listOfferTemplates, loadApplicationsForOffer } from '../api'
import { loadDepartments } from '../../requisitions/api'
import { loadJobs } from '../../jobs/api'

const routerPush = vi.fn()

vi.mock('vue-router', () => ({ useRouter: () => ({ push: routerPush, currentRoute: { value: { query: {} } } }) }))

vi.mock('../api', async importOriginal => ({ ...(await importOriginal<typeof import('../api')>()), createOffer: vi.fn(), listOfferContextRows: vi.fn(async () => []), listOfferTemplates: vi.fn(async () => []), loadApplicationsForOffer: vi.fn() }))
vi.mock('../../requisitions/api', () => ({ loadDepartments: vi.fn(async () => []) }))
vi.mock('../../jobs/api', () => ({ loadJobs: vi.fn(async () => []) }))
let app: App, root: HTMLDivElement
async function flush() { for (let i = 0; i < 10; i++) { await Promise.resolve(); await nextTick() } }
function button(text: string) { return [...root.querySelectorAll('button')].find(item => item.textContent?.trim() === text)! }
async function mount() { root = document.createElement('div'); document.body.appendChild(root); app = createApp(OfferListPage); app.mount(root); await flush() }
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listOfferContextRows).mockResolvedValue([])
  vi.mocked(listOfferTemplates).mockResolvedValue([])
  vi.mocked(loadDepartments).mockResolvedValue([{ id: 'dept-1', name: '财务部' }] as never)
  vi.mocked(loadJobs).mockResolvedValue([{ id: 'j', entityId: 'j', title: '会计', department: '财务部' }] as never)
  vi.mocked(loadApplicationsForOffer).mockImplementation(async eligible => eligible ? [{ id: 'passed', code: 'APP-1', candidateId: 'c', jobId: 'j', status: 'interviewing', candidateName: '复试通过者', jobTitle: '会计' }] : [{ id: 'initial', code: 'APP-2', candidateId: 'other', jobId: 'j', status: 'interviewing', candidateName: '仅初试者', jobTitle: '会计' }])
})
afterEach(() => { app?.unmount(); root?.remove() })
describe('Offer creation application picker', () => {
  it('starts a fresh offer for the cancelled application without copying old terms', async () => {
    vi.mocked(loadApplicationsForOffer).mockResolvedValue([{
      id: 'cancelled-application', code: 'APP-3', candidateId: 'c', jobId: 'j',
      status: 'offer_cancelled', candidateName: '取消后重新办理者', jobTitle: '会计',
    }])
    vi.mocked(listOfferContextRows).mockResolvedValue([{
      id: 'old-offer', entityId: 'old-offer', applicationId: 'cancelled-application',
      candidate: '取消后重新办理者', job: '会计', status: 'cancelled', updatedAt: '',
    }] as never)
    await mount()
    button('新建 Offer').click()
    await flush()
    expect(root.querySelector('select')?.textContent).toContain('取消后重新办理者')
    button('取消').click()
    await flush()
    button('重新创建').click()
    await flush()
    expect(root.querySelector('select')?.value).toBe('cancelled-application')
    expect(root.querySelector<HTMLInputElement>('input[placeholder="请输入候选人报到地点"]')?.value).toBe('')
    const salaries = [...root.querySelectorAll('.form-field')].filter(field => /工资（元\/月）/.test(field.querySelector('label')?.textContent ?? ''))
    expect(salaries).toHaveLength(2)
    for (const field of salaries) expect(field.querySelector<HTMLInputElement>('input')?.value).toBe('0')
    expect(root.querySelectorAll('details input[type="checkbox"]:checked')).toHaveLength(0)
  })

  it('fills and saves invoice details, renders the template and clears values on reopening', async () => {
    vi.mocked(listOfferTemplates).mockResolvedValue([{
      id: 'invoice-template', name: '发票模板', filename: 'invoice.html',
      content: '<p>发票抬头：{{发票抬头}}</p><p>企业税号：{{企业税号}}</p>',
      isActive: true, isDefault: true, createdAt: '', updatedAt: '',
    }])
    await mount()
    button('填写 Offer').click()
    await flush()
    for (const [placeholder, value] of [['请输入发票抬头', '测试<科技>有限公司'], ['请输入企业税号', 'TEST9133']]) {
      const input = root.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!
      expect(input).toBeTruthy()
      input.value = value!
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flush()
    }
    expect(root.querySelector('.rich-text-content')?.textContent).toContain('发票抬头：测试<科技>有限公司')
    expect(root.querySelector('.rich-text-content')?.textContent).toContain('企业税号：TEST9133')
    const salaryFields = [...root.querySelectorAll('.form-field')].filter(field => /工资（元\/月）/.test(field.querySelector('label')?.textContent ?? ''))
    for (const field of salaryFields) {
      const input = field.querySelector<HTMLInputElement>('input')!
      input.value = '10000'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await flush()
    button('保存草稿').click()
    await flush()
    expect(createOffer).toHaveBeenCalledWith(expect.objectContaining({
      invoiceTitle: '测试<科技>有限公司', taxNumber: 'TEST9133',
      content: '<p>发票抬头：测试&lt;科技&gt;有限公司</p><p>企业税号：TEST9133</p>',
    }))
    button('新建 Offer').click()
    await flush()
    expect(root.querySelector<HTMLInputElement>('input[placeholder="请输入发票抬头"]')?.value).toBe('')
    expect(root.querySelector<HTMLInputElement>('input[placeholder="请输入企业税号"]')?.value).toBe('')
  })
  it('opens the unified full-page detail view from the offer list', async () => {
    vi.mocked(listOfferContextRows).mockResolvedValue([{
      id: 'offer-1', entityId: 'offer-1', candidate: '张明', job: '算法工程师', status: 'sent', updatedAt: '2026-11-04 14:00',
    }] as never)
    await mount()

    button('详情').click()

    expect(routerPush).toHaveBeenCalledWith({ name: 'offer-detail', params: { id: 'offer-1' } })
  })

  it('only shows server-qualified applications and refreshes each opening', async () => {
    await mount(); button('新建 Offer').click(); await flush()
    const selector = root.querySelector('select')!
    expect([...selector.options].map(item => item.value)).toEqual(['', 'passed'])
    expect(selector.textContent).not.toContain('仅初试者')
    button('取消').click(); await flush()
    vi.mocked(loadApplicationsForOffer).mockImplementation(async () => [])
    button('新建 Offer').click(); await flush()
    expect(vi.mocked(loadApplicationsForOffer).mock.calls.filter(([eligible]) => eligible)).toHaveLength(3)
    expect(root.querySelector('select')?.textContent).toContain('暂无可办理的申请')
    expect(button('保存草稿').disabled).toBe(true)
  })
  it('does not retain an old list when loading eligible applications fails', async () => {
    await mount(); button('新建 Offer').click(); await flush(); button('取消').click(); await flush()
    vi.mocked(loadApplicationsForOffer).mockImplementation(async eligible => { if (eligible) throw new Error('读取失败'); return [] })
    button('新建 Offer').click(); await flush()
    expect(root.querySelector('select')?.disabled).toBe(true)
    expect(root.querySelectorAll('select option[value=passed]')).toHaveLength(0)
    expect(root.textContent).toContain('读取失败')
  })
  it('keeps the creation dialog open after a backdrop click and allows closing with cancel', async () => {
    await mount()
    button('新建 Offer').click()
    await flush()

    root.querySelector('.overlay')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(root.querySelector('[role="dialog"]')).toBeTruthy()

    root.querySelector<HTMLButtonElement>('.offer-create-actions button:first-child')!.click()
    await flush()
    expect(root.querySelector('[role="dialog"]')).toBeNull()
  })
  it('prefills a qualified candidate and applies the default template from the offer queue', async () => {
    vi.mocked(listOfferTemplates).mockResolvedValue([{
      id: 'template-1', name: '标准 Offer', filename: 'standard.md', content: '候选人：{{candidateName}}\n岗位：{{jobTitle}}', isActive: true, isDefault: true,
      createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
    }])
    await mount()
    button('填写 Offer').click()
    await flush()
    expect(root.querySelector('select')?.value).toBe('passed')
    expect(root.querySelector('.rich-text-content')?.textContent).toContain('候选人：复试通过者')
    expect(root.querySelector('.rich-text-content')?.textContent).toContain('岗位：会计')
  })
  it('allows selecting preset and custom materials and persists their details', async () => {
    vi.mocked(listOfferTemplates).mockResolvedValue([{
      id: 'template-1', name: '材料模板', filename: 'materials.md', content: '{{入职材料}}', isActive: true, isDefault: true,
      createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
    }])
    vi.mocked(createOffer).mockResolvedValue({} as never)
    await mount(); button('填写 Offer').click(); await flush()
    const details = root.querySelector('details.offer-materials-field')!
    expect(details.textContent).toContain('入职材料')
    expect(details.textContent).toContain('未选择')
    details.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click()
    await flush()
    details.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[6].click()
    await flush()
    details.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[7].click()
    await flush()
    expect(details.textContent).toContain('已选 3 项')
    const bankInput = details.querySelector<HTMLInputElement>('input[placeholder="请输入银行名称"]')!
    bankInput.value = '招商银行'
    bankInput.dispatchEvent(new Event('input', { bubbles: true }))
    const customInput = details.querySelector<HTMLInputElement>('input[placeholder="请输入其他入职材料"]')!
    customInput.value = '无犯罪记录证明'
    customInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    const inputForLabel = (labelText: string) => {
      const field = [...root.querySelectorAll<HTMLElement>('.form-field')].find(item => item.querySelector('label')?.textContent?.includes(labelText))
      return field?.querySelector<HTMLInputElement>('input')!
    }
    for (const [labelText, value] of [['转正期工资', '12000'], ['试用期工资', '10000']]) {
      const input = inputForLabel(labelText)
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await flush()
    button('保存草稿').click(); await flush()
    expect(createOffer).toHaveBeenCalledWith(expect.objectContaining({ materials: ['id_card', 'bank_card:招商银行', 'other:无犯罪记录证明'], content: '<p>1. 身份证；<br>2. 招商银行工资卡；<br>3. 无犯罪记录证明；</p>' }))
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
