// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import DashboardPage from './DashboardPage.vue'
import { loadDashboard, type DashboardData } from '../api'

vi.mock('../api', () => ({ loadDashboard: vi.fn() }))
let app: App, root: HTMLDivElement
const base: DashboardData = { metrics: [{ label: '简历数量', value: 99, tone: 'teal', trend: '已上传的简历总数' }], todos: [], pending: [], funnel: [], pendingInterviews: [], failedTasks: [] }
const counts = { resumes: 3, applications: 2, screened: 1, interviews: 1, offers: 0, onboarded: 0 }
const ranged: DashboardData = { ...base, metrics: [{ label: '简历数量', value: 3, tone: 'teal', trend: '较前段 +3' }], activity: {
  period: { from: '2026-10-28T16:00:00Z', to: '2026-10-29T16:00:00Z', timeZone: 'Asia/Shanghai' },
  previousPeriod: { from: '2026-10-27T16:00:00Z', to: '2026-10-28T16:00:00Z', timeZone: 'Asia/Shanghai' },
  counts, previousCounts: { ...counts, resumes: 0 }, granularity: 'day', series: [{ date: '2026-10-29', ...counts }],
} }
async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); await nextTick() } }
async function mount() {
  root = document.createElement('div'); document.body.appendChild(root)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  await router.push('/'); app = createApp(DashboardPage); app.use(router); app.mount(root); await flush()
}
async function range(from = '2026-10-29', to = '2026-10-29') {
  for (const [label, value] of [['统计开始日期', from], ['统计结束日期', to]]) {
    root.querySelector<HTMLButtonElement>('[aria-label="' + label + '"]')!.click()
    await nextTick()
    if (value) root.querySelector<HTMLButtonElement>('[data-date="' + value + '"]')!.click()
    else [...root.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === '清除')!.click()
  }
  await nextTick()
  root.querySelector<HTMLFormElement>('[aria-label="工作台日期筛选"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flush()
}

function dateValue(label: string) {
  return root.querySelector<HTMLButtonElement>('[aria-label="' + label + '"]')!.dataset.value
}
beforeEach(() => { vi.mocked(loadDashboard).mockResolvedValue(base) })
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks() })

it('隐藏功能不会继续出现在工作台主线中', async () => {
  await mount()
  expect(root.textContent).not.toContain('一键发布渠道')
  expect(root.textContent).not.toContain('自动统计排序')
  expect(root.textContent).toContain('6步一站式主线')
})

it.each(['2026-10-30T00:15:00', '2026-10-30T23:59:00', '2027-01-01T00:01:00'])('defaults the initial query to the local 30-day period at %s', async (now) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now))
  try {
    await mount()
    const day = now.slice(0, 10)
    const start = new Date(day + 'T00:00:00'); start.setDate(start.getDate() - 29)
    expect(dateValue('统计开始日期')).toBe([start.getFullYear(), String(start.getMonth() + 1).padStart(2, '0'), String(start.getDate()).padStart(2, '0')].join('-'))
    expect(dateValue('统计结束日期')).toBe(day)
    const recentButton = [...root.querySelectorAll<HTMLButtonElement>('.period-shortcuts button')].find(item => item.textContent === '近30天')!
    expect(recentButton.getAttribute('aria-pressed')).toBe('true')
    const end = new Date(day + 'T00:00:00'); end.setDate(end.getDate() + 1)
    expect(loadDashboard).toHaveBeenCalledTimes(1)
    expect(loadDashboard).toHaveBeenLastCalledWith({ from: start.toISOString(), to: end.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  } finally { vi.useRealTimers() }
})

it('queries a same-day selection from local midnight through the whole end date', async () => {
  await mount(); vi.mocked(loadDashboard).mockResolvedValue(ranged)
  await range()
  expect(loadDashboard).toHaveBeenLastCalledWith({ from: new Date('2026-10-29T00:00').toISOString(), to: new Date('2026-10-30T00:00').toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  expect(root.querySelectorAll('[data-date-picker-trigger]')).toHaveLength(2)
  expect(root.querySelectorAll('input[type="date"]')).toHaveLength(0)
  expect(root.querySelector('input[type="datetime-local"]')).toBeNull()
  expect(root.querySelector('[aria-label="时段数据变化"]')).toBeNull()
  expect(root.textContent).not.toContain('时段数据变化')
  expect(root.querySelector('.metric-card strong')?.textContent).toBe('3')
  expect(root.textContent).toContain('较前段 +3')
  expect(root.textContent).toContain('待办事项')
  expect(root.textContent).not.toContain('时段内更新的待办')
  expect(root.textContent).not.toContain('当前整体转化率')
  const reset = root.querySelector<HTMLButtonElement>('[aria-label="恢复全部时间"]')!
  vi.mocked(loadDashboard).mockResolvedValue(base); reset.click(); await flush()
  expect(loadDashboard).toHaveBeenLastCalledWith(undefined)
  expect(root.querySelector('[aria-label="时段数据变化"]')).toBeNull()
})

it('rejects incomplete or reversed ranges without making a request', async () => {
  await mount()
  await range('', '2026-10-30')
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('请选择完整')
  await range('2026-10-30', '2026-10-29')
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('结束日期不能早于')
  expect(loadDashboard).toHaveBeenCalledTimes(1)
})

it('preserves the applied range during refresh and focus updates', async () => {
  await mount(); vi.mocked(loadDashboard).mockResolvedValue(ranged); await range()
  const args = vi.mocked(loadDashboard).mock.calls.at(-1)
  window.dispatchEvent(new Event('focus')); await flush()
  expect(vi.mocked(loadDashboard).mock.calls.at(-1)).toEqual(args)
})

it.each([['今日', 1], ['近7天', 7], ['近30天', 30]] as const)('queries %s as complete calendar days including today', async (label, days) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-30T15:25:00'))
  try {
    await mount()
    const button = [...root.querySelectorAll<HTMLButtonElement>('.period-shortcuts button')].find(item => item.textContent === label)!
    button.click(); await flush()
    const period = vi.mocked(loadDashboard).mock.calls.at(-1)![0]!
    const expectedStart = new Date('2026-10-30T00:00:00'); expectedStart.setDate(expectedStart.getDate() - days + 1)
    expect(period.from).toBe(expectedStart.toISOString())
    expect(period.to).toBe(new Date('2026-10-31T00:00:00').toISOString())
    expect(dateValue('统计结束日期')).toBe('2026-10-30')
  } finally { vi.useRealTimers() }
})

it('covers every selected date without discarding the final minute', async () => {
  await mount(); await range('2026-10-28', '2026-10-30')
  const period = vi.mocked(loadDashboard).mock.calls.at(-1)![0]!
  expect(period.from).toBe(new Date('2026-10-28T00:00:00').toISOString())
  expect(period.to).toBe(new Date('2026-10-31T00:00:00').toISOString())
  expect(Date.parse(period.to)).toBeGreaterThan(new Date('2026-10-30T23:59:59.999').getTime())
})

it('ignores stale data when a newer range supersedes an in-flight request', async () => {
  await mount()
  let finish!: (value: DashboardData) => void
  vi.mocked(loadDashboard).mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValueOnce(base)
  await range()
  root.querySelectorAll<HTMLButtonElement>('.period-shortcuts button')[0]!.click(); await flush()
  finish(ranged); await flush()
  expect(root.querySelector('[aria-label="时段数据变化"]')).toBeNull()
  expect(root.querySelectorAll('.metric-card strong')[0]?.textContent).toBe('99')
})
