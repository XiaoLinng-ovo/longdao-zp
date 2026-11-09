// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import CandidateListPage from './CandidateListPage.vue'
import { authSession } from '../../auth/session'
import { ApiClientError } from '../../../shared/api'
import { cancelResumeImportBatch, deleteCandidate, getResumeImportBatch, loadCandidates, type ApiResumeImportBatch, type ApiResumeImportItem } from '../api'

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  cancelResumeImportBatch: vi.fn(),
  deleteCandidate: vi.fn(),
  getResumeImportBatch: vi.fn(),
  loadCandidates: vi.fn(async () => []),
  loadCandidateTags: vi.fn(async () => []),
  loadJobs: vi.fn(async () => []),
}))

const storageKey = 'smartrecruit:active-resume-import-batch'
const readBatch = vi.mocked(getResumeImportBatch)
let app: App | undefined
let root: HTMLDivElement
let batch: ApiResumeImportBatch

function item(patch: Partial<ApiResumeImportItem> = {}): ApiResumeImportItem {
  return {
    id: 'item-1', batchId: 'batch-1', ordinal: 1, clientFileId: 'file-1',
    originalFilename: 'resume.txt', mimeType: 'text/plain', sizeBytes: 6,
    status: 'queued', attempts: 1, createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z',
    ...patch,
  }
}
async function flush() {
  for (let i = 0; i < 25; i++) { await Promise.resolve(); await nextTick() }
}
async function mount() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  await router.push('/')
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(CandidateListPage)
  app.use(router)
  app.mount(root)
  await flush()
}
function button(label: string) {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find(entry => entry.textContent?.trim() === label)!
}
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  await flush()
}
function expectFinished() {
  expect(root.querySelector('.resume-import-progress')).toBeNull()
  expect(window.localStorage.getItem(storageKey)).toBeNull()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.mocked(loadCandidates).mockResolvedValue([])
  authSession.user = null
  window.localStorage.clear()
  window.localStorage.setItem(storageKey, 'batch-1')
  batch = {
    id: 'batch-1', jobId: 'job-1', status: 'completed', items: [item()],
    counts: { total: 1, pendingUpload: 0, uploading: 0, uploaded: 1, analyzing: 0, completed: 0, failed: 0, cancelled: 0 },
    createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z',
  }
  readBatch.mockImplementation(async () => structuredClone(batch))
})
afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
  window.localStorage.clear()
  authSession.user = null
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('resume import progress cleanup', () => {
  it('cleans the six-item deleted batch from older API responses and does not poll it again', async () => {
    batch.items = Array.from({ length: 6 }, (_, index) => item({ id: `deleted-${index}`, ordinal: index + 1 }))
    await mount()
    expectFinished()
    await advance(60_000)
    expect(readBatch).toHaveBeenCalledTimes(1)
    app!.unmount(); app = undefined; root.remove()
    await mount()
    expectFinished()
    expect(readBatch).toHaveBeenCalledTimes(1)
  })

  it.each(['completed', 'failed', 'cancelled', 'removed'])(
    'automatically clears a terminal %s batch without deleting its history', async (analysisStatus) => {
      batch.items = [item({ analysisTaskId: 'task-1', analysisStatus })]
      await mount()
      expectFinished()
      await advance(60_000)
      expect(readBatch).toHaveBeenCalledTimes(1)
      expect(cancelResumeImportBatch).not.toHaveBeenCalled()
    },
  )

  it('retains real analysis after upload completion, then stops polling and clears persistence when it finishes', async () => {
    batch.items = [item({ analysisTaskId: 'task-1', analysisStatus: 'processing' })]
    await mount()
    expect(root.querySelector('.resume-import-progress')?.textContent).toContain('文件上传：1/1 已完成；AI 分析：分析中 1，完成 0/1')
    expect(window.localStorage.getItem(storageKey)).toBe('batch-1')
    batch.items[0]!.analysisStatus = 'completed'
    batch.counts.completed = 1
    await advance(5000)
    expectFinished()
    await advance(60_000)
    expect(readBatch).toHaveBeenCalledTimes(2)
  })

  it('counts deleted entries as finished without losing another active task in the same batch', async () => {
    batch.items = [item(), item({ id: 'item-2', analysisTaskId: 'task-2', analysisStatus: 'queued' })]
    await mount()
    expect(root.querySelector('.resume-import-progress')?.textContent).toContain('文件上传：2/2 已完成；AI 分析：排队 1，完成 0/2，已删除 1')
    expect(window.localStorage.getItem(storageKey)).toBe('batch-1')
    batch.items[1]!.analysisStatus = 'completed'
    await advance(5000)
    expectFinished()
  })

  it('continues following already uploaded tasks when the rest of the upload is cancelled', async () => {
    batch.status = 'cancelled'
    batch.phase = 'cancelled'
    batch.items = [item({ analysisStatus: 'processing' }), item({ id: 'item-2', status: 'cancelled' })]
    await mount()
    expect(root.querySelector('.resume-import-progress')?.textContent).toContain('文件上传：已停止；AI 分析：分析中 1，完成 0/2')
    await advance(5000)
    expect(readBatch).toHaveBeenCalledTimes(2)
    expect(window.localStorage.getItem(storageKey)).toBe('batch-1')
  })

  it('hides the notification without cancelling or stopping actual analysis', async () => {
    batch.items = [item({ analysisStatus: 'processing' })]
    await mount()
    root.querySelector<HTMLButtonElement>('[aria-label="隐藏导入进度提示"]')!.click()
    await flush()
    expect(root.querySelector('.resume-import-progress')).toBeNull()
    expect(window.localStorage.getItem(storageKey)).toBe('batch-1')
    await advance(5000)
    expect(readBatch).toHaveBeenCalledTimes(2)
    expect(cancelResumeImportBatch).not.toHaveBeenCalled()
    batch.items[0]!.analysisStatus = 'completed'
    await advance(5000)
    expectFinished()
  })

  it('retries a temporary read error on restore rather than forgetting an unknown batch', async () => {
    batch.items = [item({ analysisStatus: 'processing' })]
    readBatch.mockRejectedValueOnce(new Error('temporary network failure'))
    await mount()
    expect(window.localStorage.getItem(storageKey)).toBe('batch-1')
    await advance(5000)
    expect(readBatch).toHaveBeenCalledTimes(2)
    expect(root.querySelector('.resume-import-progress')).not.toBeNull()
  })

  it('forgets a missing batch and does not keep polling a 404', async () => {
    readBatch.mockRejectedValue(new ApiClientError('batch missing', { kind: 'http', status: 404 }))
    await mount()
    expectFinished()
    await advance(60_000)
    expect(readBatch).toHaveBeenCalledTimes(1)
  })

  it('reconciles progress immediately after candidate deletion', async () => {
    authSession.user = { id: 'user-1', name: '企业用户', email: 'test@example.com', role: 'recruiter', departmentId: 'department-1', workspaceId: 'workspace-1' }
    vi.mocked(loadCandidates).mockResolvedValue([{
      id: 'CAN-1', entityId: 'candidate-1', name: 'Candidate', job: 'Engineer', score: 80,
      aiStatus: 'completed', applicationStatus: 'active', updatedAt: '2026-10-26',
    }])
    batch.items = [item({ analysisStatus: 'queued' })]
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(deleteCandidate).mockImplementation(async () => {
      batch.items = [item()]
      vi.mocked(loadCandidates).mockResolvedValue([])
    })
    await mount()
    expect(root.querySelector('.resume-import-progress')).not.toBeNull()
    root.querySelector<HTMLButtonElement>('.delete-button')!.click()
    await flush()
    expect(deleteCandidate).toHaveBeenCalledWith('candidate-1')
    expect(readBatch).toHaveBeenCalledTimes(2)
    expectFinished()
  })

  it('reconciles progress when the page refresh button is clicked', async () => {
    batch.items = [item({ analysisStatus: 'queued' })]
    await mount()
    batch.items = [item()]
    button('刷新').click()
    await flush()
    expect(readBatch).toHaveBeenCalledTimes(2)
    expectFinished()
  })

  it('ignores a delayed response from a previous batch after starting a new upload selection', async () => {
    batch.items = [item({ analysisStatus: 'processing' })]
    await mount()
    let resolveRead!: (value: ApiResumeImportBatch) => void
    readBatch.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve }))
    await advance(5000)
    button('上传简历并建档').click()
    await flush()
    resolveRead(structuredClone(batch))
    await flush()
    expect(root.querySelectorAll('.resume-file-row')).toHaveLength(0)
    expect(window.localStorage.getItem(storageKey)).toBeNull()
    await advance(60_000)
    expect(readBatch).toHaveBeenCalledTimes(2)
  })

  it('does not erase a newer batch cached by another tab when an older batch finishes', async () => {
    batch.items = [item({ analysisStatus: 'processing' })]
    await mount()
    window.localStorage.setItem(storageKey, 'newer-batch')
    batch.items = [item({ analysisStatus: 'completed' })]
    await advance(5000)
    expect(root.querySelector('.resume-import-progress')).toBeNull()
    expect(window.localStorage.getItem(storageKey)).toBe('newer-batch')
  })
})
