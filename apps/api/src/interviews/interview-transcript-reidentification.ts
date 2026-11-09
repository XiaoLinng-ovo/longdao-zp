import { resolve } from 'node:path'
import { createObjectStorageFromEnv } from '@smartrecruit-pro/object-storage'
import type { InterviewAudioManifestEntry } from './audio-recording-repository.js'
import { mapAudioSourceRoles, type AudioSourceConfig } from './audio-source.js'
import { createFasterWhisperClient, loadFasterWhisperConfig, type FasterWhisperConfig } from './faster-whisper-client.js'
import { FullAudioSource, FullInterviewAudio } from './full-audio.js'
import { FULL_AUDIO_CHUNK_SECONDS, splitFullInterviewAudio } from './full-audio-transcription.js'
import { transcribeInterviewChunk } from './interview-transcriber.js'
import { createLiveInterviewAudioStorage } from './live-audio-storage.js'
import { mapInterviewRoles, scopeSpeakersToChunk, type SpeakerSegment } from './role-mapper.js'
import type { TranscriptEvidenceSegment } from './transcript-postprocessing.js'

type ChunkTranscriber = (audio: Uint8Array, contentType: string) => Promise<SpeakerSegment[]>
type AudioSplitter = (audio: Buffer) => Promise<Buffer[]>
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
  constructor(
    private readonly fullAudio: Pick<FullInterviewAudio, 'load'>,
    private readonly split: AudioSplitter = splitFullInterviewAudio,
    private readonly funasr: ChunkTranscriber = transcribeInterviewChunk,
    private readonly fasterWhisper?: ChunkTranscriber,
  ) {}

  async reidentify(sessionId: string, manifest: InterviewAudioManifestEntry[]): Promise<OfflineReidentificationResult> {
    const sources = [...new Set(manifest.flatMap(row => row.audioSource ? [row.audioSource] : ['legacy' as const]))] as OfflineSource[]
    const warnings: string[] = [], routes: string[] = [], segments: TranscriptEvidenceSegment[] = []
    if (!sources.length) return { segments, routes, warnings: ['本场没有可离线重识别的原录音，已改用原始实时字幕和上下文纠错。'] }

    for (const source of sources) {
      let chunks: Buffer[]
      try {
        chunks = await this.split(await this.fullAudio.load(sessionId, manifest, source))
      } catch (error) {
        warnings.push(`${source === 'legacy' ? '历史混合音轨' : source === 'microphone' ? '本机麦克风' : '会议音频'}离线重识别失败：${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const config = sourceConfig(source, manifest)
      const routeId = `offline:${source}:funasr`
      routes.push(routeId)
      for (const [chunkIndex, audio] of chunks.entries()) {
        const recognized = await this.funasr(audio, 'audio/wav')
        segments.push(...mapRoute(recognized, routeId, 'funasr', source, config, chunkIndex))
      }

      if (!this.fasterWhisper) continue
      const secondRoute = `offline:${source}:faster-whisper`
      let secondRouteFailed = false
      for (const [chunkIndex, audio] of chunks.entries()) {
        try {
          const recognized = await this.fasterWhisper(audio, 'audio/wav')
          segments.push(...mapRoute(recognized, secondRoute, 'faster-whisper', source, config, chunkIndex))
          if (!routes.includes(secondRoute)) routes.push(secondRoute)
        } catch (error) {
          secondRouteFailed = true
          warnings.push(`faster-whisper 备用识别失败，已保留 FunASR 主结果：${error instanceof Error ? error.message : String(error)}`)
          break
        }
      }
      if (secondRouteFailed) routes.splice(routes.indexOf(secondRoute), routes.includes(secondRoute) ? 1 : 0)
    }
    return { segments, routes: [...new Set(routes)], warnings }
  }
}

export function createConfiguredInterviewTranscriptReidentifier(): InterviewTranscriptReidentifier {
  const storage = createLiveInterviewAudioStorage(createObjectStorageFromEnv(process.env, resolve(process.cwd(), '../../data/interviews')))
  const fullAudio = new FullInterviewAudio(storage)
  let fasterConfig: FasterWhisperConfig | undefined
  try { fasterConfig = loadFasterWhisperConfig(process.env) } catch { /* The second route is optional. */ }
  const fasterWhisper = fasterConfig
    ? (audio: Uint8Array, contentType: string) => createFasterWhisperClient(fasterConfig).transcribe(audio, contentType)
    : undefined
  return new InterviewTranscriptReidentifier(fullAudio, splitFullInterviewAudio, transcribeInterviewChunk, fasterWhisper)
}
