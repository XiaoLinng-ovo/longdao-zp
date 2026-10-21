import { resumeAnalysisHandler } from './handlers/resume-analysis.js'
import type { ResumeAnalysisResult, ResumeAnalysisTaskPayload } from './handlers/resume-analysis.js'
import { classifyFailure, shouldRetryFailure, WorkerFailure, type ClassifiedFailure } from './errors.js'
import {
  validateTaskEnvelope,
  type TaskEnvelope,
  type TaskHandler,
  type TaskHandlerContext,
  type TaskType,
  isSupportedTaskType,
} from './task.js'

export interface IdempotencyRecord {
  idempotencyKey: string
  taskId: string
  taskType: TaskType
  attempts: number
  storedAt: string
  result: unknown
}

/**
 * Storage boundary for completed task results. The in-memory implementation is
 * intentionally process-local and is only a development/test fallback.
 */
export interface IdempotencyStore {
  get(idempotencyKey: string): Promise<IdempotencyRecord | undefined>
  set(record: IdempotencyRecord): Promise<void>
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>()

  async get(idempotencyKey: string): Promise<IdempotencyRecord | undefined> {
    return this.records.get(idempotencyKey)
  }

  async set(record: IdempotencyRecord): Promise<void> {
    this.records.set(record.idempotencyKey, record)
  }

  clear(): void {
    this.records.clear()
  }

  get size(): number {
    return this.records.size
  }
}

export interface TaskHandlerMap {
  'resume-analysis': TaskHandler<'resume-analysis', ResumeAnalysisTaskPayload, ResumeAnalysisResult>
}

export interface TaskExecutorOptions {
  handlers?: Partial<TaskHandlerMap>
  idempotencyStore?: IdempotencyStore
  now?: () => string
}

export interface TaskExecutionResult<TResult = unknown> {
  status: 'completed' | 'failed' | 'skipped'
  taskId: string
  taskType: TaskType
  idempotencyKey: string
  /** Number of attempts consumed by this execution, or the stored value for a duplicate. */
  attempts: number
  maxAttempts: number
  retryable: boolean
  result?: TResult
  failure?: ClassifiedFailure
  skippedReason?: 'idempotency_duplicate'
  completedAt?: string
}

function addResult<TResult>(
  base: Omit<TaskExecutionResult<TResult>, 'result'>,
  result: TResult,
): TaskExecutionResult<TResult> {
  return { ...base, result }
}

export class TaskExecutor {
  private readonly handlers: TaskHandlerMap
  private readonly idempotencyStore: IdempotencyStore
  private readonly now: () => string
  private readonly inFlight = new Map<string, Promise<TaskExecutionResult>>()

  constructor(options: TaskExecutorOptions = {}) {
    this.handlers = {
      'resume-analysis': options.handlers?.['resume-analysis'] ?? resumeAnalysisHandler,
    }
    this.idempotencyStore = options.idempotencyStore ?? new InMemoryIdempotencyStore()
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async execute<TResult = unknown>(input: unknown): Promise<TaskExecutionResult<TResult>> {
    validateTaskEnvelope(input)
    const task = input as TaskEnvelope<TaskType, unknown>
    const existing = this.inFlight.get(task.idempotencyKey)
    if (existing) {
      const completed = (await existing) as TaskExecutionResult<TResult>
      if (completed.status === 'completed' || completed.status === 'skipped') {
        return {
          ...completed,
          status: 'skipped',
          taskId: task.id,
          idempotencyKey: task.idempotencyKey,
          skippedReason: 'idempotency_duplicate',
        }
      }
      return completed
    }
    const pending = this.executeOwned<TResult>(task)
    this.inFlight.set(task.idempotencyKey, pending as Promise<TaskExecutionResult>)
    try {
      return await pending
    } finally {
      if (this.inFlight.get(task.idempotencyKey) === pending) this.inFlight.delete(task.idempotencyKey)
    }
  }

  private async executeOwned<TResult = unknown>(task: TaskEnvelope<TaskType, unknown>): Promise<TaskExecutionResult<TResult>> {
    if (!isSupportedTaskType(task.type)) {
      const failure = classifyFailure(new WorkerFailure(`Unsupported task type: ${task.type}`, {
        category: 'validation',
        code: 'UNSUPPORTED_TASK_TYPE',
      }))
      return {
        status: 'failed',
        taskId: task.id,
        taskType: task.type as TaskType,
        idempotencyKey: task.idempotencyKey,
        attempts: task.attempts,
        maxAttempts: task.maxAttempts,
        retryable: false,
        failure,
      }
    }
    const stored = await this.idempotencyStore.get(task.idempotencyKey)
    if (stored !== undefined) {
      const duplicateBase: Omit<TaskExecutionResult<TResult>, 'result'> = {
        status: 'skipped',
        taskId: task.id,
        taskType: task.type,
        idempotencyKey: task.idempotencyKey,
        attempts: stored.attempts,
        maxAttempts: task.maxAttempts,
        retryable: false,
        skippedReason: 'idempotency_duplicate',
        completedAt: stored.storedAt,
      }
      return addResult(duplicateBase, stored.result as TResult)
    }

    const currentAttempt = task.attempts + 1
    if (task.attempts >= task.maxAttempts) {
      const failure = classifyFailure(new WorkerFailure(`Task ${task.id} has reached maxAttempts`, {
        category: 'max_attempts_exceeded',
        code: 'MAX_ATTEMPTS_EXCEEDED',
      }))
      return {
        status: 'failed',
        taskId: task.id,
        taskType: task.type,
        idempotencyKey: task.idempotencyKey,
        attempts: task.attempts,
        maxAttempts: task.maxAttempts,
        retryable: false,
        failure,
      }
    }

    const handler = this.handlers[task.type]
    const context: TaskHandlerContext = {
      taskId: task.id,
      attempt: currentAttempt,
      maxAttempts: task.maxAttempts,
      idempotencyKey: task.idempotencyKey,
      now: this.now,
    }
    if (task.traceId !== undefined) context.traceId = task.traceId

    try {
      const result = await handler(task as TaskEnvelope<'resume-analysis', ResumeAnalysisTaskPayload>, context)
      const completedAt = this.now()
      await this.idempotencyStore.set({
        idempotencyKey: task.idempotencyKey,
        taskId: task.id,
        taskType: task.type,
        attempts: currentAttempt,
        storedAt: completedAt,
        result,
      })
      const completedBase: Omit<TaskExecutionResult<TResult>, 'result'> = {
        status: 'completed',
        taskId: task.id,
        taskType: task.type,
        idempotencyKey: task.idempotencyKey,
        attempts: currentAttempt,
        maxAttempts: task.maxAttempts,
        retryable: false,
        completedAt,
      }
      return addResult(completedBase, result as TResult)
    } catch (error: unknown) {
      const failure = classifyFailure(error)
      return {
        status: 'failed',
        taskId: task.id,
        taskType: task.type,
        idempotencyKey: task.idempotencyKey,
        attempts: currentAttempt,
        maxAttempts: task.maxAttempts,
        retryable: shouldRetryFailure(failure, currentAttempt, task.maxAttempts),
        failure,
      }
    }
  }
}

export function createTaskExecutor(options: TaskExecutorOptions = {}): TaskExecutor {
  return new TaskExecutor(options)
}
