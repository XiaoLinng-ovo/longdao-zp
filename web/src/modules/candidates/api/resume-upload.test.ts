// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../../shared/api'
import { ensureCsrfToken } from '../../../shared/api/client'
import { setWorkspaceContext } from '../../../shared/api/workspace-context'
import { uploadResumeImportItem, type ApiResumeImportItem } from './index'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn() } }))
vi.mock('../../../shared/api/client', () => ({ ensureCsrfToken: vi.fn() }))

class UploadXhr {
  static instances: UploadXhr[] = []
  upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void } = {}
  status = 0
  responseText = ''
  headers: Record<string, string> = {}
  withCredentials = false
  onload?: () => void
  onerror?: () => void
  onabort?: () => void
  ontimeout?: () => void
  constructor() { UploadXhr.instances.push(this) }
  open() {}
  setRequestHeader(name: string, value: string) { this.headers[name] = value }
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
  vi.mocked(ensureCsrfToken).mockReset().mockResolvedValue('server-token')
  setWorkspaceContext('workspace-1', 'user-1')
})
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('resume upload response confirmation', () => {
  it('recovers a timed-out response from server state without sending the file twice', async () => {
    vi.mocked(apiClient.getJson).mockResolvedValue(serverItem('queued') as never)
    const progress = vi.fn()
    const pending = uploadResumeImportItem('batch-1', 'item-1', 'cGRm', { timeoutMs: 100, onProgress: progress })
    await vi.advanceTimersByTimeAsync(0)
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
    await vi.advanceTimersByTimeAsync(0)
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
    await vi.advanceTimersByTimeAsync(0)
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
    await vi.advanceTimersByTimeAsync(0)
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
    await vi.advanceTimersByTimeAsync(0)
    setWorkspaceContext('workspace-2', 'user-1')
    UploadXhr.instances[0]!.respond(200, { ok: true, data: item('queued') })
    await assertion
    expect(UploadXhr.instances).toHaveLength(1)
    expect(apiClient.getJson).not.toHaveBeenCalled()
  })
})

describe('resume upload CSRF security', () => {
  it('uses the server-issued token without depending on a development cookie name', async () => {
    expect(document.cookie).not.toContain('smartrecruit_csrf=')
    const pending = uploadResumeImportItem('batch-1', 'item-1', 'cGRm')
    await vi.advanceTimersByTimeAsync(0)
    const xhr = UploadXhr.instances[0]!
    expect(ensureCsrfToken).toHaveBeenCalledOnce()
    expect(xhr.headers['x-csrf-token']).toBe('server-token')
    expect(xhr.headers['x-workspace-id']).toBe('workspace-1')
    expect(xhr.withCredentials).toBe(true)
    xhr.respond(200, { ok: true, data: item('queued') })
    await expect(pending).resolves.toMatchObject({ analysisTaskId: 'task-1' })
  })

  it('refreshes a rejected token once and preserves upload progress', async () => {
    vi.mocked(ensureCsrfToken).mockResolvedValueOnce('old').mockResolvedValueOnce('new')
    const progress = vi.fn()
    const pending = uploadResumeImportItem('batch-1', 'item-1', 'cGRm', { onProgress: progress })
    await vi.advanceTimersByTimeAsync(0)
    UploadXhr.instances[0]!.respond(403, { ok: false, error: { code: 'CSRF_TOKEN_INVALID', message: 'invalid' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(ensureCsrfToken).toHaveBeenLastCalledWith(true)
    expect(UploadXhr.instances).toHaveLength(2)
    expect(UploadXhr.instances[1]!.headers['x-csrf-token']).toBe('new')
    UploadXhr.instances[1]!.respond(200, { ok: true, data: item('queued') })
    await expect(pending).resolves.toMatchObject({ analysisTaskId: 'task-1' })
    expect(progress).toHaveBeenLastCalledWith(100)
    expect(vi.getTimerCount()).toBe(0)
    expect(apiClient.getJson).not.toHaveBeenCalled()
  })

  it.each(['CSRF_TOKEN_INVALID', 'CSRF_ORIGIN_MISMATCH', 'FORBIDDEN'])('bounds retries for %s', async code => {
    const pending = uploadResumeImportItem('batch-1', 'item-1', 'cGRm')
    const assertion = expect(pending).rejects.toMatchObject({ code, status: 403 })
    await vi.advanceTimersByTimeAsync(0)
    const denied = { ok: false, error: { code, message: 'denied' } }
    UploadXhr.instances[0]!.respond(403, denied)
    await vi.advanceTimersByTimeAsync(0)
    if (code === 'CSRF_TOKEN_INVALID') UploadXhr.instances[1]!.respond(403, denied)
    await assertion
    expect(UploadXhr.instances).toHaveLength(code === 'CSRF_TOKEN_INVALID' ? 2 : 1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['abort', 'workspace'])('does not upload after %s during token refresh', async action => {
    let complete!: (token: string) => void
    vi.mocked(ensureCsrfToken).mockResolvedValueOnce('old').mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const controller = new AbortController()
    const pending = uploadResumeImportItem('batch-1', 'item-1', 'cGRm', { signal: controller.signal })
    const assertion = expect(pending).rejects.toMatchObject(action === 'abort' ? { name: 'AbortError' } : { code: 'WORKSPACE_CONTEXT_CHANGED' })
    await vi.advanceTimersByTimeAsync(0)
    UploadXhr.instances[0]!.respond(403, { ok: false, error: { code: 'CSRF_TOKEN_INVALID' } })
    await vi.advanceTimersByTimeAsync(0)
    if (action === 'abort') controller.abort()
    else setWorkspaceContext('workspace-2', 'user-1')
    complete('new')
    await assertion
    expect(UploadXhr.instances).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
