import type { SpeakerSegment } from './role-mapper.js'
import { parseSpeakerSegments } from './asr-segments.js'
import { runtimeFetch } from '@smartrecruit-pro/runtime-lifecycle'

export interface FunAsrConfig { baseUrl: string; token?: string; timeoutMs: number }
export class FunAsrError extends Error { constructor(public readonly code: 'NOT_CONFIGURED' | 'UPSTREAM' | 'ASR_HTTP_ERROR' | 'TIMEOUT' | 'INVALID_RESPONSE', message: string, public readonly cause?: unknown) { super(message); this.name = 'FunAsrError' } }
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export function loadFunAsrConfig(env: NodeJS.ProcessEnv = process.env): FunAsrConfig {
  const baseUrl = env.FUNASR_BASE_URL?.trim()
  const timeoutMs = Number(env.FUNASR_TIMEOUT_MS ?? '30000')
  if (!baseUrl || !Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new FunAsrError('NOT_CONFIGURED', 'FUNASR_BASE_URL and FUNASR_TIMEOUT_MS are required.')
  try { new URL(baseUrl) } catch (error) { throw new FunAsrError('NOT_CONFIGURED', 'FUNASR_BASE_URL must be a valid URL.', error) }
  return { baseUrl, timeoutMs, ...(env.FUNASR_TOKEN?.trim() ? { token: env.FUNASR_TOKEN.trim() } : {}) }
}

export function createFunAsrClient(config: FunAsrConfig, fetchImpl: FetchLike = runtimeFetch) {
  return { async transcribe(audio: Uint8Array, contentType = 'audio/webm'): Promise<SpeakerSegment[]> {
    const signal = AbortSignal.timeout(config.timeoutMs)
    let response: Response
    try { response = await fetchImpl(config.baseUrl, { method: 'POST', headers: { 'content-type': contentType, ...(config.token ? { authorization: 'Bearer ' + config.token } : {}) }, body: Buffer.from(audio), signal }) } catch (error) {
      if (signal.aborted) throw new FunAsrError('TIMEOUT', '语音转写服务响应超时，请稍后重试。', error)
      throw new FunAsrError('UPSTREAM', '无法连接语音转写服务，请检查服务后重试。', error)
    }
    if (!response.ok) throw new FunAsrError('ASR_HTTP_ERROR', '语音转写服务返回 HTTP ' + response.status + '，请稍后重试。')
    let payload: unknown
    try { payload = await response.json() } catch (error) {
      if (signal.aborted) throw new FunAsrError('TIMEOUT', '读取语音转写结果超时，请稍后重试。', error)
      throw new FunAsrError('INVALID_RESPONSE', '语音转写服务返回了无效结果。', error)
    }
    try { return parseSpeakerSegments(payload) } catch (error) { throw new FunAsrError('INVALID_RESPONSE', error instanceof Error ? error.message : 'FunASR response is invalid.', error) }
  } }
}

/**
 * FunASR 的正式接口是 POST /transcribe，GET 返回 405 也说明网络链路可达。
 * readiness 只关心服务是否在线，不能把“配置存在”误判成“服务可用”。
 */
export async function probeFunAsrService(
  config: FunAsrConfig,
  fetchImpl: FetchLike = runtimeFetch,
  probeTimeoutMs = 1500,
): Promise<boolean> {
  try {
    const response = await fetchImpl(config.baseUrl, {
      method: 'GET',
      headers: config.token ? { authorization: `Bearer ${config.token}` } : {},
      signal: AbortSignal.timeout(Math.max(1, Math.min(config.timeoutMs, probeTimeoutMs))),
    })
    // The transcribe endpoint commonly answers GET with 405. That still proves
    // the service is reachable, while server errors mean it is not ready.
    return response.ok || response.status === 405
  } catch {
    return false
  }
}
