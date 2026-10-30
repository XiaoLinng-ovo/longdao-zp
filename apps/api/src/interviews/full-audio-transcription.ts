import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpeakerSegment } from './role-mapper.js'
import { transcribeInterviewChunk } from './interview-transcriber.js'

export type FullAudioTranscriptionStatus = 'processing' | 'completed' | 'failed'
export interface FullAudioTranscriptionJob {
  status: FullAudioTranscriptionStatus
  progress: number
  text: string
  error?: string
  updatedAt: string
}
interface AudioStore { read(key: string): Promise<Buffer>; write(key: string, data: Uint8Array, contentType: string): Promise<void> }
type ChunkTranscriber = (audio: Uint8Array, contentType: string) => Promise<SpeakerSegment[]>
type AudioSplitter = (audio: Buffer) => Promise<Buffer[]>
const chunkSeconds = 60
const isMissing = (error: unknown) => {
  const cause = error as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } }
  return cause.code === 'ENOENT' || cause.name === 'NoSuchKey' || cause.$metadata?.httpStatusCode === 404
}

function wavDurationMs(wav: Buffer): number {
  const dataOffset = wav.indexOf('data')
  if (dataOffset < 0 || dataOffset + 8 > wav.length) return 0
  return Math.floor(wav.readUInt32LE(dataOffset + 4) / 32)
}

async function splitAudio(audio: Buffer, ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'): Promise<Buffer[]> {
  const directory = await mkdtemp(join(tmpdir(), 'interview-transcription-'))
  const input = join(directory, 'full.m4a')
  await writeFile(input, audio)
  try {
    const chunks: Buffer[] = []
    for (let index = 0; index < 240; index++) {
      const chunk = await new Promise<Buffer>((resolve, reject) => {
        const start = index * chunkSeconds
        const child = spawn(ffmpeg, ['-hide_banner','-loglevel','error','-nostdin','-ss',String(start),'-i',input,'-t',String(chunkSeconds),'-vn','-ac','1','-ar','16000','-f','wav','pipe:1'], { windowsHide: true, stdio: ['ignore','pipe','pipe'] })
        const stdout: Buffer[] = [], stderr: Buffer[] = []
        let size = 0, timedOut = false
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 30_000)
        child.stdout.on('data', (part: Buffer) => { size += part.length; if (size > 8 * 1024 * 1024) child.kill('SIGKILL'); else stdout.push(part) })
        child.stderr.on('data', (part: Buffer) => { if (Buffer.concat(stderr).length < 16_384) stderr.push(part) })
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('close', code => {
          clearTimeout(timer)
          if (code === 0) resolve(Buffer.concat(stdout))
          else reject(new Error(timedOut ? '音频分段处理超时' : Buffer.concat(stderr).toString('utf8').slice(0, 1000) || '音频分段处理失败'))
        })
      })
      const duration = wavDurationMs(chunk)
      if (!duration) break
      chunks.push(chunk)
      if (duration < chunkSeconds * 1000 - 1000) break
    }
    if (!chunks.length) throw new Error('未能从整场录音中提取可识别的音频')
    return chunks
  } finally { await rm(directory, { recursive: true, force: true }) }
}

function transcript(segments: SpeakerSegment[]): string {
  return segments.map(segment => segment.text.trim()).filter(Boolean).join('')
}

export class FullAudioTranscription {
  private readonly active = new Map<string, Promise<void>>()
  private readonly starting = new Map<string, Promise<FullAudioTranscriptionJob>>()
  constructor(
    private readonly storage: AudioStore,
    private readonly transcribe: ChunkTranscriber = transcribeInterviewChunk,
    private readonly split: AudioSplitter = splitAudio,
  ) {}

  async get(key: string): Promise<FullAudioTranscriptionJob | null> {
    try { return JSON.parse((await this.storage.read(key)).toString('utf8')) as FullAudioTranscriptionJob }
    catch (error) { if (isMissing(error)) return null; throw error }
  }

  start(key: string, loadAudio: () => Promise<Buffer>): Promise<FullAudioTranscriptionJob> {
    const pending = this.starting.get(key)
    if (pending) return pending
    const preparing = this.prepareStart(key, loadAudio).finally(() => this.starting.delete(key))
    this.starting.set(key, preparing)
    return preparing
  }

  private async prepareStart(key: string, loadAudio: () => Promise<Buffer>): Promise<FullAudioTranscriptionJob> {
    const existing = await this.get(key)
    if (existing?.status === 'completed') return existing
    if (this.active.has(key)) return existing ?? { status: 'processing', progress: 0, text: '', updatedAt: new Date().toISOString() }
    if (!this.active.has(key)) {
      const initial: FullAudioTranscriptionJob = { status: 'processing', progress: 0, text: '', updatedAt: new Date().toISOString() }
      await this.save(key, initial)
      const work = this.run(key, loadAudio).finally(() => this.active.delete(key))
      this.active.set(key, work)
    }
    return (await this.get(key)) ?? { status: 'processing', progress: 0, text: '', updatedAt: new Date().toISOString() }
  }

  private async run(key: string, loadAudio: () => Promise<Buffer>): Promise<void> {
    try {
      const chunks = await this.split(await loadAudio())
      let text = ''
      for (const [index, audio] of chunks.entries()) {
        const recognized = transcript(await this.transcribe(audio, 'audio/wav'))
        if (recognized) text += (text ? '\n' : '') + recognized
        await this.save(key, { status: 'processing', progress: Math.round((index + 1) / chunks.length * 100), text, updatedAt: new Date().toISOString() })
      }
      await this.save(key, { status: 'completed', progress: 100, text, updatedAt: new Date().toISOString() })
    } catch {
      const current = await this.get(key).catch(() => null)
      await this.save(key, { status: 'failed', progress: current?.progress ?? 0, text: current?.text ?? '', error: '整段转写失败，请检查转写服务后重试。', updatedAt: new Date().toISOString() }).catch(() => undefined)
    }
  }

  private async save(key: string, job: FullAudioTranscriptionJob): Promise<void> {
    await this.storage.write(key, Buffer.from(JSON.stringify(job)), 'application/json; charset=utf-8')
  }
}

