import os from 'node:os'

export interface WorkerConfig {
  appName: string
  appVersion: string
  nodeEnv: string
  workerId: string
  queueName: string
  maxAttempts: number
  pollIntervalMs: number
  leaseDurationMs: number
  healthHost: string
  healthPort: number
  shutdownTimeoutMs: number
  pollPostgres: boolean
  clamavHost?: string
  clamavPort: number
  clamavTimeoutMs: number
  quarantineRoot?: string
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  options: { minimum: number; maximum?: number },
): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback

  const value = Number(raw)
  if (!Number.isInteger(value) || value < options.minimum || (options.maximum !== undefined && value > options.maximum)) {
    const maximumMessage = options.maximum === undefined ? '' : ` and <= ${options.maximum}`
    throw new Error(`${name} must be an integer >= ${options.minimum}${maximumMessage}`)
  }
  return value
}

function readPort(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  return readInteger(env, name, fallback, { minimum: 0, maximum: 65535 })
}

/**
 * Loads process configuration without opening any external connection.
 * Passing an environment object and hostname keeps tests deterministic.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  hostname: string = os.hostname(),
): WorkerConfig {
  const clamavHost = env.CLAMAV_HOST?.trim() || undefined
  const quarantineRoot = env.RECRUITING_QUARANTINE_ROOT?.trim() || undefined
  return {
    appName: env.APP_NAME?.trim() || 'smartrecruit-pro-worker',
    appVersion: env.APP_VERSION?.trim() || '0.1.0',
    nodeEnv: env.NODE_ENV?.trim() || 'development',
    workerId: env.WORKER_ID?.trim() || `${hostname}-${process.pid}`,
    queueName: env.WORKER_QUEUE_NAME?.trim() || 'smartrecruit.tasks',
    maxAttempts: readInteger(env, 'WORKER_MAX_ATTEMPTS', 3, { minimum: 1 }),
    pollIntervalMs: readInteger(env, 'WORKER_POLL_INTERVAL_MS', 1000, { minimum: 0 }),
    leaseDurationMs: readInteger(env, 'WORKER_LEASE_DURATION_MS', 60_000, { minimum: 1 }),
    healthHost: env.WORKER_HEALTH_HOST?.trim() || '127.0.0.1',
    healthPort: readPort(env, 'WORKER_HEALTH_PORT', 4001),
    shutdownTimeoutMs: readInteger(env, 'WORKER_SHUTDOWN_TIMEOUT_MS', 10_000, { minimum: 1 }),
    pollPostgres: env.WORKER_DB_POLL?.trim() === 'true',
    ...(clamavHost === undefined ? {} : { clamavHost }),
    clamavPort: readPort(env, 'CLAMAV_PORT', 3310),
    clamavTimeoutMs: readInteger(env, 'CLAMAV_TIMEOUT_MS', 30_000, { minimum: 1 }),
    ...(quarantineRoot === undefined ? {} : { quarantineRoot }),
  }
}
