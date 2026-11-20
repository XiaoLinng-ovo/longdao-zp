// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiNetworkError, ApiResponseError } from '../../../shared/api'
import { endLiveInterviewSession, uploadLiveInterviewChunk, type LiveInterviewSegment } from '../api'
import { createBackgroundAudioQueue } from './background-audio'
import { removePendingAudio, removePendingFinish, restorePendingAudio, restorePendingFinishes, savePendingAudio, savePendingFinish, type PendingInterviewAudio, type PendingInterviewFinish } from './pending-audio'

vi.mock('../api', () => ({ endLiveInterviewSession: vi.fn(), uploadLiveInterviewChunk: vi.fn() }))
vi.mock('./pending-audio', () => ({ removePendingAudio: vi.fn(), removePendingFinish: vi.fn(), restorePendingAudio: vi.fn(), restorePendingFinishes: vi.fn(), savePendingAudio: vi.fn(), savePendingFinish: vi.fn() }))

const owner = 'tenant:user'
let context = { owner, revision: 1 }
let queues: ReturnType<typeof createBackgroundAudioQueue>[]
let chunks: Map<string, PendingInterviewAudio>
let finishes: Map<string, PendingInterviewFinish>
function queue() { const result = createBackgroundAudioQueue(() => ({ ...context })); queues.push(result); return result }
function finish(id = 'one'): PendingInterviewFinish { return { id: 'session-' + id, scope: owner + ':interview-' + id, interviewId: 'interview-' + id, label: '候选人 ' + id } }
function entry(id = 'a', source?: 'microphone' | 'meeting', interview = 'one') {
  const meta = finish(interview)
  return { chunk: { id, sessionId: meta.id, scope: meta.scope, audio: new Blob(['audio']), contentType: 'audio/webm', offsetMs: 0, endMs: 15000,
    ...(source ? { audioSource: { id: source, role: 'unknown' as const, multipleSpeakers: true } } : {}) } }
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function flush(count = 100) { for (let i = 0; i < count; i++) await Promise.resolve() }

beforeEach(() => {
  vi.useFakeTimers(); context = { owner, revision: 1 }; queues = []; chunks = new Map(); finishes = new Map()
  vi.stubGlobal('FileReader', class {
    result = 'data:audio/webm;base64,YXVkaW8='
    onloadend?: () => void
    readAsDataURL() { this.onloadend?.() }
  })
  vi.mocked(savePendingAudio).mockImplementation(async chunk => { chunks.set(chunk.id, { ...chunk }) })
  vi.mocked(removePendingAudio).mockImplementation(async id => { chunks.delete(id) })
  vi.mocked(savePendingFinish).mockImplementation(async row => { finishes.set(row.id, { ...row }) })
  vi.mocked(removePendingFinish).mockImplementation(async id => { finishes.delete(id) })
  vi.mocked(restorePendingFinishes).mockImplementation(async scope => [...finishes.values()].filter(row => row.scope === scope + ':' + row.interviewId))
  vi.mocked(restorePendingAudio).mockImplementation(async (scope, id) => [...chunks.values()].filter(row => row.scope === scope && row.sessionId === id).sort((a, b) => a.offsetMs - b.offsetMs))
  vi.mocked(uploadLiveInterviewChunk).mockResolvedValue([])
  vi.mocked(endLiveInterviewSession).mockResolvedValue({ status: 'completed' } as never)
})
afterEach(() => { queues.forEach(item => item.dispose()); vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllGlobals() })

describe('background interview audio', () => {
  it('retains completion intent through processing and review and recovers it after reload', async () => {
    vi.mocked(endLiveInterviewSession).mockResolvedValueOnce({ status: 'paused', completionReview: { phase: 'processing' } } as never)
      .mockResolvedValue({ status: 'paused', completionReview: { phase: 'review_required', unresolvedCount: 31, limit: 30 } } as never)
    const previous = queue(); previous.adopt(finish(), [entry()]); await flush()
    expect(previous.jobs[0]!.phase).toBe('processing')
    expect(finishes.size).toBe(1); expect(chunks.size).toBe(0)
    await vi.advanceTimersByTimeAsync(15000); await flush()
    expect(previous.jobs[0]!.phase).toBe('review_required')
    expect(previous.jobs[0]!.message).toContain('31')
    await vi.advanceTimersByTimeAsync(60000); await flush()
    expect(endLiveInterviewSession).toHaveBeenCalledTimes(2)
    expect(removePendingFinish).not.toHaveBeenCalled()
    previous.dispose()
    const recovered = queue(); await recovered.recover(); await flush()
    expect(recovered.jobs[0]!.phase).toBe('review_required')
    expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce()
    expect(finishes.size).toBe(1)
    vi.mocked(endLiveInterviewSession).mockResolvedValue({ status: 'completed' } as never)
    recovered.retry('session-one'); await flush()
    expect(recovered.jobs[0]!.phase).toBe('completed')
    expect(finishes.size).toBe(0)
  })
  it('uploads a 232-chunk backlog in order and ends exactly once after all acknowledgements', async () => {
    const worker = queue()
    const rows = Array.from({ length: 232 }, (_, index) => {
      const row = entry('chunk-' + index); row.chunk.offsetMs = index * 15000; row.chunk.endMs += row.chunk.offsetMs; return row
    })
    worker.adopt(finish(), rows)
    expect(worker.jobs[0]!.pending).toBe(232)
    await flush(2500)
    expect(vi.mocked(uploadLiveInterviewChunk).mock.calls.map(call => call[4])).toEqual(rows.map(row => row.chunk.id))
    expect(endLiveInterviewSession).toHaveBeenCalledOnce()
    expect(worker.jobs[0]!.phase).toBe('completed')
    expect(chunks.size).toBe(0); expect(finishes.size).toBe(0)
  })
  it('adopts an in-flight request without resending it or ending before its response', async () => {
    const worker = queue(), flight = deferred<LiveInterviewSegment[]>()
    worker.adopt(finish(), [{ ...entry('sent'), inFlight: flight.promise }, entry('next')])
    await flush()
    expect(uploadLiveInterviewChunk).not.toHaveBeenCalled(); expect(endLiveInterviewSession).not.toHaveBeenCalled()
    flight.resolve([]); await flush()
    expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce()
    expect(vi.mocked(uploadLiveInterviewChunk).mock.calls[0]![4]).toBe('next')
    expect(worker.jobs[0]!.phase).toBe('completed')
  })
  it('waits for the final audio/text checkpoint before persisting the finish intent', async () => {
    const worker = queue(), ready = deferred<void>(), row = entry()
    worker.adopt(finish(), [{ ...row, ready: ready.promise }]); await flush()
    expect(savePendingFinish).not.toHaveBeenCalled(); expect(uploadLiveInterviewChunk).not.toHaveBeenCalled()
    Object.assign(row.chunk, { streamingTranscript: { text: '最后的完整回答也必须保存', endMs: 15000, complete: true } })
    // The recorder updates the same chunk object while final recognition is being committed.
    const adopted = vi.mocked(savePendingAudio)
    ready.resolve(); await flush()
    expect(adopted).toHaveBeenCalledOnce(); expect(savePendingFinish).toHaveBeenCalledOnce()
    expect(vi.mocked(uploadLiveInterviewChunk).mock.calls[0]![5]).toEqual({ text: '最后的完整回答也必须保存', endMs: 15000, complete: true })
    expect(worker.jobs[0]!.phase).toBe('completed')
  })
  it('keeps meeting uploads moving independently while a microphone request is stalled', async () => {
    const worker = queue(), flight = deferred<LiveInterviewSegment[]>()
    worker.adopt(finish(), [{ ...entry('mic', 'microphone'), inFlight: flight.promise }, entry('meeting-1', 'meeting'), entry('meeting-2', 'meeting')])
    await flush()
    expect(vi.mocked(uploadLiveInterviewChunk).mock.calls.map(call => call[4])).toEqual(['meeting-1', 'meeting-2'])
    expect(worker.jobs[0]!.pending).toBe(1); expect(endLiveInterviewSession).not.toHaveBeenCalled()
    flight.resolve([]); await flush(); expect(endLiveInterviewSession).toHaveBeenCalledOnce()
  })
  it('automatically retries a failed upload using the same chunk key', async () => {
    vi.mocked(uploadLiveInterviewChunk).mockRejectedValueOnce(new ApiNetworkError('offline'))
    const worker = queue(); worker.adopt(finish(), [entry()]); await flush()
    expect(worker.jobs[0]!.phase).toBe('failed'); expect(chunks.size).toBe(1); expect(finishes.size).toBe(1)
    await vi.advanceTimersByTimeAsync(15000); await flush()
    expect(vi.mocked(uploadLiveInterviewChunk).mock.calls[1]).toEqual(vi.mocked(uploadLiveInterviewChunk).mock.calls[0])
    expect(worker.jobs[0]!.phase).toBe('completed')
  })
  it('automatically retries session completion without uploading saved audio again', async () => {
    vi.mocked(endLiveInterviewSession).mockRejectedValueOnce(new ApiNetworkError('response lost'))
    const worker = queue(); worker.adopt(finish(), [entry()]); await flush()
    expect(worker.jobs[0]!.phase).toBe('failed'); expect(chunks.size).toBe(0); expect(finishes.size).toBe(1)
    await vi.advanceTimersByTimeAsync(15000); await flush()
    expect(endLiveInterviewSession).toHaveBeenCalledTimes(2); expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce()
    expect(worker.jobs[0]!.phase).toBe('completed')
  })
  it('does not repeatedly retry forbidden uploads until the user explicitly retries', async () => {
    vi.mocked(uploadLiveInterviewChunk).mockRejectedValueOnce(new ApiResponseError('无权限', { status: 403 }))
    const worker = queue(); worker.adopt(finish(), [entry()]); await flush()
    await vi.advanceTimersByTimeAsync(60000); await flush()
    expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce(); expect(worker.jobs[0]!.message).toContain('无权限')
    worker.retry('session-one'); await flush(); expect(worker.jobs[0]!.phase).toBe('completed')
  })
  it('restores the finish intent and its pending audio after reloading, even outside the room', async () => {
    const previous = queue(), flight = deferred<LiveInterviewSegment[]>()
    previous.adopt(finish(), [{ ...entry(), inFlight: flight.promise }]); await flush(); previous.dispose()
    const restored = queue(); await restored.recover(); await flush()
    expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce(); expect(endLiveInterviewSession).toHaveBeenCalledWith('session-one')
    expect(restored.jobs[0]!.phase).toBe('completed')
    flight.resolve([]); await flush(); expect(endLiveInterviewSession).toHaveBeenCalledOnce()
  })
  it('recovers a finish intent with no pending audio by only ending the server session', async () => {
    finishes.set('session-one', finish())
    const worker = queue(); await worker.recover(); await flush()
    expect(uploadLiveInterviewChunk).not.toHaveBeenCalled(); expect(endLiveInterviewSession).toHaveBeenCalledOnce()
    expect(worker.jobs[0]!.phase).toBe('completed')
  })
  it('refuses audio belonging to another tenant, user or session', () => {
    const worker = queue()
    expect(() => worker.adopt({ ...finish(), scope: 'other:user:interview-one' }, [entry()])).toThrow('所属账号')
    expect(() => worker.adopt(finish(), [{ chunk: { ...entry().chunk, sessionId: 'other' } }])).toThrow('不匹配')
    expect(uploadLiveInterviewChunk).not.toHaveBeenCalled()
  })
  it('does not acknowledge or finish old-tenant audio after switching accounts mid-request', async () => {
    const worker = queue(), flight = deferred<LiveInterviewSegment[]>()
    worker.adopt(finish(), [{ ...entry(), inFlight: flight.promise }]); await flush()
    context = { owner: 'other:user', revision: 2 }; flight.resolve([]); await flush()
    expect(removePendingAudio).not.toHaveBeenCalled(); expect(endLiveInterviewSession).not.toHaveBeenCalled()
    worker.retry(); await flush(); expect(uploadLiveInterviewChunk).not.toHaveBeenCalled()
    context = { owner, revision: 3 }; await worker.recover(); await flush()
    expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce(); expect(worker.jobs[0]!.phase).toBe('completed')
  })
  it('does not start requests after logout while final persistence is still pending', async () => {
    const worker = queue(), ready = deferred<void>()
    worker.adopt(finish(), [{ ...entry(), ready: ready.promise }]); context = { owner: '', revision: 2 }
    ready.resolve(); await flush()
    expect(uploadLiveInterviewChunk).not.toHaveBeenCalled(); expect(endLiveInterviewSession).not.toHaveBeenCalled()
    expect(chunks.size).toBe(1)
  })
  it('suspends all new work when another browser tab changes workspace', async () => {
    const worker = queue(), flight = deferred<LiveInterviewSegment[]>()
    worker.adopt(finish(), [{ ...entry('first'), inFlight: flight.promise }, entry('next')]); await flush()
    worker.suspend(); flight.resolve([]); await flush(); worker.retry(); await flush()
    expect(uploadLiveInterviewChunk).not.toHaveBeenCalled(); expect(removePendingAudio).not.toHaveBeenCalled()
    expect(endLiveInterviewSession).not.toHaveBeenCalled()
  })
  it('keeps an explicit cache warning and never persists an unsafe finish intent when audio storage fails', async () => {
    vi.mocked(savePendingAudio).mockRejectedValue(new Error('quota'))
    const worker = queue(), flight = deferred<LiveInterviewSegment[]>()
    worker.adopt(finish(), [{ ...entry(), inFlight: flight.promise }]); await flush()
    expect(worker.jobs[0]!.cacheWarning).toContain('请勿刷新或关闭')
    expect(savePendingFinish).not.toHaveBeenCalled(); expect(endLiveInterviewSession).not.toHaveBeenCalled()
    flight.resolve([]); await flush(); expect(worker.jobs[0]!.phase).toBe('completed')
  })
  it('retries cache cleanup without uploading the same acknowledged chunk again', async () => {
    vi.mocked(removePendingAudio).mockRejectedValueOnce(new Error('storage unavailable'))
    const worker = queue(); worker.adopt(finish(), [entry()]); await flush()
    expect(worker.jobs[0]!.phase).toBe('failed'); expect(endLiveInterviewSession).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15000); await flush()
    expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce(); expect(worker.jobs[0]!.phase).toBe('completed')
  })
  it('does not repeat a successful server end when removing its local finish record fails', async () => {
    vi.mocked(removePendingFinish).mockRejectedValueOnce(new Error('storage unavailable'))
    const worker = queue(); worker.adopt(finish(), [entry()]); await flush()
    await vi.advanceTimersByTimeAsync(15000); await flush()
    expect(endLiveInterviewSession).toHaveBeenCalledOnce(); expect(worker.jobs[0]!.phase).toBe('completed')
  })
  it('deduplicates repeated handoffs for the same session', async () => {
    const worker = queue(); const first = worker.adopt(finish(), [entry()]); const again = worker.adopt(finish(), [entry()]); await flush()
    expect(first).toBe(again); expect(worker.jobs).toHaveLength(1); expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce()
  })
  it('finishes a second candidate while the previous candidate is still uploading', async () => {
    const worker = queue(), flight = deferred<LiveInterviewSegment[]>()
    worker.adopt(finish(), [{ ...entry(), inFlight: flight.promise }]); worker.adopt(finish('two'), [entry('next-candidate', undefined, 'two')]); await flush()
    expect(worker.jobs.map(job => job.phase)).toEqual(['uploading', 'completed'])
    expect(endLiveInterviewSession).toHaveBeenCalledWith('session-two'); expect(endLiveInterviewSession).not.toHaveBeenCalledWith('session-one')
    flight.resolve([]); await flush(); expect(endLiveInterviewSession).toHaveBeenCalledWith('session-one')
  })
  it('cancels retry timers and ignores late responses after disposing the queue', async () => {
    vi.mocked(uploadLiveInterviewChunk).mockRejectedValue(new ApiNetworkError('offline'))
    const worker = queue(); worker.adopt(finish(), [entry()]); await flush(); worker.dispose()
    await vi.advanceTimersByTimeAsync(30000); await flush()
    expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce(); expect(endLiveInterviewSession).not.toHaveBeenCalled()
  })
  it('does not finalize anything when recovery cannot read local storage', async () => {
    vi.mocked(restorePendingFinishes).mockRejectedValue(new Error('storage unavailable'))
    const worker = queue(); await expect(worker.recover()).rejects.toThrow('storage unavailable')
    expect(endLiveInterviewSession).not.toHaveBeenCalled(); expect(worker.jobs).toHaveLength(0)
  })
  it('only dismisses completed notifications, never an active recording queue', async () => {
    const worker = queue(), flight = deferred<LiveInterviewSegment[]>()
    worker.adopt(finish(), [{ ...entry(), inFlight: flight.promise }]); await flush(); worker.dismiss('session-one')
    expect(worker.jobs).toHaveLength(1)
    flight.resolve([]); await flush(); worker.dismiss('session-one'); expect(worker.jobs).toHaveLength(0)
  })
  it('can finish in memory even when the browser cannot access IndexedDB at all', async () => {
    vi.mocked(savePendingAudio).mockRejectedValue(new Error('unsupported'))
    vi.mocked(removePendingAudio).mockRejectedValue(new Error('unsupported'))
    vi.mocked(removePendingFinish).mockRejectedValue(new Error('unsupported'))
    const worker = queue(); worker.adopt(finish(), [entry()]); await flush()
    expect(uploadLiveInterviewChunk).toHaveBeenCalledOnce(); expect(endLiveInterviewSession).toHaveBeenCalledOnce()
    expect(worker.jobs[0]!.phase).toBe('completed')
  })
  it('shows a summary-queue warning without incorrectly reporting that saved audio failed', async () => {
    vi.mocked(endLiveInterviewSession).mockResolvedValue({ status: 'completed', summaryGeneration: { queued: false, reason: '面试已保存，但总结任务创建失败' } } as never)
    const worker = queue(); worker.adopt(finish(), [entry()]); await flush()
    expect(worker.jobs[0]!.phase).toBe('completed'); expect(worker.jobs[0]!.message).toContain('总结任务创建失败')
  })
})
