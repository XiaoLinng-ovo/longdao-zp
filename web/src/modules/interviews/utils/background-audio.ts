import { reactive } from 'vue'
import { ApiClientError, ApiNetworkError } from '../../../shared/api'
import { getWorkspaceContext } from '../../../shared/api/workspace-context'
import { describeApiFailure } from '../../../shared/utils/errorMessage'
import { authSession } from '../../auth/session'
import { endLiveInterviewSession, uploadLiveInterviewChunk, type LiveInterviewSegment } from '../api'
import { removePendingAudio, removePendingFinish, restorePendingAudio, restorePendingFinishes, savePendingAudio, savePendingFinish, type PendingInterviewAudio, type PendingInterviewFinish } from './pending-audio'

export interface BackgroundAudioEntry {
  chunk: PendingInterviewAudio
  ready?: Promise<void>
  inFlight?: Promise<LiveInterviewSegment[]>
}
export interface BackgroundAudioJob extends PendingInterviewFinish {
  pending: number
  phase: 'uploading' | 'ending' | 'processing' | 'review_required' | 'failed' | 'completed'
  message: string
  cacheWarning: string
}
interface QueueContext { owner: string; revision: number }
interface Entry extends BackgroundAudioEntry { acknowledged?: boolean }
interface Work {
  state: BackgroundAudioJob
  entries: Entry[]
  prepared: Promise<void>
  running?: Promise<void>
  retryTimer?: ReturnType<typeof setTimeout>
  ended: boolean
  durable: boolean
  summaryWarning: string
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(reader.error ?? new Error('读取录音失败'))
    reader.readAsDataURL(blob)
  })
}
function retryable(cause: unknown) {
  return cause instanceof ApiClientError && cause.retryable !== false
    && (cause instanceof ApiNetworkError || cause.status === 429 || (cause.status ?? 0) >= 500)
}

// Only finished recordings are handed off. Active capture remains protected by the room's leave guard.
export function createBackgroundAudioQueue(context: () => QueueContext) {
  const jobs = reactive<BackgroundAudioJob[]>([])
  const work = new Map<string, Work>()
  let disposed = false
  let suspended = false
  const owns = (state: PendingInterviewFinish) => !!context().owner && state.scope === context().owner + ':' + state.interviewId
  const current = (item: Work, revision: number) => !disposed && !suspended && owns(item.state) && context().revision === revision

  function schedule(item: Work) {
    if (disposed || item.retryTimer) return
    item.retryTimer = setTimeout(() => { item.retryTimer = undefined; void run(item) }, 15_000)
  }
  async function run(item: Work): Promise<void> {
    if (disposed || suspended || item.running || item.state.phase === 'completed' || !owns(item.state)) return
    const revision = context().revision
    item.running = (async () => {
      await item.prepared
      if (!current(item, revision)) return
      item.state.phase = item.entries.length ? 'uploading' : 'ending'
      item.state.message = ''
      const failures: unknown[] = []
      await Promise.all(([undefined, 'microphone', 'meeting'] as const).map(async source => {
        try {
          while (current(item, revision)) {
            const entry = item.entries.find(row => row.chunk.audioSource?.id === source)
            if (!entry) return
            const chunk = entry.chunk
            if (!entry.acknowledged) {
              // Reuse an already-sent request so handing off never duplicates an in-flight upload.
              const request = entry.inFlight
              entry.inFlight = undefined
              if (request) await request
              else {
                const encoded = await base64(chunk.audio)
                if (!current(item, revision)) return
                await uploadLiveInterviewChunk(chunk.sessionId, encoded, chunk.contentType, chunk.offsetMs, chunk.id, chunk.streamingTranscript, chunk.audioSource, chunk.endMs)
              }
              if (!current(item, revision)) return
              entry.acknowledged = true
            }
            // Keep the durable finish intent and its unacknowledged chunks consistent on reload.
            if (chunk.scope) {
              try { await removePendingAudio(chunk.id) }
              catch { if (item.durable) throw new CacheCleanupError() }
            }
            if (!current(item, revision)) return
            item.entries.splice(item.entries.indexOf(entry), 1)
            item.state.pending = item.entries.length
          }
        } catch (cause) { failures.push(cause) }
      }))
      if (!current(item, revision)) return
      if (failures.length) throw failures.find(cause => !retryable(cause) && !(cause instanceof CacheCleanupError)) ?? failures[0]
      if (item.entries.length) return
      item.state.phase = 'ending'
      if (!item.ended) {
        const ended = await endLiveInterviewSession(item.state.id)
        if (!current(item, revision)) return
        if (ended.status !== 'completed') {
          item.state.phase = ended.completionReview?.phase === 'review_required' ? 'review_required' : 'processing'
          item.state.message = item.state.phase === 'review_required'
            ? '还有 ' + ended.completionReview!.unresolvedCount + ' 条说话角色待确认，请进入面试室复核。'
            : '录音已保存，正在自动整理转写和说话角色。'
          // Keep the durable finish intent until the server confirms final completion.
          if (item.state.phase === 'processing') schedule(item)
          return
        }
        item.summaryWarning = ended.summaryGeneration?.reason ?? ''
        item.ended = true
      }
      if (item.durable) {
        try { await removePendingFinish(item.state.id) }
        catch { throw new CacheCleanupError() }
      }
      if (!current(item, revision)) return
      item.state.phase = 'completed'
      item.state.message = item.summaryWarning
      item.state.cacheWarning = ''
    })().catch(cause => {
      if (!current(item, revision)) return
      item.state.phase = 'failed'
      item.state.message = describeApiFailure(cause, '后台保存失败').message
      if (retryable(cause) || cause instanceof CacheCleanupError) schedule(item)
    }).finally(() => {
      item.running = undefined
      // An account/workspace may have changed while the old request was in flight.
      if (!disposed && !suspended && owns(item.state) && revision !== context().revision) void run(item)
    })
    return item.running
  }

  function adopt(finish: PendingInterviewFinish, entries: BackgroundAudioEntry[], recovered = false) {
    const existing = work.get(finish.id)
    if (existing) return existing.state
    if (finish.scope !== context().owner + ':' + finish.interviewId || !context().owner) throw new Error('无法确认录音所属账号，暂不能交接后台保存')
    if (entries.some(entry => entry.chunk.scope !== finish.scope || entry.chunk.sessionId !== finish.id)) throw new Error('录音与会话不匹配，未转移上传队列')
    jobs.push({ ...finish, pending: entries.length, phase: 'uploading', message: '', cacheWarning: '' })
    const state = jobs[jobs.length - 1]!
    const item: Work = { state, entries: entries.map(entry => ({ ...entry })), prepared: Promise.resolve(), ended: false, durable: recovered, summaryWarning: '' }
    work.set(finish.id, item)
    // Observe rejections immediately even while IndexedDB/checkpoints are still being prepared.
    for (const entry of item.entries) void entry.inFlight?.catch(() => undefined)
    item.prepared = (async () => {
      if (recovered) return
      try {
        const writes = await Promise.allSettled(entries.map(async entry => { await entry.ready; await savePendingAudio(entry.chunk) }))
        if (writes.some(result => result.status === 'rejected')) throw new Error('录音缓存写入失败')
        await savePendingFinish(finish)
        item.durable = true
      } catch {
        state.cacheWarning = '本地缓存不可用，后台仍会上传，请勿刷新或关闭浏览器。'
      }
    })()
    void run(item)
    return state
  }
  async function recover() {
    const { owner, revision } = context()
    if (!owner || disposed || suspended) return
    const finishes = await restorePendingFinishes(owner)
    for (const finish of finishes) {
      if (disposed || suspended || revision !== context().revision || owner !== context().owner) return
      if (work.has(finish.id)) continue
      const chunks = await restorePendingAudio(finish.scope, finish.id)
      if (disposed || suspended || revision !== context().revision || owner !== context().owner) return
      adopt(finish, chunks.map(chunk => ({ chunk })), true)
    }
    retry()
  }
  function retry(id?: string) {
    for (const item of work.values()) {
      if (id && item.state.id !== id) continue
      if (item.retryTimer) clearTimeout(item.retryTimer)
      item.retryTimer = undefined
      void run(item)
    }
  }
  return {
    jobs, adopt, recover, retry,
    has: (scope: string, id: string) => work.get(id)?.state.scope === scope,
    dismiss(id: string) {
      const item = work.get(id)
      if (item?.state.phase !== 'completed') return
      jobs.splice(jobs.indexOf(item.state), 1)
      work.delete(id)
    },
    suspend() { suspended = true },
    dispose() { disposed = true; for (const item of work.values()) if (item.retryTimer) clearTimeout(item.retryTimer) },
  }
}
class CacheCleanupError extends Error {
  constructor() { super('本地录音缓存清理失败，将自动重试，请勿清理浏览器数据。') }
}

export function backgroundAudioContext(): QueueContext {
  const workspace = getWorkspaceContext()
  return { owner: workspace.workspaceId && authSession.user?.id ? workspace.workspaceId + ':' + authSession.user.id : '', revision: workspace.revision }
}
export const backgroundAudio = createBackgroundAudioQueue(backgroundAudioContext)
