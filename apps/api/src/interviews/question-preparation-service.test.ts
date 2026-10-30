import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EnterpriseAiError } from '@smartrecruit-pro/enterprise-ai'
import { generateLocalInterviewQuestions, InterviewQuestionGenerationError, type InterviewQuestionGroup } from './question-generator.js'
import { MemoryPreparationRepository } from './question-preparation-repository.js'
import { QuestionPreparationService, preparationInputHash, type PreparationDependencies } from './question-preparation-service.js'

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
    it(`distinguishes ${reason} failures and retries without exposing raw errors`, async () => {
      const h = harness(), logs: unknown[] = []
      h.deps.logger = { error: (...args) => { logs.push(args) } }
      h.deps.generate = async () => { throw new InterviewQuestionGenerationError('MODEL_REQUEST_FAILED', 'secret resume and key', undefined, { reason }) }
      await h.service.request('interview-1', 'actor'); await h.service.processPending()
      const state = await h.service.status('interview-1')
      assert.equal(state.status, 'queued'); assert.equal(state.failure?.reason, reason)
      assert.match(state.error!, reason === 'timeout' ? /请求超时/u : /连接中断/u)
      assert.doesNotMatch(JSON.stringify(logs), /secret resume and key/u)
      assert.match(JSON.stringify(logs), new RegExp(state.failure!.diagnosticId!))
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
})
