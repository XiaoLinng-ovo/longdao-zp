// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import JobListPage from './JobListPage.vue'
import { createJob, loadJobs } from '../api'
import { apiClient } from '../../../shared/api'
import { loadDepartments } from '../../requisitions/api'

vi.mock('../api', () => ({ loadJobs: vi.fn(), createJob: vi.fn(), jobAction: vi.fn(), deleteJob: vi.fn() }))
vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn() } }))
vi.mock('../../requisitions/api', () => ({ loadDepartments: vi.fn() }))

const mockedLoadJobs = vi.mocked(loadJobs)
const mockedCreateJob = vi.mocked(createJob)
const mockedGetJson = vi.mocked(apiClient.getJson)
const mockedLoadDepartments = vi.mocked(loadDepartments)

let app: App | undefined
let root: HTMLDivElement | undefined

async function flush() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
  vi.resetAllMocks()
})

describe('JobListPage', () => {
  it('explains a disabled request URL redirect without implying Offer approval is removed', async () => {
    mockedLoadJobs.mockResolvedValue([])
    mockedLoadDepartments.mockResolvedValue([])
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/jobs', component: { template: '<div />' } }] })
    await router.push('/jobs?notice=recruitment-requests-disabled')
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(JobListPage)
    app.use(router)
    app.mount(root)
    await flush()
    expect(root.querySelector('[role="status"]')?.textContent).toContain('需求申请审批已停用')
    expect(root.querySelector('[role="status"]')?.textContent).toContain('录用审批与 Offer 仍正常保留')
    expect(mockedGetJson).not.toHaveBeenCalled()
  })

  it('ignores legacy request query and creates a job without a request association', async () => {
    mockedLoadJobs.mockResolvedValue([])
    mockedLoadDepartments.mockResolvedValue([{ id: 'dept-hr', code: 'HR', name: '人事部', isActive: true }])
    mockedCreateJob.mockResolvedValue({ id: 'new-job' } as never)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/jobs', component: { template: '<div />' } }] })
    await router.push('/jobs?create=1&recruitmentRequestId=old-approved-request')
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(JobListPage)
    app.use(router)
    app.mount(root)
    await flush()
    expect(root.querySelector('.dialog')?.textContent).not.toContain('招聘需求')
    const title = root.querySelector<HTMLInputElement>('.dialog input')!
    title.value = '人事专员'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    const department = root.querySelector<HTMLSelectElement>('.dialog select')!
    department.value = 'HR'
    department.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    const submit = [...root.querySelectorAll('button')].find((button) => button.textContent === '创建岗位')!
    submit.click()
    await flush()
    expect(mockedCreateJob).toHaveBeenCalledTimes(1)
    expect(mockedCreateJob.mock.calls[0]![0]).toMatchObject({ title: '人事专员', departmentId: 'HR', headcount: 1 })
    expect(mockedCreateJob.mock.calls[0]![0]).not.toHaveProperty('recruitmentRequestId')
    expect(mockedGetJson).not.toHaveBeenCalled()
    expect(root.querySelector('.overlay')).toBeNull()
  })

  it('opens the new job form in a modal instead of rendering it below the table', async () => {
    mockedLoadJobs.mockResolvedValue([])
    mockedGetJson.mockResolvedValue({ ok: true, requestId: 'test', data: [] } as never)
    mockedLoadDepartments.mockResolvedValue([])

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(JobListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root)
    await flush()

    const createButton = [...root.querySelectorAll('button')].find((button) => button.textContent === '新建岗位')
    expect(createButton).toBeTruthy()
    createButton!.click()
    await flush()

    expect(root.querySelector('.overlay')).not.toBeNull()
    expect(root.querySelector('.dialog h3')?.textContent).toBe('新建岗位')
    expect(root.querySelector('.dialog')?.textContent).not.toContain('招聘需求')
    expect(mockedGetJson).not.toHaveBeenCalled()
  })
})
