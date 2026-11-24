// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import AppShell from '../../../app/layout/AppShell.vue'
import { createAppRouter } from '../../../app/router'
import { authSession } from '../../auth/session'
import CandidateListPage from './CandidateListPage.vue'
import { loadCandidates, loadJobs, loadCandidateTags } from '../api'

vi.mock('../../../app/layout/SidebarNav.vue', () => ({ default: { template: '<aside />' } }))
vi.mock('../../../app/layout/TopBar.vue', () => ({ default: { template: '<header />' } }))
vi.mock('../../interviews/components/BackgroundInterviewUploads.vue', () => ({ default: { template: '<div />' } }))
vi.mock('../../../shared/components/TrialQuotaBanner.vue', () => ({ default: { template: '<div />' } }))
vi.mock('../api', async (original) => ({ ...await original<typeof import('../api')>(), loadCandidates: vi.fn(), loadJobs: vi.fn(), loadCandidateTags: vi.fn() }))

let app: App | undefined
let root: HTMLDivElement | undefined
const originalUser = authSession.user
const originalSession = authSession.sessionId
const candidate = {
  id: 'CAN-1', entityId: 'candidate-1', applicationId: 'application-1', name: '测试候选人',
  job: '开发工程师', score: 90, aiStatus: 'completed', applicationStatus: 'active', updatedAt: '2026-11-12',
}
async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); await nextTick() } }
async function mount(analyzing = false) {
  authSession.user = { id: 'user-1', workspaceId: 'workspace-1', role: 'recruiter' } as never
  vi.mocked(loadCandidates).mockResolvedValue([{ ...candidate, ...(analyzing ? { analysisStatus: 'processing' } : {}), applicationRows: [{ ...candidate, ...(analyzing ? { analysisStatus: 'processing' } : {}) }, { ...candidate, applicationId: 'application-2', job: '产品经理' }] }] as never)
  vi.mocked(loadJobs).mockResolvedValue([])
  vi.mocked(loadCandidateTags).mockResolvedValue([])
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/candidates', name: 'candidates', component: CandidateListPage },
    { path: '/candidates/:id', name: 'candidate-detail', component: { template: '<button @click="$router.back()">返回列表</button>' } },
    { path: '/other', component: { template: '<div>其他模块</div>' } },
  ] })
  await router.push('/candidates'); await router.isReady()
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(AppShell); app.use(router); app.mount(root); await flush()
  return router
}
afterEach(() => {
  app?.unmount(); root?.remove(); authSession.user = originalUser; authSession.sessionId = originalSession
  window.localStorage.clear(); vi.resetAllMocks(); vi.useRealTimers()
})

it('restores saved browser position after rendering instead of forcing the top', async () => {
  const router = createAppRouter()
  const scroll = router.options.scrollBehavior!
  const route = { ...router.currentRoute.value, name: 'candidates' }
  expect(await scroll(route, route, { left: 0, top: 1480 })).toEqual({ left: 0, top: 1480 })
  expect(await scroll(route, route, null)).toEqual({ top: 0 })
})

it('retains filters, sorting, expanded applications and horizontal position without a loading flash', async () => {
  const router = await mount()
  const search = root!.querySelector<HTMLInputElement>('[aria-label="简历库搜索"]')!
  search.value = '测试'; search.dispatchEvent(new Event('input'))
  const sort = root!.querySelector<HTMLSelectElement>('#candidate-score-sort')!
  sort.value = 'desc'; sort.dispatchEvent(new Event('change'))
  root!.querySelector<HTMLButtonElement>('.applications-toggle')!.click(); await flush()
  const table = root!.querySelector<HTMLElement>('.table-wrap')!
  table.scrollLeft = 160
  expect(root!.querySelectorAll('.application-subrow')).toHaveLength(1)
  root!.querySelector<HTMLButtonElement>('.name-link')!.click(); await flush()
  expect(router.currentRoute.value.name).toBe('candidate-detail')
  expect(router.currentRoute.value.query.applicationId).toBe('application-1')
  let finish!: (rows: Awaited<ReturnType<typeof loadCandidates>>) => void
  vi.mocked(loadCandidates).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  router.back(); await flush()
  expect(router.currentRoute.value.name).toBe('candidates')
  expect(root!.querySelector('[aria-label="简历库搜索"]')).toBe(search)
  expect(search.value).toBe('测试'); expect(sort.value).toBe('desc')
  expect(root!.querySelector('.table-wrap')).toBe(table); expect(table.scrollLeft).toBe(160)
  expect(root!.querySelectorAll('.application-subrow')).toHaveLength(1)
  expect(root!.querySelector('.loading-note')).toBeNull()
  finish([{ ...candidate, score: 95 }] as never); await flush()
  expect(root!.textContent).toContain('95')
})

it('clears the cache on workspace changes and when leaving candidate browsing', async () => {
  const router = await mount()
  const originalInput = root!.querySelector('[aria-label="简历库搜索"]')
  await router.push('/candidates/candidate-1')
  authSession.user = { ...authSession.user!, workspaceId: 'workspace-2' }; await flush()
  await router.push('/candidates'); await flush()
  expect(root!.querySelector('[aria-label="简历库搜索"]')).not.toBe(originalInput)
  const nextInput = root!.querySelector('[aria-label="简历库搜索"]')
  await router.push('/other'); await router.push('/candidates'); await flush()
  expect(root!.querySelector('[aria-label="简历库搜索"]')).not.toBe(nextInput)
})

it('pauses list polling while reading details and resumes on return', async () => {
  vi.useFakeTimers()
  const router = await mount(true)
  vi.mocked(loadCandidates).mockResolvedValue([{ ...candidate, analysisStatus: 'processing' }] as never)
  await router.push('/candidates/candidate-1'); await flush()
  const calls = vi.mocked(loadCandidates).mock.calls.length
  await vi.advanceTimersByTimeAsync(15000); await flush()
  expect(loadCandidates).toHaveBeenCalledTimes(calls)
  await router.push('/candidates'); await flush()
  expect(loadCandidates).toHaveBeenCalledTimes(calls + 1)
  await vi.advanceTimersByTimeAsync(5000); await flush()
  expect(loadCandidates).toHaveBeenCalledTimes(calls + 2)
})
