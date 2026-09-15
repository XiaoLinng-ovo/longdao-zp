import { classifyFailure } from '../errors.js'
import {
  type AnalysisTaskLease,
  type AnalysisTaskRecord,
  PostgresAnalysisTaskStore,
} from '../db/analysis-task-store.js'
import { createTask, type TaskEnvelope } from '../task.js'
import { type ResumeAnalysisResult, type ResumeAnalysisTaskPayload } from './resume-analysis.js'
import { type TaskExecutionResult, TaskExecutor } from '../runner.js'

export interface PersistedResumeAnalysisOptions {
  store: PostgresAnalysisTaskStore
  executor: TaskExecutor
  claim: {
    maxAttempts: number
    leaseDurationMs: number
    now?: Date | string
  }
  payloadFor: (task: AnalysisTaskRecord) => Promise<ResumeAnalysisTaskPayload> | ResumeAnalysisTaskPayload
}

export interface PersistedResumeAnalysisOutcome {
  lease: AnalysisTaskLease
  task: TaskEnvelope<'resume-analysis', ResumeAnalysisTaskPayload>
  execution: TaskExecutionResult<ResumeAnalysisResult>
}

/** Executes one database-leased task and fences every terminal write by attempt. */
export async function processNextPersistedResumeAnalysis(
  options: PersistedResumeAnalysisOptions,
): Promise<PersistedResumeAnalysisOutcome | undefined> {
  const lease = await options.store.claimNextTask(options.claim)
  if (!lease) return undefined

  let payload: ResumeAnalysisTaskPayload
  try {
    payload = await options.payloadFor(lease.task)
  } catch (error: unknown) {
    const failure = classifyFailure(error)
    await options.store.failTask({
      taskId: lease.task.id,
      attempt: lease.attempt,
      maxAttempts: lease.maxAttempts,
      error: failure.message,
    })
    throw error
  }

  const task = createTask({
    id: lease.task.id,
    type: 'resume-analysis',
    payload,
    // The database claim already consumed this attempt. TaskExecutor receives
    // the pre-execution count so its existing attempt semantics remain intact.
    attempts: lease.attempt - 1,
    maxAttempts: lease.maxAttempts,
    idempotencyKey: lease.task.idempotencyKey,
    createdAt: lease.task.createdAt,
  })
  const execution = await options.executor.execute<ResumeAnalysisResult>(task)

  if (execution.status === 'completed') {
    await options.store.completeTask({
      taskId: lease.task.id,
      attempt: lease.attempt,
      result: execution.result,
      ...(execution.completedAt === undefined ? {} : { completedAt: execution.completedAt }),
    })
  } else if (execution.status === 'failed') {
    await options.store.failTask({
      taskId: lease.task.id,
      attempt: lease.attempt,
      maxAttempts: lease.maxAttempts,
      error: execution.failure?.message ?? 'Analysis task failed',
    })
  }

  return { lease, task, execution }
}
