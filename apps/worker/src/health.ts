import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { WorkerConfig } from './config.js'

export type HealthState = 'starting' | 'ready' | 'stopping' | 'stopped'

export type ExternalDependencyStatus = 'not_configured' | 'ok' | 'unavailable' | 'error'

export interface HealthSnapshot {
  status: HealthState
  service: string
  version: string
  workerId: string
  queueName: string
  externalDependencies: Record<string, ExternalDependencyStatus>
  checkedAt: string
}

export class HealthStateStore {
  private state: HealthState = 'starting'
  private readonly dependencies = new Map<string, ExternalDependencyStatus>([
    ['redis', 'not_configured'],
    ['postgres', 'not_configured'],
    ['objectStorage', 'not_configured'],
  ])

  constructor(private readonly config: WorkerConfig, private readonly now: () => string = () => new Date().toISOString()) {}

  setState(state: HealthState): void {
    this.state = state
  }

  setDependency(name: string, status: ExternalDependencyStatus): void {
    this.dependencies.set(name, status)
  }

  snapshot(): HealthSnapshot {
    return {
      status: this.state,
      service: this.config.appName,
      version: this.config.appVersion,
      workerId: this.config.workerId,
      queueName: this.config.queueName,
      externalDependencies: Object.fromEntries(this.dependencies),
      checkedAt: this.now(),
    }
  }
}

function sendJson(res: ServerResponse, statusCode: number, body: HealthSnapshot): void {
  const payload = JSON.stringify(body)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(payload))
  res.end(payload)
}

function handleProbe(req: IncomingMessage, res: ServerResponse, state: HealthStateStore): void {
  const method = req.method ?? 'GET'
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const snapshot = state.snapshot()

  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD')
    sendJson(res, 405, snapshot)
    return
  }

  if (requestUrl.pathname !== '/health' && requestUrl.pathname !== '/ready') {
    sendJson(res, 404, snapshot)
    return
  }

  const isReadyProbe = requestUrl.pathname === '/ready'
  const isHealthy = snapshot.status !== 'stopping' && snapshot.status !== 'stopped'
  const isReady = snapshot.status === 'ready'
  const statusCode = isReadyProbe ? (isReady ? 200 : 503) : (isHealthy ? 200 : 503)
  if (method === 'HEAD') {
    res.statusCode = statusCode
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end()
    return
  }
  sendJson(res, statusCode, snapshot)
}

export function createHealthServer(state: HealthStateStore): Server {
  return createServer((req, res) => handleProbe(req, res, state))
}

export async function startHealthServer(
  config: WorkerConfig,
  state: HealthStateStore,
): Promise<Server> {
  const server = createHealthServer(state)
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(config.healthPort, config.healthHost)
  })
  return server
}
