export type FailureCategory =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'timeout'
  | 'rate_limited'
  | 'dependency_unavailable'
  | 'network'
  | 'internal'
  | 'unknown'
  | 'max_attempts_exceeded'
  | 'max_attempts_exceeded'

export interface ClassifiedFailure {
  category: FailureCategory
  message: string
  retryable: boolean
  code?: string
}

export interface WorkerFailureOptions {
  category: FailureCategory
  code?: string
  retryable?: boolean
  cause?: unknown
}

/** An error with an explicit operational category at a task boundary. */
export class WorkerFailure extends Error {
  readonly category: FailureCategory
  readonly code?: string
  readonly retryableOverride?: boolean

  constructor(message: string, options: WorkerFailureOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WorkerFailure'
    this.category = options.category
    if (options.code !== undefined) this.code = options.code
    if (options.retryable !== undefined) this.retryableOverride = options.retryable
  }
}

const RETRYABLE_CATEGORIES = new Set<FailureCategory>([
  'timeout',
  'rate_limited',
  'dependency_unavailable',
  'network',
])

export function isRetryableCategory(category: FailureCategory): boolean {
  return RETRYABLE_CATEGORIES.has(category)
}

function isClassifiedFailure(value: unknown): value is ClassifiedFailure {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.category === 'string'
    && typeof candidate.message === 'string'
    && typeof candidate.retryable === 'boolean'
}

function readErrorCode(error: object): string | undefined {
  const candidate = Reflect.get(error, 'code')
  return typeof candidate === 'string' ? candidate : undefined
}

function readStatusCode(error: object): number | undefined {
  const candidates = [Reflect.get(error, 'statusCode'), Reflect.get(error, 'status')]
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate
  }
  return undefined
}

function readErrorName(error: object): string | undefined {
  const candidate = Reflect.get(error, 'name')
  return typeof candidate === 'string' ? candidate : undefined
}

function readErrorMessage(error: object): string {
  const candidate = Reflect.get(error, 'message')
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : 'Unknown worker failure'
}

function inferCategory(error: object, message: string, code: string | undefined): FailureCategory {
  const normalizedMessage = message.toLowerCase()
  const normalizedCode = code?.toUpperCase()
  const statusCode = readStatusCode(error)
  const name = readErrorName(error)?.toLowerCase()

  if (name === 'timeouterror' || normalizedCode === 'ETIMEDOUT' || normalizedMessage.includes('timeout')) {
    return 'timeout'
  }
  if (statusCode === 408 || statusCode === 429 || normalizedCode === 'EAI_AGAIN') {
    return statusCode === 429 ? 'rate_limited' : 'network'
  }
  if (statusCode !== undefined && statusCode >= 500) return 'dependency_unavailable'
  if (normalizedCode === 'ECONNRESET' || normalizedCode === 'ECONNREFUSED' || normalizedCode === 'ENOTFOUND') {
    return 'network'
  }
  if (normalizedMessage.includes('rate limit') || normalizedMessage.includes('too many requests')) {
    return 'rate_limited'
  }
  if (normalizedMessage.includes('unavailable') || normalizedMessage.includes('temporarily')) {
    return 'dependency_unavailable'
  }
  if (normalizedMessage.includes('not found') || normalizedMessage.includes('missing')) return 'not_found'
  if (normalizedMessage.includes('conflict') || normalizedMessage.includes('already exists')) return 'conflict'
  if (normalizedMessage.includes('invalid') || normalizedMessage.includes('required')) return 'validation'
  return error instanceof Error ? 'internal' : 'unknown'
}

export function classifyFailure(error: unknown): ClassifiedFailure {
  if (isClassifiedFailure(error)) return error

  if (error instanceof WorkerFailure) {
    const failure: ClassifiedFailure = {
      category: error.category,
      message: error.message,
      retryable: error.retryableOverride ?? isRetryableCategory(error.category),
    }
    if (error.code !== undefined) failure.code = error.code
    return failure
  }

  if (error !== null && typeof error === 'object') {
    const code = readErrorCode(error)
    const message = readErrorMessage(error)
    const category = inferCategory(error, message, code)
    const failure: ClassifiedFailure = {
      category,
      message,
      retryable: isRetryableCategory(category),
    }
    if (code !== undefined) failure.code = code
    return failure
  }

  return {
    category: 'unknown',
    message: String(error),
    retryable: false,
  }
}

export function isRetryableFailure(error: unknown): boolean {
  return classifyFailure(error).retryable
}

export function shouldRetryFailure(error: unknown, attempts: number, maxAttempts: number): boolean {
  if (!Number.isInteger(attempts) || !Number.isInteger(maxAttempts)) return false
  if (attempts < 0 || maxAttempts < 1 || attempts >= maxAttempts) return false
  return isRetryableFailure(error)
}

