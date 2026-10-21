export type ApiClientErrorKind = 'network' | 'http' | 'api' | 'parse' | 'protocol' | 'request' | 'aborted'

export interface ApiClientErrorOptions {
  kind: ApiClientErrorKind
  status?: number
  code?: string
  requestId?: string
  details?: unknown
  fieldErrors?: { field: string; messages: string[] }[]
  retryable?: boolean
  cause?: unknown
}

/**
 * 所有 API 调用异常的共同基类。
 * 页面可以只依赖这个类型，也可以根据 status、kind 或具体子类展示不同提示。
 */
export class ApiClientError extends Error {
  readonly kind: ApiClientErrorKind
  readonly status?: number
  readonly code?: string
  readonly requestId?: string
  readonly details?: unknown
  readonly fieldErrors?: { field: string; messages: string[] }[]
  readonly retryable?: boolean
  override readonly cause?: unknown

  constructor(message: string, options: ApiClientErrorOptions) {
    super(message)
    this.name = 'ApiClientError'
    this.kind = options.kind
    this.status = options.status
    this.code = options.code
    this.requestId = options.requestId
    this.details = options.details
    this.fieldErrors = options.fieldErrors
    this.retryable = options.retryable
    this.cause = options.cause
  }
}

export class ApiHttpError extends ApiClientError {
  constructor(message: string, options: Omit<ApiClientErrorOptions, 'kind'> = {}) {
    super(message, { ...options, kind: 'http' })
    this.name = 'ApiHttpError'
  }
}

/** API 返回了 ok:false，或返回了带 error 字段的 JSON 错误。 */
export class ApiResponseError extends ApiClientError {
  constructor(message: string, options: Omit<ApiClientErrorOptions, 'kind'> = {}) {
    super(message, { ...options, kind: 'api' })
    this.name = 'ApiResponseError'
  }
}

export class ApiAuthenticationError extends ApiHttpError {
  constructor(message = '登录状态已失效，请重新登录', options: Omit<ApiClientErrorOptions, 'kind'> = {}) {
    super(message, { ...options, status: 401 })
    this.name = 'ApiAuthenticationError'
  }
}

export class ApiForbiddenError extends ApiHttpError {
  constructor(message = '当前账号没有执行此操作的权限', options: Omit<ApiClientErrorOptions, 'kind'> = {}) {
    super(message, { ...options, status: 403 })
    this.name = 'ApiForbiddenError'
  }
}

export class ApiNetworkError extends ApiClientError {
  constructor(message = '无法连接招聘平台服务，请检查网络连接后重试', options: Omit<ApiClientErrorOptions, 'kind'> = {}) {
    super(message, { ...options, kind: 'network', retryable: options.retryable ?? true })
    this.name = 'ApiNetworkError'
  }
}

export class ApiParseError extends ApiClientError {
  constructor(message = '服务返回了无法解析的 JSON', options: Omit<ApiClientErrorOptions, 'kind'> = {}) {
    super(message, { ...options, kind: 'parse' })
    this.name = 'ApiParseError'
  }
}

export class ApiProtocolError extends ApiClientError {
  constructor(message = '服务返回的数据不符合 API 契约', options: Omit<ApiClientErrorOptions, 'kind'> = {}) {
    super(message, { ...options, kind: 'protocol' })
    this.name = 'ApiProtocolError'
  }
}

export class ApiRequestSerializationError extends ApiClientError {
  constructor(message = '请求数据无法序列化为 JSON', options: Omit<ApiClientErrorOptions, 'kind'> = {}) {
    super(message, { ...options, kind: 'request' })
    this.name = 'ApiRequestSerializationError'
  }
}

export class ApiAbortError extends ApiNetworkError {
  constructor(message = '请求已取消', options: Omit<ApiClientErrorOptions, 'kind'> = {}) {
    super(message, { ...options, retryable: false })
    this.name = 'ApiAbortError'
  }
}

export function isApiClientError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError
}

export function isAuthenticationError(error: unknown): error is ApiAuthenticationError {
  return error instanceof ApiAuthenticationError || (isApiClientError(error) && error.status === 401)
}

export function isForbiddenError(error: unknown): error is ApiForbiddenError {
  return error instanceof ApiForbiddenError || (isApiClientError(error) && error.status === 403)
}
