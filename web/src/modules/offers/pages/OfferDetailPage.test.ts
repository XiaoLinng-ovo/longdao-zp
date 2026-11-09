// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import OfferDetailPage from './OfferDetailPage.vue'
import { getOffer, sendOfferEmail, updateOffer } from '../api'
import { apiClient } from '../../../shared/api'

const routerPush = vi.fn()

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'offer-1' }, query: {} }),
  useRouter: () => ({ push: routerPush }),
}))
vi.mock('../api', async importOriginal => ({
  ...(await importOriginal<typeof import('../api')>()),
  getOffer: vi.fn(),
  offerAction: vi.fn(),
  sendOfferEmail: vi.fn(),
  updateOffer: vi.fn(),
}))
vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn() } }))
vi.mock('../../../shared/api/workflow-events', () => ({ loadWorkflowEvents: vi.fn(async () => []) }))
vi.mock('../../../shared/components/PageHeader.vue', () => ({ default: { template: '<header><slot /></header>' } }))
vi.mock('../../../shared/components/StatusTag.vue', () => ({ default: { template: '<span />' } }))
vi.mock('../../candidates/components/ApplicationResumeButton.vue', () => ({ default: { template: '<button type="button">简历</button>' } }))
vi.mock('../../../shared/components/workflow/WorkflowEventTable.vue', () => ({ default: { template: '<div />' } }))

let app: App
let root: HTMLDivElement

async function flush() { for (let i = 0; i < 10; i++) { await Promise.resolve(); await nextTick() } }

beforeEach(() => {
  vi.clearAllMocks()
  const version = {
    id: 'version-1', offerId: 'offer-1', version: 1, positionTitle: '算法工程师', departmentId: 'dept-1', employmentType: 'full_time', startDate: '2026-11-03',
    compensation: { baseSalary: { amount: 8000, currency: 'CNY' }, probationSalary: { amount: 5000, currency: 'CNY' } }, benefits: [], materials: [],
    content: '# 定制 Offer\n\n模板正文标记：saved-offer-template\n\n候选人：{{candidateName}}', createdAt: '2026-11-03T00:00:00Z',
  }
  vi.mocked(getOffer).mockResolvedValue({
    offer: { id: 'offer-1', applicationId: 'application-1', status: 'draft', currentVersionId: 'version-1', version: 1, createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z', versions: [version] },
    version,
  } as never)
  vi.mocked(apiClient.getJson).mockImplementation(async (path: string) => {
    if (path === '/applications') return { data: [{ id: 'application-1', code: 'APP-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'offer_approval' }] } as never
    if (path === '/candidates') return { data: [{ id: 'candidate-1', fullName: '张明', email: 'zhangming@example.test' }] } as never
    if (path === '/jobs') return { data: [{ id: 'job-1', title: '算法工程师' }] } as never
    return { data: [{ id: 'dept-1', name: '技术部' }] } as never
  })
})

afterEach(() => { app?.unmount(); root?.remove() })

describe('Offer email composition', () => {
  it('uses saved invoice details when composing an email and revising the draft', async () => {
    const detail = await getOffer('offer-1')
    vi.mocked(getOffer).mockResolvedValue({ ...detail, version: {
      ...detail.version!, invoiceTitle: '测试<科技>有限公司', taxNumber: 'TEST9133',
      content: '<p>{{candidateName}}</p><p>抬头：{{发票抬头}}</p><p>税号：{{企业税号}}</p>',
    } })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferDetailPage)
    app.mount(root)
    await flush()
    ;[...root.querySelectorAll('button')].find(button => button.textContent?.trim() === '发送 Offer')?.click()
    await flush()
    const body = root.querySelector('.rich-text-editor:not(.display-only) .rich-text-content')
    expect(body?.textContent).toContain('抬头：测试<科技>有限公司')
    expect(body?.textContent).toContain('税号：TEST9133')
    expect(body?.innerHTML).toContain('{{candidateName}}')
    ;[...root.querySelectorAll('button')].find(button => button.textContent?.trim() === '取消')?.click()
    await flush()
    ;[...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '编辑')?.click()
    await flush()
    expect(root.querySelector<HTMLInputElement>('input[placeholder="请输入发票抬头"]')?.value).toBe('测试<科技>有限公司')
    expect(root.querySelector<HTMLInputElement>('input[placeholder="请输入企业税号"]')?.value).toBe('TEST9133')
  })
  it('provides a return action in the page header', async () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferDetailPage)
    app.mount(root)
    await flush()

    const returnButton = [...root.querySelectorAll<HTMLButtonElement>('header button')].find((button) => button.textContent?.trim() === '返回 Offer 列表')
    expect(returnButton).toBeTruthy()
    returnButton?.click()
    expect(routerPush).toHaveBeenCalledWith('/offers')
  })

  it('loads the saved Offer content instead of replacing it with the fallback email template', async () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferDetailPage)
    app.mount(root)
    await flush()

    ;[...root.querySelectorAll('button')].find((button) => button.textContent?.trim() === '发送 Offer')?.click()
    await flush()

    const body = root.querySelector<HTMLElement>('.rich-text-editor:not(.display-only) .rich-text-content')
    expect(body?.textContent).toContain('模板正文标记：saved-offer-template')
    expect(body?.textContent).not.toContain('很高兴通知您，您已通过本次招聘流程')
  })

  it('keeps onboarding materials in the template order without duplicating the candidate greeting', async () => {
    const detail = await getOffer('offer-1')
    const version = {
      ...detail.version!,
      materials: ['id_card'],
      content: [
        '<h1>录用通知书</h1>',
        '<p>张明，您好：</p>',
        '<p>录用正文介绍。</p>',
        '<h2>一、办理入职手续需提供的材料</h2>',
        '<p>1. 身份证；</p>',
        '<p>请确保所提供资料真实、完整、有效。</p>',
        '<h2>二、薪酬福利及其他</h2>',
        '<p>薪酬正文。</p>',
      ].join(''),
    }
    vi.mocked(getOffer).mockResolvedValue({ ...detail, version } as never)

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferDetailPage)
    app.mount(root)
    await flush()

    ;[...root.querySelectorAll('button')].find((button) => button.textContent?.trim() === '发送 Offer')?.click()
    await flush()

    const body = root.querySelector<HTMLElement>('.rich-text-editor:not(.display-only) .rich-text-content')
    const text = body?.textContent ?? ''
    expect(text.match(/张明，您好：/gu)).toHaveLength(1)
    expect(text.indexOf('张明，您好：')).toBeLessThan(text.indexOf('录用通知书'))
    expect(text.indexOf('录用通知书')).toBeLessThan(text.indexOf('一、办理入职手续需提供的材料'))
    expect(text.indexOf('录用正文介绍')).toBeLessThan(text.indexOf('一、办理入职手续需提供的材料'))
    expect(text.indexOf('一、办理入职手续需提供的材料')).toBeLessThan(text.indexOf('请确保所提供资料真实'))
  })

  it('shows neither resend nor archive actions when an accepted offer already has onboarding', async () => {
    const detail = await getOffer('offer-1')
    vi.mocked(getOffer).mockResolvedValue({
      ...detail,
      offer: { ...detail.offer, status: 'accepted', onboarding: { status: 'pending' } },
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferDetailPage)
    app.mount(root)
    await flush()

    const labels = [...root.querySelectorAll('button')].map((button) => button.textContent?.trim())
    expect(labels).not.toContain('重新发送')
    expect(labels).not.toContain('入职归档')
  })

  it('shows only onboarding archive for an accepted offer without an onboarding record', async () => {
    const detail = await getOffer('offer-1')
    vi.mocked(getOffer).mockResolvedValue({
      ...detail,
      offer: { ...detail.offer, status: 'accepted' },
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferDetailPage)
    app.mount(root)
    await flush()

    const labels = [...root.querySelectorAll('button')].map((button) => button.textContent?.trim())
    expect(labels).not.toContain('重新发送')
    expect(labels).toContain('入职归档')
  })

  it('allows a cancelled offer to be resent or recreated', async () => {
    const detail = await getOffer('offer-1')
    vi.mocked(getOffer).mockResolvedValue({
      ...detail,
      offer: { ...detail.offer, status: 'cancelled' },
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferDetailPage)
    app.mount(root)
    await flush()

    const labels = [...root.querySelectorAll('button')].map((button) => button.textContent?.trim())
    expect(labels).toContain('重新发送')
    expect(labels).toContain('重新创建')

    ;[...root.querySelectorAll('button')].find((button) => button.textContent?.trim() === '重新发送')?.click()
    await flush()
    expect(root.textContent).toContain('重新发送 Offer 邮件')
    expect(root.querySelector<HTMLInputElement>('#offer-email-to')?.disabled).toBe(true)
    expect(root.querySelector<HTMLInputElement>('#offer-email-subject')?.disabled).toBe(true)
    expect(root.querySelector('#offer-email-attachment')).toBeNull()
    expect(root.querySelector('.rich-text-editor:not(.display-only)')).toBeTruthy()
  })

  it('shows the resend action as a fixed bottom-right button and allows editing a sent offer', async () => {
    const detail = await getOffer('offer-1')
    vi.mocked(getOffer).mockResolvedValue({ ...detail, offer: { ...detail.offer, status: 'sent' } })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferDetailPage)
    app.mount(root)
    await flush()

    const resend = [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '重新发送')
    expect(resend?.classList.contains('floating-resend-button')).toBe(true)
    expect(resend?.getAttribute('style')).toBeNull()
    expect(root.querySelector('.floating-resend-button')).toBe(resend)
    expect([...root.querySelectorAll('button')].some(button => button.textContent?.trim() === '编辑')).toBe(true)
  })

  it('resends only the edited email without revising the cancelled offer', async () => {
    const detail = await getOffer('offer-1')
    const cancelledOffer = { ...detail.offer, status: 'cancelled' as const }
    vi.mocked(getOffer).mockResolvedValue({ ...detail, offer: cancelledOffer })
    vi.mocked(sendOfferEmail).mockResolvedValue({ ...cancelledOffer, status: 'sent' })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferDetailPage)
    app.mount(root)
    await flush()

    ;[...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '重新发送')?.click()
    await flush()
    const editor = root.querySelector<HTMLElement>('#offer-email-editor .rich-text-content')!
    editor.innerHTML = '<p>调整后的邮件正文</p>'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    ;[...root.querySelectorAll<HTMLButtonElement>('.dialog-buttons button')].find(button => button.textContent?.trim() === '发送邮件')?.click()
    await flush()

    expect(sendOfferEmail).toHaveBeenCalledWith('offer-1', {
      to: 'zhangming@example.test', subject: 'Offer 录用通知｜算法工程师', html: '<p>调整后的邮件正文</p>',
    })
    expect(updateOffer).not.toHaveBeenCalled()
  })

  it.each([
    ['declined', '已拒绝（终态）'],
    ['expired', '已过期（终态）'],
  ] as const)('shows %s as a terminal state without a resend action', async (status, expectedText) => {
    const detail = await getOffer('offer-1')
    vi.mocked(getOffer).mockResolvedValue({
      ...detail,
      offer: { ...detail.offer, status },
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferDetailPage)
    app.mount(root)
    await flush()

    const labels = [...root.querySelectorAll('button')].map((button) => button.textContent?.trim())
    expect(labels).not.toContain('重新发送')
    expect(root.textContent).toContain(expectedText)
  })

  it('shows the document version instead of the offer workflow version', async () => {
    const detail = await getOffer('offer-1')
    vi.mocked(getOffer).mockResolvedValue({
      ...detail,
      offer: { ...detail.offer, version: 3 },
      version: { ...detail.version!, version: 2 },
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferDetailPage)
    app.mount(root)
    await flush()

    const currentVersionLabel = [...root.querySelectorAll('dt')].find((item) => item.textContent?.trim() === '当前版本')
    expect(currentVersionLabel?.nextElementSibling?.textContent?.trim()).toBe('V2')
    expect(root.textContent).not.toContain('V3')
  })
})
