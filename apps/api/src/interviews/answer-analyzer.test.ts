import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InterviewAnswerAnalysisError, createInterviewAnswerAnalyzer, loadInterviewAnswerAnalyzerConfig } from './answer-analyzer.js'

const valid = { questionKind: 'assessment', summary: '候选人说明了索引与慢查询定位方法。', evidence: ['EXPLAIN ANALYZE'], scores: [{ dimension: '数据库诊断', score: 8, rationale: '给出了具体工具和步骤', questionQuote: '排查慢查询', evidence: ['EXPLAIN ANALYZE'] }], concerns: [], confidence: 0.86, nextQuestion: '如果索引导致写入变慢，你会如何权衡？' }

describe('interview answer analyzer', () => {
  const input = { question: '如何排查慢查询？', candidateAnswer: '我使用 EXPLAIN ANALYZE。', jobTitle: '后端工程师', jobRequirements: ['数据库'], priorContext: [], resumeContext: ['简历提到团队管理'] }
  const fixture = (value: unknown) => createInterviewAnswerAnalyzer({ baseUrl: 'https://llm.example/v1', apiKey: 'key', model: 'model-a', timeoutMs: 2000 }, async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] })))
  for (const kind of ['assessment', 'logistics', 'unreviewed']) {
    it('allows no score instead of forced zero: ' + kind, async () => {
      const result = await fixture({ ...valid, questionKind: kind, scores: [], evidence: [], nextQuestion: '' }).analyze(input)
      assert.deepEqual(result.scores, [])
    })
  }
  for (const scenario of ['invented-question', 'invented-answer', 'resume-evidence', 'missing-evidence', 'logistics-score', 'duplicate-dimension']) {
    it('rejects unsupported scores: ' + scenario, async () => {
      const value = structuredClone(valid)
      if (scenario === 'invented-question') value.scores[0]!.questionQuote = '请求执行顺序分析'
      if (scenario === 'invented-answer') value.evidence = ['我熟悉多线程调度']
      if (scenario === 'resume-evidence') value.scores[0]!.evidence = ['团队管理']
      if (scenario === 'missing-evidence') value.scores[0]!.evidence = []
      if (scenario === 'logistics-score') value.questionKind = 'logistics'
      if (scenario === 'duplicate-dimension') value.scores.push(value.scores[0]!)
      await assert.rejects(fixture(value).analyze(input), (error: unknown) => error instanceof InterviewAnswerAnalysisError && error.code === 'MODEL_RESPONSE_INVALID')
    })
  }
  it('calls the configured OpenAI-compatible endpoint and returns advisory analysis', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const analyzer = createInterviewAnswerAnalyzer({ baseUrl: 'https://llm.example/v1/', apiKey: 'key', model: 'model-a', timeoutMs: 2000 }, async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(valid) } }] }), { status: 200 })
    })
    const result = await analyzer.analyze({ question: '如何排查慢查询？', candidateAnswer: '我会先看监控，再用 EXPLAIN ANALYZE。', jobTitle: '后端工程师', jobRequirements: ['PostgreSQL'], priorContext: [] })
    assert.equal(requests[0]?.url, 'https://llm.example/v1/chat/completions')
    assert.equal(result.advisoryOnly, true)
    assert.equal(result.applicationStatusMutation, 'none')
    assert.equal(result.nextQuestion, valid.nextQuestion)
  })

  it('scores substantive spontaneous speech with no invented question', async () => {
    const value = structuredClone(valid)
    value.scores[0]!.questionQuote = ''
    const result = await fixture(value).analyze({ ...input, question: '' })
    assert.equal(result.scores[0]!.score, 8)
    assert.equal(result.scores[0]!.questionQuote, '')
  })

  it('rejects oversized complete context without silently truncating it', async () => {
    const analyzer = createInterviewAnswerAnalyzer({ baseUrl: 'https://model.invalid', apiKey: 'k', model: 'm', timeoutMs: 1000 }, async () => { throw new Error('must not call') })
    await assert.rejects(analyzer.analyze({ ...input, priorContext: ['对话'.repeat(90000)] }), /超出当前分析容量/)
  })

  it('rejects missing configuration', () => {
    assert.throws(() => loadInterviewAnswerAnalyzerConfig({}), (error: unknown) => error instanceof InterviewAnswerAnalysisError && error.code === 'AI_NOT_CONFIGURED')
  })

  it('fails closed when model adds a hiring decision', async () => {
    const analyzer = createInterviewAnswerAnalyzer({ baseUrl: 'https://llm.example/v1', apiKey: 'k', model: 'model', timeoutMs: 2000 }, async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...valid, decision: 'hire' }) } }] }), { status: 200 }))
    await assert.rejects(analyzer.analyze({ question: '问题', candidateAnswer: '回答内容足够长', jobTitle: '岗位', jobRequirements: ['要求'], priorContext: [] }), (error: unknown) => error instanceof InterviewAnswerAnalysisError && error.code === 'MODEL_RESPONSE_INVALID')
  })

  it('tolerates markdown fences, empty concerns, and blank evidence entries', async () => {
    const content = '```json\n' + JSON.stringify({ ...valid, concerns: [], evidence: ['EXPLAIN ANALYZE', '   '] }) + '\n```'
    const analyzer = createInterviewAnswerAnalyzer({ baseUrl: 'https://llm.example/v1', apiKey: 'k', model: 'model', timeoutMs: 2000 }, async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }))
    const result = await analyzer.analyze({ question: '如何排查慢查询？', candidateAnswer: '我会先看监控，再用 EXPLAIN ANALYZE。', jobTitle: '后端工程师', jobRequirements: ['PostgreSQL'], priorContext: [] })
    assert.equal(result.concerns.length, 0)
    assert.deepEqual(result.evidence, ['EXPLAIN ANALYZE'])
    assert.equal(result.summary, valid.summary)
  })

  it('retries once when the model returns malformed content then recovers', async () => {
    let calls = 0
    const analyzer = createInterviewAnswerAnalyzer({ baseUrl: 'https://llm.example/v1', apiKey: 'k', model: 'model', timeoutMs: 2000 }, async () => {
      calls += 1
      const content = calls === 1 ? 'not json at all' : JSON.stringify(valid)
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
    })
    const result = await analyzer.analyze({ question: '如何排查慢查询？', candidateAnswer: '我会先看监控，再用 EXPLAIN ANALYZE。', jobTitle: '后端工程师', jobRequirements: ['PostgreSQL'], priorContext: [] })
    assert.equal(calls, 2)
    assert.equal(result.summary, valid.summary)
  })
})
