import type { SpeakerSegment } from './role-mapper.js'

export interface FunAsrConfig { baseUrl: string; token?: string; timeoutMs: number }
export class FunAsrError extends Error { constructor(public readonly code: 'NOT_CONFIGURED' | 'UPSTREAM' | 'INVALID_RESPONSE', message: string, public readonly cause?: unknown) { super(message); this.name = 'FunAsrError' } }
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export function loadFunAsrConfig(env: NodeJS.ProcessEnv = process.env): FunAsrConfig {
  const baseUrl = env.FUNASR_BASE_URL?.trim()
  const timeoutMs = Number(env.FUNASR_TIMEOUT_MS ?? '30000')
  if (!baseUrl || !Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new FunAsrError('NOT_CONFIGURED', 'FUNASR_BASE_URL and FUNASR_TIMEOUT_MS are required.')
  try { new URL(baseUrl) } catch (error) { throw new FunAsrError('NOT_CONFIGURED', 'FUNASR_BASE_URL must be a valid URL.', error) }
  return { baseUrl, timeoutMs, ...(env.FUNASR_TOKEN?.trim() ? { token: env.FUNASR_TOKEN.trim() } : {}) }
}

function toSegment(value: unknown): SpeakerSegment | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const text = typeof row.text === 'string' ? row.text.trim() : typeof row.sentence === 'string' ? row.sentence.trim() : ''
  const speakerId = typeof row.speakerId === 'string' ? row.speakerId : typeof row.spk === 'string' || typeof row.spk === 'number' ? `speaker_${row.spk}` : ''
  const startMs = Number(row.startMs ?? row.start ?? 0); const endMs = Number(row.endMs ?? row.end ?? 0)
  if (!text || !speakerId || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined
  return { id: typeof row.id === 'string' ? row.id : `${speakerId}:${startMs}`, speakerId, text, startMs, endMs }
}

export function createFunAsrClient(config: FunAsrConfig, fetchImpl: FetchLike = fetch) {
  return { async transcribe(audio: Uint8Array, contentType = 'audio/webm'): Promise<SpeakerSegment[]> {
    let response: Response
    try { response = await fetchImpl(config.baseUrl, { method: 'POST', headers: { 'content-type': contentType, ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) }, body: Buffer.from(audio), signal: AbortSignal.timeout(config.timeoutMs) }) } catch (error) { throw new FunAsrError('UPSTREAM', 'FunASR request failed.', error) }
    if (!response.ok) throw new FunAsrError('UPSTREAM', `FunASR returned HTTP ${response.status}.`)
    let payload: unknown
    try { payload = await response.json() } catch (error) { throw new FunAsrError('INVALID_RESPONSE', 'FunASR response is not valid JSON.', error) }
    const rows = Array.isArray(payload) ? payload : payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).segments) ? (payload as Record<string, unknown>).segments : payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).result) ? (payload as Record<string, unknown>).result : undefined
    if (!Array.isArray(rows)) throw new FunAsrError('INVALID_RESPONSE', 'FunASR response has no segments.')
    const segments = rows.map(toSegment)
    if (segments.some((item) => !item)) throw new FunAsrError('INVALID_RESPONSE', 'FunASR response contains an invalid segment.')
    return segments as SpeakerSegment[]
  } }
}

/**
 * FunASR 的正式接口是 POST /transcribe，GET 返回 405 也说明网络链路可达。
 * readiness 只关心服务是否在线，不能把“配置存在”误判成“服务可用”。
 */
export async function probeFunAsrService(
  config: FunAsrConfig,
  fetchImpl: FetchLike = fetch,
  probeTimeoutMs = 1500,
): Promise<boolean> {
  try {
    await fetchImpl(config.baseUrl, {
      method: 'GET',
      headers: config.token ? { authorization: `Bearer ${config.token}` } : {},
      signal: AbortSignal.timeout(Math.max(1, Math.min(config.timeoutMs, probeTimeoutMs))),
    })
    return true
  } catch {
    return false
  }
}
