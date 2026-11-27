/**
 * AI 模型连接的配置、视图与连通性自检。
 *
 * 平台配置由 PostgreSQL 存储；密钥为写入专用，
 * 读取接口只返回掩码，绝不回显密钥原文。
 */

import { assertAiEndpointAllowed, normalizeAiBaseUrl } from '@smartrecruit-pro/enterprise-ai'
import { readModelJsonResponse } from '../ai/model-http-error.js'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export const AI_ENV_KEYS = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_TIMEOUT_MS'] as const
export type AiEnvKey = typeof AI_ENV_KEYS[number]
export type AiEnvPatch = Partial<Record<AiEnvKey, string>>
export interface AiEnvSetting { value: string; configured: boolean; masked: boolean }
export type AiEnvSettings = Record<AiEnvKey, AiEnvSetting>

export interface AiSettingsView {
  configured: boolean
  baseUrlHost: string
  model: string
  timeoutMs: number
  apiKeyConfigured: boolean
  missing: string[]
}

export interface AiConnectionTestResult {
  ok: boolean
  status?: number
  message: string
  latencyMs: number
  models: string[]
}

export interface AiConnectionTestInput {
  baseUrl?: string
  apiKey?: string
  timeoutMs?: number
}

export interface AiGenerationTestResult { ok: boolean; code: string | null; status?: number; model: string; latencyMs: number }

/** No draft credentials or provider response text is ever returned or logged. */
export async function testAiGeneration(env: NodeJS.ProcessEnv, fetchImpl: FetchLike = fetch): Promise<AiGenerationTestResult> {
  const started = Date.now(), model = env.OPENAI_MODEL ?? ''
  const result = (ok: boolean, code: string | null, status?: number): AiGenerationTestResult => ({ok,code,model,latencyMs:Date.now()-started,...(status ? {status} : {})})
  if (!readAiSettings(env).configured) return result(false,'PLATFORM_AI_NOT_CONFIGURED')
  try {
    assertAiEndpointAllowed(env.OPENAI_BASE_URL ?? '')
    const response = await fetchImpl(normalizeAiBaseUrl(env.OPENAI_BASE_URL) + '/chat/completions', {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(Math.min(120000,Number(env.OPENAI_TIMEOUT_MS)||120000)),
      headers:{Authorization:'Bearer '+env.OPENAI_API_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({model,messages:[{role:'user',content:'Reply with OK.'}],max_tokens:1024,stream:false}),
    })
    if (!response.ok) { await response.body?.cancel(); return result(false,'AI_PROVIDER_HTTP_ERROR',response.status) }
    const payload = await readModelJsonResponse(response) as {choices?: Array<{message?:{content?:unknown}}>}
    if (typeof payload?.choices?.[0]?.message?.content !== 'string' || !payload.choices[0].message.content.trim()) return result(false,'AI_PROVIDER_INVALID_RESPONSE',response.status)
    return result(true,null,response.status)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    return result(false, /^AI_(ENDPOINT|SECRET|ENCRYPTION)/.test(code) ? code : 'AI_PROVIDER_UNAVAILABLE')
  }
}

export interface AiSettingsResponse extends AiSettingsView {
  env: AiEnvSettings
}

const DEFAULT_TIMEOUT_MS = 30000
const MAX_TEST_TIMEOUT_MS = 15000

function text(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

/** 丢弃用户名/密码、查询串与端口之外的细节，只保留协议、主机与路径。 */
export function describeBaseUrlHost(baseUrl: string | undefined): string {
  const value = text(baseUrl)
  if (!value) return ''
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, '')}`
  } catch {
    return '地址格式无效'
  }
}

function isValidUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function readAiSettings(env: NodeJS.ProcessEnv = {}): AiSettingsView {
  const baseUrl = text(env.OPENAI_BASE_URL)
  const apiKey = text(env.OPENAI_API_KEY)
  const model = text(env.OPENAI_MODEL)
  const timeoutMs = Number(text(env.OPENAI_TIMEOUT_MS) ?? String(DEFAULT_TIMEOUT_MS))
  const timeoutValid = Number.isInteger(timeoutMs) && timeoutMs > 0
  const missing = [
    ...(isValidUrl(baseUrl) ? [] : ['OPENAI_BASE_URL']),
    ...(apiKey ? [] : ['OPENAI_API_KEY']),
    ...(model ? [] : ['OPENAI_MODEL']),
    ...(timeoutValid ? [] : ['OPENAI_TIMEOUT_MS']),
  ]
  return {
    configured: missing.length === 0,
    baseUrlHost: describeBaseUrlHost(baseUrl),
    model: model ?? '',
    timeoutMs: timeoutValid ? timeoutMs : 0,
    apiKeyConfigured: Boolean(apiKey),
    missing,
  }
}

function readModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const ids = data
    .map((item) => (item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
  return [...new Set(ids)]
}

/** 把 undici 的 "fetch failed" 还原成可诊断的原因，否则运维只能看到一句无信息量的报错。 */
export function describeFetchFailure(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } })?.cause
  const code = typeof cause?.code === 'string' ? cause.code : undefined
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '无法解析接口地址的域名（DNS 不可用或域名不存在）'
    case 'ECONNREFUSED':
      return '目标地址拒绝连接（端口未开放或被防火墙拦截）'
    case 'ECONNRESET':
      return '连接被对端重置'
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return '连接超时（网络不可达）'
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return 'HTTPS 证书校验失败'
    default:
      break
  }
  const detail = typeof cause?.message === 'string' && cause.message.trim() ? cause.message.trim() : (error as Error).message
  return code ? `${detail}（${code}）` : detail
}

/**
 * 用给定的连接拉取模型列表；未传地址或密钥时使用调用方提供的数据库配置。
 * 允许传参是为了支持「先填地址和密钥测试、再选择模型保存」的后台流程。
 */
export async function testAiConnection(
  input: AiConnectionTestInput = {},
  env: NodeJS.ProcessEnv = {},
  fetchImpl: FetchLike = fetch,
): Promise<AiConnectionTestResult> {
  const rawBaseUrl = text(input.baseUrl) ?? text(env.OPENAI_BASE_URL) ?? ''
  const apiKey = text(input.apiKey) ?? text(env.OPENAI_API_KEY)
  if (!rawBaseUrl) return { ok: false, message: '请先填写接口地址', latencyMs: 0, models: [] }
  if (!isValidUrl(rawBaseUrl)) return { ok: false, message: '接口地址必须是 http 或 https 开头的合法地址', latencyMs: 0, models: [] }
  if (!apiKey) return { ok: false, message: '请先填写 API 密钥', latencyMs: 0, models: [] }
  const configuredTimeout = input.timeoutMs ?? Number(text(env.OPENAI_TIMEOUT_MS) ?? String(DEFAULT_TIMEOUT_MS))
  const timeoutMs = Math.min(Number.isInteger(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : DEFAULT_TIMEOUT_MS, MAX_TEST_TIMEOUT_MS)
  const startedAt = Date.now()
  try {
    const baseUrl = normalizeAiBaseUrl(rawBaseUrl)
    const response = await fetchImpl(`${baseUrl}/models`, {
      method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const latencyMs = Date.now() - startedAt
    if (!response.ok) return { ok: false, status: response.status, message: `模型服务返回 HTTP ${response.status}`, latencyMs, models: [] }
    const payload = await readModelJsonResponse(response)
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) {
      return { ok: false, status: response.status, message: '模型服务未返回有效的模型列表，请检查 API 接口地址；HTTP 200 不代表模型接口可用。', latencyMs, models: [] }
    }
    const models = readModelIds(payload)
    return { ok: true, status: response.status, message: models.length ? `连接正常，发现 ${models.length} 个可用模型` : '连接正常，但服务未返回模型列表', latencyMs, models }
  } catch (error) {
    return { ok: false, message: `连接失败：${describeFetchFailure(error)}`, latencyMs: Date.now() - startedAt, models: [] }
  }
}
