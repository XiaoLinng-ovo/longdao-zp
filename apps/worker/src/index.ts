import { fileURLToPath } from 'node:url'
import { loadConfig, type WorkerConfig } from './config.js'
import { WorkerFailure, classifyFailure, isRetryableFailure, shouldRetryFailure } from './errors.js'
import { HealthStateStore, createHealthServer, startHealthServer, type HealthSnapshot } from './health.js'
import { createResumeAnalysisHandler, resumeAnalysisHandler } from './handlers/resume-analysis.js'
import { createTaskExecutor, InMemoryIdempotencyStore, TaskExecutor } from './runner.js'
import { beginTaskAttempt, createTask, hasAttemptsRemaining, isSupportedTaskType, TaskExhaustedError, TaskValidationError, validateTaskEnvelope, type CreateTaskInput, type TaskEnvelope, type TaskHandler, type TaskHandlerContext, type TaskType } from './task.js'
import { startWorker, type StartWorkerOptions, type WorkerRuntime } from './worker.js'

export {
  beginTaskAttempt,
  classifyFailure,
  createHealthServer,
  createResumeAnalysisHandler,
  createTask,
  createTaskExecutor,
  hasAttemptsRemaining,
  HealthStateStore,
  InMemoryIdempotencyStore,
  isRetryableFailure,
  loadConfig,
  resumeAnalysisHandler,
  shouldRetryFailure,
  startHealthServer,
  startWorker,
  TaskExecutor,
  TaskExhaustedError,
  TaskValidationError,
  validateTaskEnvelope,
  isSupportedTaskType,
  WorkerFailure,
}

export type {
  CreateTaskInput,
  HealthSnapshot,
  StartWorkerOptions,
  TaskEnvelope,
  TaskHandler,
  TaskHandlerContext,
  TaskType,
  WorkerConfig,
  WorkerRuntime,
}

const entrypoint = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false

if (entrypoint) {
  const config = loadConfig()
  let runtime: WorkerRuntime | undefined
  let stopping = false

  const stop = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    console.log(`${config.appName} received ${signal}; stopping`)
    try {
      await runtime?.close()
    } catch (error: unknown) {
      console.error('Failed to stop worker cleanly', error)
      process.exitCode = 1
    }
  }

  process.once('SIGINT', () => void stop('SIGINT'))
  process.once('SIGTERM', () => void stop('SIGTERM'))

  startWorker(config)
    .then((started) => {
      runtime = started
      const address = started.healthServer.address()
      const displayAddress = typeof address === 'string' ? address : `${address?.address}:${address?.port}`
      console.log(`${config.appName} ${config.appVersion} ready on ${displayAddress}; queue=${config.queueName}`)
    })
    .catch((error: unknown) => {
      console.error('Failed to start worker', error)
      process.exitCode = 1
    })
}
