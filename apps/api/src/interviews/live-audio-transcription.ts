import { createHash } from 'node:crypto'
import { startBackgroundPoll } from '../background-poll.js'
import { EnterpriseAiStore, meterInterviewAudio } from '@smartrecruit-pro/enterprise-ai'
import { createInterviewObjectStorageFromEnv } from '@smartrecruit-pro/object-storage'
import { createDatabasePool } from '../db/connection.js'
import { mapAudioSourceRoles } from './audio-source.js'
import { FunAsrError } from './funasr-client.js'
import { FasterWhisperError } from './faster-whisper-client.js'
import { transcribeLiveInterviewChunk as transcribeInterviewChunk } from './interview-transcriber.js'
import { LiveAudioTranscriptionRepository } from './live-audio-transcription-repository.js'
import { createLiveInterviewAudioStorage } from './live-audio-storage.js'
import { managedInterviewAudioStorage } from './managed-audio-storage.js'
import { LiveInterviewSessionRepository } from './live-session-repository.js'
import { scopeSpeakersToChunk, stableRoleSpeakerId, type ConfirmedSpeakerRoles, type SpeakerSegment } from './role-mapper.js'
import { reconcileTranscript } from './transcript-checkpoint.js'
import { SessionVoiceprintTracker } from './voiceprint-tracker.js'
import { createConfiguredLiveSemanticRoleReviewer, type LiveSemanticReviewer } from './live-semantic-role-review.js'

export class LiveAudioTranscriptionService {
  private readonly active = new Set<Promise<boolean>>()
  private closing: Promise<void> | undefined
  constructor(private readonly repository: Pick<LiveAudioTranscriptionRepository, 'claim' | 'complete' | 'retry' | 'progress' | 'relabelFromEvidence'>,
    private readonly sessions: Pick<LiveInterviewSessionRepository, 'get'>,
    private readonly storage: { read: (key: string) => Promise<Buffer> },
    private readonly voices = new SessionVoiceprintTracker(),
    private readonly transcribe = transcribeInterviewChunk,
    private readonly reviewRoles: LiveSemanticReviewer = async (_sessionId, turns) => turns,
    private readonly meter: <T>(job: {sessionId:string;objectKey:string;offsetMs:number;endMs:number},action:()=>Promise<T>)=>Promise<T> = async (_job,action)=>action(),
    private readonly closeResources?: () => Promise<void>) {}
  processPending(): Promise<boolean> {
    if (this.closing) return Promise.resolve(false)
    const work = this.run().finally(() => this.active.delete(work))
    this.active.add(work)
    return work
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      await Promise.allSettled([...this.active])
      await this.closeResources?.()
    })()
  }
  private async run(): Promise<boolean> {
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
      try { recognized = await this.meter(job, () => this.transcribe(audio, job.contentType)) }
      catch (error) {
        if (!(error instanceof FunAsrError || error instanceof FasterWhisperError)
          || !job.checkpoint?.complete || !job.checkpoint.text.trim()) throw error
        console.warn('[live-audio-transcription] using complete stream checkpoint', context)
        recognized = []
      }
      const duration = job.endMs - job.offsetMs
      recognized = recognized.filter(row => row.startMs >= 0 && row.startMs <= duration)
        .map(row => ({ ...row, endMs: Math.min(duration, row.endMs) }))
      // Resolve acoustic identities before text reconciliation can collapse a conflicting
      // chunk into a single unknown recovery row. The comparison retains the original
      // identified acoustic segments for later review even when streaming text wins.
      const identified = this.voices.identify(job.sessionId, recognized, job.source?.id)
      const reconciled = reconcileTranscript(identified, job.checkpoint, job.offsetMs)
      const transcribed = scopeSpeakersToChunk(reconciled, job.offsetMs)
        .map(row => ({ ...row, startMs: row.startMs + job.offsetMs, endMs: row.endMs + job.offsetMs }))
      const latest = await this.sessions.get(job.sessionId)
      const known: ConfirmedSpeakerRoles = {}, inferred: ConfirmedSpeakerRoles = {}
      for (const item of latest.segments) {
        if (item.role === 'unknown') continue
        if ((!item.roleReview && item.confidence === 1) || (item.speakerConfirmed && /(^|:)voice_/.test(item.speakerId))) known[item.speakerId] = item.role
        else if (/(^|:)voice_/.test(item.speakerId) && item.confidence >= .6 && !item.roleReview) inferred[item.speakerId] = item.role
      }
      const mapped = await this.reviewRoles(job.sessionId, mapAudioSourceRoles(transcribed, job.source, known, inferred), latest.segments)
      const completed = await this.repository.complete(job, mapped.map(item => ({ speakerId: stableRoleSpeakerId(item), role: item.role,
        confidence: item.confidence, text: item.text, startMs: item.startMs, endMs: item.endMs, audioObjectKey: job.objectKey,
        ...(item.audioSource ? { audioSource: item.audioSource } : {}),
        ...(item.roleReview ? { roleReview: item.roleReview } : {}),
        ...(item.transcriptComparison ? { transcriptComparison: item.transcriptComparison } : {}) })))
      // A chunk only carries a few seconds of context, so its sentences often
      // land as unknown first. Once a voice has consistent role evidence, backfill
      // its earlier unknown turns so the transcript does not stay half-anonymous.
      let relabelled = 0
      if (completed) {
        try { relabelled = await this.repository.relabelFromEvidence(job.sessionId) }
        catch (error) {
          console.warn('[live-audio-transcription] relabel skipped', { ...context,
            error: error instanceof Error ? error.message : String(error) })
        }
      }
      console.info('[live-audio-transcription] finished', { ...context, completed, relabelled, durationMs: Date.now() - startedAt,
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

export function createConfiguredLiveAudioTranscriptionService(providedPool?: ReturnType<typeof createDatabasePool>): LiveAudioTranscriptionService {
  const pool = providedPool ?? createDatabasePool()
  const rawStorage = createInterviewObjectStorageFromEnv(process.env)
  const storage = createLiveInterviewAudioStorage(managedInterviewAudioStorage(pool, rawStorage))
  return new LiveAudioTranscriptionService(new LiveAudioTranscriptionRepository(pool), new LiveInterviewSessionRepository(pool), storage,
    undefined, async (audio,contentType) => transcribeInterviewChunk(audio,contentType), createConfiguredLiveSemanticRoleReviewer(pool), async (job,action) => {
      const result=await pool.query('SELECT i.organization_id FROM interview_live_sessions s JOIN interviews i ON i.id=s.interview_id WHERE s.id=$1',[job.sessionId])
      if (!result.rows[0]) throw new Error('面试会话不存在')
      const env=await new EnterpriseAiStore(pool).runtimeEnv(String(result.rows[0].organization_id))
      return meterInterviewAudio(env,'chunk:'+createHash('sha256').update(job.sessionId+':'+job.objectKey).digest('hex'),{sessionId:job.sessionId,startMs:job.offsetMs,endMs:job.endMs},action)
    }, async () => {
      try { await rawStorage.close?.() } finally { if (!providedPool) await pool.end() }
    })
}

export function startLiveAudioTranscriptionPoll(service: Pick<LiveAudioTranscriptionService, 'processPending'> & Partial<Pick<LiveAudioTranscriptionService, 'close'>>, intervalMs = 1000,
  concurrency = Number(process.env.AI_AUDIO_GLOBAL_CONCURRENT ?? 1)): () => Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Invalid audio worker concurrency')
  // Match local workers to provider capacity; cross-process admission still uses database locks.
  const stop = startBackgroundPoll({ intervalMs, concurrency, run: async stopped => {
    for (let count = 0; count < 8 && !stopped() && await service.processPending(); count++) { /* Bounded drain. */ }
  }, onError: error => { console.error('[live-audio-transcription]', error instanceof Error ? error.name : 'unknown') } })
  let closing: Promise<void> | undefined
  return () => closing ??= (async () => { try { await stop() } finally { await service.close?.() } })()
}
