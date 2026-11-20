import type { PaginationMeta } from './common.js'

export interface ApiSuccessResponse<T> {
  ok: true
  data: T
  requestId: string
  meta?: ApiMeta
}

export interface ApiErrorResponse {
  ok: false
  error: ApiError
  requestId: string
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse

export interface ApiMeta {
  pagination?: PaginationMeta
  warnings?: string[]
}

export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'CSRF_FAILED'
  | 'RATE_LIMITED'
  | 'FILE_REJECTED'
  | 'ANALYSIS_FAILED'
  | 'INTERNAL_ERROR'

export interface ApiFieldError {
  field: string
  messages: string[]
}

export interface ApiError {
  code: ApiErrorCode | string
  message: string
  details?: unknown
  fieldErrors?: ApiFieldError[]
  retryable?: boolean
}

export interface ListResponse<T> extends ApiSuccessResponse<T[]> {
  meta: ApiMeta & { pagination: PaginationMeta }
}
