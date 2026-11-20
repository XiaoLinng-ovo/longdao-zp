import { createDatabasePool } from '../db/connection.js'
import { startBackgroundPoll } from '../background-poll.js'
import { createQuestionSheetAiResolver } from './question-sheet-runtime.js'
import { EnterpriseAiStore, createBillingFetch, meterAiOperation, isExecutionBusy } from '@smartrecruit-pro/enterprise-ai'
import { LiveInterviewSessionRepository } from './live-session-repository.js'
import { QuestionSheetRepository } from './question-sheet-repository.js'
import { loadQuestionSheetGeneratorConfig } from './question-sheet-generator.js'
import { assessTranscriptQuality, createInterviewSummaryGenerator, createUnscoredSummary } from './interview-summary.js'
import { InterviewSummaryRepository } from './interview-summary-repository.js'

export class InterviewSummaryService {
  private closing: Promise<void> | undefined
  private readonly active = new Set<Promise<boolean>>()
  constructor(private readonly repository: Pick<InterviewSummaryRepository, 'claim' | 'save' | 'latest' | 'request'> & Partial<Pick<InterviewSummaryRepository, 'defer'>>,
    private readonly sessions: Pick<LiveInterviewSessionRepository, 'get'>,
    private readonly jobs: Pick<QuestionSheetRepository, 'getApplicationJobContext'>,
    private readonly resolveAiEnv: (applicationId: string) => Promise<NodeJS.ProcessEnv>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly closeResources?: () => Promise<void>) {}
  close(): Promise<void> {
    return this.closing ??= (async () => {
      await Promise.allSettled([...this.active])
      await this.closeResources?.()
    })()
  }
  latest(interviewId: string) { return this.repository.latest(interviewId) }
  request(interviewId: string, actorId: string) { return this.repository.request(interviewId, actorId) }
  processPending(): Promise<boolean> {
    if (this.closing) return Promise.resolve(false)
    const work = this.run().finally(() => this.active.delete(work))
    this.active.add(work)
    return work
  }
  private async run(): Promise<boolean> {
    const job = await this.repository.claim()
    if (!job) return false
    const previousReport = job.previousReport
    let report = previousReport ?? createUnscoredSummary([])
    try {
      const { segments, transcriptWarnings = [], transcriptRoleReviewRequired = false } = await this.sessions.get(job.sessionId)
      report = createUnscoredSummary(segments)
      report.warnings.push(...transcriptWarnings)
      report.warnings = [...new Set(report.warnings)]
      if (!report.transcript.length) {
        report.summary = '本场尚无已保存的语音转写，无法进行有证据的评分。'
        report.warnings.push('请检查录音是否成功保存，不能用参考面试表代替本场实际内容。')
      } else {
        const quality = assessTranscriptQuality(report.transcript, transcriptRoleReviewRequired)
        if (!quality.usable) {
          report.reviewRequired = true
          report.summary = quality.warning ?? '面试转写证据不足，暂不评分。'
          report.warnings.push(report.summary)
          report.warnings.push('请核实说话人和重叠发言后重新生成总结，不要求与参考问题逐题配对。')
          report.warnings = [...new Set(report.warnings)]
          await this.repository.save(job, report, null)
          return true
        }
        const context = await this.jobs.getApplicationJobContext(job.applicationId)
        if (!context) throw new Error('无法读取所属岗位，未使用其他岗位规则评分。')
        const env = await this.resolveAiEnv(job.applicationId)
        const config = loadQuestionSheetGeneratorConfig(env)
        // A full interview needs a larger budget than a short question-sheet request.
        // Two bounded attempts still finish before the repository's 15-minute claim lease.
        const timeoutMs = Math.min(300000, Math.max(config.timeoutMs, report.transcript.length >= 100 ? 300000 : 180000))
        report = await meterAiOperation(env, 'interview_summary', 'summary:' + job.sessionId + ':' + job.revision, { sessionId: job.sessionId, revision: job.revision }, () => createInterviewSummaryGenerator({ ...config, timeoutMs }, createBillingFetch(env, this.fetchImpl)).generate({ ...report, model: config.model }, context), 1, 'background')
      }
      await this.repository.save(job, report, null)
    } catch (error) {
      if (isExecutionBusy(error) && this.repository.defer) { await this.repository.defer(job); return true }
      // A model failure must leave the complete transcript and all actual questions available.
      // Never replace an already evidenced report with an empty placeholder after regeneration fails.
      await this.repository.save(job, previousReport ?? report, error instanceof Error ? error.message : String(error))
    }
    return true
  }
}

export function createConfiguredInterviewSummaryService(providedPool?: ReturnType<typeof createDatabasePool>): InterviewSummaryService {
  const pool = providedPool ?? createDatabasePool()
  return new InterviewSummaryService(new InterviewSummaryRepository(pool), new LiveInterviewSessionRepository(pool),
    new QuestionSheetRepository(pool), createQuestionSheetAiResolver(pool, new EnterpriseAiStore(pool)), undefined,
    async () => { if (!providedPool) await pool.end() })
}

export function startInterviewSummaryPoll(service: Pick<InterviewSummaryService, 'processPending'> & Partial<Pick<InterviewSummaryService, 'close'>>, intervalMs = 3000): () => Promise<void> {
  const stop = startBackgroundPoll({ intervalMs, concurrency: 2, run: async stopped => {
    for (let count = 0; count < 3 && !stopped() && await service.processPending(); count++) { /* Bounded drain. */ }
  }, onError: error => { console.error('[interview-summary]', error instanceof Error ? error.name : 'unknown') } })
  let closing: Promise<void> | undefined
  return () => closing ??= (async () => { try { await stop() } finally { await service.close?.() } })()
}
