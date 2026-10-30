import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InterviewAudioManifestEntry } from './audio-recording-repository.js'

export type FullAudioSource = 'all' | 'microphone' | 'meeting' | 'legacy'
export class FullAudioError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}
interface AudioStore { read(key: string): Promise<Buffer>; write(key: string, data: Uint8Array, contentType: string): Promise<void> }
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
  private readonly pending = new Map<string, Promise<Buffer>>()
  private active = 0
  private readonly queue: (() => void)[] = []
  constructor(private readonly storage: AudioStore, private readonly ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg') {}

  async load(sessionId: string, manifest: InterviewAudioManifestEntry[], source: FullAudioSource): Promise<Buffer> {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new FullAudioError(400, '录音场次无效')
    const rows = manifest.filter(row => row.sessionId === sessionId && (source === 'all' || (source === 'legacy' ? !row.audioSource : row.audioSource === source)))
      .sort((a, b) => a.offsetMs - b.offsetMs || a.id.localeCompare(b.id))
    if (!rows.length) throw new FullAudioError(404, '该场次没有此音源的录音')
    if (rows.length > 4000 || rows.some(row => !Number.isSafeInteger(row.offsetMs) || row.offsetMs < 0 || row.offsetMs >= maxDurationMs))
      throw new FullAudioError(422, '录音时长或数量超出整场回放范围，请联系管理员导出原音频')
    const digest = this.fingerprint(rows, source)
    const key = 'interviews/' + sessionId + '/full/' + digest + '.m4a'
    const existing = this.pending.get(key)
    if (existing) return existing
    const work = this.cached(key, rows)
    this.pending.set(key, work)
    try { return await work } finally { this.pending.delete(key) }
  }

  fingerprint(manifest: InterviewAudioManifestEntry[], source: FullAudioSource): string {
    const rows = manifest.filter(row => source === 'all' || (source === 'legacy' ? !row.audioSource : row.audioSource === source))
      .sort((a, b) => a.offsetMs - b.offsetMs || a.id.localeCompare(b.id))
    return createHash('sha256').update(JSON.stringify(['timeline-v1', source, rows.map(row => [row.id,row.objectKey,row.offsetMs,row.endMs,row.byteLength,row.audioSource])])).digest('hex')
  }

  private async cached(key: string, rows: InterviewAudioManifestEntry[]): Promise<Buffer> {
    try { return await this.storage.read(key) } catch (error) { if (!missing(error)) throw error }
    if (this.active >= 2) {
      if (this.queue.length >= 8) throw new FullAudioError(503, '整场音频正在整理中，请稍后重试')
      await new Promise<void>(resolve => this.queue.push(resolve))
    } else this.active++
    try {
      const audio = await this.assemble(rows)
      await this.storage.write(key, audio, 'audio/mp4')
      return audio
    } finally { const next = this.queue.shift(); if (next) next(); else this.active-- }
  }

  private async run(args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.ffmpeg, ['-hide_banner','-loglevel','error','-nostdin','-y',...args], { windowsHide: true, stdio: ['ignore','ignore','pipe'] })
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 60_000)
      child.stderr.resume()
      child.once('error', error => { clearTimeout(timer); reject(new FullAudioError(503, (error as NodeJS.ErrnoException).code === 'ENOENT' ? '整场音频处理组件未安装，请配置 FFMPEG_PATH 后重试' : '音频处理组件启动失败')) })
      child.once('close', code => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new FullAudioError(422, timedOut ? '整场音频处理超时，请稍后重试' : '原录音存在无法解码的内容，无法生成完整音频，请保留录音并联系管理员检查'))
      })
    })
  }

  private async assemble(rows: InterviewAudioManifestEntry[]): Promise<Buffer> {
    const directory = await mkdtemp(join(tmpdir(), 'interview-audio-'))
    const timelinePath = join(directory, 'timeline.f32'), inputPath = join(directory, 'input'), pcmPath = join(directory, 'chunk.s16')
    const timeline = await open(timelinePath, 'w+')
    let length = 0
    const deadline = Date.now() + 10 * 60_000
    const gain = 1 / new Set(rows.map(row => row.audioSource || 'legacy')).size
    try {
      for (const row of rows) {
        if (Date.now() > deadline) throw new FullAudioError(503, '录音整理耗时较长，请稍后重试')
        let input: Buffer
        try { input = await this.storage.read(row.objectKey) }
        catch (error) { if (missing(error)) throw new FullAudioError(404, '部分原音频文件不存在或已移除，无法生成完整音频'); throw error }
        if (input.length > 32 * 1024 * 1024) throw new FullAudioError(422, '原录音文件过大，无法整理整场音频')
        await writeFile(inputPath, input)
        await this.run(['-protocol_whitelist','file,pipe','-format_whitelist',demuxers,'-i',inputPath,'-vn','-t','601','-ac','1','-ar',String(rate),'-f','s16le',pcmPath])
        const size = (await stat(pcmPath)).size, start = Math.round(row.offsetMs * rate / 1000)
        if (!size || size % 2 || size >= rate * 2 * 601 || (start + size / 2) / rate * 1000 > maxDurationMs)
          throw new FullAudioError(422, '原录音时长无效或超过整场回放范围')
        const pcm = await open(pcmPath, 'r')
        try {
          const bytes = Buffer.alloc(32_768)
          for (let offset = 0; offset < size;) {
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
      await this.run(['-f','f32le','-ar',String(rate),'-ac','1','-i',timelinePath,'-af','alimiter=limit=0.95:level=false:latency=true','-c:a','aac','-b:a','64k','-movflags','+faststart',output])
      return await readFile(output)
    } finally { await timeline.close().catch(() => undefined); await rm(directory, { recursive: true, force: true }) }
  }
}
