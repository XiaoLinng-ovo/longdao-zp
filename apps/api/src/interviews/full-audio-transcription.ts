import { Readable } from 'node:stream'
import type { ObjectRead } from '@smartrecruit-pro/object-storage'
import { AudioWorkspace, runAudioProcess } from './audio-resources.js'
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
export type FullAudioInput = Buffer | ObjectRead
export type AudioSplitter = (audio: FullAudioInput, signal?: AbortSignal) => AsyncIterable<Buffer> | Promise<Buffer[]>
export type RecordedChunkMeter = (audio: Buffer, index: number, action: () => Promise<SpeakerSegment[]>) => Promise<SpeakerSegment[]>
export const FULL_AUDIO_CHUNK_SECONDS = 60
const isMissing = (error: unknown) => {
  const cause = error as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } }
  return cause.code === 'ENOENT' || cause.name === 'NoSuchKey' || cause.$metadata?.httpStatusCode === 404
}

export function wavDurationMs(wav: Buffer): number {
  const dataOffset = wav.indexOf('data')
  if (dataOffset < 0 || dataOffset + 8 > wav.length) return 0
  // ffmpeg writes 0xffffffff for a streaming WAV data size. Charge actual PCM bytes.
  return Math.floor(Math.min(wav.readUInt32LE(dataOffset + 4), wav.length - dataOffset - 8) / 32)
}

export async function* splitFullInterviewAudio(audio: FullAudioInput, ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', signal?: AbortSignal): AsyncGenerator<Buffer> {
  const workspace = await AudioWorkspace.create('transcription')
  const source = Buffer.isBuffer(audio) ? { body: Readable.from([audio]), byteLength: audio.length } : audio
  try {
    signal?.throwIfAborted()
    const maxBytes = 128 * 1024 * 1024
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 1 || source.byteLength > maxBytes) throw new Error('整场音频输入超过大小上限')
    const input = await workspace.receive('full.m4a', source.body, source.byteLength, signal, source.byteLength)
    let count = 0
    for (let index = 0; index <= 240; index++) {
      signal?.throwIfAborted()
      const chunk = await runAudioProcess(ffmpeg, ['-protocol_whitelist','file,pipe','-format_whitelist','mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,wav,ogg,mp3','-ss',String(index * FULL_AUDIO_CHUNK_SECONDS),'-i',input,'-t',String(FULL_AUDIO_CHUNK_SECONDS),'-vn','-ac','1','-ar','16000','-f','wav','pipe:1'], { signal, timeoutMs: 30000, maxOutputBytes: 2 * 1024 * 1024 })
      const duration = wavDurationMs(chunk)
      if (!duration) break
      if (index === 240) throw new Error('整场录音超过四小时上限，未截断为成功结果')
      count++
      yield chunk
      if (duration < FULL_AUDIO_CHUNK_SECONDS * 1000 - 1000) break
    }
    if (!count) throw new Error('未能从整场录音中提取可识别的音频')
  } finally { source.body.destroy(); await workspace.close() }
}

export const defaultAudioSplitter: AudioSplitter = (audio, signal) => splitFullInterviewAudio(audio, undefined, signal)

function transcript(segments: SpeakerSegment[]): string {
  return segments.map(segment => segment.text.trim()).filter(Boolean).join('')
}

export class FullAudioTranscription {
  private closed = false
  private readonly lifetime = new AbortController()
  private readonly active = new Map<string, Promise<void>>()
  private readonly starting = new Map<string, Promise<FullAudioTranscriptionJob>>()
  constructor(
    private readonly storage: AudioStore,
    private readonly transcribe: ChunkTranscriber = transcribeInterviewChunk,
    private readonly split: AudioSplitter = defaultAudioSplitter,
  ) {}

  async get(key: string): Promise<FullAudioTranscriptionJob | null> {
    try { return JSON.parse((await this.storage.read(key)).toString('utf8')) as FullAudioTranscriptionJob }
    catch (error) { if (isMissing(error)) return null; throw error }
  }

  start(key: string, loadAudio: (signal?: AbortSignal) => Promise<FullAudioInput>, meter?: RecordedChunkMeter): Promise<FullAudioTranscriptionJob> {
    if (this.closed) return Promise.reject(new Error('整场转写服务正在关闭'))
    const pending = this.starting.get(key)
    if (pending) return pending
    const preparing = this.prepareStart(key, loadAudio, meter).finally(() => this.starting.delete(key))
    this.starting.set(key, preparing)
    return preparing
  }

  async close(): Promise<void> {
    this.closed = true
    this.lifetime.abort()
    await Promise.allSettled(this.starting.values())
    await Promise.allSettled(this.active.values())
  }

  private async prepareStart(key: string, loadAudio: (signal?: AbortSignal) => Promise<FullAudioInput>, meter?: RecordedChunkMeter): Promise<FullAudioTranscriptionJob> {
    const existing = await this.get(key)
    this.lifetime.signal.throwIfAborted()
    if (existing?.status === 'completed') return existing
    if (this.active.has(key)) return existing ?? { status: 'processing', progress: 0, text: '', updatedAt: new Date().toISOString() }
    if (!this.active.has(key)) {
      const initial: FullAudioTranscriptionJob = { status: 'processing', progress: 0, text: '', updatedAt: new Date().toISOString() }
      await this.save(key, initial)
      const work = this.run(key, loadAudio, meter).finally(() => this.active.delete(key))
      this.active.set(key, work)
    }
    return (await this.get(key)) ?? { status: 'processing', progress: 0, text: '', updatedAt: new Date().toISOString() }
  }

  private async run(key: string, loadAudio: (signal?: AbortSignal) => Promise<FullAudioInput>, meter?: RecordedChunkMeter): Promise<void> {
    try {
      this.lifetime.signal.throwIfAborted()
      const chunks = await this.split(await loadAudio(this.lifetime.signal), this.lifetime.signal)
      let text = ''
      let index = 0
      for await (const audio of chunks) {
        this.lifetime.signal.throwIfAborted()
        const action = () => this.transcribe(audio, 'audio/wav')
        const recognized = transcript(await (meter ? meter(audio, index, action) : action()))
        if (recognized) text += (text ? '\n' : '') + recognized
        index++
        await this.save(key, { status: 'processing', progress: Math.min(99, Math.round(index / (Array.isArray(chunks) ? chunks.length : 240) * 100)), text, updatedAt: new Date().toISOString() })
      }
      await this.save(key, { status: 'completed', progress: 100, text, updatedAt: new Date().toISOString() })
    } catch (error) {
      const current = await this.get(key).catch(() => null)
      await this.save(key, { status: 'failed', progress: current?.progress ?? 0, text: current?.text ?? '', error: String((error as { code?: string })?.code ?? '').startsWith('BILLING_') && error instanceof Error ? error.message : '整段转写失败，请检查转写服务后重试。', updatedAt: new Date().toISOString() }).catch(() => undefined)
    }
  }

  private async save(key: string, job: FullAudioTranscriptionJob): Promise<void> {
    await this.storage.write(key, Buffer.from(JSON.stringify(job)), 'application/json; charset=utf-8')
  }
}

