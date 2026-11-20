import { billedRecordingChunks } from './billed-recording.js'
import { createInterviewObjectStorageFromEnv } from '@smartrecruit-pro/object-storage'
import type { InterviewAudioManifestEntry } from './audio-recording-repository.js'
import { mapAudioSourceRoles, type AudioSourceConfig } from './audio-source.js'
import { createFasterWhisperClient, loadFasterWhisperConfig, type FasterWhisperConfig } from './faster-whisper-client.js'
import { FullAudioSource, FullInterviewAudio } from './full-audio.js'
import { FULL_AUDIO_CHUNK_SECONDS, defaultAudioSplitter, type AudioSplitter } from './full-audio-transcription.js'
import { transcribeInterviewChunk } from './interview-transcriber.js'
import { createLiveInterviewAudioStorage } from './live-audio-storage.js'
import { managedInterviewAudioStorage } from './managed-audio-storage.js'
import type { Pool } from 'pg'
import { mapInterviewRoles, scopeSpeakersToChunk, type SpeakerSegment } from './role-mapper.js'
import type { TranscriptEvidenceSegment } from './transcript-postprocessing.js'

type ChunkTranscriber = (audio: Uint8Array, contentType: string) => Promise<SpeakerSegment[]>
type OfflineSource = Exclude<FullAudioSource, 'all'>

export interface OfflineReidentificationResult {
  segments: TranscriptEvidenceSegment[]
  warnings: string[]
  routes: string[]
}

function sourceConfig(source: OfflineSource, manifest: InterviewAudioManifestEntry[]): AudioSourceConfig | undefined {
  if (source === 'legacy') return undefined
  const rows = manifest.filter(row => row.audioSource === source)
  const metadata = rows.find(row => row.sourceRole || typeof row.sourceMultipleSpeakers === 'boolean')
  return {
    id: source,
    role: metadata?.sourceRole ?? 'unknown',
    multipleSpeakers: metadata?.sourceMultipleSpeakers ?? true,
  }
}

function mapRoute(segments: SpeakerSegment[], routeId: string, engine: string, source: OfflineSource,
  config: AudioSourceConfig | undefined, chunkIndex: number): TranscriptEvidenceSegment[] {
  const offset = chunkIndex * FULL_AUDIO_CHUNK_SECONDS * 1000
  const scoped = scopeSpeakersToChunk(segments, offset)
  const mapped = config ? mapAudioSourceRoles(scoped, config, {}, {}) : mapInterviewRoles(scoped, {})
  return mapped.map(row => ({
    evidenceId: `offline:${routeId}:${chunkIndex}:${row.id}`,
    routeId,
    routeKind: 'offline' as const,
    engine,
    ...(source === 'legacy' ? {} : { audioSource: source }),
    speakerId: row.speakerId,
    role: row.role,
    confidence: row.confidence,
    text: row.text,
    startMs: row.startMs + offset,
    endMs: row.endMs + offset,
    roleReasons: row.reasons,
  }))
}

export class InterviewTranscriptReidentifier {
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<OfflineReidentificationResult>>()
  private closing: Promise<void> | undefined
  constructor(
    private readonly fullAudio: Pick<FullInterviewAudio, 'load'> & Partial<Pick<FullInterviewAudio, 'loadStream' | 'close'>>,
    private readonly split: AudioSplitter = defaultAudioSplitter,
    private readonly funasr: ChunkTranscriber = transcribeInterviewChunk,
    private readonly fasterWhisper?: ChunkTranscriber,
    private readonly closeResources?: () => Promise<void>,
  ) {}

  reidentify(sessionId: string, manifest: InterviewAudioManifestEntry[], env?: NodeJS.ProcessEnv): Promise<OfflineReidentificationResult> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('离线重识别服务正在关闭'))
    const work = this.run(sessionId, manifest, env).finally(() => this.active.delete(work))
    this.active.add(work)
    return work
  }

  close(): Promise<void> {
    this.lifetime.abort()
    return this.closing ??= (async () => {
      await Promise.allSettled([...this.active])
      try { await this.fullAudio.close?.() } finally { await this.closeResources?.() }
    })()
  }

  private async run(sessionId: string, manifest: InterviewAudioManifestEntry[], env?: NodeJS.ProcessEnv): Promise<OfflineReidentificationResult> {
    const signal = this.lifetime.signal
    const sources = [...new Set(manifest.flatMap(row => row.audioSource ? [row.audioSource] : ['legacy' as const]))] as OfflineSource[]
    const warnings: string[] = [], routes: string[] = [], segments: TranscriptEvidenceSegment[] = []
    if (!sources.length) return { segments, routes, warnings: ['本场没有可离线重识别的原录音，已改用原始实时字幕和上下文纠错。'] }

    for (const source of sources) {
      signal.throwIfAborted()
      let chunks: AsyncIterable<Buffer> | Buffer[]
      try {
        chunks = await this.split(this.fullAudio.loadStream
          ? await this.fullAudio.loadStream(sessionId, manifest, source, signal)
          : await this.fullAudio.load(sessionId, manifest, source), signal)
      } catch (error) {
        signal.throwIfAborted()
        warnings.push(`${source === 'legacy' ? '历史混合音轨' : source === 'microphone' ? '本机麦克风' : '会议音频'}离线重识别失败：${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const config = sourceConfig(source, manifest)
      const routeId = `offline:${source}:funasr`
      routes.push(routeId)
      const secondRoute = `offline:${source}:faster-whisper`
      let secondRouteFailed = false, chunkIndex = 0
      async function* guardedChunks() {
        try { for await (const audio of chunks) yield audio }
        catch (error) { signal.throwIfAborted(); warnings.push('录音解码中断，已保留成功处理的片段，请核对完整性：' + (error instanceof Error ? error.message : String(error))) }
      }
      for await (const audio of guardedChunks()) {
        signal.throwIfAborted()
        const action = () => this.funasr(audio, 'audio/wav')
        const recognized = await (env ? billedRecordingChunks(env, sessionId, routeId)(audio, chunkIndex, action) : action())
        segments.push(...mapRoute(recognized, routeId, 'funasr', source, config, chunkIndex))
        signal.throwIfAborted()
        if (this.fasterWhisper && !secondRouteFailed) try {
          const transcribe = this.fasterWhisper
          const action = () => transcribe(audio, 'audio/wav')
          const recognized = await (env ? billedRecordingChunks(env, sessionId, secondRoute)(audio, chunkIndex, action) : action())
          segments.push(...mapRoute(recognized, secondRoute, 'faster-whisper', source, config, chunkIndex))
          if (!routes.includes(secondRoute)) routes.push(secondRoute)
        } catch (error) {
          if (String((error as { code?: string })?.code ?? '').startsWith('BILLING_')) throw error
          secondRouteFailed = true
          warnings.push(`faster-whisper 备用识别失败，已保留 FunASR 主结果：${error instanceof Error ? error.message : String(error)}`)
        }
        chunkIndex += 1
      }
      if (secondRouteFailed) routes.splice(routes.indexOf(secondRoute), routes.includes(secondRoute) ? 1 : 0)
    }
    return { segments, routes: [...new Set(routes)], warnings }
  }
}

export function createConfiguredInterviewTranscriptReidentifier(pool: Pool): InterviewTranscriptReidentifier {
  const rawStorage = createInterviewObjectStorageFromEnv(process.env)
  const storage = createLiveInterviewAudioStorage(managedInterviewAudioStorage(pool, rawStorage))
  const fullAudio = new FullInterviewAudio(storage)
  let fasterConfig: FasterWhisperConfig | undefined
  try { fasterConfig = loadFasterWhisperConfig(process.env) } catch { /* The second route is optional. */ }
  const fasterWhisper = fasterConfig
    ? (audio: Uint8Array, contentType: string) => createFasterWhisperClient(fasterConfig).transcribe(audio, contentType)
    : undefined
  return new InterviewTranscriptReidentifier(fullAudio, defaultAudioSplitter, transcribeInterviewChunk, fasterWhisper, async () => { await rawStorage.close?.() })
}
