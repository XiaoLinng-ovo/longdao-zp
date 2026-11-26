import { ApiClientError, isApiClientError } from '../api'
import { businessErrorMessage } from './business-error'

interface FieldErrorLike { message: string; code?: string; status?: number }

/** 保留程序依赖的稳定错误码，页面只显示中文业务提示。 */
export function describeApiFailure(cause: unknown, fallback = '操作失败，请稍后重试'): { message: string; code?: string; status?: number } {
  const error = isApiClientError(cause) ? cause : cause instanceof Error ? (cause as unknown as FieldErrorLike) : undefined
  const code = error instanceof ApiClientError ? error.code : error?.code
  const status = error instanceof ApiClientError ? error.status : error?.status
  return { message: businessErrorMessage(error?.message, fallback, code, status), code, status }
}
