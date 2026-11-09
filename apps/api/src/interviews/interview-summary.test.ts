import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assessTranscriptQuality, buildActualDialogue, createUnscoredSummary, createInterviewSummaryGenerator, parseInterviewSummary } from './interview-summary.js'
import type { LiveSegment } from './live-session-repository.js'
import { InterviewSummaryService, startInterviewSummaryPoll } from './interview-summary-service.js'

const segment = (id: string, role: LiveSegment['role'], text: string, startMs: number, endMs = startMs + 1000, confidence = .95): LiveSegment =>
  ({ id, role, text, startMs, endMs, confidence, sessionId: 'session', speakerId: role, status: 'transcribed' })
const segments = () => [
  segment('project-q', 'interviewer', '请介绍你负责的招聘项目。', 0),
  segment('project-a', 'candidate', '我独立完成需求访谈和接口开发。', 2000),
  segment('project-a2', 'candidate', '上线前做了回归测试。', 3500),
  segment('school-q', 'interviewer', '毕业答辩是否要回学校？', 7000),
  segment('school-a', 'candidate', '答辩时需要回学校两天。', 9000),
]
const base = () => createUnscoredSummary(segments())
const output = () => ({ summary: '候选人自述完成开发及测试，尚需核实项目成果。',
  turns: base().transcript.map(turn => ({ id: turn.id, kind: turn.id.startsWith('project-') ? 'assessment' : 'logistics' })),
  pairs: [{ id: 'project-q', kind: 'assessment' }, { id: 'school-q', kind: 'logistics' }],
  dimensions: [{ name: '项目执行', score: 80, text: '有需求及开发自述。', evidence: [{ pairId: 'project-q', quote: '独立完成需求访谈和接口开发' }] },
    { name: '质量意识', score: 70, text: '提到回归测试。', evidence: [{ pairId: 'project-q', quote: '上线前做了回归测试' }] }],
  strengths: [], concerns: [], unassessed: ['团队管理能力未考察'], overallScore: 100 })
const config = { baseUrl: 'https://model.invalid/v1', apiKey: 'secret', model: 'test-model', timeoutMs: 1000 }
const reply = (body: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }), { headers: { 'content-type': 'application/json' } })

describe('actual interview dialogue', () => {
  it('blocks high-confidence mixed speech when source-role review is pending', () => {
    assert.equal(assessTranscriptQuality(base().transcript, true).usable, false)
    assert.equal(assessTranscriptQuality(base().transcript, false).usable, true)
  })

  it('blocks many short unknown segments even when a long candidate answer dominates by characters', () => {
    const rows = [segment('answer', 'candidate', '我完成了项目开发和上线验收，并负责后续维护。'.repeat(10), 0),
      ...Array.from({ length: 3 }, (_, i) => segment(`unknown-${i}`, 'unknown', '嗯。', 2000 + i * 2000))]
    assert.equal(assessTranscriptQuality(buildActualDialogue(rows).transcript).usable, false)
  })

  it('counts original segments rather than merged turns when checking unknown share', () => {
    const rows = [...Array.from({ length: 8 }, (_, i) => segment(`answer-${i}`, 'candidate', '我完成了项目开发和上线验收。', i * 2000)),
      ...Array.from({ length: 3 }, (_, i) => segment(`unknown-${i}`, 'unknown', '嗯。', 20_000 + i * 2000))]
    const dialogue = buildActualDialogue(rows)
    assert.equal(dialogue.transcript.length, 4)
    assert.equal(assessTranscriptQuality(dialogue.transcript).usable, true)
  })

  it('blocks scoring when uncertain candidate-like speech outweighs reliable evidence', () => {
    const result = assessTranscriptQuality(buildActualDialogue([
      segment('q', 'interviewer', '项目？', 0),
      segment('a', 'candidate', '我负责开发。', 2000),
      segment('mixed', 'unknown', '我负责开发和测试并且完成了上线交付工作。这里还有很多无法确认的内容，包括项目目标、技术方案、上线结果和后续维护情况。', 4000),
    ]).transcript)
    assert.equal(result.usable, false)
    assert.match(result.warning!, /暂不评分/)
  })

  it('allows a short uncertain fragment when reliable candidate evidence is larger', () => {
    const result = assessTranscriptQuality(buildActualDialogue([
      segment('a', 'candidate', '我负责开发和测试并且完成了项目上线。', 0),
      segment('mixed', 'unknown', '嗯。', 2000),
    ]).transcript)
    assert.equal(result.usable, true)
  })

  it('orders by audio timestamps, merges answer chunks and never attaches the school answer to the project', () => {
    const input = segments().reverse()
    const result = buildActualDialogue(input)
    assert.deepEqual(result.transcript.map(row => row.id), ['project-q', 'project-a', 'school-q', 'school-a'])
    assert.equal(result.pairs.length, 2)
    assert.equal(result.pairs[0]!.answer, '我独立完成需求访谈和接口开发。\n上线前做了回归测试。')
    assert.deepEqual(result.pairs[0]!.answerSegmentIds, ['project-a', 'project-a2'])
    assert.equal(result.pairs[1]!.answer, '答辩时需要回学校两天。')
    assert.equal(input[0]!.id, 'school-a')
  })
  it('preserves uncertain or mixed speech without scoring it or pairing across it', () => {
    const result = buildActualDialogue([segment('q', 'interviewer', '项目？', 0),
      segment('mixed', 'unknown', '你做的？是我做的。', 2000), segment('a', 'candidate', '完整保留。', 4000),
      segment('low', 'candidate', '低置信度。', 6000, 7000, .4)])
    assert.equal(result.pairs[0]!.answer, '')
    assert.equal(result.transcript.length, 4)
    assert.equal(result.transcript[3]!.role, 'unknown')
    assert.equal(result.warnings.length, 2)
  })
  it('does not score simultaneous speech and warns about recording gaps', () => {
    const result = buildActualDialogue([segment('q', 'interviewer', '项目？', 0, 3000),
      segment('overlap', 'candidate', '重叠回答。', 2000, 4000), segment('next', 'interviewer', '下一题？', 50000)])
    assert.ok(result.pairs.every(pair => !pair.answer))
    assert.ok(result.warnings.some(w => w.includes('重叠')))
    assert.ok(result.warnings.some(w => w.includes('空档')))
  })
  it('retains all actual questions even if unanswered, with no synthetic default question', () => {
    const report = createUnscoredSummary([segment('q', 'interviewer', '薪酬方案怎么制定？', 0)])
    assert.equal(report.overallScore, null)
    assert.deepEqual(report.pairs.map(row => row.question), ['薪酬方案怎么制定？'])
  })
})

describe('evidence grounded semantic summary', () => {
  for (const outcome of ['advance', 'reject', 'hold'] as const) {
    it(`preserves evidenced strengths, concerns and ${outcome} advice without changing the application result`, () => {
      const evidence = [{ pairId: 'project-q', quote: '独立完成需求访谈和接口开发' }]
      const strengths = [{ text: '自述具备独立开发经验。', evidence }]
      const concerns = [{ text: '项目描述缺少量化成果。', evidence }]
      const recommendation = { outcome, text: '根据岗位要求进一步评估项目经验。', evidence }
      const result = parseInterviewSummary({ ...output(), strengths, concerns, recommendation }, base())
      assert.deepEqual(result.strengths, strengths)
      assert.deepEqual(result.concerns, concerns)
      assert.deepEqual(result.recommendation, recommendation)
      assert.deepEqual(result.pairs, parseInterviewSummary(output(), base()).pairs)
      assert.equal(result.advisoryOnly, true)
      assert.equal(result.applicationStatusMutation, 'none')
    })
  }
  it('allows an evidence-insufficient hold but rejects unsupported advance or rejection advice', () => {
    const value = { ...output(), dimensions: [], recommendation: { outcome: 'hold', text: '证据不足，建议补充面试。', evidence: [] } }
    assert.equal(parseInterviewSummary(value, base()).recommendation?.outcome, 'hold')
    for (const outcome of ['advance', 'reject']) {
      assert.throws(() => parseInterviewSummary({ ...value, recommendation: { ...value.recommendation, outcome } }, base()))
    }
  })
  it('rejects invented recommendation evidence', () => {
    assert.throws(() => parseInterviewSummary({ ...output(), recommendation: {
      outcome: 'advance', text: '建议推进。', evidence: [{ pairId: 'project-q', quote: '带领百人团队' }],
    } }, base()))
  })
  it('accepts semantic dimension names but computes overall from evidenced dimensions, not model overall', () => {
    const result = parseInterviewSummary(output(), base())
    assert.equal(result.overallScore, 75)
    assert.equal(result.pairs[1]!.kind, 'logistics')
    assert.deepEqual(result.unassessed, ['团队管理能力未考察'])
    assert.deepEqual(result.transcript.map(({ kind: _kind, ...turn }) => turn), base().transcript)
    assert.equal(result.transcript.find(turn => turn.id === 'project-a')?.kind, 'assessment')
    assert.equal(result.applicationStatusMutation, 'none')
  })
  for (const scenario of ['invented-quote', 'interviewer-quote', 'logistics', 'missing-pair', 'duplicate-pair', 'unknown-pair', 'no-evidence', 'invalid-score', 'decision'] as const) {
    it(`rejects ${scenario} instead of saving an unsupported score`, () => {
      const value = output()
      if (scenario === 'invented-quote') value.dimensions[0]!.evidence[0]!.quote = '我管理过二十人的团队'
      if (scenario === 'interviewer-quote') value.dimensions[0]!.evidence[0]!.quote = '请介绍你负责的招聘项目'
      if (scenario === 'logistics') value.dimensions[0]!.evidence = [{ pairId: 'school-q', quote: '回学校两天' }]
      if (scenario === 'missing-pair') value.pairs.pop()
      if (scenario === 'duplicate-pair') value.pairs.push(value.pairs[0]!)
      if (scenario === 'unknown-pair') value.pairs[0]!.id = 'reference-only-question'
      if (scenario === 'no-evidence') value.dimensions[0]!.evidence = []
      if (scenario === 'invalid-score') value.dimensions[0]!.score = 101
      if (scenario === 'decision') Object.assign(value, { decision: 'hire' })
      assert.throws(() => parseInterviewSummary(value, base()))
    })
  }
  it('scores a substantive introduction and later cross-question addition using transcript evidence without requiring question pairs', () => {
    const report = createUnscoredSummary([segment('intro', 'candidate', '我完成接口开发。', 0),
      segment('logistics', 'unknown', '稍等一下。', 4000), segment('addition', 'candidate', '补充之前的项目，我还完成压测。', 7000)])
    const result = parseInterviewSummary({ summary: '自述完成开发与压测。', pairs: [],
      turns: [{ id: 'intro', kind: 'assessment' }, { id: 'logistics', kind: 'logistics' }, { id: 'addition', kind: 'assessment' }],
      dimensions: [{ name: '项目执行', score: 84, text: '结合两次实际发言评价。', evidence: [
        { turnId: 'intro', quote: '完成接口开发' }, { turnId: 'addition', quote: '完成压测' }] }],
      strengths: [], concerns: [], unassessed: ['未问到的题目不影响分数'] }, report)
    assert.equal(result.overallScore, 84)
    assert.equal(result.dimensions[0]!.evidence.length, 2)
    assert.equal(result.pairs.length, 0)
  })
  for (const scenario of ['missing-turn', 'duplicate-turn', 'unknown-turn', 'interviewer-evidence', 'logistics-evidence', 'invented-evidence', 'overlapping-evidence']) {
    it('rejects incomplete review or invalid transcript evidence: ' + scenario, () => {
      const report = base()
      const value: any = output()
      value.dimensions[0].evidence = [{ turnId: 'project-a', quote: '独立完成需求访谈和接口开发' }]
      if (scenario === 'missing-turn') value.turns.pop()
      if (scenario === 'duplicate-turn') value.turns.push(value.turns[0])
      if (scenario === 'unknown-turn') value.turns[0].id = 'reference-only'
      if (scenario === 'interviewer-evidence') value.dimensions[0].evidence = [{ turnId: 'project-q', quote: '请介绍' }]
      if (scenario === 'logistics-evidence') value.dimensions[0].evidence = [{ turnId: 'school-a', quote: '回学校两天' }]
      if (scenario === 'invented-evidence') value.dimensions[0].evidence[0].quote = '我管理团队'
      if (scenario === 'overlapping-evidence') report.transcript[0]!.endMs = 4000
      assert.throws(() => parseInterviewSummary(value, report))
    })
  }
  it('returns null rather than zero when no substantive assessment evidence exists', () => {
    assert.equal(parseInterviewSummary({ ...output(), dimensions: [] }, base()).overallScore, null)
  })
  it('sends actual dialogue and job context, instructing semantic evaluation without inferred competence or reference coverage penalties', async () => {
    let sent: any
    const fetcher: typeof fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body))
      return reply(String(sent.messages[0].content).includes('"turnKinds"') ? { turnKinds: 'aall' } : output())
    }
    const report = await createInterviewSummaryGenerator(config, fetcher).generate(base(), { jobTitle: '人事', requirements: ['招聘'], skills: [] })
    assert.equal(report.overallScore, 75)
    assert.match(sent.messages[0].content, /允许语义等价/)
    assert.match(sent.messages[0].content, /不按0分、不扣分/)
    assert.match(sent.messages[0].content, /严禁/)
    const input = JSON.parse(sent.messages[1].content)
    assert.deepEqual(input.pairs, [
      { id: 'p1', questionTurnIds: ['t1'], answerTurnIds: ['t2'], kind: 'assessment' },
      { id: 'p2', questionTurnIds: ['t3'], answerTurnIds: ['t4'], kind: 'logistics' },
    ])
    assert.deepEqual(input.transcript.map((row: any) => row.text), base().transcript.map(row => row.text))
    assert.deepEqual(input.evidenceTurnIds, ['t2', 't4'])
    assert.deepEqual(Object.keys(input).sort(), ['evidenceTurnIds', 'job', 'pairs', 'transcript', 'warnings'])
  })
  it('passes transcript coverage warnings to evaluation and forbids treating missing recording as an unanswered question', async () => {
    const report = base()
    report.warnings.push('原始录音只覆盖到本场第 5 分 19 秒，距面试结束还有约 17 分钟没有原音频证据；该部分不会被推测补写。')
    const requests: any[] = []
    await createInterviewSummaryGenerator(config, async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      requests.push(request)
      if (String(request.messages[0].content).includes('"turnKinds"')) return reply({ turnKinds: 'aall' })
      return reply(output())
    }).generate(report, { jobTitle: '人事', requirements: ['招聘'], skills: [] })

    for (const request of requests.slice(1)) {
      assert.deepEqual(JSON.parse(request.messages[1].content).warnings, report.warnings)
    }
    assert.match(requests[1].messages[0].content, /不能据此推断候选人未回答、拒绝回答、面试中止或能力不足/u)
    assert.match(requests[1].messages[0].content, /不得据此扣分、生成负面风险或降低推荐结论/u)
    assert.match(requests[1].messages[0].content, /所有总结、评价、优势、风险、推荐和待核实文本必须使用简体中文/u)
  })
  it('disables extended reasoning for DeepSeek so the JSON summary reaches final content', async () => {
    let sent: any
    const fetcher: typeof fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body))
      return reply(String(sent.messages[0].content).includes('"turnKinds"') ? { turnKinds: 'aall' } : output())
    }
    await createInterviewSummaryGenerator({ ...config, model: 'deepseek-v4-flash' }, fetcher)
      .generate(base(), { jobTitle: '人事', requirements: ['招聘'], skills: [] })
    assert.deepEqual(sent.thinking, { type: 'disabled' })
    assert.equal(sent.max_completion_tokens, 8192)
    assert.deepEqual(sent.response_format, { type: 'json_object' })
  })
  it('rejects oversized input without truncating and never calls the model', async () => {
    const report = base(); report.transcript[0]!.text = 'a'.repeat(160001)
    await assert.rejects(createInterviewSummaryGenerator(config, async () => { throw new Error('must not call') })
      .generate(report, { jobTitle: '人事', requirements: [], skills: [] }), /超出模型/)
  })
})

describe('summary request resilience and compact classifications', () => {
  const job = { jobTitle: '人事', requirements: [], skills: [] }
  const classification = () => ({ turnKinds: 'aall', pairKinds: 'al' })
  const legacyClassification = () => ({
    turnKinds: { assessment: ['t1', 't2'], logistics: ['t3', 't4'], unreviewed: [] },
    pairKinds: { assessment: ['p1'], logistics: ['p2'], unreviewed: [] },
  })
  const compact = () => ({ ...output(), ...legacyClassification(), turns: undefined, pairs: undefined,
    recommendation: null,
    dimensions: output().dimensions.map(row => ({ ...row, evidence: row.evidence.map(item => ({ turnId: 't2', quote: item.quote })) })),
  })
  it('classifies first, then evaluates only after restoring every turn kind', async () => {
    const requests: any[] = []
    const result = await createInterviewSummaryGenerator(config, async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return reply(requests.length === 1 ? classification() : compact())
    }).generate(base(), job)
    assert.equal(requests.length, 5)
    assert.match(requests[0].messages[0].content, /只分类/)
    assert.match(requests[1].messages[0].content, /本步只生成整场总结/)
    assert.match(requests[2].messages[0].content, /本步只生成已实际考察的岗位相关维度/)
    assert.match(requests[3].messages[0].content, /本步只生成已有原文依据的优势和风险/)
    assert.match(requests[4].messages[0].content, /本步只生成人工参考推荐和待核实事项/)
    assert.equal(JSON.parse(requests[0].messages[1].content).transcript[0].kind, undefined)
    const evaluationInput = JSON.parse(requests[1].messages[1].content)
    assert.deepEqual(evaluationInput.transcript.map((row: any) => row.kind), ['assessment', 'assessment', 'logistics', 'logistics'])
    assert.deepEqual(evaluationInput.pairs.map((row: any) => row.kind), ['assessment', 'logistics'])
    assert.equal(result.overallScore, 75)
  })
  it('splits a classification batch after repeated truncated codes instead of failing the interview', async () => {
    let calls = 0
    const result = await createInterviewSummaryGenerator(config, async (_url, init) => {
      calls++
      const request = JSON.parse(String(init?.body))
      if (String(request.messages[0].content).includes('只分类')) {
        const source = JSON.parse(request.messages[1].content) as { transcript: Array<{ text: string }> }
        if (source.transcript.length > 2) return reply({ turnKinds: 'a' })
        return reply({ turnKinds: source.transcript[0]!.text.includes('毕业') ? 'll' : 'aa' })
      }
      return reply(compact())
    }).generate(base(), job)
    assert.equal(calls, 8)
    assert.equal(result.overallScore, 75)
  })
  it('restores compact references to original IDs and retains the full report', async () => {
    const result = await createInterviewSummaryGenerator(config, async () => reply(compact())).generate(base(), job)
    assert.equal(result.overallScore, 75)
    assert.deepEqual(result.dimensions[0]!.evidence, [{ turnId: 'project-a', quote: '独立完成需求访谈和接口开发' }])
    assert.deepEqual(result.transcript.map(row => row.id), base().transcript.map(row => row.id))
    assert.deepEqual(result.pairs.map(row => row.id), base().pairs.map(row => row.id))
  })
  it('restores compact evidence references in staged responses without classification fields', async () => {
    let calls = 0
    const value = compact()
    const result = await createInterviewSummaryGenerator(config, async () => {
      calls++
      if (calls === 1) return reply(classification())
      if (calls === 2) return reply({ summary: value.summary })
      if (calls === 3) return reply({ dimensions: value.dimensions })
      if (calls === 4) return reply({ strengths: [], concerns: [] })
      return reply({ unassessed: value.unassessed, recommendation: null })
    }).generate(base(), job)
    assert.equal(calls, 5)
    assert.equal(result.overallScore, 75)
    assert.deepEqual(result.dimensions[0]!.evidence, [{ turnId: 'project-a', quote: '独立完成需求访谈和接口开发' }])
  })
  for (const scenario of ['missing', 'duplicate', 'invented-id', 'invented-quote', 'wrong-speaker', 'missing-group']) {
    it('rejects invalid compact evidence or incomplete classification: ' + scenario, async () => {
      const value: any = compact()
      if (scenario === 'missing') value.turnKinds.assessment.pop()
      if (scenario === 'duplicate') value.turnKinds.logistics.push('t2')
      if (scenario === 'invented-id') value.turnKinds.assessment.push('t999')
      if (scenario === 'invented-quote') value.dimensions[0].evidence[0].quote = '我管理百人团队'
      if (scenario === 'wrong-speaker') value.dimensions[0].evidence = [{ turnId: 't1', quote: '请介绍' }]
      if (scenario === 'missing-group') delete value.pairKinds.unreviewed
      await assert.rejects(createInterviewSummaryGenerator(config, async () => reply(value)).generate(base(), job))
    })
  }
  for (const mode of ['network', 'timeout', 'body-timeout', 'http429', 'http503']) {
    it('automatically retries one transient failure with a fresh request: ' + mode, async () => {
      let attempts = 0, waits = 0
      const signals: unknown[] = []
      const result = await createInterviewSummaryGenerator(config, async (_url, init) => {
        signals.push(init?.signal)
        if (++attempts === 1) {
          if (mode === 'network') throw new TypeError('fetch failed')
          if (mode === 'timeout') throw new DOMException('expired', 'TimeoutError')
          if (mode === 'body-timeout') return Object.assign(new Response('{}'), { json: async () => { throw new DOMException('expired', 'AbortError') } })
          return new Response('', { status: mode === 'http429' ? 429 : 503 })
        }
        return reply(compact())
      }, async ms => { assert.equal(ms, 1000); waits++ }).generate(base(), job)
      assert.equal(attempts, 6); assert.equal(waits, 1); assert.equal(result.overallScore, 75)
      assert.notEqual(signals[0], signals[1]); assert.notEqual(signals[1], signals[2])
    })
  }
  it('recovers when the first two requests return HTTP 502', async () => {
    let attempts = 0
    const waits: number[] = []
    const result = await createInterviewSummaryGenerator(config, async () => {
      attempts++
      if (attempts <= 2) return new Response('temporarily unavailable', { status: 502 })
      return reply(attempts === 3 ? classification() : compact())
    }, async ms => { waits.push(ms) }).generate(base(), job)
    assert.equal(result.overallScore, 75)
    assert.equal(attempts, 7)
    assert.deepEqual(waits, [1000, 2000])
  })
  it('retries once when the model response fails evidence validation', async () => {
    let attempts = 0
    const invalid = compact()
    invalid.dimensions[0]!.evidence = []
    const result = await createInterviewSummaryGenerator(config, async () => {
      attempts++
      return reply(attempts === 1 ? classification() : attempts === 2 ? invalid : compact())
    }).generate(base(), job)
    assert.equal(attempts, 5)
    assert.equal(result.overallScore, 75)
  })
  it('bounds repeated timeouts to four attempts with a useful error', async () => {
    let attempts = 0
    const waits: number[] = []
    await assert.rejects(createInterviewSummaryGenerator(config, async () => {
      attempts++; throw new DOMException('expired', 'TimeoutError')
    }, async ms => { waits.push(ms) }).generate(base(), job), /超时（1秒）.*完整转写已保留/)
    assert.equal(attempts, 4)
    assert.deepEqual(waits, [1000, 2000, 4000])
  })
  it('returns a clear HTTP error after four consecutive transient failures', async () => {
    let attempts = 0
    const waits: number[] = []
    await assert.rejects(createInterviewSummaryGenerator(config, async () => {
      attempts++; return new Response('temporarily unavailable', { status: 502 })
    }, async ms => { waits.push(ms) }).generate(base(), job), /HTTP 502/)
    assert.equal(attempts, 4)
    assert.deepEqual(waits, [1000, 2000, 4000])
  })
  for (const status of [400, 401, 403]) {
    it('does not retry permanent configuration/authorization HTTP ' + status, async () => {
      let attempts = 0
      await assert.rejects(createInterviewSummaryGenerator(config, async () => {
        attempts++; return new Response('invalid setting', { status })
      }, async () => { throw new Error('must not retry') }).generate(base(), job), new RegExp('HTTP ' + status))
      assert.equal(attempts, 1)
    })
  }
  it('does not accept a truncated JSON completion', async () => {
    await assert.rejects(createInterviewSummaryGenerator(config, async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: JSON.stringify(compact()) } }],
    }))).generate(base(), job), /长度限制/)
  })
  it('recovers the final complete JSON from reasoning when only the message body is truncated', async () => {
    let calls = 0
    const result = await createInterviewSummaryGenerator(config, async () => {
      calls++
      if (calls > 1) return reply(compact())
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: '{"turnKinds":"aall","pair',
        reasoning_content: `逐段核对完毕。\n最终输出：${JSON.stringify(classification())}`,
      } }] }))
    }).generate(base(), job)
    assert.equal(calls, 5)
    assert.equal(result.overallScore, 75)
    assert.deepEqual(result.transcript.map(row => row.kind), ['assessment', 'assessment', 'logistics', 'logistics'])
  })
  it('recovers when a complete JSON value is missing only its outer closing brace', async () => {
    let calls = 0
    const result = await createInterviewSummaryGenerator(config, async () => {
      calls++
      if (calls !== 3) return reply(calls === 1 ? classification() : compact())
      const complete = JSON.stringify({ dimensions: compact().dimensions })
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: complete.slice(0, -1),
      } }] }))
    }).generate(base(), job)
    assert.equal(calls, 5)
    assert.equal(result.overallScore, 75)
  })
  it('does not recover a JSON string truncated in the middle', async () => {
    let calls = 0
    await assert.rejects(createInterviewSummaryGenerator(config, async () => {
      calls++
      if (calls === 1) return reply(classification())
      if (calls === 2) return reply(compact())
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: '{"dimensions":[{"name":"项目执行',
      } }] }))
    }).generate(base(), job), /JSON结束前中断/)
    assert.equal(calls, 4)
  })
  it('recovers a complete turn classification from a truncated classification body', async () => {
    let calls = 0
    const result = await createInterviewSummaryGenerator(config, async () => {
      calls++
      if (calls > 1) return reply(compact())
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: '{"turnKinds":"aall","pair',
      } }] }))
    }).generate(base(), job)
    assert.equal(calls, 5)
    assert.equal(result.overallScore, 75)
    assert.deepEqual(result.pairs.map(row => row.kind), ['assessment', 'logistics'])
  })
  it('recovers a complete compact classification missing its closing quote and brace', async () => {
    let calls = 0
    const result = await createInterviewSummaryGenerator(config, async () => {
      calls++
      if (calls > 1) return reply(compact())
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: '{"turnKinds":"aall',
      } }] }))
    }).generate(base(), job)
    assert.equal(calls, 5)
    assert.equal(result.overallScore, 75)
    assert.deepEqual(result.transcript.map(row => row.kind), ['assessment', 'assessment', 'logistics', 'logistics'])
  })
  it('keeps complete summary sentences when only the summary field is truncated', async () => {
    let calls = 0
    const complete = '候选人自述独立完成需求分析、项目开发、回归测试和上线交付，相关经历与岗位方向基本匹配。'
    const result = await createInterviewSummaryGenerator(config, async () => {
      calls++
      if (calls === 1) return reply({ turnKinds: 'aall' })
      if (calls === 2) return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: `{"summary":"${complete}但项目成果和个人贡献边界仍需要`,
        reasoning_content: JSON.stringify({ summary: '中文整场总结' }),
      } }] }))
      return reply(compact())
    }).generate(base(), job)
    assert.equal(calls, 5)
    assert.equal(result.summary, complete)
    assert.equal(result.overallScore, 75)
  })
  it('recovers complete pending-check items when the recommendation list ends mid-string', async () => {
    let calls = 0
    const result = await createInterviewSummaryGenerator(config, async () => {
      calls++
      if (calls === 1) return reply(classification())
      if (calls === 2) return reply({ summary: output().summary })
      if (calls === 3) return reply({ dimensions: compact().dimensions })
      if (calls === 4) return reply({ strengths: [], concerns: [] })
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: '{"recommendation":{"outcome":"hold","text":"现有证据仅覆盖开场记录，建议补充岗位相关技术评估后再决定。","evidence":[]},"unassessed":["团队管理能力未考察","项目成果需要核实","后续技术细节未',
      } }] }))
    }).generate(base(), job)
    assert.equal(calls, 5)
    assert.equal(result.recommendation?.outcome, 'hold')
    assert.deepEqual(result.unassessed, ['团队管理能力未考察', '项目成果需要核实'])
  })
  it('rejects an unrelated recovery object and retries the recommendation stage', async () => {
    let calls = 0
    const result = await createInterviewSummaryGenerator(config, async () => {
      calls++
      if (calls === 1) return reply(classification())
      if (calls >= 2 && calls <= 4) return reply(compact())
      if (calls === 5) return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: '{"recommendation":',
        reasoning_content: '{}',
      } }] }))
      return reply({ recommendation: null, unassessed: [] })
    }).generate(base(), job)
    assert.equal(calls, 6)
    assert.equal(result.overallScore, 75)
  })
})

describe('summary background processing', () => {
  function fixture(rows = segments(), fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    if (String(request.messages[0].content).includes('"turnKinds"')) {
      const source = JSON.parse(request.messages[1].content) as { transcript: unknown[] }
      return reply({ turnKinds: 'a'.repeat(source.transcript.length) })
    }
    return reply(output())
  }, failRead = false, previousReport: ReturnType<typeof base> | null = null, transcriptWarnings: string[] = [], transcriptRoleReviewRequired = false) {
    const saved: Array<{ report: ReturnType<typeof base>; error: string | null }> = []
    let resolved = 0
    const job = { sessionId: 'session', applicationId: 'app', revision: 3, claim: 'claim', previousReport }
    const repository = { claim: async () => job, save: async (_job: unknown, report: ReturnType<typeof base>, error: string | null) => { saved.push({ report, error }); return true }, latest: async () => null, request: async () => { throw new Error('unused') } }
    const service = new InterviewSummaryService(repository, { get: async () => { if (failRead) throw new Error('读取转写暂时失败'); return { session: {} as never, segments: rows, transcriptWarnings, transcriptRoleReviewRequired } } },
      { getApplicationJobContext: async () => ({ candidateName: '测试候选人', jobTitle: '人事', requirements: [], skills: [] }) },
      async appId => { assert.equal(appId, 'app'); resolved++; return { OPENAI_BASE_URL: config.baseUrl, OPENAI_API_KEY: config.apiKey, OPENAI_MODEL: config.model } }, fetcher)
    return { service, saved, get resolved() { return resolved } }
  }
  it('uses the application-specific model and saves a complete report', async () => {
    const f = fixture(); assert.equal(await f.service.processPending(), true)
    assert.equal(f.resolved, 1); assert.equal(f.saved[0]!.report.overallScore, 75); assert.equal(f.saved[0]!.error, null)
  })
  it('saves an explicitly review-required report without model calls or previous scores', async () => {
    let calls = 0
    const previous = { ...base(), overallScore: 86 }
    const f = fixture(segments(), async () => { calls++; throw new Error('must not call model') }, false, previous, ['混合音轨角色未确认。'], true)
    await f.service.processPending()
    assert.equal(calls, 0)
    assert.equal(f.resolved, 0)
    assert.equal(f.saved[0]!.error, null)
    assert.equal(f.saved[0]!.report.overallScore, null)
    assert.equal(f.saved[0]!.report.reviewRequired, true)
    assert.deepEqual(f.saved[0]!.report.dimensions, [])
    assert.equal(f.saved[0]!.report.recommendation, null)
    assert.match(f.saved[0]!.report.summary, /暂不评分/u)
    assert.deepEqual(f.saved[0]!.report.transcript, base().transcript)
  })

  it('carries corrected transcript warnings into the model input and saved report', async () => {
    const warning = '原始录音只覆盖到本场第 5 分 19 秒，距面试结束还有约 17 分钟没有原音频证据。'
    const inputs: any[] = []
    const f = fixture(segments(), async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      inputs.push(JSON.parse(request.messages[1].content))
      return reply(String(request.messages[0].content).includes('"turnKinds"') ? { turnKinds: 'aall' } : output())
    }, false, null, [warning])

    await f.service.processPending()

    assert.ok(f.saved[0]!.report.warnings.includes(warning))
    assert.ok(inputs.length > 1 && inputs.slice(1).every(input => input.warnings.includes(warning)))
    assert.equal(f.saved[0]!.error, null)
  })
  it('releases a claimed task as failed when reading the transcript fails', async () => {
    const f = fixture([], undefined, true)
    assert.equal(await f.service.processPending(), true)
    assert.equal(f.saved.length, 1); assert.match(f.saved[0]!.error!, /读取转写暂时失败/)
  })
  it('allows a five-minute attempt for long interviews and retains every turn', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => segment('turn-' + i, 'candidate', '完整发言' + i, i * 10000))
    let duration = 0, calls = 0
    const f = fixture(rows, async (_url, init) => {
      calls++
      duration = Math.round(((init!.signal as AbortSignal & { testTimeout?: number }).testTimeout ?? 0))
      const body = JSON.parse(String(init?.body))
      const source = JSON.parse(body.messages[1].content)
      if (String(body.messages[0].content).includes('"turnKinds"')) {
        return reply({ turnKinds: 'u'.repeat(source.transcript.length) })
      }
      return reply({ summary: '候选人相关项目经历仍需结合原始材料进一步核实。', dimensions: [], strengths: [], concerns: [], unassessed: [], recommendation: null })
    })
    // Inspect the deadline without waiting for an actual five-minute abort.
    const timeout = AbortSignal.timeout
    AbortSignal.timeout = ms => Object.assign(timeout(ms), { testTimeout: ms })
    try { await f.service.processPending() } finally { AbortSignal.timeout = timeout }
    assert.equal(duration, 300000); assert.equal(calls, 24); assert.equal(f.saved[0]!.report.transcript.length, 120)
  })
  it('preserves every transcript turn and actual question after model failure', async () => {
    const f = fixture(segments(), async () => new Response('upstream down', { status: 503 }))
    await f.service.processPending()
    assert.ok(f.saved[0]!.error)
    assert.equal(f.saved[0]!.report.overallScore, null)
    assert.deepEqual(f.saved[0]!.report.transcript, base().transcript)
    assert.equal(f.saved[0]!.report.pairs.length, 2)
  })
  it('preserves an existing evidenced report when regeneration fails', async () => {
    const previous = { ...base(), summary: '之前已经生成的面试结论。', overallScore: 86 }
    const f = fixture(segments(), async () => new Response('upstream down', { status: 503 }), false, previous)
    await f.service.processPending()
    assert.ok(f.saved[0]!.error)
    assert.equal(f.saved[0]!.report.summary, previous.summary)
    assert.equal(f.saved[0]!.report.overallScore, 86)
  })
  it('evaluates candidate-only substantive speech instead of requiring a paired question', async () => {
    const rows = [segment('intro', 'candidate', '我独立完成项目开发。', 0)]
    const f = fixture(rows, async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      if (String(request.messages[0].content).includes('"turnKinds"')) return reply({ turnKinds: 'a' })
      return reply({ summary: '候选人自述独立完成项目开发，具体个人贡献仍需补充核验。', pairs: [],
        dimensions: [{ name: '项目开发', score: 82, text: '有实际发言证据。', evidence: [{ turnId: 'intro', quote: '独立完成项目开发' }] }],
        strengths: [], concerns: [], unassessed: [] })
    })
    await f.service.processPending()
    assert.equal(f.resolved, 1)
    assert.equal(f.saved[0]!.report.overallScore, 82)
    assert.equal(f.saved[0]!.error, null)
  })
  it('keeps unknown-only speech without calling AI or fabricating a score', async () => {
    const f = fixture([segment('mixed', 'unknown', '请问项目？我负责开发。', 0)])
    await f.service.processPending()
    assert.equal(f.resolved, 0)
    assert.equal(f.saved[0]!.report.overallScore, null)
    assert.equal(f.saved[0]!.report.transcript[0]!.text, '请问项目？我负责开发。')
  })
  it('handles empty transcription as unscored, not as a failed candidate', async () => {
    const f = fixture([]); await f.service.processPending()
    assert.equal(f.resolved, 0); assert.equal(f.saved[0]!.report.overallScore, null)
    assert.match(f.saved[0]!.report.summary, /尚无/)
  })
})

it('starts another summary while a long model request is running and caps concurrency at two', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] })
  let calls = 0
  const releases: Array<() => void> = []
  const stop = startInterviewSummaryPoll({ processPending: async () => {
    calls++; await new Promise<void>(resolve => releases.push(resolve)); return false
  } })
  try {
    assert.equal(calls, 1)
    context.mock.timers.tick(3000); assert.equal(calls, 2)
    context.mock.timers.tick(6000); assert.equal(calls, 2)
  } finally { stop(); releases.forEach(resolve => resolve()); context.mock.timers.reset() }
})
