import { ApiClientError, isApiClientError } from '../api'

interface FieldErrorLike { message: string; code?: string; status?: number }

/** 统一把业务 / 网络 / 解析错误转成对用户可见的文案，并保留稳定错误码用于 UI 判断。 */
export function describeApiFailure(cause: unknown, fallback = '操作失败，请稍后重试'): { message: string; code?: string; status?: number } {
  const error = isApiClientError(cause) ? cause : cause instanceof Error ? (cause as unknown as FieldErrorLike) : undefined
  const code = error instanceof ApiClientError ? error.code : error?.code
  const status = error instanceof ApiClientError ? error.status : error?.status
  const parts: string[] = []

  if (code === 'CSRF_ORIGIN_MISMATCH') {
    return { message: '当前页面地址未加入 API 的安全白名单，请确认 ALLOWED_ORIGINS 包含当前网页地址（本机默认为 http://127.0.0.1:5174），然后重启 API 服务', code, status }
  }

  if (status) parts.push(`[${status}]`)
  if (code) parts.push(code)
  if (parts.length) parts.push('·')

  if (error) {
    const message = trimMessage(typeof error.message === 'string' ? error.message : fallback)
    parts.push(message || fallback)
  } else {
    parts.push(fallback)
  }

  return { message: parts.join(' ').trim().replace(/\s+/g, ' '), code, status }
}

function trimMessage(message: string): string {
  const trimmed = message.trim()
  if (!trimmed) return ''
  const colon = trimmed.indexOf('：')
  if (colon >= 0 && colon < trimmed.length - 1) return trimmed
  return trimmed
}
