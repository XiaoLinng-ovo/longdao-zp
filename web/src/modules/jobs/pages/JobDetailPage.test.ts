// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import JobDetailPage from './JobDetailPage.vue'
import { generateJobSpec, generateJobDescription, type ApiJob, getJob, updateJob, jobAction, listActiveAiSkills, listJobDescriptionVersions, listJobSpecVersions } from '../api'
import { apiClient } from '../../../shared/api'
import { loadWorkflowEvents } from '../../../shared/api/workflow-events'
import { loadDepartments } from '../../requisitions/api'

const featureFlags = vi.hoisted(() => ({ externalJobPublishingEnabled: true, recruitmentRequestsEnabled: false }))
vi.mock('../../../shared/config/features', () => featureFlags)

vi.mock('../api', () => ({ getJob: vi.fn(), jobAction: vi.fn(), listActiveAiSkills: vi.fn(), listJobDescriptionVersions: vi.fn(), listJobSpecVersions: vi.fn(), createJd: vi.fn(), createSpec: vi.fn(), generateJobDescription: vi.fn(), generateJobSpec: vi.fn(), updateJob: vi.fn() }))
vi.mock('../../../shared/api', async (importOriginal) => ({ ...await importOriginal<typeof import('../../../shared/api')>(), apiClient: { getJson: vi.fn() } }))
vi.mock('../../../shared/api/workflow-events', () => ({ loadWorkflowEvents: vi.fn() }))
vi.mock('../../requisitions/api', () => ({ loadDepartments: vi.fn() }))

const readyJob = { id: 'new-job', code: 'JOB-NEW', title: '人事专员', departmentId: 'HR', department: '人事部', recruitmentRequestId: '', headcount: 1, filledCount: 0, employmentType: 'full_time', workMode: 'onsite', status: 'ready', channels: [], version: 1, createdAt: '', updatedAt: '', spec: { version: 1, title: '人事专员', summary: '管理人员档案', responsibilities: [], requirements: [], skills: [], confirmed: true }, jd: { version: 1, language: 'zh-CN', content: '人事岗位 JD', generatedBy: 'human' as const, confirmed: true } }
let app: App | undefined
let root: HTMLDivElement
async function flush() { for (let i = 0; i < 16; i++) { await Promise.resolve(); await nextTick() } }
async function mount() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/jobs/:id', component: { template: '<div />' } }] })
  await router.push('/jobs/new-job?recruitmentRequestId=legacy-query-must-be-ignored')
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(JobDetailPage); app.use(router); app.mount(root)
  await flush()
}
function publishButton() { return [...root.querySelectorAll<HTMLButtonElement>('.actions-panel button')].find(button => button.textContent?.trim() === '发布')! }
beforeEach(() => {
  featureFlags.externalJobPublishingEnabled = true
  vi.mocked(getJob).mockResolvedValue(structuredClone(readyJob))
  vi.mocked(listActiveAiSkills).mockResolvedValue([])
  vi.mocked(listJobDescriptionVersions).mockResolvedValue([])
  vi.mocked(listJobSpecVersions).mockResolvedValue([])
  vi.mocked(loadWorkflowEvents).mockResolvedValue([])
  vi.mocked(loadDepartments).mockResolvedValue([])
})
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.resetAllMocks() })

describe('独立岗位详情与发布', () => {
  it('无关联岗位可以发布，不从 URL 引入需求关联也不读取需求接口', async () => {
    vi.mocked(jobAction).mockResolvedValue({ ...readyJob, status: 'published' })
    await mount()
    expect(root.textContent).not.toContain('需求来源')
    expect(publishButton().disabled).toBe(false)
    expect(vi.mocked(apiClient.getJson)).not.toHaveBeenCalled()
    publishButton().click(); await flush()
    expect(jobAction).toHaveBeenCalledWith('new-job', 'publish', undefined)
    expect(root.textContent).toContain('发布成功')
  })
  it('无关联岗位未确认文档时仍然不能发布', async () => {
    vi.mocked(getJob).mockResolvedValue({ ...readyJob, spec: { ...readyJob.spec, confirmed: false } })
    await mount()
    expect(publishButton().disabled).toBe(true)
    expect(vi.mocked(apiClient.getJson)).not.toHaveBeenCalled()
  })
  it.each(['pending_approval', 'approved', 'converted'])('保留历史关联审批校验：%s', async (status) => {
    vi.mocked(getJob).mockResolvedValue({ ...readyJob, recruitmentRequestId: 'historical-request' })
    vi.mocked(apiClient.getJson).mockResolvedValue({ ok: true, requestId: 'test', data: { title: '历史招聘需求', status } } as never)
    await mount()
    expect(apiClient.getJson).toHaveBeenCalledWith('/recruitment-requests/historical-request')
    expect(publishButton().disabled).toBe(status === 'pending_approval')
  })
})


describe('岗位负责人保存与显示', () => {
  function button(label: string) { return [...root.querySelectorAll('button')].find(item => item.textContent?.trim() === label)! }
  function managerInput() { return [...root.querySelectorAll('.form-field')].find(item => item.querySelector('label')?.textContent === '负责人')!.querySelector('input')! }
  function managerDisplay() { return [...root.querySelectorAll('.detail-item')].find(item => item.querySelector('span')?.textContent === '负责人')!.querySelector('strong')! }
  it('submits multiple manager names and keeps them visible after save, refresh and reopening the form', async () => {
    vi.mocked(updateJob).mockResolvedValue({ ...readyJob, hiringManagerId: '张三、李四' })
    await mount()
    expect(managerDisplay().textContent).toBe('未设置')
    button('编辑基础信息').click(); await flush()
    managerInput().value = '  张三、李四  '; managerInput().dispatchEvent(new Event('input')); await flush()
    button('保存').click(); await flush()
    expect(updateJob).toHaveBeenCalledWith('new-job', expect.objectContaining({ hiringManagerId: '张三、李四' }))
    expect(managerDisplay().textContent).toBe('张三、李四')
    vi.mocked(getJob).mockResolvedValue({ ...readyJob, hiringManagerId: '张三、李四' })
    button('刷新').click(); await flush()
    expect(managerDisplay().textContent).toBe('张三、李四')
    button('编辑基础信息').click(); await flush()
    expect(managerInput().value).toBe('张三、李四')
  })
  it.each([undefined, '张三'])('does not report success when the backend drops or changes manager names: %s', async (returnedNames) => {
    vi.mocked(updateJob).mockResolvedValue({ ...readyJob, hiringManagerId: returnedNames, version: 2 })
    await mount(); button('编辑基础信息').click(); await flush()
    managerInput().value = '  张三、李四  '; managerInput().dispatchEvent(new Event('input')); await flush()
    button('保存').click(); await flush()
    expect(root.textContent).toContain('负责人未保存')
    expect(root.textContent).toContain('可能仍在运行旧版后端')
    expect(root.textContent).not.toContain('岗位基础信息已更新')
    expect(managerInput().value).toBe('  张三、李四  ')
    expect(button('保存').disabled).toBe(false)
    expect(managerDisplay().textContent).toBe(returnedNames || '未设置')
    // Once the backend is updated, the same form can be retried successfully.
    vi.mocked(updateJob).mockResolvedValue({ ...readyJob, hiringManagerId: '张三、李四', version: 3 })
    button('保存').click(); await flush()
    expect(updateJob).toHaveBeenCalledTimes(2)
    expect(root.textContent).not.toContain('负责人未保存')
    expect(root.textContent).toContain('岗位基础信息已更新')
    expect(managerDisplay().textContent).toBe('张三、李四')
    expect([...root.querySelectorAll('button')].some(item => item.textContent?.trim() === '保存')).toBe(false)
  })
  it('does not report success when clearing the manager names was ignored', async () => {
    vi.mocked(getJob).mockResolvedValue({ ...readyJob, hiringManagerId: '张三、李四' })
    vi.mocked(updateJob).mockResolvedValue({ ...readyJob, hiringManagerId: '张三、李四', version: 2 })
    await mount(); button('编辑基础信息').click(); await flush()
    managerInput().value = ''; managerInput().dispatchEvent(new Event('input')); await flush()
    button('保存').click(); await flush()
    expect(root.textContent).toContain('负责人未保存')
    expect(root.textContent).not.toContain('岗位基础信息已更新')
    expect(managerInput().value).toBe('')
    expect(managerDisplay().textContent).toBe('张三、李四')
  })
  it('sends an empty string to explicitly clear the manager names', async () => {
    vi.mocked(getJob).mockResolvedValue({ ...readyJob, hiringManagerId: '张三、李四' })
    vi.mocked(updateJob).mockResolvedValue({ ...readyJob })
    await mount(); button('编辑基础信息').click(); await flush()
    managerInput().value = ''; managerInput().dispatchEvent(new Event('input')); await flush()
    button('保存').click(); await flush()
    expect(updateJob).toHaveBeenCalledWith('new-job', expect.objectContaining({ hiringManagerId: '' }))
    expect(managerDisplay().textContent).toBe('未设置')
  })
})


describe('岗位说明书和 JD 同时生成', () => {
  const emptyJob: ApiJob = { ...readyJob, spec: undefined, jd: undefined }
  const specResult: ApiJob = { ...emptyJob, version: 3, spec: { ...readyJob.spec, summary: '新生成的说明书', confirmed: false, generatedBy: 'ai' } }
  const jdResult: ApiJob = { ...emptyJob, version: 2, jd: { ...readyJob.jd, content: '新生成的招聘 JD', confirmed: false, generatedBy: 'ai_assisted' } }
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
  }
  function generationButton(kind: 'spec' | 'jd') {
    return root.querySelector<HTMLButtonElement>('#job-document-' + kind + ' header button')!
  }
  function input(kind: 'spec' | 'jd', selector: 'textarea' | 'select', value: string) {
    const field = root.querySelector<HTMLTextAreaElement | HTMLSelectElement>('#job-document-' + kind + ' .generation-options ' + selector)!
    field.value = value
    field.dispatchEvent(new Event(selector === 'select' ? 'change' : 'input'))
  }

  it.each(['spec', 'jd'] as const)('点击 %s 同时发起两项生成，分别传入要求/Skill，乱序返回也不丢失文档', async (trigger) => {
    vi.mocked(getJob).mockResolvedValue(emptyJob)
    vi.mocked(listActiveAiSkills).mockResolvedValue([
      { id: 'spec-skill', name: '说明书 Skill', targetType: 'job_spec', content: '内部说明书' },
      { id: 'jd-skill', name: 'JD Skill', targetType: 'jd', content: '招聘广告' },
    ])
    const spec = deferred<ApiJob>()
    const jd = deferred<ApiJob>()
    vi.mocked(generateJobSpec).mockReturnValue(spec.promise)
    vi.mocked(generateJobDescription).mockReturnValue(jd.promise)
    await mount()
    input('spec', 'textarea', '  突出人事管理职责  ')
    input('jd', 'textarea', '  面向候选人  ')
    input('spec', 'select', 'spec-skill')
    input('jd', 'select', 'jd-skill')
    generationButton(trigger).click(); await flush()
    expect(generateJobSpec).toHaveBeenCalledWith('new-job', { prompt: '突出人事管理职责', skillId: 'spec-skill' })
    expect(generateJobDescription).toHaveBeenCalledWith('new-job', { prompt: '面向候选人', skillId: 'jd-skill' })
    for (const kind of ['spec', 'jd'] as const) {
      expect(generationButton(kind).textContent).toBe('生成中...')
      expect(generationButton(kind).disabled).toBe(true)
      generationButton(kind).click()
    }
    expect(generateJobSpec).toHaveBeenCalledTimes(1)
    expect(generateJobDescription).toHaveBeenCalledTimes(1)
    if (trigger === 'spec') spec.resolve(specResult)
    else jd.resolve(jdResult)
    await flush()
    expect(generationButton(trigger).textContent).toBe('AI 重新生成')
    expect(generationButton(trigger).disabled).toBe(true)
    expect(generationButton(trigger === 'spec' ? 'jd' : 'spec').textContent).toBe('生成中...')
    if (trigger === 'spec') jd.resolve(jdResult)
    else spec.resolve(specResult)
    await flush()
    expect(root.querySelector('#job-document-spec')?.textContent).toContain('新生成的说明书')
    expect(root.querySelector('#job-document-jd')?.textContent).toContain('新生成的招聘 JD')
    expect(root.textContent).toContain('岗位说明书已由AI生成（未确认）；JD已由AI生成（未确认）')
    expect(generationButton('spec').disabled).toBe(false)
    expect(generationButton('jd').disabled).toBe(false)
    expect(publishButton().disabled).toBe(true)
  })

  it.each(['spec', 'jd'] as const)('%s 失败不丢失另一侧成功内容，并展示部分失败原因且恢复操作', async (failed) => {
    vi.mocked(getJob).mockResolvedValue(emptyJob)
    if (failed === 'spec') {
      vi.mocked(generateJobSpec).mockRejectedValue(new Error('说明书服务超时'))
      vi.mocked(generateJobDescription).mockResolvedValue(jdResult)
    } else {
      vi.mocked(generateJobSpec).mockResolvedValue(specResult)
      vi.mocked(generateJobDescription).mockRejectedValue(new Error('JD 服务超时'))
    }
    await mount(); generationButton('spec').click(); await flush()
    expect(root.textContent).toContain(failed === 'spec' ? '岗位说明书生成失败：说明书服务超时' : 'JD生成失败：JD 服务超时')
    expect(root.textContent).toContain(failed === 'spec' ? '新生成的招聘 JD' : '新生成的说明书')
    expect(root.textContent).toContain(failed === 'spec' ? 'JD已由AI生成（未确认）' : '岗位说明书已由AI生成（未确认）')
    expect(generationButton('spec').disabled).toBe(false)
    expect(generationButton('jd').disabled).toBe(false)
  })

  it('两项均失败时显示两项错误，并允许再次生成', async () => {
    vi.mocked(generateJobSpec).mockRejectedValue(new Error('说明书不可用'))
    vi.mocked(generateJobDescription).mockRejectedValue(new Error('JD 不可用'))
    await mount(); generationButton('jd').click(); await flush()
    expect(root.textContent).toContain('岗位说明书生成失败：说明书不可用')
    expect(root.textContent).toContain('JD生成失败：JD 不可用')
    expect(generationButton('spec').disabled).toBe(false)
    expect(generationButton('jd').disabled).toBe(false)
  })

  it('版本历史读取失败不误报生成失败，仍保留生成结果并提示刷新', async () => {
    vi.mocked(generateJobSpec).mockResolvedValue(specResult)
    vi.mocked(generateJobDescription).mockResolvedValue(jdResult)
    await mount()
    vi.mocked(listJobSpecVersions).mockRejectedValue(new Error('历史读取失败'))
    generationButton('spec').click(); await flush()
    expect(root.textContent).toContain('新生成的说明书')
    expect(root.textContent).toContain('新生成的招聘 JD')
    expect(root.textContent).toContain('版本历史加载失败，请刷新查看')
    expect(root.textContent).not.toContain('生成失败：')
  })
})


describe('暂时隐藏招聘平台发布入口', () => {
  it.each(['draft', 'ready', 'published', 'paused', 'closed'])('%s 岗位不展示发布操作、渠道和状态，也不调用发布接口', async (status) => {
    featureFlags.externalJobPublishingEnabled = false
    vi.mocked(getJob).mockResolvedValue({ ...readyJob, status, channels: ['外部招聘平台'] })
    await mount()
    const labels = [...root.querySelectorAll('button')].map(button => button.textContent?.trim())
    for (const label of ['发布', '关闭', '暂停', '恢复']) expect(labels).not.toContain(label)
    expect(root.textContent).not.toContain('发布渠道')
    expect(root.textContent).not.toContain('外部招聘平台')
    expect(root.textContent).not.toContain('可发布岗位')
    expect(root.querySelector('.actions-panel')).toBeNull()
    expect([...root.querySelectorAll('.detail-item > span')].map(el => el.textContent)).not.toContain('状态')
    expect(labels).toContain('编辑基础信息')
    expect(root.textContent).toContain('岗位文档')
    expect(jobAction).not.toHaveBeenCalled()
  })
  it('隐藏发布入口不影响说明书与 JD 确认', async () => {
    featureFlags.externalJobPublishingEnabled = false
    vi.mocked(getJob).mockResolvedValue({ ...readyJob, spec: { ...readyJob.spec, confirmed: false }, jd: { ...readyJob.jd, confirmed: false } })
    vi.mocked(jobAction).mockResolvedValue(structuredClone(readyJob))
    await mount()
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('.actions-panel button')]
    expect(buttons.map(button => button.textContent?.trim())).toEqual(['确认说明书', '确认 JD'])
    buttons[0]!.click(); await flush()
    expect(jobAction).toHaveBeenCalledWith('new-job', 'confirm-spec', undefined)
  })
})
