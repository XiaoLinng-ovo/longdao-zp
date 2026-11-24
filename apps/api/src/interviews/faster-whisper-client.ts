import type { SpeakerSegment } from './role-mapper.js'
import { parseSpeakerSegments } from './asr-segments.js'

export interface FasterWhisperConfig { baseUrl: string; token?: string; timeoutMs: number }
export class FasterWhisperError extends Error {
  constructor(public readonly code: 'NOT_CONFIGURED' | 'UPSTREAM' | 'INVALID_RESPONSE', message: string, public readonly cause?: unknown) {
    super(message); this.name = 'FasterWhisperError'
  }
}
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export function loadFasterWhisperConfig(env: NodeJS.ProcessEnv = process.env): FasterWhisperConfig {
  const baseUrl = env.FASTER_WHISPER_BASE_URL?.trim()
  const timeoutMs = Number(env.FASTER_WHISPER_TIMEOUT_MS ?? '120000')
  if (!baseUrl) throw new FasterWhisperError('NOT_CONFIGURED', 'FASTER_WHISPER_BASE_URL is not configured.')
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new FasterWhisperError('NOT_CONFIGURED', 'FASTER_WHISPER_TIMEOUT_MS must be a positive integer.')
  try { new URL(baseUrl) } catch (error) { throw new FasterWhisperError('NOT_CONFIGURED', 'FASTER_WHISPER_BASE_URL must be a valid URL.', error) }
  return { baseUrl, timeoutMs, ...(env.FASTER_WHISPER_TOKEN?.trim() ? { token: env.FASTER_WHISPER_TOKEN.trim() } : {}) }
}

export function createFasterWhisperClient(config: FasterWhisperConfig, fetchImpl: FetchLike = fetch) {
  return { async transcribe(audio: Uint8Array, contentType = 'audio/webm'): Promise<SpeakerSegment[]> {
    let response: Response
    try {
      response = await fetchImpl(config.baseUrl, { method: 'POST', headers: { 'content-type': contentType, ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) }, body: Buffer.from(audio), signal: AbortSignal.timeout(config.timeoutMs) })
    } catch (error) { throw new FasterWhisperError('UPSTREAM', 'faster-whisper request failed.', error) }
    if (!response.ok) throw new FasterWhisperError('UPSTREAM', `faster-whisper returned HTTP ${response.status}.`)
    let payload: unknown
    try { payload = await response.json() } catch (error) { throw new FasterWhisperError('INVALID_RESPONSE', 'faster-whisper response is not valid JSON.', error) }
    try { return parseSpeakerSegments(payload) } catch (error) { throw new FasterWhisperError('INVALID_RESPONSE', error instanceof Error ? error.message : 'faster-whisper response is invalid.', error) }
  } }
}

export async function probeFasterWhisperService(config: FasterWhisperConfig, fetchImpl: FetchLike = fetch, probeTimeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetchImpl(new URL('/health', config.baseUrl), { method: 'GET', headers: config.token ? { authorization: `Bearer ${config.token}` } : {}, signal: AbortSignal.timeout(Math.max(1, Math.min(config.timeoutMs, probeTimeoutMs))) })
    return response.ok
  } catch { return false }
}
