import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { join } from 'node:path'
import type { ObjectRead } from '@smartrecruit-pro/object-storage'
import type { InterviewAudioManifestEntry } from './audio-recording-repository.js'
import type { InterviewAudioStorage } from './live-audio-storage.js'
import { AudioWorkspace, runAudioProcess } from './audio-resources.js'

export type FullAudioSource = 'all' | 'microphone' | 'meeting' | 'legacy'
export class FullAudioError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}
const maxCompressedBytes = 128 * 1024 * 1024
const rate = 16000, maxDurationMs = 4 * 60 * 60 * 1000
// Never let an uploaded playlist cause FFmpeg to open other files or URLs.
const demuxers = 'matroska,webm,wav,ogg,mp3,mov,mp4,m4a,3gp,3g2,mj2'
const missing = (error: unknown) => {
  const e = error as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } }
  return e.code === 'ENOENT' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404
}

/** A process per chunk avoids the input/file-descriptor limit of a giant concat graph.
 * Place decoded samples on the capture clock: gaps stay silent and simultaneous
 * sources overlap. Speech end metadata is deliberately NOT used to trim audio. */
export class FullInterviewAudio {
  private readonly pending = new Map<string, { work: Promise<void>; controller: AbortController; users: number; settled: boolean }>()
  private readonly lifetime = new AbortController()
  private readonly generations = new Set<Promise<void>>()
  private readonly readers = new Map<Readable, Promise<void>>()
  private active = 0
  private readonly queue: { resolve(): void; reject(error: Error): void }[] = []
  constructor(private readonly storage: InterviewAudioStorage, private readonly ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg',
    private readonly execute: typeof runAudioProcess = runAudioProcess) {}

  async load(sessionId: string, manifest: InterviewAudioManifestEntry[], source: FullAudioSource): Promise<Buffer> {
    const file = await this.loadStream(sessionId, manifest, source)
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of file.body) {
      size += chunk.length
      if (size > maxCompressedBytes) throw new FullAudioError(422, '整场音频超过读取上限')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, size)
  }

  async loadStream(sessionId: string, manifest: InterviewAudioManifestEntry[], source: FullAudioSource, signal?: AbortSignal): Promise<ObjectRead> {
    const combined = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal
    combined.throwIfAborted()
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new FullAudioError(400, '录音场次无效')
    const rows = manifest.filter(row => row.sessionId === sessionId && (source === 'all' || (source === 'legacy' ? !row.audioSource : row.audioSource === source)))
      .sort((a, b) => a.offsetMs - b.offsetMs || a.id.localeCompare(b.id))
    if (!rows.length) throw new FullAudioError(404, '该场次没有此音源的录音')
    if (rows.length > 4000 || rows.some(row => !Number.isSafeInteger(row.offsetMs) || row.offsetMs < 0 || row.offsetMs >= maxDurationMs))
      throw new FullAudioError(422, '录音时长或数量超出整场回放范围，请联系管理员导出原音频')
    const digest = this.fingerprint(rows, source)
    const key = 'interviews/' + sessionId + '/full/' + digest + '.m4a'
    let pending = this.pending.get(key)
    if (!pending || pending.controller.signal.aborted) {
      const controller = new AbortController()
      const entry = { work: Promise.resolve(), controller, users: 0, settled: false }
      entry.work = this.cached(key, rows, AbortSignal.any([controller.signal, this.lifetime.signal])).finally(() => {
        this.generations.delete(entry.work)
        entry.settled = true
        if (this.pending.get(key) === entry) this.pending.delete(key)
      })
      this.generations.add(entry.work)
      this.pending.set(key, entry); pending = entry
    }
    pending.users++
    let abort!: () => void
    try {
      await Promise.race([pending.work, new Promise<never>((_resolve, reject) => {
        abort = () => reject(new FullAudioError(499, '音频读取已取消'))
        combined.addEventListener('abort', abort, { once: true })
        if (combined.aborted) abort()
      })])
      return await this.openRead(key, combined)
    } finally {
      combined.removeEventListener('abort', abort)
      if (--pending.users === 0 && !pending.settled) pending.controller.abort()
    }
  }

  async close() {
    this.lifetime.abort()
    await Promise.allSettled([...this.generations])
    const readers = [...this.readers]
    for (const [body] of readers) body.destroy()
    await Promise.all(readers.map(([, work]) => work))
  }

  fingerprint(manifest: InterviewAudioManifestEntry[], source: FullAudioSource): string {
    const rows = manifest.filter(row => source === 'all' || (source === 'legacy' ? !row.audioSource : row.audioSource === source))
      .sort((a, b) => a.offsetMs - b.offsetMs || a.id.localeCompare(b.id))
    return createHash('sha256').update(JSON.stringify(['timeline-v1', source, rows.map(row => [row.id,row.objectKey,row.offsetMs,row.endMs,row.byteLength,row.audioSource])])).digest('hex')
  }

  private async openRead(key: string, signal: AbortSignal): Promise<ObjectRead> {
    const file = this.storage.openRead ? await this.storage.openRead(key, { signal }) : await this.storage.read(key).then(buffer => ({ body: Readable.from([buffer], { signal }), byteLength: buffer.length }))
    const completion = finished(file.body, { cleanup: true }).catch(() => undefined).finally(() => this.readers.delete(file.body))
    this.readers.set(file.body, completion)
    if (signal.aborted) { file.body.destroy(); signal.throwIfAborted() }
    if (!Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || file.byteLength > maxCompressedBytes) {
      file.body.destroy(); throw new FullAudioError(422, '整场音频超过读取上限')
    }
    return file
  }

  private async cached(key: string, rows: InterviewAudioManifestEntry[], signal: AbortSignal): Promise<void> {
    try { const cached = await this.openRead(key, signal); cached.body.destroy(); return } catch (error) { if (!missing(error)) throw error }
    if (this.active >= 2) {
      if (this.queue.length >= 8) throw new FullAudioError(503, '整场音频正在整理中，请稍后重试')
      await new Promise<void>((resolve, reject) => {
        const abort = () => { const index = this.queue.indexOf(entry); if (index >= 0) this.queue.splice(index, 1); signal.removeEventListener('abort', abort); reject(new FullAudioError(499, '音频处理已取消')) }
        const entry = { resolve: () => { signal.removeEventListener('abort', abort); resolve() }, reject }
        this.queue.push(entry); signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    } else this.active++
    try {
      await this.assemble(key, rows, signal)
    } finally { const next = this.queue.shift(); if (next) next.resolve(); else this.active-- }
  }

  private async run(args: string[], signal: AbortSignal, stage: string, timeoutMs = 60000): Promise<void> {
    try { await this.execute(this.ffmpeg, ['-y', ...args], { signal, timeoutMs }) }
    catch (error) { throw new FullAudioError(/超时|取消|组件/.test(String(error)) ? 503 : 422, stage + '：' + (error instanceof Error ? error.message : '音频处理失败')) }
  }

  private async assemble(key: string, rows: InterviewAudioManifestEntry[], callerSignal: AbortSignal): Promise<void> {
    const workspace = await AudioWorkspace.create('assembly'), directory = workspace.directory
    const deadlineController = new AbortController(), timer = setTimeout(() => deadlineController.abort(), 10 * 60_000)
    const signal = AbortSignal.any([callerSignal, deadlineController.signal])
    const timelinePath = join(directory, 'timeline.f32'), inputPath = join(directory, 'input'), pcmPath = join(directory, 'chunk.s16')
    let timeline: Awaited<ReturnType<typeof open>> | undefined
    let length = 0
    const deadline = Date.now() + 10 * 60_000
    const gain = 1 / new Set(rows.map(row => row.audioSource || 'legacy')).size
    try {
      timeline = await open(timelinePath, 'w+')
      await workspace.reserve('chunk.s16', rate * 2 * 601)
      for (const row of rows) {
        signal.throwIfAborted()
        if (Date.now() > deadline) throw new FullAudioError(503, '录音整理耗时较长，请稍后重试')
        try {
          const input = await this.openRead(row.objectKey, signal)
          await workspace.receive('input', input.body, 32 * 1024 * 1024, signal, input.byteLength)
        }
        catch (error) { if (missing(error)) throw new FullAudioError(404, '部分原音频文件不存在或已移除，无法生成完整音频'); throw error }
        await this.run(['-protocol_whitelist','file,pipe','-format_whitelist',demuxers,'-i',inputPath,'-vn','-t','601','-ac','1','-ar',String(rate),'-f','s16le',pcmPath], signal, '原音频解码')
        const size = (await stat(pcmPath)).size, start = Math.round(row.offsetMs * rate / 1000)
        if (!size || size % 2 || size >= rate * 2 * 601 || (start + size / 2) / rate * 1000 > maxDurationMs)
          throw new FullAudioError(422, '原录音时长无效或超过整场回放范围')
        await workspace.reserve('timeline.f32', Math.max(length, start + size / 2) * 4)
        const pcm = await open(pcmPath, 'r')
        try {
          const bytes = Buffer.alloc(32_768)
          for (let offset = 0; offset < size;) {
            signal.throwIfAborted()
            const { bytesRead } = await pcm.read(bytes, 0, Math.min(bytes.length, size - offset), offset)
            if (!bytesRead) throw new FullAudioError(422, '原录音读取不完整，请重试')
            const mixed = Buffer.alloc(bytesRead * 2), position = (start + offset / 2) * 4
            await timeline.read(mixed, 0, mixed.length, position)
            for (let sample = 0; sample < bytesRead / 2; sample++) mixed.writeFloatLE(mixed.readFloatLE(sample * 4) + bytes.readInt16LE(sample * 2) / 32768 * gain, sample * 4)
            await timeline.write(mixed, 0, mixed.length, position)
            offset += bytesRead
          }
        } finally { await pcm.close() }
        length = Math.max(length, start + size / 2)
      }
      await timeline.truncate(length * 4)
      await timeline.close()
      const output = join(directory, 'full.m4a')
      await workspace.reserve('full.m4a', maxCompressedBytes)
      // Encoding covers the whole recording; short-input decode limits do not apply.
      // The original task deadline remains authoritative, including time spent mixing.
      await this.run(['-f','f32le','-ar',String(rate),'-ac','1','-i',timelinePath,'-af','alimiter=limit=0.95:level=false:latency=true','-c:a','aac','-b:a','64k','-fs',String(maxCompressedBytes),'-movflags','+faststart',output], signal, '整场音频编码', Math.max(1, deadline - Date.now()))
      const metadata = await stat(output)
      if (!metadata.size || metadata.size >= maxCompressedBytes) throw new FullAudioError(422, '整场音频输出超过上限或不完整')
      if (this.storage.writeStream) {
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(output, { signal })) hash.update(chunk)
        await this.storage.writeStream(key, createReadStream(output, { signal }), metadata.size, 'audio/mp4', { signal, sha256: hash.digest('hex') })
      } else await this.storage.write(key, await readFile(output), 'audio/mp4')
    } finally {
      clearTimeout(timer)
      await timeline?.close().catch(() => undefined)
      await workspace.close()
    }
  }
}
