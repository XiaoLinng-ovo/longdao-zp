import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, statfs, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { checkedLocalObjectPath } from '@smartrecruit-pro/object-storage'
import { combinedRuntimeSignal } from '@smartrecruit-pro/runtime-lifecycle'

const MiB = 1024 * 1024
const workspaces = new Map<string, number>()
const children = new Set<number>()
export const audioResourceSnapshot = () => ({
  temporaryReservedBytes: [...workspaces.values()].reduce((sum, size) => sum + size, 0),
  temporaryDirectories: [...workspaces.keys()], childPids: [...children],
})
export function audioResourceLimit(key: string, fallback: number): number {
  const value = Number(process.env[key] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > 16 * 1024 * MiB) throw new Error(key + ' 配置无效')
  return value
}

/** Only files below this invocation's owned directory may be removed. No crash-residue sweeper. */
export class AudioWorkspace {
  private readonly sizes = new Map<string, number>()
  private closed = false
  private closing: Promise<void> | undefined
  private reservationWork: Promise<void> = Promise.resolve()
  private readonly receivers = new Set<Promise<string>>()
  private readonly lifetime = new AbortController()
  private constructor(readonly directory: string, private readonly removeDirectory: typeof rm) {}
  static async create(kind: 'assembly' | 'transcription', removeDirectory: typeof rm = rm) {
    const root = join(tmpdir(), 'smartrecruit-audio')
    await checkedLocalObjectPath(root, '.owner-probe', true)
    const workspace = new AudioWorkspace(await mkdtemp(join(root, kind + '-')), removeDirectory)
    workspaces.set(workspace.directory, 0)
    try {
      await writeFile(join(workspace.directory, 'owner.json'), JSON.stringify({ application: 'smartrecruit', pid: process.pid, createdAt: new Date().toISOString(), kind }), { flag: 'wx', mode: 0o600 })
      return workspace
    } catch (error) { await workspace.close(); throw error }
  }
  reserve(name: string, bytes: number): Promise<void> {
    const work = this.reservationWork.then(() => this.reserveOwned(name, bytes))
    this.reservationWork = work.catch(() => undefined)
    return work
  }
  private async reserveOwned(name: string, bytes: number) {
    if (this.closed || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name === 'owner.json' || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error('音频临时空间申请无效')
    const previous = this.sizes.get(name) ?? 0, delta = bytes - previous
    const owned = (workspaces.get(this.directory) ?? 0) + delta
    const shared = audioResourceSnapshot().temporaryReservedBytes + delta
    if (owned > audioResourceLimit('AUDIO_TEMP_TASK_MAX_BYTES', 1280 * MiB) || shared > audioResourceLimit('AUDIO_TEMP_SHARED_MAX_BYTES', 3072 * MiB)) throw new Error('音频临时磁盘额度不足，请稍后重试')
    // Reserve synchronously before the filesystem await so concurrent tasks cannot overbook.
    this.sizes.set(name, bytes); workspaces.set(this.directory, owned)
    try {
      if (delta > 0) {
        const disk = await statfs(this.directory)
        if (disk.bavail * disk.bsize < delta + audioResourceLimit('AUDIO_TEMP_MIN_FREE_BYTES', 512 * MiB)) throw new Error('音频临时磁盘可用空间不足')
      }
    } catch (error) {
      this.sizes.set(name, previous); workspaces.set(this.directory, (workspaces.get(this.directory) ?? 0) - delta)
      throw error
    }
  }
  receive(name: string, input: Readable, maxBytes: number, signal?: AbortSignal, expectedBytes?: number): Promise<string> {
    const work = this.receiveOwned(name, input, maxBytes, signal, expectedBytes).finally(() => this.receivers.delete(work))
    this.receivers.add(work)
    return work
  }
  private async receiveOwned(name: string, input: Readable, maxBytes: number, callerSignal?: AbortSignal, expectedBytes?: number): Promise<string> {
    const signal = combinedRuntimeSignal(callerSignal ? AbortSignal.any([callerSignal, this.lifetime.signal]) : this.lifetime.signal)!
    try {
      signal.throwIfAborted()
      if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes)) throw new Error('音频声明长度无效')
      await this.reserve(name, maxBytes)
      const path = await checkedLocalObjectPath(this.directory, name)
      let received = 0
      await pipeline(input, new Transform({ transform(chunk, _encoding, callback) {
        received += chunk.length
        callback(received > maxBytes ? new Error('音频实际读取字节数超过上限') : null, chunk)
      }, flush(callback) { callback(expectedBytes !== undefined && received !== expectedBytes ? new Error('音频文件读取不完整') : null) } }), createWriteStream(path, { mode: 0o600 }), { signal })
      return path
    } finally { input.destroy() }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.lifetime.abort()
    this.closing = (async () => {
      await this.reservationWork
      await Promise.allSettled([...this.receivers])
      await this.removeDirectory(this.directory, { recursive: true, force: true })
      workspaces.delete(this.directory)
      this.sizes.clear()
    })().catch(error => { this.closing = undefined; throw error })
    return this.closing
  }
}

export async function runAudioProcess(ffmpeg: string, args: string[], options: { signal?: AbortSignal | undefined; timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<Buffer> {
  const signal = combinedRuntimeSignal(options.signal)
  signal?.throwIfAborted()
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    if (child.pid) children.add(child.pid)
    let size = 0, failure: Error | undefined
    const output: Buffer[] = []
    const cancel = (error: Error) => { failure ??= error; child.kill('SIGKILL') }
    const abort = () => cancel(new Error('音频处理已取消'))
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => cancel(new Error('音频处理超时')), options.timeoutMs ?? 60000)
    child.stdout.on('data', (part: Buffer) => {
      size += part.length
      if (size > (options.maxOutputBytes ?? 0)) cancel(new Error('音频处理输出超过上限'))
      else output.push(part)
    })
    child.stderr.resume()
    child.once('error', error => { failure = new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? '音频处理组件未安装，请配置 FFMPEG_PATH' : '音频处理组件启动失败') })
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (child.pid) children.delete(child.pid)
      if (failure || code !== 0) reject(failure ?? new Error('原录音存在无法解码的内容，音频处理失败'))
      else resolve(Buffer.concat(output, size))
    })
    if (signal?.aborted) abort()
  })
}
