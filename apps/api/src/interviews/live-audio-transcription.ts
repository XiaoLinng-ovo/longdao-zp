import { resolve } from 'node:path'
import { createObjectStorageFromEnv } from '@smartrecruit-pro/object-storage'
import { createDatabasePool } from '../db/connection.js'
import { mapAudioSourceRoles } from './audio-source.js'
import { FunAsrError } from './funasr-client.js'
import { FasterWhisperError } from './faster-whisper-client.js'
import { transcribeLiveInterviewChunk as transcribeInterviewChunk } from './interview-transcriber.js'
import { LiveAudioTranscriptionRepository } from './live-audio-transcription-repository.js'
import { createLiveInterviewAudioStorage } from './live-audio-storage.js'
import { LiveInterviewSessionRepository } from './live-session-repository.js'
import { scopeSpeakersToChunk, stableRoleSpeakerId, type ConfirmedSpeakerRoles, type SpeakerSegment } from './role-mapper.js'
import { reconcileTranscript } from './transcript-checkpoint.js'
import { SessionVoiceprintTracker } from './voiceprint-tracker.js'

export class LiveAudioTranscriptionService {
  constructor(private readonly repository: Pick<LiveAudioTranscriptionRepository, 'claim' | 'complete' | 'retry' | 'progress'>,
    private readonly sessions: Pick<LiveInterviewSessionRepository, 'get'>,
    private readonly storage: { read: (key: string) => Promise<Buffer> },
    private readonly voices = new SessionVoiceprintTracker(),
    private readonly transcribe = transcribeInterviewChunk) {}
  async processPending(): Promise<boolean> {
    const job = await this.repository.claim()
    if (!job) return false
    const startedAt = Date.now()
    const context = { sessionId: job.sessionId, source: job.source?.id, offsetMs: job.offsetMs,
      endMs: job.endMs, attempt: job.attempts }
    console.info('[live-audio-transcription] started', context)
    try {
      // Storage errors must retry; only recognition errors may use the saved stream checkpoint.
      const audio = await this.storage.read(job.objectKey)
      let recognized: SpeakerSegment[]
      try { recognized = await this.transcribe(audio, job.contentType) }
      catch (error) {
        if (!(error instanceof FunAsrError || error instanceof FasterWhisperError)
          || !job.checkpoint?.complete || !job.checkpoint.text.trim()) throw error
        console.warn('[live-audio-transcription] using complete stream checkpoint', context)
        recognized = []
      }
      const duration = job.endMs - job.offsetMs
      recognized = recognized.filter(row => row.startMs >= 0 && row.startMs <= duration)
        .map(row => ({ ...row, endMs: Math.min(duration, row.endMs) }))
      const identified = this.voices.identify(job.sessionId, reconcileTranscript(recognized, job.checkpoint, job.offsetMs), job.source?.id)
      const transcribed = scopeSpeakersToChunk(identified, job.offsetMs)
        .map(row => ({ ...row, startMs: row.startMs + job.offsetMs, endMs: row.endMs + job.offsetMs }))
      const latest = await this.sessions.get(job.sessionId)
      const known: ConfirmedSpeakerRoles = {}, inferred: ConfirmedSpeakerRoles = {}
      for (const item of latest.segments) {
        if (item.role === 'unknown') continue
        if (item.confidence === 1) known[item.speakerId] = item.role
        else if (/(^|:)voice_/.test(item.speakerId) && item.confidence >= .6) inferred[item.speakerId] = item.role
      }
      const mapped = mapAudioSourceRoles(transcribed, job.source, known, inferred)
      const completed = await this.repository.complete(job, mapped.map(item => ({ speakerId: stableRoleSpeakerId(item), role: item.role,
        confidence: item.confidence, text: item.text, startMs: item.startMs, endMs: item.endMs, audioObjectKey: job.objectKey,
        ...(item.audioSource ? { audioSource: item.audioSource } : {}),
        ...(item.transcriptComparison ? { transcriptComparison: item.transcriptComparison } : {}) })))
      console.info('[live-audio-transcription] finished', { ...context, completed, durationMs: Date.now() - startedAt,
        audioBytes: audio.byteLength, segmentCount: mapped.length })
      if (latest.session.status === 'completed' && !(await this.repository.progress(job.sessionId)).pendingCount) this.voices.forget(job.sessionId)
    } catch (error) {
      console.warn('[live-audio-transcription] retry', { ...context, durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error) })
      await this.repository.retry(job, error)
    }
    return true
  }
}

export function createConfiguredLiveAudioTranscriptionService(): LiveAudioTranscriptionService {
  const pool = createDatabasePool()
  const storage = createLiveInterviewAudioStorage(createObjectStorageFromEnv(process.env, resolve(process.cwd(), '../../data/interviews')))
  return new LiveAudioTranscriptionService(new LiveAudioTranscriptionRepository(pool), new LiveInterviewSessionRepository(pool), storage)
}

export function startLiveAudioTranscriptionPoll(service: Pick<LiveAudioTranscriptionService, 'processPending'>, intervalMs = 1000): () => void {
  let running = 0, closed = false
  const tick = async () => {
    if (running >= 2 || closed) return
    running++
    try { for (let count = 0; count < 8 && !closed && await service.processPending(); count++) { /* Bounded drain. */ } }
    catch (error) { console.error('[live-audio-transcription]', error instanceof Error ? error.message : String(error)) }
    finally { running-- }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()
  return () => { closed = true; clearInterval(timer) }
}
