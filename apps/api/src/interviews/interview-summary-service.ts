import { createDatabasePool } from '../db/connection.js'
import { createQuestionSheetAiResolver } from './question-sheet-runtime.js'
import { EnterpriseAiStore } from '@smartrecruit-pro/enterprise-ai'
import { LiveInterviewSessionRepository } from './live-session-repository.js'
import { QuestionSheetRepository } from './question-sheet-repository.js'
import { loadQuestionSheetGeneratorConfig } from './question-sheet-generator.js'
import { createInterviewSummaryGenerator, createUnscoredSummary, reliableCandidateTurns } from './interview-summary.js'
import { InterviewSummaryRepository } from './interview-summary-repository.js'

export class InterviewSummaryService {
  constructor(private readonly repository: Pick<InterviewSummaryRepository, 'claim' | 'save' | 'latest' | 'request'>,
    private readonly sessions: Pick<LiveInterviewSessionRepository, 'get'>,
    private readonly jobs: Pick<QuestionSheetRepository, 'getApplicationJobContext'>,
    private readonly resolveAiEnv: (applicationId: string) => Promise<NodeJS.ProcessEnv>,
    private readonly fetchImpl: typeof fetch = fetch) {}
  latest(interviewId: string) { return this.repository.latest(interviewId) }
  request(interviewId: string, actorId: string) { return this.repository.request(interviewId, actorId) }
  async processPending(): Promise<boolean> {
    const job = await this.repository.claim()
    if (!job) return false
    let report = createUnscoredSummary([])
    try {
      const { segments } = await this.sessions.get(job.sessionId)
      report = createUnscoredSummary(segments)
      if (!report.transcript.length) {
        report.summary = '本场尚无已保存的语音转写，无法进行有证据的评分。'
        report.warnings.push('请检查录音是否成功保存，不能用参考面试表代替本场实际内容。')
      } else if (!reliableCandidateTurns(report.transcript).length) {
        report.summary = '已保留本场完整转写，但没有可确认归属的候选人发言，暂不评分。'
        report.warnings.push('请核实说话人和重叠发言后重新生成总结，不要求与参考问题逐题配对。')
      } else {
        const context = await this.jobs.getApplicationJobContext(job.applicationId)
        if (!context) throw new Error('无法读取所属岗位，未使用其他岗位规则评分。')
        const config = loadQuestionSheetGeneratorConfig(await this.resolveAiEnv(job.applicationId))
        // A full interview needs a larger budget than a short question-sheet request.
        // Two bounded attempts still finish before the repository's 15-minute claim lease.
        const timeoutMs = Math.min(300000, Math.max(config.timeoutMs, report.transcript.length >= 100 ? 300000 : 180000))
        report = await createInterviewSummaryGenerator({ ...config, timeoutMs }, this.fetchImpl).generate({ ...report, model: config.model }, context)
      }
      await this.repository.save(job, report, null)
    } catch (error) {
      // A model failure must leave the complete transcript and all actual questions available.
      await this.repository.save(job, report, error instanceof Error ? error.message : String(error))
    }
    return true
  }
}

export function createConfiguredInterviewSummaryService(): InterviewSummaryService {
  const pool = createDatabasePool()
  return new InterviewSummaryService(new InterviewSummaryRepository(pool), new LiveInterviewSessionRepository(pool),
    new QuestionSheetRepository(pool), createQuestionSheetAiResolver(pool, new EnterpriseAiStore(pool)))
}

export function startInterviewSummaryPoll(service: Pick<InterviewSummaryService, 'processPending'>, intervalMs = 3000): () => void {
  let running = 0
  let closed = false
  const tick = async () => {
    if (running >= 2 || closed) return
    running++
    try { for (let count = 0; count < 3 && !closed && await service.processPending(); count++) { /* Drain a bounded batch. */ } }
    catch (error) { console.error('[interview-summary]', error instanceof Error ? error.message : String(error)) }
    finally { running-- }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()
  return () => { closed = true; clearInterval(timer) }
}
