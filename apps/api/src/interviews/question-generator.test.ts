import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type GeneratedInterviewQuestion,
  InterviewQuestionGenerationError,
  COMMON_CAPABILITY_DIMENSIONS,
  generateLocalInterviewQuestions,
  createInterviewQuestionGenerator,
  loadInterviewQuestionGeneratorConfig,
} from './question-generator.js'

const validModelPayload = {
  questions: [
    {
      category: 'technical',
      difficulty: 'medium',
      question: '请说明你会如何为高并发订单接口设计幂等机制？',
      rationale: '验证岗位要求中的分布式系统设计能力。',
      groundedIn: ['岗位要求：熟悉高并发系统', '简历摘要：参与过订单平台建设'],
      scoringRubric: [
        { criterion: '识别重复请求风险', points: 3 },
        { criterion: '提出可落地的幂等键与存储方案', points: 4 },
        { criterion: '说明异常与并发处理', points: 3 },
      ],
    },
  ],
} satisfies { questions: GeneratedInterviewQuestion[] }

function responseWith(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('interview question generation', () => {
  it('uses one OpenAI-compatible endpoint and returns advisory structured questions', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = []
    const generator = createInterviewQuestionGenerator(
      { baseUrl: 'https://llm.example/v1/', apiKey: 'secret', model: 'approved-model', timeoutMs: 2_000 },
      async (url, init) => {
        requests.push({ url: String(url), init })
        return responseWith(JSON.stringify(validModelPayload))
      },
    )

    const result = await generator.generate({
      jobTitle: 'Java 后端工程师',
      jobRequirements: ['熟悉高并发系统', '掌握 PostgreSQL'],
      anonymizedResume: '候选人参与过订单平台建设，联系方式为 [EMAIL]。',
      analysisSummary: ['有 6 年后端经验', '数据库优化经验需要核实'],
      questionCount: 1,
    })

    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.url, 'https://llm.example/v1/chat/completions')
    assert.equal((requests[0]?.init?.headers as Record<string, string>).Authorization, 'Bearer secret')
    const requestBody = JSON.parse(String(requests[0]?.init?.body))
    assert.equal(requestBody.model, 'approved-model')
    assert.match(requestBody.messages[1].content, /\[EMAIL\]/u)
    assert.equal(result.advisoryOnly, true)
    assert.equal(result.applicationStatusMutation, 'none')
    assert.deepEqual(result.questions, validModelPayload.questions)
  })

  it('loads a single model configuration and rejects incomplete configuration', () => {
    assert.deepEqual(loadInterviewQuestionGeneratorConfig({
      OPENAI_BASE_URL: 'https://llm.example/v1',
      OPENAI_API_KEY: 'key',
      OPENAI_MODEL: 'model-a',
      OPENAI_TIMEOUT_MS: '45000',
    }), { baseUrl: 'https://llm.example/v1', apiKey: 'key', model: 'model-a', timeoutMs: 45_000 })

    assert.throws(
      () => loadInterviewQuestionGeneratorConfig({ OPENAI_BASE_URL: 'https://llm.example/v1' }),
      (error: unknown) => error instanceof InterviewQuestionGenerationError && error.code === 'AI_NOT_CONFIGURED',
    )
  })

  it('fails closed when the model returns invalid question JSON', async () => {
    const generator = createInterviewQuestionGenerator(
      { baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'model', timeoutMs: 2_000 },
      async () => responseWith(JSON.stringify({
        questions: [{ ...validModelPayload.questions[0], difficulty: 'expert', unexpected: true }],
      })),
    )

    await assert.rejects(
      generator.generate({
        jobTitle: '后端工程师',
        jobRequirements: ['高并发'],
        anonymizedResume: '[NAME] 有后端经验',
        analysisSummary: ['经验待核实'],
        questionCount: 1,
      }),
      (error: unknown) => error instanceof InterviewQuestionGenerationError && error.code === 'MODEL_RESPONSE_INVALID',
    )
  })

  it('accepts common model variations such as string groundedIn or missing rationale', async () => {
    const generator = createInterviewQuestionGenerator(
      { baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'model', timeoutMs: 2_000 },
      async () => responseWith(JSON.stringify({
        questions: [{
          question: '请描述一次你排查线上性能问题的经历。',
          category: 'technical',
          difficulty: 'hard',
          groundedIn: '岗位要求：高并发；简历：8 年后端经验',
          scoringRubric: [{ criterion: '定位过程', points: 3 }, { criterion: '量化结果', points: 2 }],
        }],
      })),
    )

    const result = await generator.generate({
      jobTitle: '后端工程师',
      jobRequirements: ['高并发'],
      anonymizedResume: '[NAME] 有后端经验',
      analysisSummary: [],
      questionCount: 1,
    })

    assert.deepEqual(result.questions[0]?.groundedIn, ['岗位要求：高并发；简历：8 年后端经验'])
    assert.equal(typeof result.questions[0]?.rationale, 'string')
    assert.equal(result.questions[0]?.scoringRubric.length, 2)
  })

  it('fails closed on upstream errors without returning partial questions', async () => {
    const generator = createInterviewQuestionGenerator(
      { baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'model', timeoutMs: 2_000 },
      async () => responseWith('{"error":"unavailable"}', 503),
    )

    await assert.rejects(
      generator.generate({
        jobTitle: '后端工程师',
        jobRequirements: ['PostgreSQL'],
        anonymizedResume: '匿名简历',
        analysisSummary: [],
        questionCount: 1,
      }),
      (error: unknown) => error instanceof InterviewQuestionGenerationError && error.code === 'MODEL_HTTP_ERROR',
    )
  })
})


const bankInput = { jobTitle: '后端工程师', jobRequirements: ['高并发'], anonymizedResume: '[NAME] 有后端经验', analysisSummary: ['项目贡献待核实'], questionCount: 10, includeCommonQuestions: true }
function generatedBank(final = false): GeneratedInterviewQuestion[] {
  return [
    ...Array.from({ length: 10 }, (_, index) => ({ ...validModelPayload.questions[0]!, group: 'ai' as const, question: `简历针对性问题 ${index + 1}` })),
    ...((final ? ['hr', 'department', 'boss'] : ['hr', 'department']) as Array<'hr' | 'department' | 'boss'>).flatMap(group => COMMON_CAPABILITY_DIMENSIONS[group].map(dimension => ({ ...validModelPayload.questions[0]!, group, dimension: dimension.id, question: `${group}能力题：${dimension.title}`, groundedIn: ['岗位能力维度：' + dimension.focus], scoringRubric: [{ criterion: dimension.focus, points: dimension.points }] }))),
  ]
}
function bankGenerator(payload: unknown, requests: RequestInit[] = []) {
  return createInterviewQuestionGenerator({ baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'model', timeoutMs: 2000 }, async (_, init) => { requests.push(init!); const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content); const questions = Array.isArray(payload) && input.requestedGroup ? payload.filter(question => question.group === input.requestedGroup) : payload; return responseWith(JSON.stringify({ questions })) })
}
describe('AI capability question bank', () => {
  it('generates 10 resume questions and one question per HR / department dimension with diverse sampling', async () => {
    const requests: RequestInit[] = []
    const result = await bankGenerator(generatedBank().reverse(), requests).generate(bankInput)
    assert.equal(result.questions.length, 20)
    assert.deepEqual(result.questions.map(question => question.group), [...Array(10).fill('ai'), ...Array(5).fill('hr'), ...Array(5).fill('department')])
    const body = JSON.parse(String(requests[0]!.body))
    assert.equal(body.temperature, 0.75)
    const prompt = body.messages[0].content
    assert.match(prompt, /不复制模板/)
    assert.match(prompt, /不依赖简历特定项目/)
    assert.equal(requests.length, 3)
    const hrRequest = requests.map(request => JSON.parse(String(request.body))).find(request => JSON.parse(request.messages[1].content).requestedGroup === 'hr')
    assert.deepEqual(JSON.parse(hrRequest.messages[1].content).capabilityDimensions, { hr: COMMON_CAPABILITY_DIMENSIONS.hr })
    assert.equal(JSON.parse(hrRequest.messages[1].content).anonymizedResume, '')
  })
  it('rejects omitted, duplicate, unknown dimensions, incorrect groups and score totals', async () => {
    for (const mutate of [
      (questions: ReturnType<typeof generatedBank>) => { questions.pop() },
      (questions: ReturnType<typeof generatedBank>) => { questions[11]!.dimension = questions[10]!.dimension! },
      (questions: ReturnType<typeof generatedBank>) => { questions[10]!.dimension = 'unknown' },
      (questions: ReturnType<typeof generatedBank>) => { questions[10]!.group = 'ai' },
      (questions: ReturnType<typeof generatedBank>) => { questions[1]!.question = questions[0]!.question },
      (questions: ReturnType<typeof generatedBank>) => { questions[15]!.scoringRubric = [{ criterion: '考察点', points: 1 }] },
    ]) {
      const questions = generatedBank(); mutate(questions)
      const requests: RequestInit[] = []
      await assert.rejects(bankGenerator(questions, requests).generate(bankInput), (error: unknown) => error instanceof InterviewQuestionGenerationError && error.code === 'MODEL_RESPONSE_INVALID')
      assert.ok(requests.length >= 3)
    }
  })
  it('keeps legacy single-group callers compatible and rejects invalid includeCommonQuestions', async () => {
    await assert.rejects(bankGenerator(generatedBank()).generate({ ...bankInput, includeCommonQuestions: 'yes' as never }), (error: unknown) => error instanceof InterviewQuestionGenerationError && error.code === 'INVALID_INPUT')
    const result = await bankGenerator(validModelPayload.questions).generate({ ...bankInput, questionCount: 1, includeCommonQuestions: false })
    assert.deepEqual(result.questions, validModelPayload.questions)
  })
  it('returns an explicitly local, complete and distinct fallback without claiming AI random generation', () => {
    const result = generateLocalInterviewQuestions(bankInput)
    assert.equal(result.questions.length, 20)
    assert.equal(new Set(result.questions.map(question => question.question)).size, 20)
    for (const group of ['hr', 'department'] as const) {
      const questions = result.questions.filter(question => question.group === group)
      assert.equal(questions.length, 5)
      for (const question of questions) { assert.match(question.rationale, /不是大模型随机生成/); assert.equal(question.scoringRubric.reduce((sum, rubric) => sum + rubric.points, 0), group === 'hr' ? 8 : 12) }
    }
  })
})


describe('第二轮复试题库', () => {
  it('生成25题，BOSS每个维度一题并使用复试出题要求', async () => {
    const requests: RequestInit[] = []
    const result = await bankGenerator(generatedBank(true).reverse(), requests).generate({ ...bankInput, stage: 'final' })
    assert.equal(result.questions.length, 25)
    assert.equal(result.questions.filter(item => item.group === 'ai').length, 10)
    assert.deepEqual(result.questions.filter(item => item.group === 'boss').map(item => item.dimension).sort(), COMMON_CAPABILITY_DIMENSIONS.boss.map(item => item.id).sort())
    assert.equal(requests.length, 4)
    const body = requests.map(request => JSON.parse(String(request.body))).find(request => JSON.parse(request.messages[1].content).requestedGroup === 'boss')
    assert.match(body.messages[0].content, /第二轮复试/)
    assert.match(body.messages[0].content, /group=boss/)
    assert.deepEqual(JSON.parse(body.messages[1].content).capabilityDimensions.boss, COMMON_CAPABILITY_DIMENSIONS.boss)
  })
  it('拒绝把第一轮20题或错误的BOSS维度、分值当作复试题库', async () => {
    for (const mutate of [
      (q: GeneratedInterviewQuestion[]) => { q.splice(20) },
      (q: GeneratedInterviewQuestion[]) => { q[21]!.dimension = q[20]!.dimension! },
      (q: GeneratedInterviewQuestion[]) => { q[20]!.scoringRubric = [{ criterion: '考察点', points: 12 }] },
      (q: GeneratedInterviewQuestion[]) => { q[20]!.group = 'department' },
    ]) {
      const questions = generatedBank(true); mutate(questions)
      await assert.rejects(bankGenerator(questions).generate({ ...bankInput, stage: 'final' }), (error: unknown) => error instanceof InterviewQuestionGenerationError && error.code === 'MODEL_RESPONSE_INVALID')
    }
  })
  it('未配置模型的复试参考题仍完整包含25题，BOSS每题20分', () => {
    const result = generateLocalInterviewQuestions({ ...bankInput, stage: 'final' })
    assert.equal(result.questions.length, 25)
    assert.equal(new Set(result.questions.map(item => item.question)).size, 25)
    for (const q of result.questions.filter(item => item.group === 'boss')) assert.equal(q.scoringRubric.reduce((sum, item) => sum + item.points, 0), 20)
  })
})


describe('题库生成并行与超时保护', () => {
  const config = { baseUrl: 'https://llm.example/v1', apiKey: 'test-key', model: 'mock', timeoutMs: 2000 }
  const groupOf = (init?: RequestInit): string => JSON.parse(JSON.parse(String(init?.body)).messages[1].content).requestedGroup
  const responseFor = (group: string) => responseWith(JSON.stringify({ questions: generatedBank(true).filter(q => q.group === group) }))
  it('四组请求同时开始，全部通过校验后再合并', async () => {
    const releases: Array<() => void> = []
    const signals: AbortSignal[] = []
    const generator = createInterviewQuestionGenerator(config, async (_, init) => {
      signals.push(init!.signal! as AbortSignal)
      await new Promise<void>(resolve => releases.push(resolve))
      return responseFor(groupOf(init))
    })
    const pending = generator.generate({ ...bankInput, stage: 'final' })
    assert.equal(releases.length, 4)
    assert.equal(new Set(signals).size, 1)
    releases.forEach(release => release())
    assert.equal((await pending).questions.length, 25)
    assert.ok(signals.every(signal => signal.aborted))
  })
  it('只重试格式失败的组，已成功的组不重复调用', async () => {
    const calls: Record<string, number> = {}
    const generator = createInterviewQuestionGenerator(config, async (_, init) => {
      const group = groupOf(init)
      calls[group] = (calls[group] ?? 0) + 1
      return group === 'hr' && calls[group] === 1 ? responseWith('{}') : responseFor(group)
    })
    assert.equal((await generator.generate({ ...bankInput, stage: 'final' })).questions.length, 25)
    assert.deepEqual(calls, { ai: 1, hr: 2, department: 1, boss: 1 })
  })
  it('响应正文不结束时，总超时仍退出并中止所有请求', async () => {
    const signals: AbortSignal[] = []
    const generator = createInterviewQuestionGenerator({ ...config, timeoutMs: 30 }, async (_, init) => {
      signals.push(init!.signal! as AbortSignal)
      const response = responseFor(groupOf(init))
      response.json = () => new Promise<never>(() => {})
      return response
    })
    await assert.rejects(generator.generate({ ...bankInput, stage: 'final' }), (error: unknown) => error instanceof InterviewQuestionGenerationError && /超时/.test(error.message))
    assert.equal(signals.length, 4)
    assert.ok(signals.every(signal => signal.aborted))
  })
  it('格式重试沿用同一个总超时，不能重新开始计时', async () => {
    const signals: AbortSignal[] = []
    const generator = createInterviewQuestionGenerator({ ...config, timeoutMs: 40 }, async (_, init) => {
      signals.push(init!.signal! as AbortSignal)
      if (signals.length === 1) { await new Promise(resolve => setTimeout(resolve, 20)); return responseWith('{}') }
      return new Promise<never>(() => {})
    })
    await assert.rejects(generator.generate({ ...bankInput, questionCount: 1, includeCommonQuestions: false }), /超时/)
    assert.equal(signals.length, 2)
    assert.equal(signals[0], signals[1])
    assert.ok(signals[1]!.aborted)
  })
  it('外部取消终止四组，预先取消时不启动请求', async () => {
    const signals: AbortSignal[] = []
    const controller = new AbortController()
    const generator = createInterviewQuestionGenerator(config, async (_, init) => { signals.push(init!.signal! as AbortSignal); return new Promise<never>(() => {}) })
    const pending = generator.generate({ ...bankInput, stage: 'final' }, controller.signal)
    const rejected = assert.rejects(pending, /已取消/)
    controller.abort()
    await rejected
    assert.equal(signals.length, 4)
    assert.ok(signals.every(signal => signal.aborted))
    await assert.rejects(generator.generate(bankInput, controller.signal), /已取消/)
    assert.equal(signals.length, 4)
  })
  it('某组失败时中止其他挂起组，不等待其结束', async () => {
    const signals: AbortSignal[] = []
    const generator = createInterviewQuestionGenerator(config, async (_, init) => {
      signals.push(init!.signal! as AbortSignal)
      return groupOf(init) === 'hr' ? responseWith('{}', 503) : new Promise<never>(() => {})
    })
    await assert.rejects(generator.generate({ ...bankInput, stage: 'final' }), (error: unknown) => error instanceof InterviewQuestionGenerationError && error.code === 'MODEL_HTTP_ERROR')
    assert.ok(signals.every(signal => signal.aborted))
  })
  it('单组均合格时仍拒绝跨组重复问题', async () => {
    const questions = generatedBank(true)
    questions[10]!.question = questions[0]!.question
    await assert.rejects(bankGenerator(questions).generate({ ...bankInput, stage: 'final' }), (error: unknown) => error instanceof InterviewQuestionGenerationError && error.code === 'MODEL_RESPONSE_INVALID')
  })
})
