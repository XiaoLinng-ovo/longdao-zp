// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import CandidateListPage from './CandidateListPage.vue'
import {
  cancelResumeImportBatch,
  createResumeImportBatch,
  getResumeImportBatch,
  loadCandidates,
  uploadResumeImportItem,
  type ApiResumeImportBatch,
  type ApiResumeImportItem,
} from '../api'

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  cancelResumeImportBatch: vi.fn(),
  createResumeImportBatch: vi.fn(),
  getResumeImportBatch: vi.fn(),
  uploadResumeImportItem: vi.fn(),
  loadCandidates: vi.fn(),
  loadCandidateTags: vi.fn(async () => []),
  loadJobs: vi.fn(async () => [{ id: 'JOB-1', entityId: 'job-1', title: '人事专员' }]),
}))

const createBatch = vi.mocked(createResumeImportBatch)
const readBatch = vi.mocked(getResumeImportBatch)
const cancelBatch = vi.mocked(cancelResumeImportBatch)
const uploadItem = vi.mocked(uploadResumeImportItem)
let app: App | undefined
let root: HTMLDivElement
let currentBatch: ApiResumeImportBatch

async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); await nextTick() } }
async function waitFor(check: () => void) {
  let last: unknown
  for (let i = 0; i < 120; i++) { try { check(); return } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 0)); await flush() } }
  throw last
}
async function mount(openDialog = true) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  await router.push('/')
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(CandidateListPage); app.use(router); app.mount(root); await flush()
  if (openDialog) { button('上传简历并建档').click(); await flush() }
}
function button(label: string) { return [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)! }
function submit() { return root.querySelector<HTMLButtonElement>('.resume-submit')! }
function files(...values: File[]) {
  const input = root.querySelector<HTMLInputElement>('#candidate-resume-file')!
  Object.defineProperty(input, 'files', { configurable: true, value: values })
  input.dispatchEvent(new Event('change'))
}
function job() {
  const select = root.querySelector<HTMLSelectElement>('#candidate-resume-job')!
  select.value = 'job-1'; select.dispatchEvent(new Event('change'))
}
function file(name: string) { return new File(['resume'], name, { type: 'text/plain', lastModified: 1 }) }
function batchStatus(): 'uploading' | 'completed' | 'cancelled' {
  if (currentBatch.status === 'cancelled') return 'cancelled'
  const active = currentBatch.items.some(item => item.status === 'pending_upload' || item.status === 'uploading')
  return active ? 'uploading' : 'completed'
}
function refreshCounts() {
  currentBatch.status = batchStatus()
  currentBatch.counts = {
    total: currentBatch.items.length,
    pendingUpload: currentBatch.items.filter(item => item.status === 'pending_upload').length,
    uploading: currentBatch.items.filter(item => item.status === 'uploading').length,
    uploaded: currentBatch.items.filter(item => item.status === 'queued' || item.analysisStatus === 'completed').length,
    analyzing: currentBatch.items.filter(item => item.analysisStatus === 'processing').length,
    completed: currentBatch.items.filter(item => item.analysisStatus === 'completed').length,
    failed: currentBatch.items.filter(item => item.status === 'failed' || item.analysisStatus === 'failed').length,
    cancelled: currentBatch.items.filter(item => item.status === 'cancelled').length,
  }
}
function itemFor(itemId: string): ApiResumeImportItem {
  return currentBatch.items.find(item => item.id === itemId)!
}

beforeEach(() => {
  vi.mocked(loadCandidates).mockResolvedValue([])
  createBatch.mockImplementation(async input => {
    const timestamp = new Date().toISOString()
    currentBatch = {
      id: 'batch-1',
      jobId: input.jobId,
      status: 'uploading',
      items: input.files.map((file, index) => ({
        id: `item-${index + 1}`,
        batchId: 'batch-1',
        ordinal: index + 1,
        clientFileId: file.clientFileId,
        originalFilename: file.originalFilename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        status: 'pending_upload',
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
      counts: { total: input.files.length, pendingUpload: input.files.length, uploading: 0, uploaded: 0, analyzing: 0, completed: 0, failed: 0, cancelled: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    return structuredClone(currentBatch)
  })
  readBatch.mockImplementation(async () => {
    refreshCounts()
    return structuredClone(currentBatch)
  })
  cancelBatch.mockImplementation(async () => {
    currentBatch.status = 'cancelled'
    currentBatch.cancelledAt = new Date().toISOString()
    for (const item of currentBatch.items) {
      if (item.status === 'pending_upload' || item.status === 'failed') item.status = 'cancelled'
    }
    refreshCounts()
    return structuredClone(currentBatch)
  })
  uploadItem.mockImplementation(async (_batchId, itemId, _content, options) => {
    const item = itemFor(itemId)
    item.status = 'uploading'
    options?.onProgress?.(45)
    await Promise.resolve()
    item.status = 'queued'
    item.analysisStatus = 'queued'
    options?.onProgress?.(100)
    refreshCounts()
    return structuredClone(item)
  })
  window.localStorage.clear()
})
afterEach(() => {
  app?.unmount(); app = undefined; root?.remove(); vi.restoreAllMocks(); vi.clearAllMocks(); window.localStorage.clear()
})

describe('resumable batch upload', () => {
  it('supports multiple selection, append, duplicate suppression, remove and reselection', async () => {
    await mount()
    expect(root.querySelector<HTMLInputElement>('#candidate-resume-file')!.multiple).toBe(true)
    const a = file('张三.txt')
    files(a, file('李四.txt')); await flush()
    expect(root.querySelectorAll('.resume-file-row')).toHaveLength(2)
    files(a, file('王五.txt')); await flush()
    expect(root.querySelectorAll('.resume-file-row')).toHaveLength(3)
    root.querySelector<HTMLButtonElement>('[aria-label="移除 张三.txt"]')!.click(); await flush()
    expect(root.querySelectorAll('.resume-file-row')).toHaveLength(2)
    files(a); await flush()
    expect(root.querySelectorAll('.resume-file-row')).toHaveLength(3)
    expect(submit().textContent).toContain('3份')
  })

  it('validates files and job before creating a batch', async () => {
    await mount(); submit().click(); await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('请选择简历文件')
    files(file('bad.exe'), new File([], 'empty.txt'), new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.pdf'), file('valid.txt')); await flush()
    expect(root.querySelectorAll('.resume-file-row')).toHaveLength(1)
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('不支持此文件格式')
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('文件为空')
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('不能超过 10 MB')
    submit().click(); await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('请选择简历对应岗位')
    expect(createBatch).not.toHaveBeenCalled()
  })

  it('starts three independent upload lanes and keeps the batch after closing', async () => {
    const releases: Array<() => void> = []
    uploadItem.mockImplementation((_batchId, itemId, _content, options) => new Promise(resolve => {
      options?.onProgress?.(40)
      releases.push(() => {
        const item = itemFor(itemId)
        item.status = 'queued'
        item.analysisStatus = 'queued'
        options?.onProgress?.(100)
        refreshCounts()
        resolve(structuredClone(item))
      })
    }))
    await mount(); files(file('一.txt'), file('二.txt'), file('三.txt'), file('四.txt'), file('五.txt')); job(); await flush(); submit().click()
    await waitFor(() => expect(uploadItem).toHaveBeenCalledTimes(3))
    expect(createBatch).toHaveBeenCalledTimes(1)
    expect(root.querySelectorAll('[data-status="uploading"]')).toHaveLength(3)
    releases.splice(0).forEach(release => release())
    await waitFor(() => expect(uploadItem).toHaveBeenCalledTimes(5))
    releases.splice(0).forEach(release => release())
    await waitFor(() => expect(root.querySelectorAll('[data-status="queued"]')).toHaveLength(5))
    button('完成').click(); await flush()
    expect(root.querySelector('.resume-dialog')).toBeNull()
  })

  it('isolates a failed item and retries without creating another batch', async () => {
    uploadItem.mockImplementation(async (_batchId, itemId, _content, options) => {
      const item = itemFor(itemId)
      if (item.originalFilename === '二.txt') {
        item.status = 'failed'
        item.error = '网络连接中断'
        refreshCounts()
        throw new Error('网络连接中断')
      }
      item.status = 'queued'
      item.analysisStatus = 'queued'
      options?.onProgress?.(100)
      refreshCounts()
      return structuredClone(item)
    })
    await mount(); files(file('一.txt'), file('二.txt'), file('三.txt')); job(); await flush(); submit().click()
    await waitFor(() => expect(submit().textContent).toContain('重试失败文件'))
    expect(root.querySelectorAll('[data-status="queued"]')).toHaveLength(2)
    expect(root.querySelectorAll('[data-status="failed"]')).toHaveLength(1)
    expect(root.textContent).toContain('网络连接中断')
    uploadItem.mockImplementation(async (_batchId, itemId, _content, options) => {
      const item = itemFor(itemId)
      item.status = 'queued'
      item.analysisStatus = 'queued'
      options?.onProgress?.(100)
      refreshCounts()
      return structuredClone(item)
    })
    submit().click()
    await waitFor(() => expect(root.querySelectorAll('[data-status="queued"]')).toHaveLength(3))
    expect(createBatch).toHaveBeenCalledTimes(1)
    expect(uploadItem).toHaveBeenCalledTimes(4)
  })

  it('cancels remaining uploads and retains already uploaded work', async () => {
    uploadItem.mockImplementation((_batchId, itemId, _content, options) => {
      const item = itemFor(itemId)
      if (item.ordinal <= 2) {
        const item = itemFor(itemId)
        item.status = 'queued'
        item.analysisStatus = 'queued'
        options?.onProgress?.(100)
        refreshCounts()
        return Promise.resolve(structuredClone(item))
      }
      item.status = 'uploading'
      return new Promise<ApiResumeImportItem>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('上传已取消', 'AbortError')), { once: true })
      })
    })
    await mount(); files(file('一.txt'), file('二.txt'), file('三.txt'), file('四.txt')); job(); await flush(); submit().click()
    await waitFor(() => expect(root.querySelectorAll('[data-status="queued"]')).toHaveLength(2))
    root.querySelector<HTMLButtonElement>('.resume-cancel-upload')!.click()
    await waitFor(() => expect(cancelBatch).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(root.querySelectorAll('[data-status="cancelled"]')).toHaveLength(2))
    expect(root.querySelectorAll('[data-status="queued"]')).toHaveLength(2)
    expect(root.textContent).toContain('已上传成功的简历会继续处理')
  })

  it('restores the recent batch after reopening the page', async () => {
    const timestamp = new Date().toISOString()
    currentBatch = {
      id: 'batch-restored', jobId: 'job-1', status: 'uploading',
      items: [{ id: 'item-restored', batchId: 'batch-restored', ordinal: 1, clientFileId: 'local-1', originalFilename: '恢复.txt', mimeType: 'text/plain', sizeBytes: 6, status: 'queued', analysisStatus: 'processing', attempts: 1, createdAt: timestamp, updatedAt: timestamp }],
      counts: { total: 1, pendingUpload: 0, uploading: 0, uploaded: 1, analyzing: 1, completed: 0, failed: 0, cancelled: 0 },
      createdAt: timestamp, updatedAt: timestamp,
    }
    window.localStorage.setItem('smartrecruit:active-resume-import-batch', 'batch-restored')
    await mount(false)
    await waitFor(() => expect(button('查看进度')).toBeTruthy())
    button('查看进度').click()
    await flush()
    expect(root.querySelectorAll('.resume-file-row')).toHaveLength(1)
    expect(root.textContent).toContain('恢复.txt')
    expect(root.textContent).toContain('AI 分析中')
  })
})
