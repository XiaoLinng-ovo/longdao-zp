import { createHash } from 'node:crypto'
import type { ObjectStorage } from '@smartrecruit-pro/object-storage'

function extensionFor(contentType: string): string {
  contentType = contentType.split(';')[0]!.trim().toLowerCase()
  if (contentType === 'audio/webm') return 'webm'
  if (contentType === 'audio/ogg') return 'ogg'
  if (contentType === 'audio/wav' || contentType === 'audio/x-wav') return 'wav'
  if (contentType === 'audio/mpeg') return 'mp3'
  if (contentType === 'audio/mp4') return 'm4a'
  return 'bin'
}

export function createLiveInterviewAudioStorage(storage: ObjectStorage) {
  return {
    async store(sessionId: string, audio: Uint8Array, contentType: string, offsetMs: number, source?: 'microphone' | 'meeting'): Promise<string> {
      const safeOffset = Number.isFinite(offsetMs) && offsetMs >= 0 ? Math.floor(offsetMs) : 0
      const digest = createHash('sha256').update(audio).digest('hex')
      const key = `interviews/${sessionId}/audio/${source ? source + '/' : ''}${safeOffset}-${digest}.${extensionFor(contentType)}`
      await storage.put(key, audio, contentType)
      return key
    },
    async read(key: string): Promise<Buffer> { return storage.get(key) },
    async write(key: string, audio: Uint8Array, contentType: string): Promise<void> { await storage.put(key, audio, contentType) },
  }
}
