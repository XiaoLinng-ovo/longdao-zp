import type { SpeakerSegment } from './role-mapper.js'
import { parseSpeakerSegments } from './asr-segments.js'

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

export function createFunAsrClient(config: FunAsrConfig, fetchImpl: FetchLike = fetch) {
  return { async transcribe(audio: Uint8Array, contentType = 'audio/webm'): Promise<SpeakerSegment[]> {
    let response: Response
    try { response = await fetchImpl(config.baseUrl, { method: 'POST', headers: { 'content-type': contentType, ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) }, body: Buffer.from(audio), signal: AbortSignal.timeout(config.timeoutMs) }) } catch (error) { throw new FunAsrError('UPSTREAM', 'FunASR request failed.', error) }
    if (!response.ok) throw new FunAsrError('UPSTREAM', `FunASR returned HTTP ${response.status}.`)
    let payload: unknown
    try { payload = await response.json() } catch (error) { throw new FunAsrError('INVALID_RESPONSE', 'FunASR response is not valid JSON.', error) }
    try { return parseSpeakerSegments(payload) } catch (error) { throw new FunAsrError('INVALID_RESPONSE', error instanceof Error ? error.message : 'FunASR response is invalid.', error) }
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
