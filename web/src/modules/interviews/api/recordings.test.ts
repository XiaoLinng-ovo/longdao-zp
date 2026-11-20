// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadInterviewRecording, listInterviewRecordings, loadFullInterviewRecording } from './recordings'
import { apiClient } from '../../../shared/api'
import { setWorkspaceContext, WORKSPACE_CONTEXT_EVENT } from '../../../shared/api/workspace-context'
vi.mock('../../../shared/api', () => ({ apiClient: { baseUrl: '/api/v1', getJson: vi.fn(), postJson: vi.fn() } }))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setWorkspaceContext(undefined) })
describe('original recording API', () => {
  it('starts and reads a full-audio transcription scoped to the selected session and source', async () => {
    const job = { status: 'processing', progress: 25, text: '', updatedAt: '2026-10-21T00:00:00Z' }
    vi.mocked(apiClient.postJson).mockResolvedValue({ data: job } as never)
    vi.mocked(apiClient.getJson).mockResolvedValue({ data: job } as never)
    const controller = new AbortController()
    const { startFullAudioTranscription, getFullAudioTranscription } = await import('./recordings')
    expect(await startFullAudioTranscription('i','session 1','meeting',controller.signal)).toEqual(job)
    expect(apiClient.postJson).toHaveBeenCalledWith('/interviews/i/recordings/transcription?sessionId=session+1&source=meeting', {}, { signal: controller.signal })
    expect(await getFullAudioTranscription('i','session 1','meeting',controller.signal)).toEqual(job)
    expect(apiClient.getJson).toHaveBeenCalledWith('/interviews/i/recordings/transcription?sessionId=session+1&source=meeting', { signal: controller.signal })
  })
  it('loads the requested full session and source with private workspace credentials', async () => {
    setWorkspaceContext('org-a')
    const fetchMock = vi.fn().mockResolvedValue({ok:true,blob:async()=>new Blob(['full'],{type:'audio/mp4'})})
    vi.stubGlobal('fetch',fetchMock)
    await loadFullInterviewRecording('i','s','meeting')
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/interviews/i/recordings/full?sessionId=s&source=meeting',expect.objectContaining({credentials:'include',headers:{Accept:'audio/*','x-workspace-id':'org-a'}}))
    fetchMock.mockResolvedValueOnce({ok:true,blob:async()=>{setWorkspaceContext('org-b');return new Blob(['private'])}})
    await expect(loadFullInterviewRecording('i','s','all')).rejects.toThrow('工作空间已变更')
  })
  it('unwraps the list and loads private audio with session credentials and the current workspace', async () => {
    vi.mocked(apiClient.getJson).mockResolvedValue({ data: [{ id: 'r' }] } as never)
    expect(await listInterviewRecordings('i')).toEqual([{ id: 'r' }])
    setWorkspaceContext('org-a')
    const blob = new Blob(['original'], { type: 'audio/webm' })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob })
    vi.stubGlobal('fetch', fetchMock)
    expect(await loadInterviewRecording('i', 'r')).toBe(blob)
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/interviews/i/recordings/r', expect.objectContaining({ credentials: 'include', headers: { Accept: 'audio/*', 'x-workspace-id': 'org-a' } }))
  })
  it('rejects audio when workspace changes during download', async () => {
    setWorkspaceContext('org-a')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => { setWorkspaceContext('org-b'); return new Blob(['private']) } }))
    await expect(loadInterviewRecording('i', 'r')).rejects.toThrow('工作空间已变更')
  })
  it('surfaces missing-file errors and invalidates stale workspace context', async () => {
    const listener = vi.fn(); window.addEventListener(WORKSPACE_CONTEXT_EVENT, listener)
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: { message: '工作空间已切换' } }) }))
      await expect(loadInterviewRecording('i', 'r')).rejects.toThrow('工作空间已切换')
      expect(listener).toHaveBeenCalledOnce()
    } finally { window.removeEventListener(WORKSPACE_CONTEXT_EVENT, listener) }
  })
})
