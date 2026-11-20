import { meterAiOperation, EnterpriseAiStore as EnterpriseAiStoreClass } from '@smartrecruit-pro/enterprise-ai'
import { startBackgroundPoll } from '../background-poll.js'
import { createDatabasePool } from '../db/connection.js'
import type { InterviewAudioManifestEntry } from './audio-recording-repository.js'
import { createConfiguredInterviewTranscriptReidentifier, type OfflineReidentificationResult } from './interview-transcript-reidentification.js'
import { InterviewTranscriptPostprocessRepository, type TranscriptPostprocessJob, type TranscriptVersionInput } from './interview-transcript-postprocess-repository.js'
import type { QuestionSheetRepository } from './question-sheet-repository.js'
import { QuestionSheetRepository as QuestionSheetRepositoryClass } from './question-sheet-repository.js'
import { createQuestionSheetAiResolver } from './question-sheet-runtime.js'
import { createConfiguredTranscriptContextCorrector, type TranscriptContext, type TranscriptContextCorrectionResult } from './transcript-context-corrector.js'
import { consolidateTranscript, rawSegmentsToEvidence, reviewRoleBoundaries, transcriptCoverageWarning, transcriptRoleReviewWarning } from './transcript-postprocessing.js'
import { SemanticRoleReviewer } from './semantic-role-review.js'

type PostprocessRepository = Pick<InterviewTranscriptPostprocessRepository, 'claim' | 'load' | 'updatePhase' | 'retry' | 'publish'>
type Reidentifier = { reidentify: (sessionId: string, manifest: InterviewAudioManifestEntry[], env?: NodeJS.ProcessEnv) => Promise<OfflineReidentificationResult>; close?(): Promise<void> }
type Corrector = { correct: (input: { turns: ReturnType<typeof consolidateTranscript>['turns']; context: TranscriptContext }, env: NodeJS.ProcessEnv) => Promise<TranscriptContextCorrectionResult> }
type JobContextRepository = Pick<QuestionSheetRepository, 'getApplicationJobContext'>

export class InterviewTranscriptPostprocessService {
  private closing: Promise<void> | undefined
  private readonly active = new Set<Promise<boolean>>()
  constructor(
    private readonly repository: PostprocessRepository,
    private readonly reidentifier: Reidentifier,
    private readonly corrector: Corrector,
    private readonly jobs: JobContextRepository,
    private readonly resolveAiEnv: (applicationId: string) => Promise<NodeJS.ProcessEnv>,
    private readonly roleReviewer = new SemanticRoleReviewer(),
    private readonly closeResources?: () => Promise<void>,
  ) {}

  processPending(): Promise<boolean> {
    return this.claimAndProcess()
  }

  processSession(sessionId: string): Promise<boolean> {
    return this.claimAndProcess(sessionId)
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      await Promise.allSettled([...this.active])
      try { await this.reidentifier.close?.() } finally { await this.closeResources?.() }
    })()
  }

  private claimAndProcess(sessionId?: string): Promise<boolean> {
    if (this.closing) return Promise.resolve(false)
    const work = (async () => {
      const job = await this.repository.claim(sessionId)
      return job ? this.process(job) : false
    })().finally(() => this.active.delete(work))
    this.active.add(work)
    return work
  }

  private async process(job: TranscriptPostprocessJob): Promise<true> {
    const startedAt = Date.now()
    console.info('[interview-transcript-postprocess] started', { sessionId: job.sessionId, attempts: job.attempts })
    try {
      const snapshot = await this.repository.load(job)
      let billingEnv: NodeJS.ProcessEnv = {}, configWarning = ''
      try { billingEnv = await this.resolveAiEnv(job.applicationId) }
      catch (error) { configWarning = '无法读取平台模型配置，将发布确定性整理版：' + (error instanceof Error ? error.message : String(error)) }
      // Finish audio reservations before reserving the text task (including maxConcurrent=1).
      const offline = configWarning ? { segments: [], warnings: [], routes: [] }
        : await this.reidentifier.reidentify(job.sessionId, snapshot.manifest, billingEnv)
      await meterAiOperation(billingEnv, 'transcript_processing', 'post:' + job.sessionId + ':' + snapshot.fingerprint, {sessionId:job.sessionId,fingerprint:snapshot.fingerprint}, async () => {
      if (!(await this.repository.updatePhase(job, 'deduplication'))) throw new Error('转写整理任务租约已失效')
      const consolidated = consolidateTranscript(offline.segments, rawSegmentsToEvidence(snapshot.segments))
      if (!(await this.repository.updatePhase(job, 'role_review'))) throw new Error('转写整理任务租约已失效')
      const reviewedTurns = reviewRoleBoundaries(consolidated.turns)
      if (!(await this.repository.updatePhase(job, 'context_correction'))) throw new Error('转写整理任务租约已失效')

      const warnings = [...offline.warnings, ...(configWarning ? [configWarning] : [])]
      const coverageWarning = transcriptCoverageWarning(snapshot.sessionDurationMs, snapshot.manifest)
      if (coverageWarning) warnings.push(coverageWarning)
      let context: TranscriptContext = { candidateName: '', jobTitle: '', requirements: [], skills: [] }
      try {
        const loaded = await this.jobs.getApplicationJobContext(job.applicationId)
        if (loaded) context = loaded
        else warnings.push('无法读取岗位上下文，已跳过依赖岗位信息的术语纠正。')
      } catch (error) {
        warnings.push(`无法读取岗位上下文，已继续处理转写：${error instanceof Error ? error.message : String(error)}`)
      }
      const env = billingEnv
      const corrected = await this.corrector.correct({ turns: reviewedTurns, context }, env)
      warnings.push(...corrected.warnings)
      if (!(await this.repository.updatePhase(job, 'role_review'))) throw new Error('转写整理任务租约已失效')
      const semantic = await this.roleReviewer.review(corrected.turns, env, { heartbeat: async () => {
        if (!(await this.repository.updatePhase(job, 'role_review'))) throw new Error('角色复核任务租约已失效')
      } })
      warnings.push(...semantic.warnings)
      const roleWarning = transcriptRoleReviewWarning(snapshot.manifest, semantic.turns)
      if (roleWarning) warnings.push(roleWarning)

      if (!(await this.repository.updatePhase(job, 'publishing'))) throw new Error('转写整理任务租约已失效')
      const input: TranscriptVersionInput = {
        turns: semantic.turns,
        evidence: consolidated.evidence,
        corrections: corrected.corrections,
        uncertainties: corrected.uncertainties,
        warnings: [...new Set(warnings)],
        audioRoutes: [...new Set(['live-realtime', ...offline.routes])],
        roleReviewRequired: Boolean(roleWarning),
      }
      const outcome = await this.repository.publish(job, snapshot.fingerprint, input)
      console.info('[interview-transcript-postprocess] finished', { sessionId: job.sessionId, outcome,
        durationMs: Date.now() - startedAt, turns: input.turns.length, evidence: input.evidence.length })
      return true
      }, 1, 'background')
    } catch (error) {
      console.warn('[interview-transcript-postprocess] retry', { sessionId: job.sessionId, attempts: job.attempts,
        error: error instanceof Error ? error.message : String(error) })
      await this.repository.retry(job, error)
    }
    return true
  }
}

export function createConfiguredInterviewTranscriptPostprocessService(providedPool?: ReturnType<typeof createDatabasePool>): InterviewTranscriptPostprocessService {
  const pool = providedPool ?? createDatabasePool()
  return new InterviewTranscriptPostprocessService(
    new InterviewTranscriptPostprocessRepository(pool),
    createConfiguredInterviewTranscriptReidentifier(pool),
    createConfiguredTranscriptContextCorrector(),
    new QuestionSheetRepositoryClass(pool),
    createQuestionSheetAiResolver(pool, new EnterpriseAiStoreClass(pool)),
    undefined,
    async () => { if (!providedPool) await pool.end() },
  )
}

export function startInterviewTranscriptPostprocessPoll(
  service: Pick<InterviewTranscriptPostprocessService, 'processPending'> & Partial<Pick<InterviewTranscriptPostprocessService, 'close'>>, intervalMs = 2000): () => Promise<void> {
  const stop = startBackgroundPoll({ intervalMs, run: async stopped => {
    for (let count = 0; count < 3 && !stopped() && await service.processPending(); count++) { /* Bounded drain. */ }
  }, onError: error => { console.error('[interview-transcript-postprocess]', error instanceof Error ? error.name : 'unknown') } })
  let closing: Promise<void> | undefined
  return () => closing ??= (async () => { try { await stop() } finally { await service.close?.() } })()
}
