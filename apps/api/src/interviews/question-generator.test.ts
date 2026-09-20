import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  InterviewQuestionGenerationError,
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
}

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
