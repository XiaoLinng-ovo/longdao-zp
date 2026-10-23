import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type GeneratedInterviewQuestion,
  InterviewQuestionGenerationError,
  COMMON_CAPABILITY_DIMENSIONS,
  generateLocalInterviewQuestions,
  createInterviewQuestionGenerator,
  replaceSelectedInterviewQuestion,
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
  return createInterviewQuestionGenerator({ baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'model', timeoutMs: 2000 }, async (_, init) => {
    requests.push(init!)
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
    const groupQuestions = Array.isArray(payload) && input.requestedGroup ? payload.filter(question => question.group === input.requestedGroup) : payload
    const questions = Array.isArray(groupQuestions) && input.requestedGroup === 'ai' ? groupQuestions.slice(input.batchOffset ?? 0, (input.batchOffset ?? 0) + input.questionCount) : groupQuestions
    return responseWith(JSON.stringify({ questions }))
  })
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
    assert.equal(requests.length, 4)
    const hrRequest = requests.map(request => JSON.parse(String(request.body))).find(request => JSON.parse(request.messages[1].content).requestedGroup === 'hr')
    assert.deepEqual(JSON.parse(hrRequest.messages[1].content).capabilityDimensions, { hr: COMMON_CAPABILITY_DIMENSIONS.hr })
    assert.equal(JSON.parse(hrRequest.messages[1].content).anonymizedResume, bankInput.anonymizedResume)
    assert.deepEqual(JSON.parse(hrRequest.messages[1].content).analysisSummary, bankInput.analysisSummary)
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
      assert.ok(requests.length >= 2)
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
    assert.equal(requests.length, 5)
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


describe('当前面试表独立生成与简历分批', () => {
  it('只生成所选用人部门表，不先生成简历题，且只发送五题要求', async () => {
    const requests: RequestInit[] = []
    const result = await bankGenerator(generatedBank(), requests).generateGroup(bankInput, 'department')
    assert.equal(requests.length, 1)
    const payload = JSON.parse(JSON.parse(String(requests[0]!.body)).messages[1].content)
    assert.equal(payload.requestedGroup, 'department')
    assert.equal(payload.questionCount, 5)
    assert.equal(payload.anonymizedResume, bankInput.anonymizedResume)
    assert.deepEqual(payload.analysisSummary, bankInput.analysisSummary)
    assert.equal(result.questions.length, 5)
    assert.ok(result.questions.every(question => question.group === 'department'))
  })
  it('十道简历题拆为两批五题，后批传递前批问题避免重复', async () => {
    const requests: RequestInit[] = []
    const result = await bankGenerator(generatedBank(), requests).generateGroup(bankInput, 'ai')
    const payloads = requests.map(request => JSON.parse(JSON.parse(String(request.body)).messages[1].content))
    assert.equal(requests.length, 2)
    assert.deepEqual(payloads.map(payload => payload.questionCount), [5, 5])
    assert.equal(payloads[0].previousQuestions, undefined)
    assert.equal(payloads[1].batchOffset, 5)
    assert.deepEqual(payloads[1].previousQuestions, result.questions.slice(0, 5).map(question => question.question))
    assert.equal(new Set(result.questions.map(question => question.question)).size, 10)
  })
  it('两批各自合法但跨批重复时拒绝返回成功', async () => {
    const bank = generatedBank()
    bank[5]!.question = bank[0]!.question
    await assert.rejects(bankGenerator(bank).generateGroup(bankInput, 'ai'), (error: unknown) => error instanceof InterviewQuestionGenerationError && error.code === 'MODEL_RESPONSE_INVALID')
  })
  it('初试不能生成BOSS表，调用模型前拒绝', async () => {
    const requests: RequestInit[] = []
    await assert.rejects(bankGenerator(generatedBank(), requests).generateGroup(bankInput, 'boss'), /不包含/)
    assert.equal(requests.length, 0)
  })
  it('第二批失败时不返回已完成的第一批', async () => {
    let calls = 0
    const generator = createInterviewQuestionGenerator({ baseUrl: 'https://llm.example/v1', apiKey: 'key', model: 'mock', timeoutMs: 2000 }, async () => {
      calls++
      return calls === 1 ? responseWith(JSON.stringify({ questions: generatedBank().slice(0, 5) })) : responseWith('{}', 503)
    })
    await assert.rejects(generator.generateGroup(bankInput, 'ai'), (error: unknown) => error instanceof InterviewQuestionGenerationError && error.code === 'MODEL_HTTP_ERROR')
    assert.equal(calls, 2)
  })
})

describe('题库串行生成、限流重试与超时保护', () => {
  const config = { baseUrl: 'https://llm.example/v1', apiKey: 'test-key', model: 'mock', timeoutMs: 2000 }
  const groupOf = (init?: RequestInit): string => JSON.parse(JSON.parse(String(init?.body)).messages[1].content).requestedGroup
  const responseFor = (group: string, init?: RequestInit) => {
    const input = init ? JSON.parse(JSON.parse(String(init.body)).messages[1].content) : {}
    const questions = generatedBank(true).filter(q => q.group === group)
    return responseWith(JSON.stringify({ questions: group === 'ai' ? questions.slice(input.batchOffset ?? 0, (input.batchOffset ?? 0) + (input.questionCount ?? 5)) : questions }))
  }
  it('四组依次请求，全部通过校验后再合并', async () => {
    let release!: () => void
    const groups: string[] = []
    const signals: AbortSignal[] = []
    const generator = createInterviewQuestionGenerator(config, async (_, init) => {
      signals.push(init!.signal! as AbortSignal)
      groups.push(groupOf(init))
      if (groups.length === 1) await new Promise<void>(resolve => { release = resolve })
      return responseFor(groupOf(init), init)
    })
    const pending = generator.generate({ ...bankInput, stage: 'final' })
    assert.deepEqual(groups, ['ai'])
    release()
    assert.equal((await pending).questions.length, 25)
    assert.deepEqual(groups, ['ai', 'ai', 'hr', 'department', 'boss'])
    assert.equal(new Set(signals).size, 1)
    assert.ok(signals.every(signal => signal.aborted))
  })
  it('只重试格式失败的组，已成功的组不重复调用', async () => {
    const calls: Record<string, number> = {}
    const generator = createInterviewQuestionGenerator(config, async (_, init) => {
      const group = groupOf(init)
      calls[group] = (calls[group] ?? 0) + 1
      return group === 'hr' && calls[group] === 1 ? responseWith('{}') : responseFor(group, init)
    })
    assert.equal((await generator.generate({ ...bankInput, stage: 'final' })).questions.length, 25)
    assert.deepEqual(calls, { ai: 2, hr: 2, department: 1, boss: 1 })
  })
  it('响应正文不结束时，总超时仍退出并中止所有请求', async () => {
    const signals: AbortSignal[] = []
    const generator = createInterviewQuestionGenerator({ ...config, timeoutMs: 30 }, async (_, init) => {
      signals.push(init!.signal! as AbortSignal)
      const response = responseFor(groupOf(init), init)
      response.json = () => new Promise<never>(() => {})
      return response
    })
    await assert.rejects(generator.generate({ ...bankInput, stage: 'final' }), (error: unknown) => error instanceof InterviewQuestionGenerationError && /超时/.test(error.message))
    assert.equal(signals.length, 1)
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
  it('外部取消终止当前组且不启动后续组，预先取消时不启动请求', async () => {
    const signals: AbortSignal[] = []
    const controller = new AbortController()
    const generator = createInterviewQuestionGenerator(config, async (_, init) => { signals.push(init!.signal! as AbortSignal); return new Promise<never>(() => {}) })
    const pending = generator.generate({ ...bankInput, stage: 'final' }, controller.signal)
    const rejected = assert.rejects(pending, /已取消/)
    controller.abort()
    await rejected
    assert.equal(signals.length, 1)
    assert.ok(signals.every(signal => signal.aborted))
    await assert.rejects(generator.generate(bankInput, controller.signal), /已取消/)
    assert.equal(signals.length, 1)
  })
  it('某组遇到不可重试HTTP错误时停止，不请求后续组', async () => {
    const signals: AbortSignal[] = []
    const groups: string[] = []
    const generator = createInterviewQuestionGenerator(config, async (_, init) => {
      signals.push(init!.signal! as AbortSignal)
      groups.push(groupOf(init))
      return groupOf(init) === 'hr' ? responseWith('{}', 503) : responseFor(groupOf(init), init)
    })
    await assert.rejects(generator.generate({ ...bankInput, stage: 'final' }), (error: unknown) => error instanceof InterviewQuestionGenerationError && error.code === 'MODEL_HTTP_ERROR')
    assert.deepEqual(groups, ['ai', 'ai', 'hr'])
    assert.ok(signals.every(signal => signal.aborted))
  })
  it('单组均合格时仍拒绝跨组重复问题', async () => {
    const questions = generatedBank(true)
    questions[10]!.question = questions[0]!.question
    await assert.rejects(bankGenerator(questions).generate({ ...bankInput, stage: 'final' }), (error: unknown) => error instanceof InterviewQuestionGenerationError && error.code === 'MODEL_RESPONSE_INVALID')
  })

  const limited = (retryAfter?: string) => new Response('provider-secret', {
    status: 429, headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
  })
  it('限流后仅重试当前组，不重复已成功组，最终生成完整复试题库', async () => {
    const calls: Record<string, number> = {}
    const generator = createInterviewQuestionGenerator(config, async (_, init) => {
      const group = groupOf(init)
      calls[group] = (calls[group] ?? 0) + 1
      return group === 'hr' && calls[group] === 1 ? limited('0') : responseFor(group, init)
    })
    assert.equal((await generator.generate({ ...bankInput, stage: 'final' })).questions.length, 25)
    assert.deepEqual(calls, { ai: 2, hr: 2, department: 1, boss: 1 })
  })
  it('持续限流最多重试三次，给出友好错误而不暴露服务端信息', async () => {
    let calls = 0
    const generator = createInterviewQuestionGenerator(config, async () => { calls++; return limited('0') })
    await assert.rejects(generator.generate(bankInput), (error: unknown) => {
      assert.ok(error instanceof InterviewQuestionGenerationError)
      assert.equal(error.code, 'MODEL_HTTP_ERROR')
      assert.match(error.message, /429.*重试/)
      assert.doesNotMatch(error.message, /provider-secret/)
      return true
    })
    assert.equal(calls, 4)
  })
  it('遵守Retry-After等待时长', async () => {
    const times: number[] = []
    const generator = createInterviewQuestionGenerator(config, async (_, init) => {
      times.push(performance.now())
      return times.length === 1 ? limited('0.05') : responseFor(groupOf(init), init)
    })
    assert.equal((await generator.generate(bankInput)).questions.length, 20)
    assert.ok(times[1]! - times[0]! >= 45)
  })
  for (const retryAfter of [undefined, 'invalid']) {
    it('Retry-After为' + String(retryAfter) + '时使用默认退避', async () => {
      const times: number[] = []
      const generator = createInterviewQuestionGenerator({ ...config, timeoutMs: 5000 }, async (_, init) => {
        times.push(performance.now())
        return times.length === 1 ? limited(retryAfter) : responseFor(groupOf(init), init)
      })
      assert.equal((await generator.generate(bankInput)).questions.length, 20)
      assert.ok(times[1]! - times[0]! >= 950)
    })
  }
  for (const retryAfter of ['60', new Date(Date.now() + 60_000).toUTCString()]) {
    it('Retry-After为' + retryAfter + '时仍遵守共享总超时', async () => {
      let calls = 0
      const generator = createInterviewQuestionGenerator({ ...config, timeoutMs: 30 }, async () => { calls++; return limited(retryAfter) })
      await assert.rejects(generator.generate(bankInput), /超时/)
      assert.equal(calls, 1)
    })
  }
  it('取消退避等待后不再重试或请求后续组', async () => {
    let calls = 0
    let waiting!: () => void
    const started = new Promise<void>(resolve => { waiting = resolve })
    const controller = new AbortController()
    const generator = createInterviewQuestionGenerator(config, async () => { calls++; waiting(); return limited('60') })
    const pending = generator.generate(bankInput, controller.signal)
    const rejected = assert.rejects(pending, /已取消/)
    await started
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort()
    await rejected
    assert.equal(calls, 1)
  })
  it('格式重试与限流重试分别计数', async () => {
    const calls: Record<string, number> = {}
    const generator = createInterviewQuestionGenerator(config, async (_, init) => {
      const group = groupOf(init)
      calls[group] = (calls[group] ?? 0) + 1
      if (group === 'ai' && calls[group] <= 3) return limited('0')
      if (group === 'ai' && calls[group] === 4) return responseWith('{}')
      return responseFor(group, init)
    })
    assert.equal((await generator.generate(bankInput)).questions.length, 20)
    assert.deepEqual(calls, { ai: 6, hr: 1, department: 1 })
  })
})

describe('题库对话兼容与独立分组预算', () => {
  const config = { baseUrl: 'https://llm.example/v1', apiKey: 'test-key', model: 'mock', timeoutMs: 2000 }
  const hrQuestions = () => generatedBank().filter(q => q.group === 'hr')
  const messages = [{ role: 'user' as const, content: '请改为适合应届生的情境题。' }]
  it('各组均未超时时，累计超过单组预算仍可生成完整题库', async () => {
    const generator = createInterviewQuestionGenerator({ ...config, timeoutMs: 200 }, async (_, init) => {
      const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
      const group = payload.requestedGroup
      await new Promise(resolve => setTimeout(resolve, 80))
      return responseWith(JSON.stringify({ questions: generatedBank(true).filter(q => q.group === group).slice(group === 'ai' ? payload.batchOffset ?? 0 : 0, group === 'ai' ? (payload.batchOffset ?? 0) + payload.questionCount : 5) }))
    })
    assert.equal((await generator.generate({ ...bankInput, stage: 'final' })).questions.length, 25)
  })
  it('兼容代码围栏及文本内容块，同时返回中文回复', async () => {
    const content = '~~~json\n' + JSON.stringify({ questions: hrQuestions(), assistantMessage: '已调整为情境题。' }) + '\n~~~'
    const generator = createInterviewQuestionGenerator(config, async () => new Response(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: content.replaceAll('~~~', String.fromCharCode(96).repeat(3)) }] } }] })))
    const result = await generator.refine(bankInput, 'hr', hrQuestions(), messages)
    assert.equal(result.questions.length, 5)
    assert.equal(result.assistantMessage, '已调整为情境题。')
  })
  it('仅在接口明确不支持JSON模式时去掉response_format重新请求', async () => {
    const bodies: Record<string, unknown>[] = []
    const generator = createInterviewQuestionGenerator(config, async (_, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return bodies.length === 1 ? new Response('response_format json_object is not supported', { status: 400 }) : responseWith(JSON.stringify({ questions: hrQuestions() }))
    })
    assert.equal((await generator.refine(bankInput, 'hr', hrQuestions(), messages)).questions.length, 5)
    assert.ok(bodies[0]!.response_format)
    assert.equal(bodies[1]!.response_format, undefined)
  })
  it('普通400错误不被误当成格式兼容问题或重复扣费重试', async () => {
    let calls = 0
    const generator = createInterviewQuestionGenerator(config, async () => { calls++; return new Response('invalid model', { status: 400 }) })
    await assert.rejects(generator.refine(bankInput, 'hr', hrQuestions(), messages), /400/)
    assert.equal(calls, 1)
  })
  it('格式重试带上具体校验反馈，且仍然拒绝错误分值', async () => {
    const bodies: Array<{ messages: Array<{ content: string }> }> = []
    const invalid = hrQuestions().map(q => ({ ...q, scoringRubric: [{ criterion: '行动依据', points: 1 }] }))
    const generator = createInterviewQuestionGenerator(config, async (_, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return responseWith(JSON.stringify({ questions: invalid }))
    })
    await assert.rejects(generator.refine(bankInput, 'hr', hrQuestions(), messages), /points 总和/)
    assert.equal(bodies.length, 2)
    assert.match(JSON.parse(bodies[1]!.messages[1]!.content).validationFeedback, /points 总和/)
  })
  it('截断响应进行一次精简重试，未修复则给出截断原因', async () => {
    let calls = 0
    const generator = createInterviewQuestionGenerator(config, async () => {
      calls++
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }))
    })
    await assert.rejects(generator.refine(bankInput, 'hr', hrQuestions(), messages), /截断/)
    assert.equal(calls, 2)
  })
  it('对话取消后中止模型请求，不再返回修改结果', async () => {
    const controller = new AbortController()
    let signal: AbortSignal | undefined
    const generator = createInterviewQuestionGenerator(config, async (_, init) => { signal = init!.signal as AbortSignal; return new Promise(() => {}) })
    const pending = generator.refine(bankInput, 'hr', hrQuestions(), messages, controller.signal)
    const rejected = assert.rejects(pending, /已取消/)
    controller.abort()
    await rejected
    assert.ok(signal?.aborted)
  })
})

describe('精确单题修改与整表修改范围', () => {
  const config = { baseUrl: 'https://llm.example/v1', apiKey: 'test-key', model: 'mock', timeoutMs: 2000 }
  const messages = [{ role: 'user' as const, content: '把这道题改为考察创新能力' }]
  const department = () => generatedBank().filter(q => q.group === 'department')
  it('把第一道题改为创新题仍替换第一题，其他题目与创新维度保持原样', async () => {
    const bank = generatedBank(), current = department(), original = current[0]!
    const target = { index: 0, question: original.question }
    const replacement = { ...original, question: '请描述你提出创新方案并验证效果的经历。' }
    let body: { messages: Array<{ content: string }> } | undefined
    const generator = createInterviewQuestionGenerator(config, async (_, init) => {
      body = JSON.parse(String(init?.body))
      return responseWith(JSON.stringify({ questions: [replacement], assistantMessage: '已修改所选题目' }))
    })
    const result = await generator.refine(bankInput, 'department', current, messages, undefined, target)
    const request = JSON.parse(body!.messages[1]!.content)
    assert.equal(request.scope, 'single_question')
    assert.equal(request.questionCount, 1)
    assert.deepEqual(request.currentQuestions, [original])
    assert.equal(request.capabilityDimensions, undefined)
    assert.match(body!.messages[0]!.content, /不得转去其他创新维度/)
    const updated = replaceSelectedInterviewQuestion(bank, 'department', target, result.questions[0]!)
    assert.equal(updated[15]!.question, replacement.question)
    assert.equal(updated[15]!.sourceEngine, 'llm')
    bank.forEach((question, index) => { if (index !== 15) assert.equal(updated[index], question) })
  })
  for (const kind of ['wrong_dimension', 'whole_group', 'wrong_points'] as const) {
    it('拒绝单题请求中的错误结果：' + kind, async () => {
      const current = department(), original = current[0]!
      const questions = kind === 'whole_group' ? current : [{ ...original,
        ...(kind === 'wrong_dimension' ? { dimension: current[3]!.dimension } : {}),
        ...(kind === 'wrong_points' ? { scoringRubric: [{ criterion: '证据', points: 1 }] } : {}),
      }]
      const bodies: Array<{ messages: Array<{ content: string }> }> = []
      const generator = createInterviewQuestionGenerator(config, async (_, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return responseWith(JSON.stringify({ questions }))
      })
      await assert.rejects(generator.refine(bankInput, 'department', current, messages, undefined, { index: 0, question: original.question }), (error: unknown) => error instanceof InterviewQuestionGenerationError && error.code === 'MODEL_RESPONSE_INVALID')
      assert.equal(bodies.length, 2)
      assert.ok(JSON.parse(bodies[1]!.messages[1]!.content).validationFeedback)
    })
  }
  it('过期题文或越界索引在调用模型前就拒绝', async () => {
    let calls = 0
    const generator = createInterviewQuestionGenerator(config, async () => { calls++; return responseWith('{}') })
    for (const target of [{ index: 0, question: '旧题文' }, { index: 99, question: department()[0]!.question }]) {
      await assert.rejects(generator.refine(bankInput, 'department', department(), messages, undefined, target), /所选题目/)
    }
    assert.equal(calls, 0)
  })
  it('未选择题目时提交整表范围和完整五题，不按关键词限定其中一题', async () => {
    let payload: Record<string, unknown> | undefined
    const generator = createInterviewQuestionGenerator(config, async (_, init) => {
      payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
      return responseWith(JSON.stringify({ questions: department() }))
    })
    const result = await generator.refine(bankInput, 'department', department(), messages)
    assert.equal(payload!.scope, 'entire_group')
    assert.deepEqual(payload!.currentQuestions, department())
    assert.equal(payload!.selectedQuestion, undefined)
    assert.equal(result.questions.length, 5)
  })
})
