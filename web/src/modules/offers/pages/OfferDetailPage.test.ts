// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import OfferDetailPage from './OfferDetailPage.vue'
import { getOffer, listOfferTemplates, previewOfferEmail, sendOfferEmail, updateOffer, offerAction } from '../api'
import { apiClient } from '../../../shared/api'

const routerPush = vi.fn()
const routeQuery = vi.hoisted(() => ({} as Record<string, string>))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'offer-1' }, query: routeQuery }),
  useRouter: () => ({ push: routerPush }),
}))
vi.mock('../api', async importOriginal => ({
  ...(await importOriginal<typeof import('../api')>()),
  getOffer: vi.fn(),
  listOfferTemplates: vi.fn(),
  offerAction: vi.fn(),
  sendOfferEmail: vi.fn(),
  previewOfferEmail: vi.fn(),
  updateOffer: vi.fn(),
}))
vi.mock('../../../shared/api', async importOriginal => ({ ...(await importOriginal<typeof import('../../../shared/api')>()), apiClient: { getJson: vi.fn() } }))
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
  vi.mocked(listOfferTemplates).mockResolvedValue([])
  for (const key of Object.keys(routeQuery)) delete routeQuery[key]
  vi.mocked(previewOfferEmail).mockImplementation(async (_id, input) => ({ to: input.to!, subject: input.subject, html: input.html!, versionId: 'version-1' }))
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
  it('uses the latest selected template without old contacts and sends exactly the previewed revision', async () => {
    const detail = await getOffer('offer-1')
    const version = { ...detail.version!, invoiceTitle: '123', taxNumber: '123456',
      content: '<p>企业税号：91330110MADN84UJ22。</p><p>如有疑问，请与人事部董春玲联系。</p><p>联系电话：18106122955</p>' }
    const offer = { ...detail.offer, status: 'sent' as const, versions: [version] }
    vi.mocked(getOffer).mockResolvedValue({ offer, version })
    const template = { id: 'template-1', name: '最新录用模板', filename: 'offer.html', isActive: true, isDefault: false,
      createdAt: '', updatedAt: '', content: '<p>缓存旧模板</p>' }
    vi.mocked(listOfferTemplates).mockResolvedValue([template])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(updateOffer).mockImplementation(async (_id, input) => {
      const nextVersion = { ...version, ...input, id: 'version-2', version: 2 }
      const nextOffer = { ...offer, currentVersionId: nextVersion.id, version: 2, versions: [nextVersion] }
      vi.mocked(getOffer).mockResolvedValue({ offer: nextOffer, version: nextVersion } as never)
      return nextOffer
    })
    vi.mocked(previewOfferEmail).mockImplementation(async (_id, input) => ({ to: input.to!, subject: input.subject, html: input.html!, versionId: input.versionId! }))
    vi.mocked(sendOfferEmail).mockResolvedValue({ ...offer, currentVersionId: 'version-2' })
    await mountDetail(); await click('重新发送')
    expect(root.querySelector('.offer-revise-dialog .rich-text-content')?.textContent).toContain('企业税号：123456。')
    // Re-fetch on apply, rather than using the template cached when opening.
    vi.mocked(listOfferTemplates).mockResolvedValue([{ ...template,
      content: '<p>{{候选人姓名}}，您好：</p><p>企业税号：{{企业税号}}。</p><p>发票抬头：{{发票抬头}}</p><p>工资：{{转正后月薪}}</p><h2>四、联系方式</h2><p>如有疑问，请与人事部联系。</p>' }])
    await inputByLabel('企业税号', '654321')
    await click('重新套用模板')
    expect(confirm).toHaveBeenCalled()
    expect(root.querySelector('.offer-revise-dialog .rich-text-content')?.textContent).not.toMatch(/董春玲|18106122955|缓存旧模板/)
    await click('预览邮件')
    const payload = vi.mocked(previewOfferEmail).mock.calls.at(-1)![1]
    expect(payload.versionId).toBe('version-2')
    expect(payload.html).toContain('654321')
    expect(payload.html).toContain('8000')
    expect(payload.html).toContain('如有疑问，请与人事部联系。')
    expect(payload.html).not.toMatch(/91330110MADN84UJ22|董春玲|18106122955|缓存旧模板/)
    expect(updateOffer).toHaveBeenCalledWith('offer-1', expect.objectContaining({ taxNumber: '654321', invoiceTitle: '123', baseSalary: { amount: 8000, currency: 'CNY' } }), 1)
    await click('确认发送')
    expect(vi.mocked(sendOfferEmail).mock.calls.at(-1)![1].html).toBe(payload.html)
    confirm.mockRestore()
  })
  it('preserves saved prose until reapplying is explicitly confirmed and handles template read failures', async () => {
    vi.mocked(listOfferTemplates).mockResolvedValue([{ id: 'template-1', name: '新模板', content: '<p>替换正文</p>', isActive: true } as never])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await mountDetail(); await click('编辑')
    expect(root.querySelector('.offer-revise-dialog .rich-text-content')?.textContent).toContain('saved-offer-template')
    await click('重新套用模板')
    expect(root.querySelector('.offer-revise-dialog .rich-text-content')?.textContent).toContain('saved-offer-template')
    vi.mocked(listOfferTemplates).mockRejectedValueOnce(new Error('读取模板失败'))
    await click('重新套用模板')
    expect(root.querySelector('.offer-revise-dialog')?.textContent).toContain('读取模板失败')
    expect(root.querySelector('.offer-revise-dialog .rich-text-content')?.textContent).toContain('saved-offer-template')
    expect(updateOffer).not.toHaveBeenCalled()
    confirm.mockRestore()
  })
  async function mountDetail() {
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(OfferDetailPage); app.mount(root); await flush()
  }
  async function click(label: string, scope: ParentNode = root) {
    const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)
    expect(button, label).toBeTruthy(); button!.click(); await flush()
  }
  async function input(selector: string, value: string) {
    const field = root.querySelector<HTMLInputElement>(selector)!
    field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); await flush()
  }
  async function inputByLabel(label: string, value: string) {
    const field = [...root.querySelectorAll<HTMLElement>('.form-field')]
      .find(item => item.querySelector('label')?.textContent?.trim() === label)
      ?.querySelector<HTMLInputElement>('input')
    expect(field, label).toBeTruthy()
    field!.value = value; field!.dispatchEvent(new Event('input', { bubbles: true })); await flush()
  }

  it('restores all saved fields and retains unsaved input across revision and resend openings', async () => {
    const detail = await getOffer('offer-1')
    const version = { ...detail.version!, reportingLocation: '杭州报到地址', invoiceTitle: '测试公司', taxNumber: '9133TEST',
      templateFields: { reportingTime: '09:30', supervisorName: '王主管', supervisorTitle: '总监', probationDuration: '3个月', formalSalaryStartMonth: '4', payday: '15' },
      compensation: { ...detail.version!.compensation, bonus: { amount: 2000, currency: 'CNY' }, equity: '保留股权约定' },
      benefits: ['五险一金', '餐补'], materials: ['id_card', 'bank_card:中国银行', 'other:资格证'],
      content: '<p>保留手写约定。</p><p>{{报到日期}} {{报到时间}} {{报到地点}}</p>' }
    vi.mocked(getOffer).mockResolvedValue({ ...detail, version, offer: { ...detail.offer, status: 'sent', lastEmail: { to: 'saved@example.test', subject: '上次保存的主题' } } })
    await mountDetail(); await click('编辑')
    expect(root.querySelector<HTMLInputElement>('#offer-reporting-date')?.value).toBe('2026-11-03')
    expect(root.querySelector<HTMLInputElement>('#offer-reporting-time')?.value).toBe('09:30')
    for (const [key, value] of Object.entries(version.templateFields).filter(([key]) => key !== 'reportingTime')) {
      expect(root.querySelector<HTMLInputElement>('#offer-' + key)?.value).toBe(value)
    }
    expect(root.querySelector<HTMLInputElement>('input[placeholder="请输入发票抬头"]')?.value).toBe('测试公司')
    expect(root.querySelector<HTMLInputElement>('input[placeholder="请输入企业税号"]')?.value).toBe('9133TEST')
    expect(root.querySelector('.offer-revise-body')?.textContent).toContain('保留手写约定。')
    await input('input[placeholder="请输入候选人报到地点"]', '未提交的新地址')
    await click('取消', root.querySelector('.offer-revise-dialog')!)
    await click('重新发送')
    expect(root.querySelector<HTMLInputElement>('input[placeholder="请输入候选人报到地点"]')?.value).toBe('未提交的新地址')
    expect(root.querySelector<HTMLInputElement>('#offer-email-to')?.value).toBe('saved@example.test')
    expect(root.querySelector<HTMLInputElement>('#offer-email-subject')?.value).toBe('上次保存的主题')
    await input('#offer-email-subject', '未提交的邮件主题')
    await click('取消', root.querySelector('.offer-revise-dialog')!)
    await click('重新发送')
    expect(root.querySelector<HTMLInputElement>('#offer-email-subject')?.value).toBe('未提交的邮件主题')
    expect(root.querySelector('.offer-revise-body .rich-text-content')?.textContent).toContain('未提交的新地址')
    expect(updateOffer).not.toHaveBeenCalled()
  })

  it('saves changed resend fields before previewing the new version and retains them on return', async () => {
    const detail = await getOffer('offer-1')
    const version = { ...detail.version!, content: '<p>报到地点：{{报到地点}}</p>' }
    const baseDetail = { ...detail, version, offer: { ...detail.offer, versions: [version] } }
    const sent = { ...baseDetail.offer, status: 'sent' as const }
    vi.mocked(getOffer).mockResolvedValue({ ...baseDetail, offer: sent })
    vi.mocked(previewOfferEmail).mockImplementation(async (_id, input) => ({ to: input.to!, subject: input.subject, html: input.html!, versionId: input.versionId! }))
    vi.mocked(updateOffer).mockImplementation(async (_id, input) => {
      const version = { ...baseDetail.version!, ...input, id: 'version-2', version: 2 }
      const offer = { ...sent, currentVersionId: version.id, version: 2, versions: [version] }
      vi.mocked(getOffer).mockResolvedValue({ offer, version } as never)
      return offer as never
    })
    await mountDetail(); await click('重新发送')
    await input('input[placeholder="请输入候选人报到地点"]', '新报到地点')
    await input('#offer-email-subject', '修订后的主题')
    await click('预览邮件')
    expect(updateOffer).toHaveBeenCalledTimes(1)
    expect(updateOffer).toHaveBeenCalledWith('offer-1', expect.objectContaining({ reportingLocation: '新报到地点' }), 1)
    expect(previewOfferEmail).toHaveBeenCalledWith('offer-1', expect.objectContaining({ versionId: 'version-2', subject: '修订后的主题', html: expect.stringContaining('新报到地点') }))
    expect(sendOfferEmail).not.toHaveBeenCalled()
    await click('返回', root.querySelector('.offer-email-dialog')!)
    expect(root.querySelector<HTMLInputElement>('input[placeholder="请输入候选人报到地点"]')?.value).toBe('新报到地点')
    expect(root.querySelector<HTMLInputElement>('#offer-email-subject')?.value).toBe('修订后的主题')
    await click('预览邮件')
    expect(updateOffer).toHaveBeenCalledTimes(1)
    vi.mocked(sendOfferEmail).mockResolvedValue({ ...sent, currentVersionId: 'version-2' })
    await click('确认发送')
    expect(sendOfferEmail).toHaveBeenCalledWith('offer-1', expect.objectContaining({ versionId: 'version-2', subject: '修订后的主题', html: expect.stringContaining('新报到地点') }))
  })

  it('rebuilds the email body from the current version after editing from an already-open email dialog', async () => {
    const detail = await getOffer('offer-1')
    const version = { ...detail.version!, content: '<p>报到地点：{{报到地点}}</p><p>转正月薪：{{转正后月薪}}</p>' }
    const baseDetail = { ...detail, version, offer: { ...detail.offer, versions: [version] } }
    vi.mocked(getOffer).mockResolvedValue(baseDetail)
    vi.mocked(updateOffer).mockImplementation(async (_id, input) => {
      const nextVersion = {
        ...version,
        ...input,
        compensation: {
          ...version.compensation,
          baseSalary: input.baseSalary ?? version.compensation.baseSalary,
          probationSalary: input.probationSalary ?? version.compensation.probationSalary,
          bonus: input.bonus ?? version.compensation.bonus,
          equity: input.equity ?? version.compensation.equity,
        },
        id: 'version-2', version: 2,
      }
      const nextOffer = { ...baseDetail.offer, currentVersionId: nextVersion.id, version: 2, versions: [nextVersion] }
      vi.mocked(getOffer).mockResolvedValue({ offer: nextOffer, version: nextVersion } as never)
      return nextOffer as never
    })
    vi.mocked(previewOfferEmail).mockImplementation(async (_id, input) => ({ to: input.to!, subject: input.subject, html: input.html!, versionId: input.versionId! }))
    vi.mocked(sendOfferEmail).mockResolvedValue({ ...baseDetail.offer, currentVersionId: 'version-2' } as never)

    await mountDetail()
    await click('发送 Offer')
    await click('编辑', root.querySelector('.offer-email-dialog')!)
    await inputByLabel('报到地点', '修订后地址')
    await inputByLabel('转正期工资（元/月）', '18000')
    await click('保存修订')
    expect(updateOffer).toHaveBeenCalledWith('offer-1', expect.objectContaining({
      baseSalary: { amount: 18000, currency: 'CNY' },
      content: expect.stringContaining('18000'),
    }), 1)
    await click('发送 Offer')
    await click('预览邮件', root.querySelector('.offer-email-dialog')!)

    expect(previewOfferEmail).toHaveBeenCalledWith('offer-1', expect.objectContaining({
      versionId: 'version-2',
      html: expect.stringContaining('修订后地址'),
    }))
    expect(vi.mocked(previewOfferEmail).mock.calls.at(-1)?.[1].html).toContain('18000')
    expect(vi.mocked(previewOfferEmail).mock.calls.at(-1)?.[1].html).not.toMatch(/>8000</u)
    await click('确认发送', root.querySelector('.offer-email-dialog')!)
    expect(sendOfferEmail).toHaveBeenCalledWith('offer-1', expect.objectContaining({
      versionId: 'version-2',
      html: expect.stringContaining('修订后地址'),
    }))
    expect(vi.mocked(sendOfferEmail).mock.calls[0]?.[1].html).toContain('18000')
    expect(vi.mocked(sendOfferEmail).mock.calls[0]?.[1].html).not.toMatch(/>8000</u)
  })

  it('does not create another version when resending unchanged saved content', async () => {
    const detail = await getOffer('offer-1')
    vi.mocked(getOffer).mockResolvedValue({ ...detail, offer: { ...detail.offer, status: 'sent' } })
    await mountDetail(); await click('重新发送'); await click('预览邮件')
    expect(updateOffer).not.toHaveBeenCalled()
    expect(previewOfferEmail).toHaveBeenCalledWith('offer-1', expect.objectContaining({ versionId: 'version-1' }))
  })

  it('retains resend edits when saving conflicts and does not preview or send stale content', async () => {
    const detail = await getOffer('offer-1')
    vi.mocked(getOffer).mockResolvedValue({ ...detail, offer: { ...detail.offer, status: 'sent' } })
    vi.mocked(updateOffer).mockRejectedValueOnce(new Error('Offer 已有变更，请刷新后重新编辑'))
    await mountDetail(); await click('重新发送')
    await input('input[placeholder="请输入候选人报到地点"]', '待保存的新地址')
    await click('预览邮件')
    expect(root.querySelector('.offer-revise-dialog')).toBeTruthy()
    expect(root.querySelector<HTMLInputElement>('input[placeholder="请输入候选人报到地点"]')?.value).toBe('待保存的新地址')
    expect(root.textContent).toContain('已有变更')
    expect(previewOfferEmail).not.toHaveBeenCalled()
    expect(sendOfferEmail).not.toHaveBeenCalled()
  })

  it('stops sending if a saved revision cannot be reloaded', async () => {
    const detail = await getOffer('offer-1')
    vi.mocked(getOffer).mockResolvedValue({ ...detail, offer: { ...detail.offer, status: 'sent' } })
    vi.mocked(updateOffer).mockImplementation(async () => {
      vi.mocked(getOffer).mockRejectedValueOnce(new Error('network unavailable'))
      return { ...detail.offer, version: 2, currentVersionId: 'version-2' }
    })
    await mountDetail(); await click('重新发送')
    await input('input[placeholder="请输入候选人报到地点"]', '新地址')
    await click('预览邮件')
    expect(root.textContent).toContain('新版本已保存，但详情刷新失败')
    expect(previewOfferEmail).not.toHaveBeenCalled()
    expect(sendOfferEmail).not.toHaveBeenCalled()
  })

  it('stops preview when the saved revision is not the reloaded current version', async () => {
    const detail = await getOffer('offer-1')
    const sent = { ...detail.offer, status: 'sent' as const }
    vi.mocked(getOffer)
      .mockResolvedValueOnce({ ...detail, offer: sent })
      .mockResolvedValue({ ...detail, offer: { ...sent, currentVersionId: 'version-1' }, version: detail.version })
    vi.mocked(updateOffer).mockResolvedValue({ ...sent, currentVersionId: 'version-2', version: 2 })
    await mountDetail(); await click('重新发送')
    await input('input[placeholder="请输入候选人报到地点"]', '新地址')
    await click('预览邮件')
    expect(root.querySelector('.offer-revise-dialog')).toBeTruthy()
    expect(root.textContent).toContain('当前版本尚未刷新成功')
    expect(previewOfferEmail).not.toHaveBeenCalled()
    expect(sendOfferEmail).not.toHaveBeenCalled()
  })

  it('ignores backdrop clicks in the email form and preview but still allows explicit cancellation', async () => {
    await mountDetail(); await click('发送 Offer')
    await input('#offer-email-to', 'custom@example.test')
    await input('#offer-email-subject', '自定义主题')
    const dialog = root.querySelector<HTMLElement>('.offer-email-dialog')!
    const backdrop = dialog.parentElement!

    backdrop.click(); await flush()
    expect(root.querySelector('.offer-email-dialog')).toBe(dialog)
    expect(dialog.querySelector<HTMLInputElement>('#offer-email-to')?.value).toBe('custom@example.test')
    expect(dialog.querySelector<HTMLInputElement>('#offer-email-subject')?.value).toBe('自定义主题')

    await click('预览邮件', dialog)
    expect(dialog.querySelector('.email-final-preview')?.textContent).toContain('自定义主题')
    backdrop.click(); await flush()
    expect(root.querySelector('.offer-email-dialog .email-final-preview')).not.toBeNull()
    expect(sendOfferEmail).not.toHaveBeenCalled()

    await click('取消', dialog)
    expect(root.querySelector('.offer-email-dialog')).toBeNull()
    expect(sendOfferEmail).not.toHaveBeenCalled()
  })

  it('offers confirmation only in the fixed header after previewing the email from its beginning', async () => {
    await mountDetail(); await click('发送 Offer')
    const dialog = root.querySelector('.offer-email-dialog')!
    const header = dialog.querySelector('.offer-email-header')!
    const body = dialog.querySelector<HTMLElement>('.offer-email-body')!
    expect(header.querySelector('button')).toBeNull()
    body.scrollTop = 180

    await click('预览邮件', body)
    expect(header.querySelector('button')?.textContent?.trim()).toBe('确认发送')
    expect(body.textContent).not.toContain('确认发送')
    expect(body.scrollTop).toBe(0)
    expect(sendOfferEmail).not.toHaveBeenCalled()

    await click('返回', body)
    expect(header.querySelector('button')).toBeNull()
  })

  it('retains an unsent initial email subject and recipient when reopening', async () => {
    await mountDetail(); await click('发送 Offer')
    await input('#offer-email-to', 'custom@example.test')
    await input('#offer-email-subject', '自定义主题')
    await click('取消', root.querySelector('.offer-email-dialog')!)
    await click('发送 Offer')
    expect(root.querySelector<HTMLInputElement>('#offer-email-to')?.value).toBe('custom@example.test')
    expect(root.querySelector<HTMLInputElement>('#offer-email-subject')?.value).toBe('自定义主题')
  })

  it('keeps accepted offers editable, previews before sending and preserves their status', async () => {
    const detail = await getOffer('offer-1')
    const accepted = { ...detail.offer, status: 'accepted' as const, respondedAt: '2026-11-04T00:00:00Z', confirmation: { currentVersionStatus: 'confirmed' as const, confirmations: [] } }
    vi.mocked(getOffer).mockResolvedValue({ ...detail, offer: accepted })
    vi.mocked(sendOfferEmail).mockResolvedValue(accepted)
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(OfferDetailPage); app.mount(root); await flush()
    const click = (label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label)!.click()
    expect(root.querySelector('.floating-resend-button')).toBeTruthy()
    expect(root.textContent).toContain('当前版本已确认')
    click('重新发送'); await flush()
    expect(root.querySelector('#offer-email-editor [contenteditable="true"]')).toBeNull()
    click('预览邮件'); await flush()
    expect(sendOfferEmail).not.toHaveBeenCalled()
    expect(root.querySelector('iframe')?.getAttribute('srcdoc')).toContain('saved-offer-template')
    click('确认发送'); await flush()
    expect(sendOfferEmail).toHaveBeenCalledWith('offer-1', expect.objectContaining({ versionId: 'version-1' }))
    expect(root.textContent).toContain('当前版本已确认')
    expect(root.textContent).not.toContain('新版本待确认')
    click('编辑'); await flush()
    expect(root.querySelector('[aria-labelledby="offer-revise-title"]')).toBeTruthy()
  })

  it.each([['1', undefined, '1', '2'], ['2个月', undefined, '2', '3'], ['3个月', undefined, '3', '4'], ['1', '12', '1', '12'], ['3个月', '3', '2', '3']])('previews and sends salary timing for probation %s and explicit month %s', async (duration, explicitMonth, salaryMonths, startMonth) => {
    const detail = await getOffer('offer-1')
    const version = { ...detail.version!, templateFields: { probationDuration: duration!, formalSalaryStartMonth: explicitMonth, payday: '15' },
      compensation: { baseSalary: { amount: 8000, currency: 'CNY' }, probationSalary: { amount: 4000, currency: 'CNY' } },
      benefits: ['五险一金'], content: '<p>试用期为 （建议填写 1 至 3 个月）。</p><p>入职前 个月税前薪资为 <strong>元/月</strong>；</p><p>转正后或自第 个月起，税前薪资调整为 <strong>元/月</strong>；</p><p>公司于每月 日发放工资；</p><p><strong>其他福利/约定</strong>：。</p>' }
    const accepted = { ...detail.offer, status: 'accepted' as const, versions: [version] }
    vi.mocked(getOffer).mockResolvedValue({ ...detail, offer: accepted, version })
    vi.mocked(sendOfferEmail).mockResolvedValue(accepted)
    await mountDetail()
    const salaryMonthRow = [...root.querySelectorAll('.info-list div')].find(row => row.querySelector('dt')?.textContent === '调薪起始月（入职第几个月）')
    expect(salaryMonthRow?.querySelector('dd')?.textContent).toBe(startMonth)
    await click('重新发送')
    await click('预览邮件')
    const input = vi.mocked(previewOfferEmail).mock.calls.at(-1)![1]
    const text = new DOMParser().parseFromString(input.html!, 'text/html').body.textContent
    expect(text).toContain(`入职前 ${salaryMonths}个月税前薪资为 4000元/月`)
    expect(text).toContain(`转正后或自第 ${startMonth}个月起，税前薪资调整为 8000元/月`)
    expect(text).toContain('公司于每月 15日发放工资')
    expect(text).toContain('其他福利/约定：五险一金。')
    expect(input.html).not.toContain('{{')
    expect(updateOffer).not.toHaveBeenCalled()
    expect(sendOfferEmail).not.toHaveBeenCalled()
    await click('确认发送')
    expect(sendOfferEmail).toHaveBeenCalledWith('offer-1', expect.objectContaining({ html: input.html, versionId: 'version-1' }))
  })

  it('expands the final email preview to show long content in full', async () => {
    const detail = await getOffer('offer-1')
    vi.mocked(previewOfferEmail).mockResolvedValue({
      to: 'zhangming@example.test',
      subject: 'Offer',
      html: '<html><body><p>完整邮件正文</p></body></html>',
      versionId: 'version-1',
    })
    vi.mocked(getOffer).mockResolvedValue(detail)
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(OfferDetailPage); app.mount(root); await flush()

    ;[...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '发送 Offer')!.click()
    await flush()
    ;[...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '预览邮件')!.click()
    await flush()

    const frame = root.querySelector<HTMLIFrameElement>('.email-final-preview iframe')!
    Object.defineProperty(frame, 'contentDocument', {
      configurable: true,
      value: { documentElement: { scrollHeight: 2400 }, body: { scrollHeight: 2400 } },
    })
    frame.dispatchEvent(new Event('load'))
    await flush()

    expect(frame.style.height).toBe('2400px')
    expect(root.querySelector('.offer-email-dialog')).toBeTruthy()
  })

  it('updates bound fields while preserving custom prose when saving an accepted revision', async () => {
    const detail = await getOffer('offer-1')
    const version = { ...detail.version!, reportingLocation: '旧地址', templateFields: { reportingTime: '2026-11-20T09:00' }, content: '<p>手工约定不得覆盖。</p><p>{{报到日期}} {{报到时间}} {{报到地点}}</p>' }
    vi.mocked(getOffer).mockResolvedValue({ ...detail, offer: { ...detail.offer, status: 'accepted' }, version })
    vi.mocked(updateOffer).mockResolvedValue(detail.offer)
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(OfferDetailPage); app.mount(root); await flush()
    ;[...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '编辑')!.click(); await flush()
    const set = async (selector: string, value: string) => { const input = root.querySelector<HTMLInputElement>(selector)!; input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); await flush() }
    await set('input[placeholder="请输入候选人报到地点"]', '新地址')
    await set('#offer-reporting-date', '2026-12-01')
    await set('#offer-reporting-time', '10:30')
    const body = root.querySelector('.offer-revise-body .rich-text-content')!
    expect(body.textContent).toContain('手工约定不得覆盖。')
    expect(body.textContent).toContain('2026-12-01 10:30 新地址')
    expect(body.textContent).not.toContain('旧地址')
    ;[...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '保存修订')!.click(); await flush()
    expect(updateOffer).toHaveBeenCalledWith('offer-1', expect.objectContaining({ startDate: '2026-12-01', reportingLocation: '新地址', content: expect.stringContaining('手工约定不得覆盖。') }), 1)
  })

  it('opens the same editor when entering from the list edit action', async () => {
    routeQuery.edit = '1'
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(OfferDetailPage); app.mount(root); await flush()
    expect(root.querySelector('[aria-labelledby="offer-revise-title"]')).toBeTruthy()
  })

  it('reports delivery success even when refreshing details fails afterwards', async () => {
    const detail = await getOffer('offer-1')
    const accepted = { ...detail.offer, status: 'accepted' as const }
    vi.mocked(getOffer).mockResolvedValue({ ...detail, offer: accepted })
    vi.mocked(sendOfferEmail).mockResolvedValue(accepted)
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(OfferDetailPage); app.mount(root); await flush()
    const click = (label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label)!.click()
    click('重新发送'); await flush()
    click('预览邮件'); await flush()
    vi.mocked(getOffer).mockRejectedValueOnce(new Error('network unavailable'))
    click('确认发送'); await flush()
    expect(sendOfferEmail).toHaveBeenCalledTimes(1)
    expect(root.querySelector('[aria-labelledby="offer-email-title"]')).toBeNull()
    expect(root.textContent).toContain('邮件已发送')
    expect(root.textContent).toContain('无需重复发送')
    expect(root.textContent).not.toContain('邮件发送失败')
  })

  it('keeps a conflicting send open without falsely reporting success', async () => {
    const detail = await getOffer('offer-1')
    vi.mocked(getOffer).mockResolvedValue({ ...detail, offer: { ...detail.offer, status: 'accepted' } })
    vi.mocked(sendOfferEmail).mockRejectedValueOnce(new Error('Offer 已有新版本，请刷新并重新预览'))
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(OfferDetailPage); app.mount(root); await flush()
    const click = (label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label)!.click()
    click('重新发送'); await flush()
    click('预览邮件'); await flush()
    click('确认发送'); await flush()
    expect(sendOfferEmail).toHaveBeenCalledTimes(1)
    expect(root.querySelector('[aria-labelledby="offer-email-title"]')).toBeTruthy()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('已有新版本')
    expect(root.textContent).not.toContain('邮件已发送至')
  })

  it('preserves custom material details when saving a revision', async () => {
    const detail = await getOffer('offer-1')
    vi.mocked(getOffer).mockResolvedValue({ ...detail, version: { ...detail.version!, materials: ['id_card', 'other:职业资格证书', 'bank_card:工商银行'] } })
    vi.mocked(updateOffer).mockResolvedValue(detail.offer)
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(OfferDetailPage); app.mount(root); await flush()
    ;[...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '编辑')!.click(); await flush()
    ;[...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '保存修订')!.click(); await flush()
    expect(updateOffer).toHaveBeenCalledWith('offer-1', expect.objectContaining({ materials: ['id_card', 'other:职业资格证书', 'bank_card:工商银行'] }), 1)
  })

  it('requires confirmation evidence and binds it to the current pending version', async () => {
    const detail = await getOffer('offer-1')
    vi.mocked(getOffer).mockResolvedValue({ ...detail, offer: { ...detail.offer, status: 'accepted', confirmation: { currentVersionStatus: 'pending', confirmations: [] } } })
    vi.mocked(offerAction).mockResolvedValue({ ...detail.offer, status: 'accepted' })
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(OfferDetailPage); app.mount(root); await flush()
    expect(root.textContent).toContain('新版本待确认')
    ;[...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '记录新版本确认')!.click(); await flush()
    const confirm = [...root.querySelectorAll<HTMLButtonElement>('.dialog-buttons button')].find(button => button.textContent?.trim() === '确认')!
    expect(confirm.disabled).toBe(true)
    const reason = root.querySelector<HTMLTextAreaElement>('#offer-detail-reason')!
    reason.value = '候选人已邮件确认调整'; reason.dispatchEvent(new Event('input')); await flush()
    confirm.click(); await flush()
    expect(offerAction).toHaveBeenCalledWith('offer-1', 'confirm-revision', '候选人已邮件确认调整', 'version-1')
  })

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
    const body = root.querySelector('#offer-email-editor .rich-text-content')
    expect(body?.textContent).toContain('抬头：测试<科技>有限公司')
    expect(body?.textContent).toContain('税号：TEST9133')
    expect(body?.textContent).toContain('张明')
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

    const body = root.querySelector<HTMLElement>('#offer-email-editor .rich-text-content')
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

    const body = root.querySelector<HTMLElement>('#offer-email-editor .rich-text-content')
    const text = body?.textContent ?? ''
    expect(text.match(/张明，您好：/gu)).toHaveLength(1)
    expect(text.indexOf('张明，您好：')).toBeLessThan(text.indexOf('录用通知书'))
    expect(text.indexOf('录用通知书')).toBeLessThan(text.indexOf('一、办理入职手续需提供的材料'))
    expect(text.indexOf('录用正文介绍')).toBeLessThan(text.indexOf('一、办理入职手续需提供的材料'))
    expect(text.indexOf('一、办理入职手续需提供的材料')).toBeLessThan(text.indexOf('请确保所提供资料真实'))
  })

  it('shows resend and edit without archive when an accepted offer already has onboarding', async () => {
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
    expect(labels).toContain('重新发送')
    expect(labels).not.toContain('入职归档')
  })

  it('shows resend and onboarding archive for an accepted offer without an onboarding record', async () => {
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
    expect(labels).toContain('重新发送')
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
    expect(root.querySelector<HTMLInputElement>('#offer-email-to')?.disabled).toBe(false)
    expect(root.querySelector<HTMLInputElement>('#offer-email-subject')?.disabled).toBe(false)
    expect(root.querySelector('#offer-email-attachment')).toBeNull()
    expect(root.querySelector('.offer-revise-body [contenteditable="true"]')).toBeTruthy()
    expect(root.querySelector<HTMLInputElement>('#offer-reporting-date')?.value).toBe('2026-11-03')
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

  it.each(['draft', 'sent', 'cancelled', 'accepted'] as const)('routes %s email edits through versioned revision', async (status) => {
    const detail = await getOffer('offer-1')
    vi.mocked(getOffer).mockResolvedValue({ ...detail, offer: { ...detail.offer, status } })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferDetailPage)
    app.mount(root)
    await flush()

    ;[...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === (status === 'draft' ? '发送 Offer' : '重新发送'))?.click()
    await flush()
    if (status === 'draft') {
      expect(root.querySelector('#offer-email-editor')).toBeTruthy()
      expect(root.querySelector('#offer-email-editor [contenteditable="true"]')).toBeNull()
      ;[...root.querySelectorAll<HTMLButtonElement>('.offer-email-dialog button')].find(button => button.textContent?.trim() === '编辑')?.click()
      await flush()
    } else {
      expect(root.querySelector('#offer-email-to')).toBeTruthy()
      expect(root.querySelector('.offer-revise-body [contenteditable="true"]')).toBeTruthy()
    }
    expect(root.querySelector('.offer-email-dialog')).toBeNull()
    expect(root.querySelector('.offer-revise-dialog')).toBeTruthy()
    expect([...root.querySelectorAll('button')].some(button => button.textContent?.trim() === (status === 'draft' ? '保存修订' : '预览邮件'))).toBe(true)
    expect(sendOfferEmail).not.toHaveBeenCalled()
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
