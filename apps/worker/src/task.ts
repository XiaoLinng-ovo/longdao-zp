import { randomUUID } from 'node:crypto'

export type TaskType = 'resume-analysis'

export function isSupportedTaskType(value: string): value is TaskType {
  return value === 'resume-analysis'
}

export interface TaskEnvelope<TType extends string = string, TPayload = unknown> {
  id: string
  type: TType
  payload: TPayload
  /** Number of attempts already consumed before this execution begins. */
  attempts: number
  /** Inclusive upper bound for consumed attempts. */
  maxAttempts: number
  idempotencyKey: string
  createdAt: string
  updatedAt?: string
  traceId?: string
}

export interface CreateTaskInput<TType extends string, TPayload> {
  type: TType
  payload: TPayload
  id?: string
  attempts?: number
  maxAttempts: number
  idempotencyKey: string
  createdAt?: string
  traceId?: string
}

export class TaskValidationError extends Error {
  readonly code = 'INVALID_TASK'

  constructor(message: string) {
    super(message)
    this.name = 'TaskValidationError'
  }
}

export class TaskExhaustedError extends Error {
  readonly code = 'MAX_ATTEMPTS_EXCEEDED'

  constructor(taskId: string) {
    super(`Task ${taskId} has no remaining attempts`)
    this.name = 'TaskExhaustedError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TaskValidationError(`${field} must be a non-empty string`)
  }
  return value
}

function requireInteger(value: unknown, field: string, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new TaskValidationError(`${field} must be an integer >= ${minimum}`)
  }
  return value as number
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireNonEmptyString(value, field)
  if (Number.isNaN(Date.parse(timestamp))) throw new TaskValidationError(`${field} must be an ISO date-time`)
  return timestamp
}

export function validateTaskEnvelope(value: unknown): asserts value is TaskEnvelope {
  if (!isRecord(value)) throw new TaskValidationError('task must be an object')
  requireNonEmptyString(value.id, 'id')
  requireNonEmptyString(value.type, 'type')
  if (!('payload' in value)) throw new TaskValidationError('payload is required')
  requireInteger(value.attempts, 'attempts', 0)
  requireInteger(value.maxAttempts, 'maxAttempts', 1)
  if ((value.attempts as number) > (value.maxAttempts as number)) {
    throw new TaskValidationError('attempts must be <= maxAttempts')
  }
  requireNonEmptyString(value.idempotencyKey, 'idempotencyKey')
  requireTimestamp(value.createdAt, 'createdAt')
  if (value.updatedAt !== undefined) requireTimestamp(value.updatedAt, 'updatedAt')
  if (value.traceId !== undefined) requireNonEmptyString(value.traceId, 'traceId')
}

export function createTask<TType extends string, TPayload>(input: CreateTaskInput<TType, TPayload>): TaskEnvelope<TType, TPayload> {
  const task: TaskEnvelope<TType, TPayload> = {
    id: input.id ?? randomUUID(),
    type: input.type,
    payload: input.payload,
    attempts: input.attempts ?? 0,
    maxAttempts: input.maxAttempts,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.createdAt ?? new Date().toISOString(),
  }
  if (input.traceId !== undefined) task.traceId = input.traceId
  validateTaskEnvelope(task)
  return task
}

export function hasAttemptsRemaining(task: TaskEnvelope): boolean {
  return task.attempts < task.maxAttempts
}

export function beginTaskAttempt<TType extends string, TPayload>(
  task: TaskEnvelope<TType, TPayload>,
  now: Date = new Date(),
): TaskEnvelope<TType, TPayload> {
  validateTaskEnvelope(task)
  if (!hasAttemptsRemaining(task)) throw new TaskExhaustedError(task.id)
  return {
    ...task,
    attempts: task.attempts + 1,
    updatedAt: now.toISOString(),
  }
}

export interface TaskHandlerContext {
  taskId: string
  attempt: number
  maxAttempts: number
  idempotencyKey: string
  traceId?: string
  now: () => string
  signal?: AbortSignal
}

export type TaskHandler<TType extends string = string, TPayload = unknown, TResult = unknown> = (
  task: TaskEnvelope<TType, TPayload>,
  context: TaskHandlerContext,
) => Promise<TResult>
