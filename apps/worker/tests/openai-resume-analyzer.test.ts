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
function semanticItems() {
  return [
    { requirementId: 'job-1-requirement-1', status: 'met', score: 100, sourceTexts: ['五年 TypeScript 开发经验'], rationale: '简历明确描述 TypeScript 开发经历' },
    { requirementId: 'job-1-requirement-2', status: 'not_mentioned', score: 0, sourceTexts: [], rationale: '未写数据库经历' },
  ]
}
const context = {
  taskId: task.id,
  attempt: 1,
  maxAttempts: 3,
  idempotencyKey: task.idempotencyKey,
  now: () => '2026-09-17T00:00:00.000Z',
}

void describe('OpenAI-compatible resume analyzer', () => {
  it('does not misclassify an interrupted response body as invalid model evidence', async () => {
    let calls = 0
    const analyzer = createOpenAIResumeAnalyzer({
      baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'resume-model',
      fetch: async () => {
        calls++
        const response = Response.json({})
        response.json = async () => { throw new TypeError('connection terminated') }
        return response
      },
    })
    await assert.rejects(createResumeAnalysisHandler({ analyze: analyzer })(task, context), (error: unknown) => classifyFailure(error).code === 'MODEL_NETWORK_ERROR')
    assert.equal(calls, 1)
  })

  it('shares one timeout across scoring and its correction', async () => {
    let calls = 0
    const signals: Array<AbortSignal | null | undefined> = []
    const analyzer = createOpenAIResumeAnalyzer({
      baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'resume-model', timeoutMs: 200,
      fetch: async (_input, init) => {
        calls++
        signals.push(init?.signal)
        if (calls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 120))
          return Response.json({ choices: [{ message: { content: '{}' } }] })
        }
        return await new Promise<never>(() => {})
      },
    })
    const started = Date.now()
    await assert.rejects(createResumeAnalysisHandler({ analyze: analyzer })(task, context), (error: unknown) => classifyFailure(error).code === 'MODEL_TIMEOUT')
    assert.equal(calls, 2)
    assert.equal(signals[0], signals[1])
    assert.equal(signals[1]?.aborted, true)
    assert.ok(Date.now() - started < 300, 'correction must not reset the timeout')
  })

  it('corrects evidence once without echoing rejected private output', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = []
    const analyzer = createOpenAIResumeAnalyzer({
      baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'resume-model',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        const items = semanticItems()
        if (bodies.length === 1) items[0]!.sourceTexts = ['虚构能力，私人电话13912345678']
        return Response.json({ choices: [{ message: { content: JSON.stringify({ score: 99, requirementAssessments: items }) } }] })
      },
    })
    const result = await createResumeAnalysisHandler({ analyze: analyzer })(task, context)
    assert.equal(bodies.length, 2)
    assert.equal(result.analysis.report.assessment.score, 71)
    assert.equal(bodies[0]!.messages[1]!.content, bodies[1]!.messages[1]!.content)
    assert.match(bodies[1]!.messages[2]!.content, /逐字|not_mentioned/u)
    assert.doesNotMatch(JSON.stringify(bodies[1]), /13912345678|虚构能力|13800138000|张三|zhang@example/u)
  })

  it('stops at two invalid responses without leaking JSON parser excerpts', async () => {
    let calls = 0
    const analyzer = createOpenAIResumeAnalyzer({
      baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'resume-model',
      fetch: async (_input, init) => {
        calls++
        assert.doesNotMatch(String(init?.body), /13912345678|private-payload/u)
        return new Response('private-payload 13912345678', { headers: { 'content-type': 'application/json' } })
      },
    })
    await assert.rejects(createResumeAnalysisHandler({ analyze: analyzer })(task, context), (error: unknown) => {
      assert.doesNotMatch((error as Error).message, /13912345678|private-payload/u)
      return classifyFailure(error).code === 'MODEL_RESPONSE_INVALID' && !classifyFailure(error).retryable
    })
    assert.equal(calls, 2)
  })

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
            score: 99,
            requirementAssessments: semanticItems(),
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
    assert.equal(result.analysis.report.assessment.score, 71)
    assert.equal(result.analysis.report.assessment.conflicts.length, 0)
    assert.equal(result.analysis.report.assessment.missingRequirements[0]?.status, 'not_mentioned')
    assert.match(result.analysis.report.assessment.strengths.join(' '), /TypeScript/u)
    assert.doesNotMatch(result.analysis.report.assessment.strengths.join(' '), /PostgreSQL/u)
    assert.equal(result.analysis.report.assessment.confidence, 0.72)
    assert.equal(result.safety.applicationStatusMutation, 'none')
    assert.equal(result.safety.autoReject, false)
  })


  it('uses the job scoring Skill even without structured requirements and snapshots its rules', async () => {
    const scoringSkill = { id: 'skill-1', name: '后端专属规则', content: '项目经验 70 分，技术能力 30 分；逐项说明证据。', updatedAt: '2026-10-08T00:00:00.000Z' }
    const skillTask = { ...task, payload: { ...task.payload, jobRequirements: [], scoringSkill } }
    let prompt = ''
    const analyzer = createOpenAIResumeAnalyzer({
      baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'resume-model',
      fetch: async (_input, init) => {
        prompt = String(init?.body)
        return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: '不要信任自由总结', score: 99, requirementAssessments: [], scoringDimensions: [{ label: '项目经验', maxScore: 70, score: 60, status: 'partial', sourceTexts: ['五年 TypeScript 开发经验'], rationale: '明确开发经验，但项目细节需核实' }, { label: '技术能力', maxScore: 30, score: 25, status: 'partial', sourceTexts: ['五年 TypeScript 开发经验'], rationale: '明确使用 TypeScript' }] }) } }] })
      },
    })
    const result = await createResumeAnalysisHandler({ analyze: analyzer })(skillTask, context)
    assert.match(prompt, /项目经验 70 分/u)
    assert.equal(result.analysis.report.assessment.score, 85)
    assert.deepEqual(result.analysis.report.provenance.scoringSkill, scoringSkill)
    assert.notEqual(result.analysis.report.provenance.scoringSkill, scoringSkill)
    assert.match(result.analysis.suggestion?.summary ?? '', /60\/70/u)
    assert.equal(result.safety.autoReject, false)
  })

  it('never substitutes a default score when a custom Skill returns no valid score', async () => {
    const skillTask = { ...task, payload: { ...task.payload, scoringSkill: { id: 'skill-1', name: '专属规则', content: '经验 100 分', updatedAt: '2026-10-08T00:00:00.000Z' } } }
    for (const score of [undefined, null, -1, 101, 'not a number']) {
      const analyzer = createOpenAIResumeAnalyzer({
        baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'resume-model',
        fetch: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ summary: '分析结果', score, requirementAssessments: semanticItems(), scoringDimensions: [{ label: '经验', maxScore: 100, score: 100, status: 'met', sourceTexts: ['五年 TypeScript 开发经验'], rationale: '明确的开发经验' }] }) } }] }),
      })
      await assert.rejects(createResumeAnalysisHandler({ analyze: analyzer })(skillTask, context), (error: unknown) => {
        const failure = classifyFailure(error)
        return failure.code === 'MODEL_RESPONSE_INVALID' && !failure.retryable
      })
    }
  })

  it('requires an AI analyzer for job scoring Skills instead of default-rule fallback', async () => {
    const skillTask = { ...task, payload: { ...task.payload, scoringSkill: { id: 'skill-1', name: '专属规则', content: '经验 100 分', updatedAt: '2026-10-08T00:00:00.000Z' } } }
    await assert.rejects(createResumeAnalysisHandler()(skillTask, context), (error: unknown) => {
      const failure = classifyFailure(error)
      return failure.code === 'SCORING_SKILL_AI_REQUIRED' && !failure.retryable
    })
  })

  it('does not ask a model to fabricate a score without job requirements', async () => {
    let called = false
    const analyzer = createOpenAIResumeAnalyzer({
      baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'resume-model',
      fetch: async () => { called = true; throw new Error('should not call model') },
    })
    const unconfigured = { ...task, payload: { ...task.payload, jobRequirements: [], jobSkills: [] } }
    const result = await createResumeAnalysisHandler({ analyze: analyzer })(unconfigured, context)
    assert.equal(called, false)
    assert.equal(result.analysis.report.assessment.score, null)
    assert.equal(result.analysis.report.assessment.recommendation, 'needs_review')
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

  it('accepts common model variations for numeric strings and object arrays', async () => {
    const analyzer = createOpenAIResumeAnalyzer({
      baseUrl: 'https://llm.example/v1',
      apiKey: 'secret',
      model: 'resume-model',
      fetch: async () => Response.json({
        choices: [{ message: { content: JSON.stringify({
          summary: '模型返回了可用的结构化结果。',
          score: '91',
          requirementAssessments: semanticItems().map(item => ({ ...item, score: String(item.score) })),
          strengths: [
            { evidence: '五年 TypeScript 开发经验', relevance: '满足核心技能要求' },
          ],
          matchedRequirements: [
            { requirement: 'PostgreSQL', evidence: '负责过 PostgreSQL 性能优化' },
          ],
          interviewQuestions: ['请说明一次数据库性能优化经历。'],
          confidence: '0.86',
        }) } }],
      }),
    })
    const result = await createResumeAnalysisHandler({ analyze: analyzer })(task, context)
    assert.equal(result.analysis.report.assessment.score, 71)
    assert.equal(result.analysis.report.assessment.confidence, 0.86)
    assert.doesNotMatch(result.analysis.report.assessment.strengths.join(' '), /PostgreSQL/u)
  })

  it('stops model timeouts without automatically repeating the same expensive analysis', async () => {
    const timeoutAnalyzer = createOpenAIResumeAnalyzer({
      baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'resume-model', timeoutMs: 1,
      fetch: async (_input: string | URL | Request, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
    })
    await assert.rejects(createResumeAnalysisHandler({ analyze: timeoutAnalyzer })(task, context), (error: unknown) => {
      const failure = classifyFailure(error)
      return failure.code === 'MODEL_TIMEOUT' && !failure.retryable
    })
  })

  it('includes stalled response bodies in the timeout, even if a gateway ignores abort', async () => {
    let signal: AbortSignal | undefined
    const analyzer = createOpenAIResumeAnalyzer({
      baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'resume-model', timeoutMs: 10,
      fetch: async (_input, init) => {
        signal = init?.signal ?? undefined
        const response = Response.json({})
        response.json = async () => await new Promise<never>(() => {})
        return response
      },
    })
    await assert.rejects(createResumeAnalysisHandler({ analyze: analyzer })(task, context), (error: unknown) => {
      const failure = classifyFailure(error)
      return failure.code === 'MODEL_TIMEOUT' && !failure.retryable
    })
    assert.equal(signal?.aborted, true)
  })

  it('uses a bounded reasoning mode for reasoning models without an unsupported temperature', async () => {
    let body: Record<string, unknown> = {}
    const analyzer = createOpenAIResumeAnalyzer({
      baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'gpt-6.1-sol',
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({ choices: [{ message: { content: JSON.stringify({ score: 50, requirementAssessments: semanticItems() }) } }] })
      },
    })
    await createResumeAnalysisHandler({ analyze: analyzer })(task, context)
    assert.equal(body.reasoning_effort, 'low')
    assert.equal(body.temperature, undefined)
  })

  it('retries temporary HTTP failures but not configuration or authorization errors', async () => {

    const httpAnalyzer = createOpenAIResumeAnalyzer({
      baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'resume-model',
      fetch: async () => new Response('upstream unavailable', { status: 503 }),
    })
    await assert.rejects(createResumeAnalysisHandler({ analyze: httpAnalyzer })(task, context), (error: unknown) => {
      const failure = classifyFailure(error)
      return failure.code === 'MODEL_HTTP_ERROR' && failure.retryable
    })
    for (const status of [400, 401, 403]) {
      const analyzer = createOpenAIResumeAnalyzer({ baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'resume-model', fetch: async () => new Response('invalid request', { status }) })
      await assert.rejects(createResumeAnalysisHandler({ analyze: analyzer })(task, context), (error: unknown) => classifyFailure(error).code === 'MODEL_HTTP_ERROR' && !classifyFailure(error).retryable)
    }
  })
})

void describe('semantic evidence boundaries', () => {
  it('fails job scoring without a model instead of returning a keyword score', async () => {
    await assert.rejects(createResumeAnalysisHandler()(task, context), (error: unknown) => classifyFailure(error).code === 'SEMANTIC_SCORING_AI_REQUIRED')
  })
  it('rejects invented evidence and unsupported missing-item points without exposing response text', async () => {
    for (const mode of ['quote', 'points', 'missing', 'duplicate']) {
      const items = semanticItems()
      if (mode === 'quote') items[0]!.sourceTexts = ['负责过 PostgreSQL 性能优化，私人电话13800138000']
      if (mode === 'points') items[1]!.score = 80
      if (mode === 'missing') items.pop()
      if (mode === 'duplicate') items[1]!.requirementId = items[0]!.requirementId
      const analyzer = createOpenAIResumeAnalyzer({ baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'resume-model',
        fetch: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ score: 100, requirementAssessments: items }) } }] }),
      })
      await assert.rejects(createResumeAnalysisHandler({ analyze: analyzer })(task, context), (error: unknown) => {
        assert.doesNotMatch((error as Error).message, /13800138000|私人电话/u)
        return classifyFailure(error).code === 'MODEL_RESPONSE_INVALID'
      })
    }
  })
  it('does not persist fabricated capabilities in the model summary or strengths', async () => {
    const analyzer = createOpenAIResumeAnalyzer({ baseUrl: 'https://llm.example/v1', apiKey: 'secret', model: 'resume-model',
      fetch: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ score: 100, summary: '精通薪酬核算及保密制度', strengths: ['具备招聘经验'], requirementAssessments: semanticItems() }) } }] }),
    })
    const result = await createResumeAnalysisHandler({ analyze: analyzer })(task, context)
    assert.equal(result.analysis.report.assessment.score, 71)
    assert.doesNotMatch(JSON.stringify(result.analysis), /薪酬核算|保密制度|具备招聘经验/u)
    assert.equal(result.analysis.report.provenance.scorerVersion, '0.1.0')
  })
})
