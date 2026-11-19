import { AsyncLocalStorage } from 'node:async_hooks'
import { setMaxListeners } from 'node:events'

const context = new AsyncLocalStorage()
export const currentRuntimeSignal = () => context.getStore()
export const runWithRuntimeSignal = (signal, operation) => context.run(signal, operation)
export function combinedRuntimeSignal(signal) {
  const lifetime = currentRuntimeSignal()
  return signal && lifetime ? AbortSignal.any([signal, lifetime]) : signal ?? lifetime
}
export function runtimeFetch(input, init) {
  const signal = combinedRuntimeSignal(init?.signal ?? (input instanceof Request ? input.signal : undefined))
  signal?.throwIfAborted()
  return fetch(input, { ...init, ...(signal ? { signal } : {}) })
}

export class ShutdownTimeoutError extends Error {
  constructor(pending) {
    super('关停期限已到，仍有资源未回收：' + pending.join('、'))
    this.name = 'ShutdownTimeoutError'
    this.code = 'SHUTDOWN_TIMEOUT'
    this.pending = pending
  }
}

/** One absolute deadline shared by nested drains. A timeout is never a successful close. */
export function createShutdownBudget(timeoutMs, controller = new AbortController()) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('关停期限必须在 1 到 600000 毫秒之间')
  setMaxListeners(0, controller.signal)
  let deadline, active = 0
  const pending = new Map()
  const snapshot = () => [...pending.values()]
  const run = (name, operation) => {
    deadline ??= Date.now() + timeoutMs
    active++
    const token = Symbol(name)
    pending.set(token, name)
    const remaining = Math.max(0, deadline - Date.now())
    let cancel, timer
    const work = Promise.resolve().then(operation).finally(() => pending.delete(token))
    const timeout = new Promise((_, reject) => {
      cancel = setTimeout(() => controller.abort(new Error('服务关停：取消在途操作')), Math.max(0, remaining - Math.max(1, Math.floor(timeoutMs * 0.3))))
      timer = setTimeout(() => {
        controller.abort(new Error('服务关停期限已到'))
        reject(new ShutdownTimeoutError(snapshot()))
      }, remaining)
    })
    // Keep handling the real drain after timeout; its late rejection must not be unhandled.
    return Promise.race([work, timeout]).finally(() => {
      clearTimeout(cancel); clearTimeout(timer)
      if (--active === 0 && pending.size === 0) deadline = undefined
    })
  }
  return { signal: controller.signal, run, pending: snapshot }
}

// Use the installed pg driver's CancelRequest serializer, including its key format.
function cancelPostgresLease(client) {
  if (!client.connectionParameters || !client.connection || !Number.isInteger(client.processID)) return undefined
  if (client.readyForQuery === true) return undefined
  return new Promise((resolve, reject) => {
    let connection, timer, finished = false, sent = false, channelClosed = false, targetReady = false
    const target = client.connection
    const onReady = () => { targetReady = client.readyForQuery === true; complete() }
    const complete = () => { if (channelClosed && targetReady) finish() }
    const onChannelError = error => {
      // Windows may reset the response-less cancel socket. Require independent target confirmation.
      if (sent && error.code === 'ECONNRESET') { channelClosed = true; complete() }
      else finish(error)
    }
    const finish = error => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      target.removeListener('readyForQuery', onReady)
      connection?.stream?.destroy()
      if (error) reject(Object.assign(new Error('数据库取消通道失败，服务端执行结果需要核对'), {
        code: 'DATABASE_CANCEL_FAILED',
        reasonCode: typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'CANCEL_CHANNEL_ERROR',
      }))
      else resolve()
    }
    try {
      target.on('readyForQuery', onReady)
      connection = new client.constructor(client.connectionParameters).connection
      connection.on('error', onChannelError)
      connection.once('end', () => { channelClosed = true; complete() })
      const send = () => {
        try { connection.cancel(client.processID, client.secretKey); sent = true } catch(error) { finish(error) }
      }
      if (connection.ssl) {
        connection.once('sslconnect', send)
        if (connection.sslNegotiation !== 'direct') connection.once('connect', () => connection.requestSsl())
      } else connection.once('connect', send)
      timer = setTimeout(() => finish(Object.assign(new Error('cancel deadline'), { code: 'CANCEL_CONFIRMATION_TIMEOUT' })), 500)
      const { host, port } = client.connectionParameters
      if (host.startsWith('/')) connection.connect(host + '/.s.PGSQL.' + port)
      else connection.connect(port, host)
    } catch(error) { finish(error) }
  })
}

/** Cancel only the leased client, never another operation or an externally owned pool. */
export function bindPoolCancellation(pool, signal = currentRuntimeSignal()) {
  const connect = pool.connect.bind(pool)
  // When idle, pg has already evicted the client before emitting the pool error.
  pool.on?.('error', error => {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,24}$/.test(error.code) ? error.code : 'CONNECTION_LOST'
    console.warn('[postgres] idle connection discarded:', code)
  })
  const protectLease = leased => {
    const release = leased.release.bind(leased)
    let disconnected = false
    // pg rejects outstanding queries separately from the checked-out client's error event.
    const onError = () => { disconnected = true }
    leased.on?.('error', onError)
    return error => {
      leased.removeListener?.('error', onError)
      release(error || (disconnected ? true : error))
    }
  }
  const cancellations = new Set(), cancellationErrors = []
  if (signal && pool.end) {
    const end = pool.end.bind(pool)
    pool.end = callback => {
      const work = (async () => {
        await Promise.allSettled([...cancellations])
        await end()
        if (cancellationErrors.length) throw new AggregateError(cancellationErrors, '数据库关停存在未确认取消请求')
      })()
      if (!callback) return work
      void work.then(() => callback(), callback)
    }
  }
  const acquire = () => !signal ? Promise.resolve().then(connect).then(leased => {
    leased.release = protectLease(leased)
    return leased
  }) : new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    let cancelLease, released = false, aborted = false
    const abort = () => {
      aborted = true
      cancelLease?.()
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    // Always consume late acquisitions so a cancelled waiter cannot leak its client.
    Promise.resolve().then(() => connect()).then(leased => {
      if (aborted || signal.aborted) { signal.removeEventListener('abort', abort); leased.release(true); return }
      const release = protectLease(leased)
      const releaseOwned = error => {
        if (released) { if (aborted) return; throw new Error('Database client has already been released') }
        released = true
        signal.removeEventListener('abort', abort)
        release(error)
      }
      leased.release = releaseOwned
      cancelLease = () => {
        if (released) return
        released = true
        signal.removeEventListener('abort', abort)
        const cancel = cancelPostgresLease(leased)
        if (!cancel) { release(true); return }
        const work = cancel.catch(error => { cancellationErrors.push(error) }).finally(() => {
          release(true)
          cancellations.delete(work)
        })
        cancellations.add(work)
      }
      resolve(leased)
    }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
  pool.connect = callback => {
    const work = acquire()
    if (!callback) return work
    void work.then(client => callback(undefined, client, client.release), error => callback(error))
  }
  return pool
}
