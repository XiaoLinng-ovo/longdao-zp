// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import OnboardingListPage from './OnboardingListPage.vue'
import { listOnboardingWorkbench, type ApiOnboarding, type ApiOnboardingWorkbenchItem } from '../api'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  listOnboardingWorkbench: vi.fn(),
  getOnboardingReport: vi.fn(async () => null),
}))
vi.mock('../components/OnboardingDetailDialog.vue', () => ({ default: { template: '<div />' } }))

function item(id: string, department: string, details: Partial<ApiOnboarding> = {}): ApiOnboardingWorkbenchItem {
  return {
    onboarding: { id, applicationId: id, offerId: id, status: 'scheduled', createdAt: '', updatedAt: '', ...details },
    candidateName: id, department, jobTitle: '工程师', offerCode: `OFF-${id}`, readiness: 100,
    overdueTasks: 0, requiredTasksRemaining: 0, highRiskReasons: [], tasks: [], materials: [], reminders: [], integrations: [],
  }
}

let app: App
let root: HTMLDivElement

beforeEach(async () => {
  vi.mocked(listOnboardingWorkbench).mockResolvedValue([
    item('计划较早', '技术部', { plannedStartDate: '2026-11-02', status: 'completed', actualArrivalAt: '2026-11-02T16:30:00.000Z' }),
    item('计划当天', '技术部', { plannedStartDate: '2026-11-03' }),
    item('计划较晚', '运营部', { plannedStartDate: '2026-11-05', status: 'completed', actualArrivalAt: '2026-11-03T07:00:00.000Z' }),
    item('日期未记录', '技术部', { status: 'completed' }),
  ])
  root = document.createElement('div')
  document.body.append(root)
  app = createApp(OnboardingListPage)
  app.mount(root)
  await vi.waitFor(() => expect(names()).toHaveLength(4))
})

afterEach(() => { app.unmount(); root.remove() })

function names() {
  return Array.from(root.querySelectorAll('.candidate-name'), (node) => node.textContent)
}

const control = (label: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!

async function filter(label: string, value: string) {
  const element = control(label)
  element.value = value
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  await nextTick()
}

describe('入职日期筛选', () => {
  it('支持单独起止日期及包含两端的日期区间', async () => {
    await filter('结束日期', '2026-11-03')
    expect(names()).toEqual(['计划较早', '计划当天'])
    await filter('起始日期', '2026-11-03')
    expect(names()).toEqual(['计划当天'])
    expect(root.querySelector('.table-heading strong')?.textContent).toBe('1')
    await filter('结束日期', '')
    expect(names()).toEqual(['计划当天', '计划较晚'])
  })

  it('按北京时间匹配实际报到日，且可与状态及部门组合', async () => {
    await filter('日期类型', 'actual')
    await filter('起始日期', '2026-11-03')
    await filter('结束日期', '2026-11-03')
    expect(names()).toEqual(['计划较早', '计划较晚'])
    await filter('按状态筛选', 'completed')
    await filter('按部门筛选', '技术部')
    expect(names()).toEqual(['计划较早'])
    expect(root.querySelector('.arrival-dates')?.textContent).toContain('计划：2026-11-02')
    expect(root.querySelector('.arrival-dates')?.textContent).toContain('实际：2026-11-03')
  })

  it('提示无效区间，清除后恢复所有记录与默认日期类型', async () => {
    await filter('日期类型', 'actual')
    await filter('起始日期', '2026-11-04')
    await filter('结束日期', '2026-11-03')
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('起始日期不能晚于结束日期')
    expect(names()).toEqual([])
    Array.from(root.querySelectorAll('button')).find((button) => button.textContent === '清除筛选')!.click()
    await nextTick()
    expect(control('日期类型').value).toBe('planned')
    expect(control('起始日期').value).toBe('')
    expect(control('结束日期').value).toBe('')
    expect(root.querySelector('[role="alert"]')).toBeNull()
    expect(names()).toHaveLength(4)
  })
})
