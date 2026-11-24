import { HttpError } from '../../http.js'
import { normalizePhone } from '../../auth/registration.js'
import type { PlatformUserListQuery, PlatformUserProfileInput, PlatformUserReasonInput, PlatformUserStatusInput } from './types.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function integer(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value === null || value === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new HttpError(400, 'VALIDATION_ERROR', '分页参数无效')
  return parsed
}

export function validateUserId(value: string): string {
  if (!UUID.test(value)) throw new HttpError(400, 'VALIDATION_ERROR', '用户 ID 无效')
  return value
}

export function validateReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 2 || value.trim().length > 500) {
    throw new HttpError(400, 'VALIDATION_ERROR', '请填写 2～500 字的操作原因')
  }
  return value.trim()
}

export function validateUserListQuery(query: URLSearchParams): PlatformUserListQuery {
  const page = integer(query.get('page'), 1, 1, 1_000_000)
  const pageSize = integer(query.get('pageSize'), 20, 1, 100)
  const q = (query.get('q') ?? '').trim()
  if (q.length > 120) throw new HttpError(400, 'VALIDATION_ERROR', '搜索内容过长')
  const status = query.get('status')
  if (status !== null && !['active', 'disabled'].includes(status)) throw new HttpError(400, 'VALIDATION_ERROR', '用户状态筛选无效')
  const workspaceId = query.get('workspaceId')
  if (workspaceId !== null && !UUID.test(workspaceId)) throw new HttpError(400, 'VALIDATION_ERROR', '企业 ID 无效')
  const platformRole = query.get('platformRole')
  if (platformRole !== null && !['admin', 'viewer', 'none'].includes(platformRole)) throw new HttpError(400, 'VALIDATION_ERROR', '平台身份筛选无效')
  return {
    page,
    pageSize,
    q,
    status: status as PlatformUserListQuery['status'],
    workspaceId,
    platformRole: platformRole as PlatformUserListQuery['platformRole'],
  }
}

export function validateStatusInput(input: Record<string, unknown>): PlatformUserStatusInput {
  if (typeof input.isActive !== 'boolean') throw new HttpError(400, 'VALIDATION_ERROR', '请选择启用或停用')
  return { isActive: input.isActive, reason: validateReason(input.reason) }
}

export function validateWorkspaceAiAccessInput(input: Record<string, unknown>) {
  if (Object.keys(input).some(key => !['usePlatformAi', 'reason'].includes(key))) throw new HttpError(400, 'VALIDATION_ERROR', '不支持的模型共用配置项')
  if (typeof input.usePlatformAi !== 'boolean') throw new HttpError(400, 'VALIDATION_ERROR', '请选择是否使用平台 AI 模型')
  return { usePlatformAi: input.usePlatformAi, reason: validateReason(input.reason) }
}

export function validateReasonInput(input: Record<string, unknown>): PlatformUserReasonInput {
  return { reason: validateReason(input.reason) }
}

export function validateProfileInput(input: Record<string, unknown>): PlatformUserProfileInput {
  const allowed = new Set(['displayName', 'phone', 'reason'])
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new HttpError(400, 'VALIDATION_ERROR', '不支持的用户资料字段')
  const result: PlatformUserProfileInput = { reason: validateReason(input.reason) }
  if (input.displayName !== undefined) {
    if (typeof input.displayName !== 'string') throw new HttpError(400, 'VALIDATION_ERROR', '姓名格式无效')
    const displayName = input.displayName.trim()
    if (displayName.length < 2 || displayName.length > 80) throw new HttpError(400, 'VALIDATION_ERROR', '姓名长度需为 2 到 80 个字符')
    result.displayName = displayName
  }
  if (input.phone !== undefined) result.phone = input.phone === null ? null : normalizePhone(input.phone)
  if (result.displayName === undefined && result.phone === undefined) throw new HttpError(400, 'VALIDATION_ERROR', '请至少修改一个资料字段')
  return result
}
