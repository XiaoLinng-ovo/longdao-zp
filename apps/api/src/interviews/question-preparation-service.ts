import { createHash, randomUUID } from 'node:crypto'
import { startBackgroundPoll } from '../background-poll.js'
import { EnterpriseAiError, isExecutionBusy } from '@smartrecruit-pro/enterprise-ai'
import { InterviewQuestionGenerationError, type GeneratedInterviewQuestion, type InterviewQuestionGenerationInput, type InterviewQuestionGroup } from './question-generator.js'
import type { InterviewQuestionSetRepository } from './interview-question-set-repository.js'
import type { PreparationFailure, PreparationFailureStage, PreparationRepository, QuestionPreparation } from './question-preparation-repository.js'
import { preparationBillingFailureMessage } from './question-preparation-billing.js'

export interface PreparationInterview { id: string; applicationId: string; status: string; round: number; stage?: 'initial' | 'final' }
export interface PreparationDependencies {
  questions: Pick<InterviewQuestionSetRepository, 'get'>
  interview(id: string): Promise<PreparationInterview>
  context(id: string): Promise<InterviewQuestionGenerationInput>
  generate(id: string, input: InterviewQuestionGenerationInput, group: InterviewQuestionGroup, generationId: string | null): Promise<{ questions: GeneratedInterviewQuestion[] }>
  prepareRubrics(interview: PreparationInterview, actorId: string): Promise<'queued' | 'ready' | void>
  logger?: Pick<Console, 'error'>
  closeResources?(): Promise<void>
}
export function preparationInputHash(input: InterviewQuestionGenerationInput): string {
  return createHash('sha256').update(JSON.stringify({ ...input, questionCount: 10, includeCommonQuestions: true })).digest('hex')
}

export class QuestionPreparationService {
  private closing: Promise<void> | undefined
  private readonly active = new Set<Promise<boolean>>()
  constructor(readonly repository: PreparationRepository, private readonly dependencies: PreparationDependencies) {}
  close(): Promise<void> {
    return this.closing ??= (async () => {
      await Promise.allSettled([...this.active])
      await this.dependencies.closeResources?.()
    })()
  }
  async request(interviewId: string, actorId: string, retry = false): Promise<QuestionPreparation> {
    const interview = await this.dependencies.interview(interviewId)
    const saved = await this.dependencies.questions.get(interviewId)
    if (saved?.questions.length) return { status: 'ready', completedGroups: [] }
    if (interview.status !== 'scheduled') return { status: 'cancelled', completedGroups: [] }
    await this.repository.enqueue(interviewId, actorId, retry)
    return this.status(interviewId)
  }
  async status(interviewId: string, inspectMaterials = false): Promise<QuestionPreparation> {
    const state = (await this.repository.list([interviewId])).get(interviewId) ?? { status: 'not_started' as const, completedGroups: [] }
    const saved = await this.dependencies.questions.get(interviewId)
    if (saved?.questions.length) {
      const job = inspectMaterials ? await this.repository.get(interviewId) : null
      const materialsChanged = Boolean(job?.inputHash && job.inputHash !== preparationInputHash(await this.dependencies.context(interviewId)))
      const { error: _error, failure: _failure, nextRetryAt: _nextRetryAt, ...ready } = state
      return { ...ready, status: 'ready', materialsChanged }
    }
    return state
  }
  processPending(): Promise<boolean> {
    if (this.closing) return Promise.resolve(false)
    const work = this.run().finally(() => this.active.delete(work))
    this.active.add(work)
    return work
  }
  private async run(): Promise<boolean> {
    const job = await this.repository.claim()
    if (!job) return false
    const startedAt = Date.now()
    let failureStage: PreparationFailureStage = 'rubrics'
    let failureGroup: InterviewQuestionGroup | undefined
    const heartbeat = setInterval(() => { void this.repository.heartbeat(job).catch(() => undefined) }, 25_000)
    heartbeat.unref()
    try {
      const interview = await this.dependencies.interview(job.interviewId)
      if (interview.status !== 'scheduled') { await this.repository.cancel(job); return true }
      // These are fixed human-scored criteria, not AI-generated interview questions.
      const rubricsStatus = await this.dependencies.prepareRubrics(interview, job.requestedBy)
      if (rubricsStatus) job.rubricsStatus = rubricsStatus
      failureStage = 'publish'
      if (!await this.repository.checkpoint(job)) return true
      const saved = await this.dependencies.questions.get(job.interviewId)
      if (saved?.questions.length) { await this.repository.complete(job, saved.questions); return true }
      failureStage = 'context'
      const input = { ...await this.dependencies.context(job.interviewId), questionCount: 10, includeCommonQuestions: true }
      const hash = preparationInputHash(input)
      if (job.inputHash !== hash) job.completedGroups = {}
      job.inputHash = hash
      failureStage = 'publish'
      if (!await this.repository.checkpoint(job)) return true
      failureStage = 'context'
      const groups: InterviewQuestionGroup[] = ['ai', 'hr', 'department', ...(input.stage === 'final' ? ['boss' as const] : [])]
      for (const group of groups) {
        if (job.completedGroups[group]?.length) continue
        failureStage = 'question_generation'
        failureGroup = group
        const latest = await this.dependencies.interview(job.interviewId)
        if (latest.status !== 'scheduled') { await this.repository.cancel(job); return true }
        const generated = await this.dependencies.generate(job.interviewId, input, group, job.generationId)
        if (generated.questions.length !== (group === 'ai' ? 10 : 5) || generated.questions.some(question => question.group !== group || !question.question.trim())) {
          throw new InterviewQuestionGenerationError('MODEL_RESPONSE_INVALID', '模型返回的面试表不完整，请重试。')
        }
        job.completedGroups[group] = generated.questions.map(question => ({ ...question, sourceEngine: 'llm' }))
        if (!await this.repository.checkpoint(job)) return true
      }
      failureGroup = undefined
      failureStage = 'context'
      if (preparationInputHash(await this.dependencies.context(job.interviewId)) !== hash) {
        throw new InterviewQuestionGenerationError('INVALID_INPUT', 'MATERIALS_CHANGED')
      }
      failureStage = 'publish'
      const current = await this.dependencies.interview(job.interviewId)
      if (current.status !== 'scheduled') await this.repository.cancel(job)
      else await this.repository.complete(job, groups.flatMap(group => job.completedGroups[group]!))
    } catch (error) {
      const materialsChanged = error instanceof InterviewQuestionGenerationError && error.code === 'INVALID_INPUT' && error.message === 'MATERIALS_CHANGED'
      const code = materialsChanged ? 'MATERIALS_CHANGED' : error instanceof InterviewQuestionGenerationError || error instanceof EnterpriseAiError ? error.code : 'PREPARATION_FAILED'
      const status = error instanceof InterviewQuestionGenerationError ? error.diagnostic?.httpStatus
        ?? Number(error.code === 'MODEL_HTTP_ERROR' ? error.message.match(/HTTP\s+(\d{3})/iu)?.[1] : NaN) : NaN
      const busy = isExecutionBusy(error)
      const retryable = error instanceof EnterpriseAiError ? busy
        : !['AI_NOT_CONFIGURED', 'INVALID_INPUT', 'MATERIALS_CHANGED', 'MODEL_REQUEST_FAILED', 'MODEL_RESPONSE_INVALID'].includes(code)
          && !(code === 'MODEL_HTTP_ERROR' && Number.isFinite(status) && ![408, 429].includes(status) && status < 500)
      const failure: PreparationFailure = {
        stage: materialsChanged ? 'context' : failureStage, ...(failureGroup ? { group: failureGroup } : {}), code,
        diagnosticId: randomUUID(), retryable,
        durationMs: Date.now() - startedAt,
        ...(Number.isFinite(status) ? { httpStatus: status } : {}),
        ...(error instanceof InterviewQuestionGenerationError && error.diagnostic?.reason ? { reason: error.diagnostic.reason } : {}),
        ...(error instanceof InterviewQuestionGenerationError && error.diagnostic?.model ? { model: error.diagnostic.model } : {}),
      }
      const message = preparationFailureMessage(error, failure)
      await this.repository.fail(job, message, busy || retryable && job.attempts < 3, failure)
      // The managed runtime omits object arguments; persist only sanitized diagnostics.
      this.dependencies.logger?.error('interview-question-preparation-failed', JSON.stringify({
        interviewId: job.interviewId, attempt: job.attempts, ...failure,
        summary: message,
      }))
    } finally { clearInterval(heartbeat) }
    return true
  }
}

function preparationFailureMessage(error: unknown, failure: PreparationFailure): string {
  const groupLabels: Record<InterviewQuestionGroup, string> = { ai: 'AI', hr: 'HR', department: '用人部门', boss: 'BOSS' }
  const prefix = failure.group ? `${groupLabels[failure.group]}题组` : failure.stage === 'rubrics' ? '评价表' : '面试表'
  if (failure.code === 'AI_NOT_CONFIGURED' || failure.code === 'INVALID_INPUT') {
    return `${prefix}准备失败：${failure.code === 'AI_NOT_CONFIGURED' ? 'AI模型配置不完整或无效，请联系管理员检查。' : '面试资料无效，请检查简历、岗位及面试状态。'}`
  }
  if (failure.code === 'MATERIALS_CHANGED') return '简历或岗位资料已更新，请重试以准备最新面试表。'
  if (error instanceof EnterpriseAiError) {
    return preparationBillingFailureMessage(failure.code) ?? 'AI服务配置或企业访问状态不可用，请联系管理员检查后重试。'
  }
  if (failure.code === 'MODEL_RESPONSE_INVALID' && error instanceof Error) {
    // Only extract numeric validation metadata, never echo upstream text or candidate data.
    const count = error.message.match(/模型返回 (\d+) 道题，应为 (\d+) 道/u)
    const points = error.message.match(/第 (\d+) 题评分项 points 总和为 (\d+)，应为 (\d+)/u)
    const reason = count ? `模型返回${count[1]}道题，应为${count[2]}道。`
      : /原文依据/u.test(error.message) ? '题目缺少简历原文依据，请重试。'
      : /截断/u.test(error.message) ? '模型输出被截断，请重试或检查模型输出容量。'
      : /重复题目/u.test(error.message) ? '模型返回重复题目，请重试。'
      : points ? '第' + points[1] + '题评分项合计' + points[2] + '分，应为' + points[3] + '分，请重试。'
      : /points|分值/u.test(error.message) ? '题目评分项分值不符合要求，请重试。'
      : /维度/u.test(error.message) ? '题目能力维度不完整或重复，请重试。'
      : '模型返回格式或题目内容未通过校验，请重试。'
    return `${prefix}生成失败：${reason}`
  }
  if (failure.code === 'MODEL_HTTP_ERROR') {
    const status = failure.httpStatus
    return `${prefix}生成失败：模型服务请求错误${status ? `（HTTP ${status}）` : ''}，${status === 401 || status === 403 ? '请联系管理员检查模型访问凭证和权限。' : '请检查服务商状态与模型配置。'}`
  }
  if (failure.code === 'MODEL_REQUEST_FAILED') {
    return `${prefix}生成失败：${failure.reason === 'timeout' ? '模型请求超时' : failure.reason === 'network' ? '模型连接中断' : '模型请求超时或连接中断'}。上次调用结果待核对，未自动重复调用；确认后可点击重试，新任务可能产生新的调用费用。`
  }
  if (failure.stage === 'rubrics') return '评价表准备失败，请检查本轮评价表生成状态后重试。'
  if (failure.stage === 'context') return '读取面试资料失败，请检查候选人简历与岗位资料后重试。'
  if (failure.stage === 'publish') return '面试题已生成，但保存题库失败，请重试。'
  return `${prefix}准备失败，请查看服务日志中的任务编号后重试。`
}

/** A single sequential consumer respects providers with one-request-per-key limits. */
export function startQuestionPreparationPoll(service: QuestionPreparationService, intervalMs = 1500): () => Promise<void> {
  const stop = startBackgroundPoll({ intervalMs, run: async stopped => {
    while (!stopped() && await service.processPending()) { /* Drain only claimable work. */ }
  }, onError: error => { console.error('interview-question-preparation-poll-failed', error instanceof Error ? error.name : 'unknown') } })
  let closing: Promise<void> | undefined
  return () => closing ??= (async () => { try { await stop() } finally { await service.close() } })()
}
