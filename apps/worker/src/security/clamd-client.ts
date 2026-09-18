import { connect } from 'node:net'

export type MalwareScanResult = { status: 'clean' } | { status: 'infected'; signature: string }

export interface ClamdClientOptions {
  host: string
  port?: number
  timeoutMs?: number
}

export class ClamdClient {
  private readonly port: number
  private readonly timeoutMs: number

  constructor(private readonly options: ClamdClientOptions) {
    this.port = options.port ?? 3310
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  ping(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.options.host, port: this.port })
      const response: Buffer[] = []
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(error)
      }
      socket.setTimeout(this.timeoutMs, () => fail(new Error(`clamd ping timed out after ${this.timeoutMs}ms`)))
      socket.on('error', fail)
      socket.on('data', (chunk) => response.push(chunk))
      socket.on('connect', () => socket.end('zPING\0'))
      socket.on('end', () => {
        if (settled) return
        settled = true
        const message = Buffer.concat(response).toString('utf8').replace(/\0+$/, '').trim()
        if (message === 'PONG') return resolve()
        reject(new Error(`Unexpected clamd ping response: ${message || '<empty>'}`))
      })
    })
  }

  scan(content: Buffer): Promise<MalwareScanResult> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.options.host, port: this.port })
      const response: Buffer[] = []
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(error)
      }
      socket.setTimeout(this.timeoutMs, () => fail(new Error(`clamd scan timed out after ${this.timeoutMs}ms`)))
      socket.on('error', fail)
      socket.on('data', (chunk) => response.push(chunk))
      socket.on('connect', () => {
        socket.write('zINSTREAM\0')
        for (let offset = 0; offset < content.length; offset += 64 * 1024) {
          const chunk = content.subarray(offset, offset + 64 * 1024)
          const size = Buffer.allocUnsafe(4)
          size.writeUInt32BE(chunk.length)
          socket.write(size)
          socket.write(chunk)
        }
        socket.end(Buffer.alloc(4))
      })
      socket.on('end', () => {
        if (settled) return
        settled = true
        const message = Buffer.concat(response).toString('utf8').replace(/\0+$/, '').trim()
        if (/^stream: OK$/.test(message)) return resolve({ status: 'clean' })
        const infected = /^stream: (.+) FOUND$/.exec(message)
        if (infected?.[1]) return resolve({ status: 'infected', signature: infected[1] })
        reject(new Error(`Unexpected clamd response: ${message || '<empty>'}`))
      })
    })
  }
}
