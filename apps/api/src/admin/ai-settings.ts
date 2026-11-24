/**
 * AI 模型连接的配置、视图与连通性自检。
 *
 * 地址、模型与超时可在管理后台维护并写入 .env；密钥为写入专用，
 * 读取接口只返回掩码，绝不回显密钥原文。
 */

import { normalizeAiBaseUrl } from '@smartrecruit-pro/enterprise-ai'
import { readModelJsonResponse } from '../ai/model-http-error.js'
import { readEnvValues, resolveEnvFilePath, writeEnvFile } from './env-file.js'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export const AI_ENV_KEYS = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_TIMEOUT_MS'] as const
export type AiEnvKey = typeof AI_ENV_KEYS[number]
export type AiEnvPatch = Partial<Record<AiEnvKey, string>>
export interface AiEnvSetting { value: string; configured: boolean; masked: boolean }
export type AiEnvSettings = Record<AiEnvKey, AiEnvSetting>

const SECRET_AI_KEYS = new Set<AiEnvKey>(['OPENAI_API_KEY'])

export class AiSettingsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiSettingsValidationError'
  }
}

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

export function readAiSettings(env: NodeJS.ProcessEnv = process.env): AiSettingsView {
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

function maskSecret(value: string): string {
  if (!value) return ''
  if (value.length <= 4) return '••••'
  return `${value.slice(0, 2)}••••${value.slice(-2)}`
}

/** 表单用的原始值：密钥只返回掩码，其余原样返回，便于管理员看到当前连接。 */
export async function readAiEnvSettings(filePath = resolveEnvFilePath()): Promise<AiEnvSettings> {
  const values = await readEnvValues(filePath)
  return Object.fromEntries(AI_ENV_KEYS.map((key) => {
    const value = values.get(key) ?? ''
    const masked = SECRET_AI_KEYS.has(key)
    return [key, { value: masked ? maskSecret(value) : value, configured: Boolean(value), masked }]
  })) as AiEnvSettings
}

function validateAiPatch(patch: AiEnvPatch): void {
  for (const [key, value] of Object.entries(patch)) {
    if (!(AI_ENV_KEYS as readonly string[]).includes(key)) throw new AiSettingsValidationError(`不支持的模型配置项：${key}`)
    if (typeof value !== 'string') throw new AiSettingsValidationError(`${key} 必须是字符串`)
    if (/[\r\n]/u.test(value)) throw new AiSettingsValidationError(`${key} 不能包含换行符`)
  }
  const baseUrl = patch.OPENAI_BASE_URL?.trim()
  if (baseUrl) {
    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch {
      throw new AiSettingsValidationError('接口地址必须是合法地址')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new AiSettingsValidationError('接口地址只支持 http 或 https')
    if (parsed.username || parsed.password) throw new AiSettingsValidationError('接口地址不能包含用户名或密码')
  }
  const timeout = patch.OPENAI_TIMEOUT_MS?.trim()
  if (timeout && (!Number.isInteger(Number(timeout)) || Number(timeout) <= 0)) throw new AiSettingsValidationError('超时必须是正整数（毫秒）')
}

/** 写入 .env 并立即作用于当前进程，保存后无需重启即可用于生成与自检。 */
export async function updateAiEnvSettings(filePath = resolveEnvFilePath(), patch: AiEnvPatch): Promise<AiEnvSettings> {
  validateAiPatch(patch)
  await writeEnvFile(filePath, patch)
  return readAiEnvSettings(filePath)
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
 * 用给定的连接拉取模型列表；未传地址或密钥时回落到进程环境。
 * 允许传参是为了支持「先填地址和密钥测试、再选择模型保存」的后台流程。
 */
export async function testAiConnection(
  input: AiConnectionTestInput = {},
  env: NodeJS.ProcessEnv = process.env,
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
