// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import CandidateListPage from './CandidateListPage.vue'
import { authSession } from '../../auth/session'
import { deleteApplication, deleteCandidate, loadCandidateTags, loadCandidates, loadJobs } from '../api'
import type { Candidate } from '../../../shared/types/recruiting'

vi.mock('../api', async (original) => ({
  ...await original<typeof import('../api')>(),
  deleteApplication: vi.fn(), deleteCandidate: vi.fn(),
  loadCandidateTags: vi.fn(), loadCandidates: vi.fn(), loadJobs: vi.fn(),
}))
const first: Candidate = { id: 'CAN-1', entityId: 'candidate-1', name: '王强', job: '人事', applicationId: 'application-1', rawApplicationStatus: 'pending_analysis', score: 0, aiStatus: 'pending', applicationStatus: 'pending', updatedAt: '2026-11-20' }
const second: Candidate = { ...first, applicationId: 'application-2', job: '工程师' }
const orphan: Candidate = { ...first, id: 'CAN-2', entityId: 'candidate-2', applicationId: undefined, name: '李明', job: '未关联岗位' }
let app: App | undefined
let root: HTMLDivElement
let stored: Candidate[]
async function flush() { for (let i = 0; i < 25; i++) { await Promise.resolve(); await nextTick() } }
async function mount() {
  root = document.createElement('div'); document.body.appendChild(root)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  app = createApp(CandidateListPage); app.use(router); app.mount(root); await flush()
}
const all = () => root.querySelector<HTMLInputElement>('thead input[type="checkbox"]')!
const batch = () => root.querySelector<HTMLButtonElement>('.batch-delete-button')!
async function selectAll() { all().click(); await flush() }
async function expand() { root.querySelector<HTMLButtonElement>('.applications-toggle')!.click(); await flush() }
beforeEach(() => {
  authSession.user = { id: 'u1', name: '企业用户', email: 'test@example.invalid', role: 'admin', departmentId: 'dept', workspaceId: 'org' }
  stored = [{ ...first, applicationRows: [first, second] }, orphan]
  vi.mocked(loadCandidates).mockImplementation(async () => stored)
  vi.mocked(loadJobs).mockResolvedValue([]); vi.mocked(loadCandidateTags).mockResolvedValue([])
  vi.mocked(deleteCandidate).mockImplementation(async id => { stored = stored.filter(row => row.entityId !== id) })
  vi.mocked(deleteApplication).mockImplementation(async id => {
    stored = stored.map(row => {
      if (row.entityId !== 'candidate-1') return row
      const remaining = (row.applicationRows || [row]).filter(item => item.applicationId !== id)
      return remaining.length ? { ...remaining[0], applicationRows: remaining.length > 1 ? remaining : undefined } : null
    }).filter((row): row is Candidate => row !== null)
    return { candidateDeleted: !stored.some(row => row.entityId === 'candidate-1') }
  })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks(); vi.restoreAllMocks(); authSession.user = null; localStorage.clear() })
describe('candidate batch deletion', () => {
  it('selects only displayed rows; expanded applications are independent and collapsing prunes hidden selections', async () => {
    await mount(); expect(batch().disabled).toBe(true)
    await selectAll(); expect(root.querySelector('.batch-delete-toolbar')?.textContent).toContain('已选择 2 条')
    await expand(); expect(all().indeterminate).toBe(true)
    await selectAll(); expect(root.querySelector('.batch-delete-toolbar')?.textContent).toContain('已选择 3 条')
    await expand(); expect(root.querySelector('.batch-delete-toolbar')?.textContent).toContain('已选择 2 条')
    batch().click(); await flush()
    expect(deleteApplication).toHaveBeenCalledExactlyOnceWith('application-1')
    expect(deleteCandidate).toHaveBeenCalledExactlyOnceWith('candidate-2')
    expect(root.querySelector('tbody')?.textContent).toContain('工程师')
    expect(root.querySelector('.success-note')?.textContent).toContain('成功 2 条，失败 0 条')
    expect(batch().disabled).toBe(true)
  })
  it('cancels the entire batch without any delete calls', async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    await mount(); await expand(); await selectAll(); batch().click(); await flush()
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('3 条记录'))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('档案及全部简历自动删除'))
    expect(deleteApplication).not.toHaveBeenCalled(); expect(deleteCandidate).not.toHaveBeenCalled()
    expect(root.querySelectorAll('tbody input:checked')).toHaveLength(3)
  })
  it('continues after a protected record fails and retains only that selection with the reason', async () => {
    const original = vi.mocked(deleteApplication).getMockImplementation()!
    vi.mocked(deleteApplication).mockImplementation(async id => { if (id === 'application-2') throw new Error('已有面试记录，不能删除'); return original(id) })
    await mount(); await expand(); await selectAll(); batch().click(); await flush()
    expect(deleteApplication).toHaveBeenCalledTimes(2); expect(deleteCandidate).toHaveBeenCalledWith('candidate-2')
    expect(root.querySelector('.success-note')?.textContent).toContain('成功 2 条，失败 1 条')
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('王强 · 工程师：已有面试记录')
    expect(root.querySelectorAll('tbody input:checked')).toHaveLength(1)
    expect(root.querySelector('tbody')?.textContent).toContain('工程师')
  })
  it('removes the candidate automatically after deleting its final application, with no second delete', async () => {
    stored = [{ ...first, applicationRows: [first, second] }]
    await mount(); await expand(); await selectAll(); batch().click(); await flush()
    expect(deleteApplication).toHaveBeenCalledTimes(2); expect(deleteCandidate).not.toHaveBeenCalled()
    expect(root.querySelector('tbody')?.textContent).not.toContain('未关联岗位')
    expect(root.querySelectorAll('tbody input:checked')).toHaveLength(0)
  })
  it('clears filtered-out selections and deletes only remaining matching applications', async () => {
    await mount(); await expand(); await selectAll()
    const filter = root.querySelector<HTMLSelectElement>('#candidate-job-filter')!
    filter.value = '工程师'; filter.dispatchEvent(new Event('change')); await flush()
    expect(root.querySelector('.batch-delete-toolbar')?.textContent).toContain('已选择 1 条')
    batch().click(); await flush()
    expect(deleteApplication).toHaveBeenCalledExactlyOnceWith('application-2'); expect(deleteCandidate).not.toHaveBeenCalled()
  })
  it('prevents duplicate or single-row deletion while a batch is in flight', async () => {
    let finish!: () => void
    vi.mocked(deleteApplication).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ candidateDeleted: false }) }))
    await mount(); await selectAll(); batch().click(); await flush()
    expect(batch().disabled).toBe(true); expect(all().disabled).toBe(true)
    expect([...root.querySelectorAll<HTMLButtonElement>('.delete-button')].every(button => button.disabled)).toBe(true)
    batch().click(); root.querySelector<HTMLButtonElement>('.delete-button')!.click(); await flush()
    expect(deleteApplication).toHaveBeenCalledTimes(1)
    finish(); await flush(); expect(deleteCandidate).toHaveBeenCalledTimes(1)
  })
  it('does not resurrect local deletions when the final refresh fails', async () => {
    await mount(); await expand(); await selectAll()
    vi.mocked(loadCandidates).mockRejectedValue(new Error('刷新失败'))
    batch().click(); await flush()
    expect(root.querySelector('tbody')?.textContent).not.toContain('未关联岗位')
    expect(root.querySelector('tbody')?.textContent).not.toContain('工程师')
    expect(root.querySelector('.error-note')?.textContent).toContain('刷新失败')
    expect(root.querySelector('.success-note')?.textContent).toContain('成功 3 条')
  })
  it('hides selection and batch delete for users outside an enterprise', async () => {
    authSession.user = { ...authSession.user!, workspaceId: undefined }
    await mount()
    expect(root.querySelector('.batch-delete-toolbar')).toBeNull(); expect(root.querySelector('thead input')).toBeNull()
    expect(root.querySelector('.delete-button')).toBeNull()
  })
})
