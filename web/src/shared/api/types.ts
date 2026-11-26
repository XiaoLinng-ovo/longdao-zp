/**
 * 与 SmartRecruit Pro API 保持一致的 JSON 包装结构。
 *
 * 前端客户端只依赖这份轻量契约，避免页面直接耦合具体传输实现；正式
 * 业务 DTO 可以在调用 getJson/postJson 时通过泛型传入。
 */
export interface ApiMeta {
  pagination?: unknown
  warnings?: string[]
  [key: string]: unknown
}

export interface ApiFieldError {
  field: string
  messages: string[]
}

export interface ApiErrorPayload {
  code: string
  message: string
  details?: unknown
  fieldErrors?: ApiFieldError[]
  retryable?: boolean
}

export interface ApiSuccessResponse<T> {
  ok: true
  data: T
  requestId: string
  meta?: ApiMeta
}

export interface ApiErrorResponse {
  ok: false
  error: ApiErrorPayload
  requestId: string
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse

export type JsonHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * JSON API 请求选项。
 * body 使用 unknown，由客户端统一 JSON.stringify；其它选项透传给 fetch。
 */
export type JsonRequestOptions = Omit<RequestInit, 'body' | 'method'> & {
  method?: JsonHttpMethod
  body?: unknown
}

export interface ApiClientOptions {
  /** 默认 /api/v1；也可以传绝对地址，例如 http://localhost:3100/api/v1。 */
  baseUrl?: string
  /** 用于测试、SSR 或特殊运行环境注入 fetch 实现。 */
  fetcher?: typeof globalThis.fetch
  /** 默认请求头，会被单次请求的 headers 覆盖。 */
  defaultHeaders?: HeadersInit
  /** 招聘平台使用服务端 Session，默认显式携带 Cookie。 */
  credentials?: RequestCredentials
  /** 服务端 request id 响应头名称，默认 x-request-id。 */
  requestIdHeader?: string
}

export type RequestHeaders = HeadersInit

export interface ApiClient {
  readonly baseUrl: string
  requestJson<T>(path: string, options?: JsonRequestOptions): Promise<ApiSuccessResponse<T>>
  getJson<T>(path: string, options?: Omit<JsonRequestOptions, 'method' | 'body'>): Promise<ApiSuccessResponse<T>>
  postJson<TResponse, TBody = unknown>(
    path: string,
    body?: TBody,
    options?: Omit<JsonRequestOptions, 'method' | 'body'>,
  ): Promise<ApiSuccessResponse<TResponse>>
  putJson<TResponse, TBody = unknown>(
    path: string,
    body?: TBody,
    options?: Omit<JsonRequestOptions, 'method' | 'body'>,
  ): Promise<ApiSuccessResponse<TResponse>>
  patchJson<TResponse, TBody = unknown>(
    path: string,
    body?: TBody,
    options?: Omit<JsonRequestOptions, 'method' | 'body'>,
  ): Promise<ApiSuccessResponse<TResponse>>
  deleteJson<T>(path: string, options?: Omit<JsonRequestOptions, 'method' | 'body'>): Promise<ApiSuccessResponse<T>>
}
