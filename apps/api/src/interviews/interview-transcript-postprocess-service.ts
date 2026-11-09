import { EnterpriseAiStore as EnterpriseAiStoreClass } from '@smartrecruit-pro/enterprise-ai'
import { createDatabasePool } from '../db/connection.js'
import type { InterviewAudioManifestEntry } from './audio-recording-repository.js'
import { createConfiguredInterviewTranscriptReidentifier, type OfflineReidentificationResult } from './interview-transcript-reidentification.js'
import { InterviewTranscriptPostprocessRepository, type TranscriptPostprocessJob, type TranscriptVersionInput } from './interview-transcript-postprocess-repository.js'
import type { QuestionSheetRepository } from './question-sheet-repository.js'
import { QuestionSheetRepository as QuestionSheetRepositoryClass } from './question-sheet-repository.js'
import { createQuestionSheetAiResolver } from './question-sheet-runtime.js'
import { createConfiguredTranscriptContextCorrector, type TranscriptContext, type TranscriptContextCorrectionResult } from './transcript-context-corrector.js'
import { consolidateTranscript, rawSegmentsToEvidence, reviewRoleBoundaries, transcriptCoverageWarning, transcriptRoleReviewWarning } from './transcript-postprocessing.js'

type PostprocessRepository = Pick<InterviewTranscriptPostprocessRepository, 'claim' | 'load' | 'updatePhase' | 'retry' | 'publish'>
type Reidentifier = { reidentify: (sessionId: string, manifest: InterviewAudioManifestEntry[]) => Promise<OfflineReidentificationResult> }
type Corrector = { correct: (input: { turns: ReturnType<typeof consolidateTranscript>['turns']; context: TranscriptContext }, env: NodeJS.ProcessEnv) => Promise<TranscriptContextCorrectionResult> }
type JobContextRepository = Pick<QuestionSheetRepository, 'getApplicationJobContext'>

export class InterviewTranscriptPostprocessService {
  constructor(
    private readonly repository: PostprocessRepository,
    private readonly reidentifier: Reidentifier,
    private readonly corrector: Corrector,
    private readonly jobs: JobContextRepository,
    private readonly resolveAiEnv: (applicationId: string) => Promise<NodeJS.ProcessEnv>,
  ) {}

  async processPending(): Promise<boolean> {
    const job = await this.repository.claim()
    if (!job) return false
    return this.process(job)
  }

  async processSession(sessionId: string): Promise<boolean> {
    const job = await this.repository.claim(sessionId)
    if (!job) return false
    return this.process(job)
  }

  private async process(job: TranscriptPostprocessJob): Promise<true> {
    const startedAt = Date.now()
    console.info('[interview-transcript-postprocess] started', { sessionId: job.sessionId, attempts: job.attempts })
    try {
      const snapshot = await this.repository.load(job)
      const offline = await this.reidentifier.reidentify(job.sessionId, snapshot.manifest)
      if (!(await this.repository.updatePhase(job, 'deduplication'))) return true
      const consolidated = consolidateTranscript(offline.segments, rawSegmentsToEvidence(snapshot.segments))
      if (!(await this.repository.updatePhase(job, 'role_review'))) return true
      const reviewedTurns = reviewRoleBoundaries(consolidated.turns)
      if (!(await this.repository.updatePhase(job, 'context_correction'))) return true

      const warnings = [...offline.warnings]
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
      let env: NodeJS.ProcessEnv = {}
      try { env = await this.resolveAiEnv(job.applicationId) }
      catch (error) {
        warnings.push(`无法读取企业模型配置，将发布确定性整理版：${error instanceof Error ? error.message : String(error)}`)
      }
      const corrected = await this.corrector.correct({ turns: reviewedTurns, context }, env)
      warnings.push(...corrected.warnings)
      const roleWarning = transcriptRoleReviewWarning(snapshot.manifest, corrected.turns)
      if (roleWarning) warnings.push(roleWarning)

      if (!(await this.repository.updatePhase(job, 'publishing'))) return true
      const input: TranscriptVersionInput = {
        turns: corrected.turns,
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
    } catch (error) {
      console.warn('[interview-transcript-postprocess] retry', { sessionId: job.sessionId, attempts: job.attempts,
        error: error instanceof Error ? error.message : String(error) })
      await this.repository.retry(job, error)
    }
    return true
  }
}

export function createConfiguredInterviewTranscriptPostprocessService(): InterviewTranscriptPostprocessService {
  const pool = createDatabasePool()
  return new InterviewTranscriptPostprocessService(
    new InterviewTranscriptPostprocessRepository(pool),
    createConfiguredInterviewTranscriptReidentifier(),
    createConfiguredTranscriptContextCorrector(),
    new QuestionSheetRepositoryClass(pool),
    createQuestionSheetAiResolver(pool, new EnterpriseAiStoreClass(pool)),
  )
}

export function startInterviewTranscriptPostprocessPoll(
  service: Pick<InterviewTranscriptPostprocessService, 'processPending'>, intervalMs = 2000): () => void {
  let running = 0, closed = false
  const tick = async () => {
    if (running >= 1 || closed) return
    running++
    try { for (let count = 0; count < 3 && !closed && await service.processPending(); count++) { /* Bounded drain. */ } }
    catch (error) { console.error('[interview-transcript-postprocess]', error instanceof Error ? error.message : String(error)) }
    finally { running-- }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()
  return () => { closed = true; clearInterval(timer) }
}
