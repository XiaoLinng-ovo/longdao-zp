// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../../shared/api'
import { setWorkspaceContext } from '../../../shared/api/workspace-context'
import { uploadResumeImportItem, type ApiResumeImportItem } from './index'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn() } }))

class UploadXhr {
  static instances: UploadXhr[] = []
  upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void } = {}
  status = 0
  responseText = ''
  onload?: () => void
  onerror?: () => void
  onabort?: () => void
  ontimeout?: () => void
  constructor() { UploadXhr.instances.push(this) }
  open() {}
  setRequestHeader() {}
  getResponseHeader(name: string) { return name === 'x-request-id' ? 'request-test' : null }
  send() {}
  abort() { this.onabort?.() }
  respond(status: number, body: unknown) {
    this.status = status
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body)
    this.onload?.()
  }
}

const item = (status: ApiResumeImportItem['status']): ApiResumeImportItem => ({
  id: 'item-1', batchId: 'batch-1', ordinal: 1, clientFileId: 'file-1', originalFilename: 'resume.pdf',
  mimeType: 'application/pdf', sizeBytes: 782 * 1024, status, attempts: status === 'pending_upload' ? 0 : 1,
  ...(status === 'queued' ? { analysisTaskId: 'task-1', resumeId: 'resume-1' } : {}),
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
})
function serverItem(status: ApiResumeImportItem['status']) {
  return { ok: true, requestId: 'test', data: { id: 'batch-1', status: 'uploading', items: [item(status)] } }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  vi.stubGlobal('XMLHttpRequest', UploadXhr)
  UploadXhr.instances = []
  setWorkspaceContext('workspace-1', 'user-1')
})
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('resume upload response confirmation', () => {
  it('recovers a timed-out response from server state without sending the file twice', async () => {
    vi.mocked(apiClient.getJson).mockResolvedValue(serverItem('queued') as never)
    const progress = vi.fn()
    const pending = uploadResumeImportItem('batch-1', 'item-1', 'cGRm', { timeoutMs: 100, onProgress: progress })
    UploadXhr.instances[0]!.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 })
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toMatchObject({ analysisTaskId: 'task-1' })
    expect(UploadXhr.instances).toHaveLength(1)
    expect(progress).toHaveBeenLastCalledWith(100)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('only polls while the server is saving an upload; it does not resend the body', async () => {
    vi.mocked(apiClient.getJson).mockResolvedValueOnce(serverItem('uploading') as never).mockResolvedValue(serverItem('queued') as never)
    const retry = vi.fn()
    const pending = uploadResumeImportItem('batch-1', 'item-1', 'cGRm', { onRetry: retry })
    UploadXhr.instances[0]!.onerror?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(retry).toHaveBeenCalledWith(1, 2000, expect.objectContaining({ code: 'UPLOAD_IN_PROGRESS' }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toMatchObject({ analysisTaskId: 'task-1' })
    expect(UploadXhr.instances).toHaveLength(1)
  })

  it('resends only after confirming the server still has a pending file and keeps the gateway cause', async () => {
    vi.mocked(apiClient.getJson).mockResolvedValue(serverItem('pending_upload') as never)
    const retry = vi.fn()
    const pending = uploadResumeImportItem('batch-1', 'item-1', 'cGRm', { onRetry: retry })
    UploadXhr.instances[0]!.respond(502, '<html>Bad Gateway</html>')
    await vi.advanceTimersByTimeAsync(0)
    expect(retry).toHaveBeenCalledWith(1, 2000, expect.objectContaining({ status: 502, requestId: 'request-test' }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(UploadXhr.instances).toHaveLength(2)
    UploadXhr.instances[1]!.respond(200, { ok: true, data: item('queued') })
    expect(await pending).toMatchObject({ analysisTaskId: 'task-1' })
  })

  it('does not resend while the confirmation endpoint is also unavailable', async () => {
    vi.mocked(apiClient.getJson).mockRejectedValue(new Error('network unavailable'))
    const controller = new AbortController()
    const pending = uploadResumeImportItem('batch-1', 'item-1', 'cGRm', { signal: controller.signal })
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    UploadXhr.instances[0]!.onerror?.()
    await vi.advanceTimersByTimeAsync(2500)
    expect(UploadXhr.instances).toHaveLength(1)
    controller.abort()
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never retries authorization failures or sends to a newly selected workspace', async () => {
    const pending = uploadResumeImportItem('batch-1', 'item-1', 'cGRm')
    const assertion = expect(pending).rejects.toMatchObject({ code: 'WORKSPACE_CONTEXT_CHANGED' })
    setWorkspaceContext('workspace-2', 'user-1')
    UploadXhr.instances[0]!.respond(200, { ok: true, data: item('queued') })
    await assertion
    expect(UploadXhr.instances).toHaveLength(1)
    expect(apiClient.getJson).not.toHaveBeenCalled()
  })
})
