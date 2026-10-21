import type { InterviewAudioSource, InterviewAudioSourceConfig } from './audio-capture'

export interface PendingInterviewAudio {
  audioSource?: InterviewAudioSourceConfig
  id: string
  scope: string
  sessionId: string
  audio: Blob
  contentType: string
  offsetMs: number
  endMs: number
  streamingTranscript?: { text: string; endMs: number; complete: boolean; audioSource?: InterviewAudioSource }
}

// Store only unacknowledged audio. Scope includes both tenant and user identity.
async function database(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw new Error('浏览器不支持本地录音缓存')
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('smartrecruit-pending-interview-audio', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('chunks', { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('本地录音缓存被其他页面占用'))
  })
}

async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('chunks', mode)
      const request = action(tx.objectStore('chunks'))
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error ?? new Error('本地录音缓存写入失败'))
      tx.onerror = () => reject(tx.error ?? request.error)
    })
  } finally { db.close() }
}

export async function savePendingAudio(chunk: PendingInterviewAudio): Promise<void> {
  if (!chunk.scope) throw new Error('无法确认当前用户，录音仅保留在当前页面')
  await transaction('readwrite', store => store.put(chunk))
}
export async function removePendingAudio(id: string): Promise<void> {
  await transaction('readwrite', store => store.delete(id))
}
export async function restorePendingAudio(scope: string, sessionId: string): Promise<PendingInterviewAudio[]> {
  if (!scope) return []
  const rows = await transaction('readonly', store => store.getAll()) as PendingInterviewAudio[]
  return rows.filter(row => row.scope === scope && row.sessionId === sessionId).sort((a, b) => a.offsetMs - b.offsetMs)
}

export function hasSubstantiveAnswer(text: string): boolean {
  const content = text.replace(/[\p{P}\p{Z}\s]/gu, '')
  return content.length >= 4 && !/^[嗯啊哦呃唔哇呀哈额]+$/.test(content)
}
