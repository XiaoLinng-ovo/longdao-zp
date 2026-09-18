import { randomUUID } from 'node:crypto'
import type { ObjectStorage } from '@smartrecruit-pro/object-storage'

function extensionFor(contentType: string): string {
  if (contentType === 'audio/webm') return 'webm'
  if (contentType === 'audio/ogg') return 'ogg'
  if (contentType === 'audio/wav' || contentType === 'audio/x-wav') return 'wav'
  if (contentType === 'audio/mpeg') return 'mp3'
  return 'bin'
}

export function createLiveInterviewAudioStorage(storage: ObjectStorage) {
  return {
    async store(sessionId: string, audio: Uint8Array, contentType: string, offsetMs: number): Promise<string> {
      const safeOffset = Number.isInteger(offsetMs) && offsetMs >= 0 ? offsetMs : 0
      const key = `interviews/${sessionId}/audio/${safeOffset}-${randomUUID()}.${extensionFor(contentType)}`
      await storage.put(key, audio, contentType)
      return key
    },
  }
}
