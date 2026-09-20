// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import JobListPage from './JobListPage.vue'
import { loadJobs } from '../api'
import { apiClient } from '../../../shared/api'
import { loadDepartments } from '../../requisitions/api'

vi.mock('../api', () => ({ loadJobs: vi.fn(), createJob: vi.fn(), jobAction: vi.fn() }))
vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn() } }))
vi.mock('../../requisitions/api', () => ({ loadDepartments: vi.fn() }))

const mockedLoadJobs = vi.mocked(loadJobs)
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
  })
})
