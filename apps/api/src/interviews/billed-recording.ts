import { createHash } from 'node:crypto'
import { meterInterviewAudio } from '@smartrecruit-pro/enterprise-ai'
import { FULL_AUDIO_CHUNK_SECONDS, wavDurationMs, type RecordedChunkMeter } from './full-audio-transcription.js'

/** Share session time coverage with live ASR, while caching each route's own result. */
export function billedRecordingChunks(env: NodeJS.ProcessEnv, sessionId: string, route: string): RecordedChunkMeter {
  return (audio, index, action) => {
    const duration = wavDurationMs(audio)
    if (duration <= 0 || duration > FULL_AUDIO_CHUNK_SECONDS * 1000 + 1000) {
      return Promise.reject(new Error('离线转写音频时长无效，未调用模型'))
    }
    const startMs = index * FULL_AUDIO_CHUNK_SECONDS * 1000
    const digest = createHash('sha256').update(audio).digest('hex')
    return meterInterviewAudio(env, 'recording:' + sessionId + ':' + route + ':' + index + ':' + digest,
      { sessionId, startMs, endMs: startMs + duration }, action)
  }
}
