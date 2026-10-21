// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import InterviewListPage from './InterviewListPage.vue'
import { loadInterviews, type InterviewView } from '../api'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, loadInterviews: vi.fn() }
})

let app: App | undefined
let root: HTMLDivElement

function interview(id: string, candidate: string, job: string, round: string, interviewer: string, feedbackStatus: InterviewView['feedbackStatus']): InterviewView {
  return {
    id, entityId: `entity-${id}`, candidate, job, round, feedbackStatus,
    scheduledAt: '10/21 10:00', interviewers: [interviewer],
    interviewerIds: ['user-1'], interviewerOptions: [{ id: 'user-1', name: interviewer }],
    status: 'scheduled', applicationId: `application-${id}`,
  }
}

const records = [
  interview('INT-003', 'Alice', '研发工程师', '10 轮', '林晓', 'scheduled'),
  interview('INT-001', '张三', '产品经理', '1 轮', '王敏', 'completed'),
  interview('INT-002', '李四', '研发工程师', '2 轮', '林晓', 'submitted'),
]

async function flush() {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function mount(rows = records) {
  vi.mocked(loadInterviews).mockResolvedValue(rows)
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(InterviewListPage)
  app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
  app.mount(root)
  await flush()
}

function names() {
  return [...root.querySelectorAll('tbody tr td:first-child strong')].map((node) => node.textContent)
}

async function search(value: string) {
  const input = root.querySelector<HTMLInputElement>('input[aria-label="面试中心搜索"]')!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flush()
}

async function select(id: string, value: string) {
  const control = root.querySelector<HTMLSelectElement>(`#interview-${id}`)!
  control.value = value
  control.dispatchEvent(new Event('change', { bubbles: true }))
  await flush()
}

function button(text: string) {
  return [...root.querySelectorAll('button')].find((node) => node.textContent?.trim() === text)!
}

afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
  vi.resetAllMocks()
})

describe('Interview list search and filters', () => {
  it('preserves default order and exposes unique, sorted options from the full list', async () => {
    await mount()
    expect(names()).toEqual(['Alice', '张三', '李四'])
    const options = (id: string) => [...root.querySelectorAll<HTMLOptionElement>(`#interview-${id} option`)].map((option) => option.value)
    expect(options('round-filter')).toEqual(['', '1 轮', '2 轮', '10 轮'])
    expect(options('job-filter')).toEqual(['', '产品经理', '研发工程师'])
    expect(options('interviewer-filter')).toEqual(['', '林晓', '王敏'])
    await select('job-filter', '产品经理')
    expect(names()).toEqual(['张三'])
    expect(options('interviewer-filter')).toEqual(['', '林晓', '王敏'])
  })

  it('uses normalized substring matching for candidates, jobs, interviewers and codes', async () => {
    await mount()
    for (const [query, expected] of [
      ['  ＡＬＩ  ', ['Alice']], ['产品', ['张三']], ['林晓', ['Alice', '李四']],
      ['ｉｎｔ－００２', ['李四']], ['已完成', ['张三']],
    ] as const) {
      await search(query)
      expect(names()).toEqual(expected)
    }
    await search('  alice  ')
    root.querySelector('form[role="search"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(root.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('alice')
    expect(names()).toEqual(['Alice'])
  })

  it('combines all filters with search and resets every control', async () => {
    await mount()
    await select('job-filter', '研发工程师')
    await select('status-filter', 'submitted')
    await select('round-filter', '2 轮')
    await select('interviewer-filter', '林晓')
    await select('job-sort', 'desc')
    await search('李')
    expect(names()).toEqual(['李四'])
    expect(root.querySelector('.filter-summary')!.textContent).toContain('显示 1 / 3 场面试')
    await search('张三')
    expect(names()).toEqual([])
    expect(root.querySelector('.table-empty')!.textContent).toContain('没有符合条件的面试')
    button('清除筛选').click()
    await flush()
    expect(names()).toEqual(['Alice', '张三', '李四'])
    expect(root.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('')
    expect([...root.querySelectorAll<HTMLSelectElement>('.interview-filters select')].map((node) => node.value)).toEqual(['', '', '', '', 'none'])
    expect(button('清除筛选')).toBeUndefined()
  })

  it('sorts by job without mutating the original order', async () => {
    await mount()
    await select('job-sort', 'asc')
    expect(names()).toEqual(['张三', 'Alice', '李四'])
    await select('job-sort', 'desc')
    expect(names()).toEqual(['Alice', '李四', '张三'])
    await select('job-sort', 'none')
    expect(names()).toEqual(['Alice', '张三', '李四'])
    expect(records.map((row) => row.id)).toEqual(['INT-003', 'INT-001', 'INT-002'])
  })

  it('retains active filters across refresh and updates results', async () => {
    await mount()
    await select('job-filter', '研发工程师')
    await search('林晓')
    vi.mocked(loadInterviews).mockResolvedValue([records[1]!, records[2]!])
    button('刷新').click()
    await flush()
    expect(names()).toEqual(['李四'])
    expect(root.querySelector('.filter-summary')!.textContent).toContain('显示 1 / 2 场面试')
    expect(root.querySelector<HTMLSelectElement>('#interview-job-filter')!.value).toBe('研发工程师')
  })

  it('keeps the original empty-list message when no filters are active', async () => {
    await mount([])
    expect(root.querySelector('.table-empty')!.textContent).toContain('暂无面试记录')
    await search('无结果')
    expect(root.querySelector('.table-empty')!.textContent).toContain('没有符合条件的面试')
  })
})
