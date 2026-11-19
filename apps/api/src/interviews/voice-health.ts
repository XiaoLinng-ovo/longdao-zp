import { loadFunAsrConfig, probeFunAsrService } from './funasr-client.js'
import { loadFasterWhisperConfig, probeFasterWhisperService } from './faster-whisper-client.js'

export type VoiceDependencyStatus = 'ok' | 'unavailable' | 'not_configured'
export function voiceCapabilities(funasr: VoiceDependencyStatus, fasterWhisper: VoiceDependencyStatus) {
  return {
    streaming: funasr === 'ok',
    chunks: funasr === 'ok',
    fullRecording: funasr === 'ok',
    secondaryReview: funasr === 'ok' && fasterWhisper === 'ok',
  }
}

export function createVoiceHealthProbe(ttlMs = 3000) {
  let cached: { key: string; expires: number; value: Promise<{ funasr: VoiceDependencyStatus; fasterWhisper: VoiceDependencyStatus; capabilities: ReturnType<typeof voiceCapabilities> }> } | undefined
  return (env: NodeJS.ProcessEnv = process.env) => {
    const key = JSON.stringify([env.FUNASR_BASE_URL, env.FUNASR_TOKEN, env.FUNASR_TIMEOUT_MS, env.FASTER_WHISPER_BASE_URL, env.FASTER_WHISPER_TOKEN, env.FASTER_WHISPER_TIMEOUT_MS])
    if (cached?.key === key && cached.expires > Date.now()) return cached.value
    const value = (async () => {
      const [funasr, fasterWhisper] = await Promise.all([
        (async (): Promise<VoiceDependencyStatus> => { try { return await probeFunAsrService(loadFunAsrConfig(env)) ? 'ok' : 'unavailable' } catch { return 'unavailable' } })(),
        (async (): Promise<VoiceDependencyStatus> => { if (!env.FASTER_WHISPER_BASE_URL?.trim()) return 'not_configured'; try { return await probeFasterWhisperService(loadFasterWhisperConfig(env)) ? 'ok' : 'unavailable' } catch { return 'unavailable' } })(),
      ])
      return { funasr, fasterWhisper, capabilities: voiceCapabilities(funasr, fasterWhisper) }
    })()
    cached = { key, expires: Date.now() + ttlMs, value }
    return value
  }
}
