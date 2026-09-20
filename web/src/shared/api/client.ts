import {
  ApiAbortError,
  ApiAuthenticationError,
  ApiClientError,
  ApiForbiddenError,
  ApiHttpError,
  ApiNetworkError,
  ApiParseError,
  ApiProtocolError,
  ApiRequestSerializationError,
  ApiResponseError,
} from './errors'
import type {
  ApiClient,
  ApiClientOptions,
  ApiErrorPayload,
  ApiResponse,
  ApiSuccessResponse,
  JsonHttpMethod,
  JsonRequestOptions,
} from './types'

export const DEFAULT_API_BASE_URL = '/api/v1'
export const DEFAULT_REQUEST_ID_HEADER = 'x-request-id'

const JSON_ACCEPT = 'application/json'
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value)
}

/**
 * 将相对业务路径拼到 API 根路径；允许调用方传入 /health 或 health。
 * 已经包含 baseUrl 路径的相对地址不会重复拼接，便于迁移旧适配器。
 */
export function resolveApiUrl(baseUrl: string, path: string): string {
  const normalizedBase = trimTrailingSlashes(baseUrl.trim())
  const normalizedPath = path.trim()

  if (normalizedPath === '') {
    return normalizedBase || '/'
  }

  if (isAbsoluteUrl(normalizedPath)) {
    return normalizedPath
  }

  const pathWithLeadingSlash = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`
  if (normalizedBase === '' || normalizedBase === '/') {
    return pathWithLeadingSlash
  }

  if (isAbsoluteUrl(normalizedBase)) {
    const base = new URL(normalizedBase)
    const basePath = trimTrailingSlashes(base.pathname)
    const pathAlreadyIncludesBase =
      pathWithLeadingSlash === basePath || pathWithLeadingSlash.startsWith(`${basePath}/`)

    if (pathAlreadyIncludesBase) {
      return `${base.origin}${pathWithLeadingSlash}`
    }

    return `${normalizedBase}${pathWithLeadingSlash}`
  }

  if (pathWithLeadingSlash === normalizedBase || pathWithLeadingSlash.startsWith(`${normalizedBase}/`)) {
    return pathWithLeadingSlash
  }

  return `${normalizedBase}${pathWithLeadingSlash}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readRequestId(response: Response, payload: unknown, requestIdHeader: string): string | undefined {
  const headerRequestId = response.headers.get(requestIdHeader) ?? response.headers.get(DEFAULT_REQUEST_ID_HEADER)
  if (headerRequestId) return headerRequestId

  if (isRecord(payload)) {
    return readString(payload.requestId)
  }

  return undefined
}

function readApiErrorPayload(payload: unknown): ApiErrorPayload | undefined {
  if (!isRecord(payload)) return undefined

  const possibleError = payload.error
  if (!isRecord(possibleError)) return undefined

  const code = readString(possibleError.code)
  const message = readString(possibleError.message)
  if (!code || !message) return undefined

  return {
    code,
    message,
    ...(possibleError.details !== undefined ? { details: possibleError.details } : {}),
    ...(Array.isArray(possibleError.fieldErrors) ? { fieldErrors: possibleError.fieldErrors as ApiErrorPayload['fieldErrors'] } : {}),
    ...(typeof possibleError.retryable === 'boolean' ? { retryable: possibleError.retryable } : {}),
  }
}

function isApiSuccessResponse<T>(payload: unknown): payload is ApiSuccessResponse<T> {
  return isRecord(payload) && payload.ok === true && 'data' in payload
}

function isApiErrorResponse(payload: unknown): boolean {
  return isRecord(payload) && payload.ok === false
}

function defaultHttpMessage(status: number): string {
  if (status === 401) return '登录状态已失效，请重新登录'
  if (status === 403) return '当前账号没有执行此操作的权限'
  return `请求失败（HTTP ${status}）`
}

function makeApiError(
  response: Response,
  payload: unknown,
  requestId: string | undefined,
): ApiClientError {
  const apiError = readApiErrorPayload(payload)
  const status = response.status
  const errorOptions = {
    status,
    code: apiError?.code ?? (status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : 'HTTP_ERROR'),
    requestId,
    details: apiError?.details,
    fieldErrors: apiError?.fieldErrors,
    retryable: apiError?.retryable,
  }
  const message = apiError?.message ?? defaultHttpMessage(status)

  if (status === 401) {
    return new ApiAuthenticationError(message, errorOptions)
  }

  if (status === 403) {
    return new ApiForbiddenError(message, errorOptions)
  }

  if (isApiErrorResponse(payload)) {
    return new ApiResponseError(message, errorOptions)
  }

  return new ApiHttpError(message, errorOptions)
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError'
}

function createHeaders(
  defaultHeaders: HeadersInit | undefined,
  requestHeaders: HeadersInit | undefined,
  hasBody: boolean,
): Headers {
  const headers = new Headers(defaultHeaders)
  new Headers(requestHeaders).forEach((value, key) => headers.set(key, value))

  if (!headers.has('accept')) headers.set('accept', JSON_ACCEPT)
  if (hasBody && !headers.has('content-type')) headers.set('content-type', JSON_CONTENT_TYPE)

  return headers
}

function serializeBody(body: unknown): string | undefined {
  if (body === undefined) return undefined

  try {
    const serialized = JSON.stringify(body)
    // JSON.stringify(undefined) is possible for values such as functions or symbols.
    if (serialized === undefined) return undefined
    return serialized
  } catch (cause) {
    throw new ApiRequestSerializationError('请求数据无法序列化为 JSON', { cause })
  }
}

async function parseJsonBody(response: Response, requestId: string | undefined): Promise<unknown> {
  let text: string
  try {
    text = await response.text()
  } catch (cause) {
    throw new ApiNetworkError('读取服务响应失败，请稍后重试', {
      status: response.status,
      requestId,
      cause,
    })
  }

  if (text.trim() === '') return undefined

  try {
    return JSON.parse(text) as unknown
  } catch (cause) {
    throw new ApiParseError('服务返回了无法解析的 JSON', {
      status: response.status,
      requestId,
      cause,
    })
  }
}

function requireRequestId(payload: unknown, response: Response, requestIdHeader: string): string {
  return readRequestId(response, payload, requestIdHeader) ?? ''
}

function isSuccessfulStatus(response: Response): boolean {
  return response.status >= 200 && response.status < 300
}

function createFetchUnavailableError(): ApiNetworkError {
  return new ApiNetworkError('当前运行环境不支持 fetch，请检查前端运行时配置', { retryable: false })
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
let csrfToken: string | undefined
let csrfInFlight: Promise<string | undefined> | null = null

async function fetchCsrfToken(): Promise<string | undefined> {
  try {
    const response = await fetch('/api/v1/auth/csrf', { credentials: 'include' })
    if (!response.ok) return undefined
    const payload: unknown = await response.json()
    const token = isRecord(payload) && isRecord(payload.data) && typeof payload.data.token === 'string' ? payload.data.token : undefined
    if (token) csrfToken = token
    return token
  } catch {
    return undefined
  }
}

function ensureCsrfToken(): Promise<string | undefined> {
  if (csrfToken) return Promise.resolve(csrfToken)
  if (!csrfInFlight) csrfInFlight = fetchCsrfToken().finally(() => { csrfInFlight = null })
  return csrfInFlight
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? DEFAULT_API_BASE_URL
  const requestIdHeader = options.requestIdHeader ?? DEFAULT_REQUEST_ID_HEADER
  const credentials = options.credentials ?? 'include'

  const requestJson = async <T>(path: string, requestOptions: JsonRequestOptions = {}): Promise<ApiSuccessResponse<T>> => {
    const { method = 'GET', body, headers: requestHeaders, ...fetchOptions } = requestOptions
    const url = resolveApiUrl(baseUrl, path)
    const fetcher = options.fetcher ?? globalThis.fetch
    if (typeof fetcher !== 'function') throw createFetchUnavailableError()

    const isWrite = WRITE_METHODS.has((method ?? 'GET').toUpperCase())
    const serializedBody = serializeBody(body)

    const execute = async (): Promise<ApiSuccessResponse<T>> => {
      const headers = createHeaders(options.defaultHeaders, requestHeaders, serializedBody !== undefined)
      if (isWrite) {
        const token = await ensureCsrfToken()
        if (token) headers.set('x-csrf-token', token)
      }
      const requestInit: RequestInit = {
        ...fetchOptions,
        method,
        headers,
        credentials: fetchOptions.credentials ?? credentials,
        ...(serializedBody !== undefined ? { body: serializedBody } : {}),
      }

      let response: Response
      try {
        response = await fetcher(url, requestInit)
      } catch (cause) {
        if (isAbortError(cause)) {
          throw new ApiAbortError('请求已取消', { cause })
        }
        throw new ApiNetworkError('无法连接招聘平台服务，请检查网络连接后重试', { cause })
      }

      const headerRequestId = response.headers.get(requestIdHeader) ?? response.headers.get(DEFAULT_REQUEST_ID_HEADER) ?? undefined
      const payload = await parseJsonBody(response, headerRequestId)
      const requestId = requireRequestId(payload, response, requestIdHeader)

      if (isApiErrorResponse(payload)) {
        throw makeApiError(response, payload, requestId || undefined)
      }
      if (!isSuccessfulStatus(response)) {
        // API 的错误响应始终是带 error 字段的 JSON 信封；空响应体的 5xx 只可能来自网关或开发代理，
        // 说明后端进程不可达。这里给出可诊断的提示，而不是笼统的「请求失败」。
        if (response.status >= 500 && payload === undefined) {
          throw new ApiNetworkError(`无法连接后端服务（HTTP ${response.status}），请确认 API 进程正在运行`, {
            status: response.status,
            requestId: requestId || undefined,
          })
        }
        throw makeApiError(response, payload, requestId || undefined)
      }
      if (payload === undefined && (response.status === 204 || response.status === 205)) {
        return { ok: true, data: undefined as T, requestId }
      }
      if (!isApiSuccessResponse<T>(payload)) {
        throw new ApiProtocolError('服务返回的数据不符合 API 契约', { status: response.status, requestId: requestId || undefined })
      }
      return {
        ok: true,
        data: payload.data,
        requestId,
        ...(isRecord(payload.meta) ? { meta: payload.meta } : {}),
      }
    }

    try {
      return await execute()
    } catch (error) {
      const code = (error as { code?: string })?.code
      if (isWrite && (code === 'CSRF_TOKEN_INVALID' || code === 'CSRF_ORIGIN_MISMATCH')) {
        csrfToken = undefined
        return await execute()
      }
      throw error
    }
  }

  return {
    baseUrl,
    requestJson,
    getJson: <T>(path: string, requestOptions?: Omit<JsonRequestOptions, 'method' | 'body'>) => requestJson<T>(path, { ...requestOptions, method: 'GET' }),
    postJson: <TResponse, TBody = unknown>(path: string, body?: TBody, requestOptions?: Omit<JsonRequestOptions, 'method' | 'body'>) =>
      requestJson<TResponse>(path, { ...requestOptions, method: 'POST', body }),
    patchJson: <TResponse, TBody = unknown>(path: string, body?: TBody, requestOptions?: Omit<JsonRequestOptions, 'method' | 'body'>) =>
      requestJson<TResponse>(path, { ...requestOptions, method: 'PATCH', body }),
    putJson: <TResponse, TBody = unknown>(path: string, body?: TBody, requestOptions?: Omit<JsonRequestOptions, 'method' | 'body'>) =>
      requestJson<TResponse>(path, { ...requestOptions, method: 'PUT', body }),
    deleteJson: <T>(path: string, requestOptions?: Omit<JsonRequestOptions, 'method' | 'body'>) => requestJson<T>(path, { ...requestOptions, method: 'DELETE' }),
  }
}

/** 默认使用 /api/v1 的应用级客户端。业务模块只需要传入相对接口路径。 */
export const apiClient = createApiClient()

export const requestJson = <T>(path: string, options?: JsonRequestOptions) => apiClient.requestJson<T>(path, options)
export const getJson = <T>(path: string, options?: Omit<JsonRequestOptions, 'method' | 'body'>) => apiClient.getJson<T>(path, options)
export const postJson = <TResponse, TBody = unknown>(
  path: string,
  body?: TBody,
  options?: Omit<JsonRequestOptions, 'method' | 'body'>,
) => apiClient.postJson<TResponse, TBody>(path, body, options)
export const patchJson = <TResponse, TBody = unknown>(
  path: string,
  body?: TBody,
  options?: Omit<JsonRequestOptions, 'method' | 'body'>,
) => apiClient.patchJson<TResponse, TBody>(path, body, options)
export const putJson = <TResponse, TBody = unknown>(
  path: string,
  body?: TBody,
  options?: Omit<JsonRequestOptions, 'method' | 'body'>,
) => apiClient.putJson<TResponse, TBody>(path, body, options)
export const deleteJson = <T>(path: string, options?: Omit<JsonRequestOptions, 'method' | 'body'>) => apiClient.deleteJson<T>(path, options)

export type { ApiResponse }


