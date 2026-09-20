import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyFailure } from '../src/errors.js'
import { createOpenAIResumeAnalyzer } from '../src/handlers/openai-resume-analyzer.js'
import { createResumeAnalysisHandler } from '../src/handlers/resume-analysis.js'
import { createTask } from '../src/task.js'

const task = createTask<'resume-analysis', import('../src/handlers/resume-analysis.js').ResumeAnalysisTaskPayload>({
  type: 'resume-analysis',
  maxAttempts: 3,
  idempotencyKey: 'llm-test',
  payload: {
    resumeId: 'resume-1',
    applicationId: 'application-1',
    jobId: 'job-1',
    jobTitle: '后端工程师',
    jobRequirements: ['TypeScript', 'PostgreSQL'],
    fileName: 'resume.txt',
    text: '张三 13800138000 zhang@example.com\n五年 TypeScript 开发经验',
    source: 'test',
  },
})
const context = {
  taskId: task.id,
  attempt: 1,
  maxAttempts: 3,
  idempotencyKey: task.idempotencyKey,
  now: () => '2026-09-17T00:00:00.000Z',
}

void describe('OpenAI-compatible resume analyzer', () => {
  it('calls chat completions with anonymized text and returns advisory-only suggestions', async () => {
    let request: Request | undefined
    const analyzer = createOpenAIResumeAnalyzer({
      baseUrl: 'https://llm.example/v1',
      apiKey: 'secret',
      model: 'resume-model',
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        request = new Request(input, init)
        return Response.json({
          choices: [{ message: { content: JSON.stringify({
            summary: '具备相关开发经验，建议人工复核。',
            score: 78,
            strengths: ['TypeScript 经验'],
            risks: ['岗位要求信息不足'],
            matchedRequirements: [],
            conflicts: [],
            interviewQuestions: ['请说明复杂项目中的职责。'],
            confidence: 0.72,
          }) } }],
        })
      },
    })
    const result = await createResumeAnalysisHandler({ analyze: analyzer })(task, context)
    assert.equal(request?.url, 'https://llm.example/v1/chat/completions')
    assert.equal(request?.headers.get('authorization'), 'Bearer secret')
    const body = JSON.parse(await request!.clone().text()) as { model: string; messages: Array<{ content: string }> }
    assert.equal(body.model, 'resume-model')
    assert.doesNotMatch(body.messages[1]!.content, /13800138000|zhang@example\.com|张三/u)
    assert.match(body.messages[1]!.content, /\[PHONE\]|\[EMAIL\]|\[NAME\]/u)
    assert.match(body.messages[1]!.content, /TypeScript|PostgreSQL/u)
    assert.equal(result.analysis.engine, 'llm-suggestion')
    assert.equal(result.analysis.report.assessment.score, 78)
    assert.deepEqual(result.analysis.report.assessment.strengths, ['TypeScript 经验'])
    assert.equal(result.analysis.report.assessment.confidence, 0.72)
    assert.equal(result.safety.applicationStatusMutation, 'none')
    assert.equal(result.safety.autoReject, false)
  })

  it('rejects malformed model JSON without replacing it with an unsafe result', async () => {
    const analyzer = createOpenAIResumeAnalyzer({
      baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'resume-model',
      fetch: async () => Response.json({ choices: [{ message: { content: '{"summary": 42}' } }] }),
    })
    await assert.rejects(
      createResumeAnalysisHandler({ analyze: analyzer })(task, context),
      (error: unknown) => classifyFailure(error).code === 'MODEL_RESPONSE_INVALID'
        && classifyFailure(error).retryable === false,
    )
  })

  it('classifies timeout and non-2xx responses as retryable failures', async () => {
    const timeoutAnalyzer = createOpenAIResumeAnalyzer({
      baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'resume-model', timeoutMs: 1,
      fetch: async (_input: string | URL | Request, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
    })
    await assert.rejects(createResumeAnalysisHandler({ analyze: timeoutAnalyzer })(task, context), (error: unknown) => {
      const failure = classifyFailure(error)
      return failure.code === 'MODEL_TIMEOUT' && failure.retryable
    })

    const httpAnalyzer = createOpenAIResumeAnalyzer({
      baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'resume-model',
      fetch: async () => new Response('upstream unavailable', { status: 503 }),
    })
    await assert.rejects(createResumeAnalysisHandler({ analyze: httpAnalyzer })(task, context), (error: unknown) => {
      const failure = classifyFailure(error)
      return failure.code === 'MODEL_HTTP_ERROR' && failure.retryable
    })
  })
})
