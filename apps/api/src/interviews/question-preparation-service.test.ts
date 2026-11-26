import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EnterpriseAiError } from '@smartrecruit-pro/enterprise-ai'
import { generateLocalInterviewQuestions, InterviewQuestionGenerationError, type InterviewQuestionGroup } from './question-generator.js'
import { MemoryPreparationRepository } from './question-preparation-repository.js'
import { QuestionPreparationService, preparationInputHash, type PreparationDependencies } from './question-preparation-service.js'
import { preparationBillingIdentity } from './question-preparation-billing.js'
import { createHash } from 'node:crypto'

function harness(final = false) {
  const repository = new MemoryPreparationRepository()
  let input = { jobTitle: '测试岗位', jobRequirements: ['项目经验'], anonymizedResume: '候选人负责招聘系统项目。', analysisSummary: [], questionCount: 10, stage: final ? 'final' as const : 'initial' as const }
  let interview = { id: 'interview-1', applicationId: 'application-1', round: final ? 2 : 1, status: 'scheduled' }
  const calls: InterviewQuestionGroup[] = []
  let rubrics = 0
  let saved: { questions: ReturnType<typeof generateLocalInterviewQuestions>['questions'] } | null = null
  const deps: PreparationDependencies = {
    questions: { get: async () => saved ? { ...saved, interviewId: interview.id, generatedBy: 'actor', engine: 'llm', updatedAt: '' } : null },
    interview: async () => interview,
    context: async () => input,
    generate: async (_id, context, group) => { calls.push(group); return { questions: generateLocalInterviewQuestions({ ...context, includeCommonQuestions: true }).questions.filter(q => q.group === group) } },
    prepareRubrics: async () => { rubrics++ },
  }
  return { repository, deps, calls, get rubrics() { return rubrics }, setSaved(value: typeof saved) { saved = value },
    updateInput() { input = { ...input, jobTitle: '已更新岗位' } }, close() { interview = { ...interview, status: 'completed' } },
    get input() { return input }, service: new QuestionPreparationService(repository, deps) }
}
describe('invitation background question preparation', () => {
  it('评分总分错误不再误报为能力维度错误，保留安全的数字明细', async () => {
    for (const message of [
      '模型返回的评分项 points 总和与该能力维度规定分值不一致。',
      '第 2 题评分项 points 总和为 3，应为 10。私有简历内容不得显示',
    ]) {
      const h = harness()
      h.deps.generate = async () => { throw new InterviewQuestionGenerationError('MODEL_RESPONSE_INVALID', message) }
      await h.service.request('interview-1', 'actor')
      await h.service.processPending()
      const state = await h.service.status('interview-1')
      assert.equal(state.status, 'failed')
      assert.equal(state.failure?.group, 'ai')
      assert.equal(state.failure?.retryable, false)
      assert.match(state.error!, /评分项/u)
      assert.doesNotMatch(state.error!, /能力维度不完整|私有简历/u)
      if (message.startsWith('第')) assert.match(state.error!, /第2题评分项合计3分，应为10分/u)
    }
  })

  it('真正的角色维度错误仍显示维度提示', async () => {
    const h = harness(), generate = h.deps.generate
    h.deps.generate = async (...args) => {
      if (args[2] === 'hr') throw new InterviewQuestionGenerationError('MODEL_RESPONSE_INVALID', '模型返回的能力维度不完整或重复，每个 dimension 必须恰好一道题。')
      return generate(...args)
    }
    await h.service.request('interview-1', 'actor')
    await h.service.processPending()
    const state = await h.service.status('interview-1')
    assert.equal(state.failure?.group, 'hr')
    assert.deepEqual(state.completedGroups, ['ai'])
    assert.match(state.error!, /HR题组生成失败：题目能力维度不完整或重复/u)
  })

  it('关闭等待在途生成和持久化，拒绝新领取并只释放一次依赖', async () => {
    const h = harness()
    let enter!: () => void, release!: () => void, closed = 0
    const entered = new Promise<void>(resolve => { enter = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const generate = h.deps.generate
    h.deps.generate = async (...args) => { enter(); await gate; return generate(...args) }
    h.deps.closeResources = async () => { closed++ }
    await h.service.request('interview-1', 'actor')
    const work = h.service.processPending()
    await entered
    const closing = h.service.close()
    assert.equal(h.service.close(), closing)
    assert.equal(await h.service.processPending(), false)
    assert.equal(closed, 0)
    release()
    await work
    await closing
    assert.ok(h.repository.results.get('interview-1')?.length)
    assert.equal(closed, 1)
  })
  it('queues without calling the model and deduplicates repeated requests', async () => {
    const h = harness()
    assert.equal((await h.service.request('interview-1', 'actor')).status, 'queued')
    await h.service.request('interview-1', 'actor', true)
    assert.equal(h.repository.jobs.size, 1); assert.equal(h.calls.length, 0)
  })
  it('prepares only initial-round groups, fixed criteria, and stores the full AI bank', async () => {
    const h = harness(); await h.service.request('interview-1', 'actor')
    await h.service.processPending()
    assert.deepEqual(h.calls, ['ai', 'hr', 'department']); assert.equal(h.rubrics, 1)
    const result = h.repository.results.get('interview-1')!
    assert.equal(result.length, 20); assert.ok(result.every(q => q.sourceEngine === 'llm'))
    assert.equal((await h.service.status('interview-1')).status, 'ready')
  })
  it('prepares boss questions only for the final round', async () => {
    const h = harness(true); await h.service.request('interview-1', 'actor'); await h.service.processPending()
    assert.deepEqual(h.calls, ['ai', 'hr', 'department', 'boss']); assert.equal(h.repository.results.get('interview-1')!.length, 25)
  })
  it('reuses existing questions without scheduling or overwriting them', async () => {
    const h = harness(); h.setSaved({ questions: generateLocalInterviewQuestions(h.input).questions })
    assert.equal((await h.service.request('interview-1', 'actor', true)).status, 'ready')
    assert.equal(h.repository.jobs.size, 0); assert.equal(h.calls.length, 0)
  })
  it('preserves completed groups when a service restarts and retries only missing work', async () => {
    const h = harness(); const generate = h.deps.generate
    let fail = true
    h.deps.generate = async (...args) => { if (args[2] === 'hr' && fail) throw new Error('network'); return generate(...args) }
    await h.service.request('interview-1', 'actor'); await h.service.processPending()
    assert.deepEqual(h.calls, ['ai']); assert.equal(h.repository.jobs.get('interview-1')?.status, 'queued')
    assert.equal(h.repository.jobs.get('interview-1')?.completedGroups.ai?.length, 10)
    fail = false
    const restarted = new QuestionPreparationService(h.repository, h.deps)
    await restarted.processPending()
    assert.deepEqual(h.calls, ['ai', 'hr', 'department']); assert.equal(h.repository.results.get('interview-1')!.length, 20)
  })
  it('exhausts transient retries and supports explicit retry without losing checkpoints', async () => {
    const h = harness(); h.deps.generate = async () => { throw new Error('network') }
    await h.service.request('interview-1', 'actor')
    for (let i = 0; i < 3; i++) await h.service.processPending()
    assert.equal((await h.service.status('interview-1')).status, 'failed')
    assert.equal(await h.service.processPending(), false)
    assert.equal((await h.service.request('interview-1', 'actor', true)).status, 'queued')
  })
  it('persists the failed stage, group, and stable error code without exposing model response bodies', async () => {
    const h = harness()
    h.deps.generate = async () => { throw new InterviewQuestionGenerationError('MODEL_HTTP_ERROR', 'Question generator returned HTTP 429: private provider body') }
    await h.service.request('interview-1', 'actor')
    for (let i = 0; i < 3; i++) await h.service.processPending()
    const state = await h.service.status('interview-1')
    assert.equal(state.status, 'failed')
    assert.equal(state.failure?.stage, 'question_generation'); assert.equal(state.failure?.group, 'ai')
    assert.equal(state.failure?.code, 'MODEL_HTTP_ERROR'); assert.equal(state.failure?.httpStatus, 429)
    assert.match(state.failure?.diagnosticId ?? '', /^[0-9a-f-]{36}$/u)
    assert.equal(state.error, 'AI题组生成失败：模型服务请求错误（HTTP 429），请检查服务商状态与模型配置。')
    assert.equal(state.error.includes('private provider body'), false)
  })
  for (const status of [400, 401, 403, 404, 422]) {
    it(`does not automatically retry non-transient HTTP ${status} failures`, async () => {
      const h = harness()
      h.deps.generate = async () => { throw new InterviewQuestionGenerationError('MODEL_HTTP_ERROR', 'private body', undefined, { httpStatus: status }) }
      await h.service.request('interview-1', 'actor'); await h.service.processPending()
      const state = await h.service.status('interview-1')
      assert.equal(state.status, 'failed'); assert.equal(state.attempts, 1)
      assert.equal(state.failure?.retryable, false); assert.equal(await h.service.processPending(), false)
      assert.match(state.error!, new RegExp(`HTTP ${status}`))
    })
  }
  for (const reason of ['timeout', 'network'] as const) {
    it(`distinguishes ${reason} failures and requires explicit retry without exposing raw errors`, async () => {
      const h = harness(), logs: unknown[] = []
      h.deps.logger = { error: (...args) => { logs.push(args) } }
      h.deps.generate = async () => { throw new InterviewQuestionGenerationError('MODEL_REQUEST_FAILED', 'secret resume and key', undefined, { reason }) }
      await h.service.request('interview-1', 'actor'); await h.service.processPending()
      const state = await h.service.status('interview-1')
      assert.equal(state.status, 'failed'); assert.equal(state.failure?.reason, reason)
      assert.equal(await h.service.processPending(), false)
      assert.match(state.error!, reason === 'timeout' ? /请求超时/u : /连接中断/u)
      assert.doesNotMatch(JSON.stringify(logs), /secret resume and key/u)
      assert.match(JSON.stringify(logs), new RegExp(state.failure!.diagnosticId!))
      const entry = logs[0] as unknown[]
      assert.equal(entry[0], 'interview-question-preparation-failed')
      assert.equal(typeof entry[1], 'string', 'runtime logger only persists string arguments')
      const diagnostic = JSON.parse(entry[1] as string)
      assert.equal(diagnostic.diagnosticId, state.failure!.diagnosticId)
      assert.equal(diagnostic.reason, reason)
      assert.equal(diagnostic.group, 'ai')
      assert.equal(diagnostic.summary, state.error)
    })
  }
  it('preserves partial groups across exhausted retries and clears stale diagnostics after success', async () => {
    const h = harness(), generate = h.deps.generate
    h.deps.prepareRubrics = async () => 'ready'
    h.deps.generate = async (...args) => {
      if (args[2] === 'hr') throw new InterviewQuestionGenerationError('MODEL_RESPONSE_INVALID', '模型返回 3 道题，应为 5 道。')
      return generate(...args)
    }
    await h.service.request('interview-1', 'actor')
    for (let i = 0; i < 3; i++) await h.service.processPending()
    const failed = await h.service.status('interview-1')
    assert.equal(failed.failure?.group, 'hr'); assert.equal(failed.rubricsStatus, 'ready')
    assert.deepEqual(failed.completedGroups, ['ai']); assert.match(failed.error!, /3道题，应为5道/u)
    h.deps.generate = generate
    const retry = await h.service.request('interview-1', 'actor', true)
    assert.equal(retry.failure, undefined); assert.deepEqual(retry.completedGroups, ['ai'])
    await h.service.processPending()
    const ready = await h.service.status('interview-1')
    assert.equal(ready.status, 'ready'); assert.equal(ready.failure, undefined); assert.equal(ready.error, undefined)
    assert.deepEqual(h.calls, ['ai', 'hr', 'department'])
  })
  it('defers capacity contention without exhausting retries or changing generation identity', async () => {
    const h = harness(), generate = h.deps.generate
    h.deps.generate = async () => { throw new EnterpriseAiError('AI_CHANNEL_BUSY', 'busy', 429) }
    await h.service.request('interview-1', 'actor')
    const identity = h.repository.jobs.get('interview-1')?.generationId
    for (let i = 0; i < 5; i++) {
      await h.service.processPending()
      const state = await h.service.status('interview-1')
      assert.equal(state.status, 'queued'); assert.equal(state.failure?.retryable, true)
      assert.equal(h.repository.jobs.get('interview-1')?.attempts, 0)
      assert.equal(h.repository.jobs.get('interview-1')?.generationId, identity)
    }
    h.deps.generate = generate
    await h.service.processPending()
    assert.equal((await h.service.status('interview-1')).status, 'ready')
  })
  it('classifies platform AI configuration failures as permanent', async () => {
    const h = harness()
    h.deps.generate = async () => { throw new EnterpriseAiError('PLATFORM_AI_NOT_CONFIGURED', 'sensitive internal details') }
    await h.service.request('interview-1', 'actor'); await h.service.processPending()
    const state = await h.service.status('interview-1')
    assert.equal(state.status, 'failed'); assert.equal(state.failure?.code, 'PLATFORM_AI_NOT_CONFIGURED')
    assert.equal(state.failure?.retryable, false); assert.doesNotMatch(state.error!, /sensitive/u)
  })
  it('records rubric and material failures without blaming the question model', async () => {
    for (const stage of ['rubrics', 'context'] as const) {
      const h = harness()
      if (stage === 'rubrics') h.deps.prepareRubrics = async () => { throw new Error('SQL contains personal data') }
      else h.deps.context = async () => { throw new Error('SQL contains personal data') }
      await h.service.request('interview-1', 'actor'); await h.service.processPending()
      const state = await h.service.status('interview-1')
      assert.equal(state.failure?.stage, stage); assert.equal(state.failure?.group, undefined)
      assert.doesNotMatch(state.error!, /personal data/u); assert.equal(h.calls.length, 0)
    }
  })
  it('retries publishing the checkpointed bank without generating any group again', async () => {
    const h = harness(), complete = h.repository.complete.bind(h.repository)
    h.repository.complete = async () => { throw new Error('database disconnected') }
    await h.service.request('interview-1', 'actor'); await h.service.processPending()
    assert.equal((await h.service.status('interview-1')).failure?.stage, 'publish')
    h.repository.complete = complete; await h.service.processPending()
    assert.deepEqual(h.calls, ['ai', 'hr', 'department']); assert.equal((await h.service.status('interview-1')).status, 'ready')
  })
  it('fails clearly without inventing local questions when the enterprise model is unconfigured', async () => {
    const h = harness(); h.deps.generate = async () => { throw new InterviewQuestionGenerationError('AI_NOT_CONFIGURED', '请配置企业模型') }
    await h.service.request('interview-1', 'actor'); await h.service.processPending()
    assert.equal((await h.service.status('interview-1')).status, 'failed')
    assert.equal(h.repository.results.size, 0); assert.equal(h.rubrics, 1)
  })
  it('does not generate or save a bank after the interview is cancelled/completed', async () => {
    const h = harness(); await h.service.request('interview-1', 'actor'); h.close()
    await h.service.processPending(); assert.equal(h.calls.length, 0); assert.equal(h.repository.results.size, 0)
    assert.equal(h.repository.jobs.get('interview-1')?.status, 'cancelled')
  })
  it('does not publish stale material and clears old checkpoints on explicit retry', async () => {
    const h = harness(); const generate = h.deps.generate
    h.deps.generate = async (...args) => { const result = await generate(...args); if (args[2] === 'department') h.updateInput(); return result }
    await h.service.request('interview-1', 'actor'); await h.service.processPending()
    assert.equal(h.repository.results.size, 0); assert.equal((await h.service.status('interview-1')).status, 'failed')
    h.deps.generate = generate
    await h.service.request('interview-1', 'actor', true); await h.service.processPending()
    assert.deepEqual(h.calls, ['ai', 'hr', 'department', 'ai', 'hr', 'department'])
  })
  it('displays material-change hints but never replaces existing questions automatically', async () => {
    const h = harness(); await h.service.request('interview-1', 'actor'); await h.service.processPending()
    const saved = h.repository.results.get('interview-1')!
    h.setSaved({ questions: saved }); h.updateInput()
    assert.equal((await h.service.status('interview-1', true)).materialsChanged, true)
    await h.service.request('interview-1', 'actor', true)
    assert.equal(h.repository.results.get('interview-1'), saved)
  })
  it('uses the same fingerprint for default context and the room count/settings', () => {
    const h = harness()
    assert.equal(preparationInputHash({ ...h.input, questionCount: 5 }), preparationInputHash({ ...h.input, questionCount: 10, includeCommonQuestions: true }))
  })
  it('keeps billing identity across automatic retries and restarts, rotating only accepted explicit retries', async () => {
    const h = harness(), seen: (string | null)[] = [], generate = h.deps.generate
    let failing = true
    h.deps.generate = async (...args) => {
      seen.push(args[3])
      if (args[2] === 'hr' && failing) throw new Error('temporary database failure')
      return generate(...args)
    }
    await h.service.request('interview-1', 'actor')
    const original = (await h.repository.get('interview-1'))!.generationId
    await h.service.request('interview-1', 'actor', true)
    assert.equal((await h.repository.get('interview-1'))!.generationId, original)
    await h.service.processPending()
    const restarted = new QuestionPreparationService(h.repository, h.deps)
    await restarted.processPending(); await restarted.processPending()
    assert.ok(seen.every(id => id === original))
    await restarted.request('interview-1', 'actor')
    assert.equal((await h.repository.get('interview-1'))!.generationId, original)
    await restarted.request('interview-1', 'actor', true)
    const next = (await h.repository.get('interview-1'))!.generationId
    assert.notEqual(next, original)
    await Promise.all([restarted.request('interview-1', 'actor', true), restarted.request('interview-1', 'actor', true)])
    assert.equal((await h.repository.get('interview-1'))!.generationId, next)
    failing = false
    await restarted.processPending()
    assert.deepEqual(h.calls, ['ai', 'hr', 'department'])
    assert.equal((await restarted.status('interview-1')).status, 'ready')
  })
  it('preserves legacy keys and scopes new operation keys by generation and group', () => {
    const h = harness(), fingerprint = { id: 'interview-1', input: h.input, group: 'ai' }
    const legacy = 'prep:' + createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex')
    assert.equal(preparationBillingIdentity('interview-1', h.input, 'ai', null).key, legacy)
    const next = preparationBillingIdentity('interview-1', h.input, 'ai', 'generation-1')
    assert.notEqual(next.key, legacy)
    assert.equal(next.key, preparationBillingIdentity('interview-1', h.input, 'ai', 'generation-1').key)
    assert.notEqual(next.key, preparationBillingIdentity('interview-1', h.input, 'ai', 'generation-2').key)
    assert.notEqual(next.key, preparationBillingIdentity('interview-1', h.input, 'hr', 'generation-1').key)
  })
  it('renders accurate legacy billing errors without rewriting the stored failure', async () => {
    const h = harness()
    await h.service.request('interview-1', 'actor')
    const job = h.repository.jobs.get('interview-1')!
    job.status = 'failed'
    job.error = 'AI服务配置或企业访问状态不可用，请联系管理员检查后重试。'
    job.failure = { stage: 'question_generation', group: 'ai', code: 'BILLING_TASK_EXISTS' }
    const original = structuredClone(job)
    assert.match((await h.service.status('interview-1')).error!, /待核对/u)
    assert.deepEqual(job, original)
  })
  for (const [code, expected] of [['BILLING_TASK_EXISTS', /待核对/u], ['BILLING_QUOTA_EXHAUSTED', /额度不足/u], ['BILLING_CONCURRENCY_LIMIT', /排队/u], ['BILLING_DAILY_LIMIT', /今日AI用量/u]]) {
    it(`shows an actionable sanitized ${code} message`, async () => {
      const h = harness()
      h.deps.generate = async () => { throw new EnterpriseAiError(code as string, 'private upstream credential') }
      await h.service.request('interview-1', 'actor'); await h.service.processPending()
      const state = await h.service.status('interview-1')
      assert.equal(state.status, code === 'BILLING_CONCURRENCY_LIMIT' ? 'queued' : 'failed'); assert.match(state.error!, expected as RegExp)
      assert.doesNotMatch(state.error!, /private upstream|配置或企业访问/u)
      if (code !== 'BILLING_CONCURRENCY_LIMIT') assert.equal(await h.service.processPending(), false)
    })
  }
})
