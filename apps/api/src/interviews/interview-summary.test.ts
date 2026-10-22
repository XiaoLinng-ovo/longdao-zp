import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildActualDialogue, createUnscoredSummary, createInterviewSummaryGenerator, parseInterviewSummary } from './interview-summary.js'
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
    const fetcher: typeof fetch = async (_url, init) => { sent = JSON.parse(String(init?.body)); return reply(output()) }
    const report = await createInterviewSummaryGenerator(config, fetcher).generate(base(), { jobTitle: '人事', requirements: ['招聘'], skills: [] })
    assert.equal(report.overallScore, 75)
    assert.match(sent.messages[0].content, /允许语义等价/)
    assert.match(sent.messages[0].content, /不按0分、不扣分/)
    assert.match(sent.messages[0].content, /严禁/)
    const input = JSON.parse(sent.messages[1].content)
    assert.deepEqual(input.pairs, [
      { id: 'p1', questionTurnIds: ['t1'], answerTurnIds: ['t2'] },
      { id: 'p2', questionTurnIds: ['t3'], answerTurnIds: ['t4'] },
    ])
    assert.deepEqual(input.transcript.map((row: any) => row.text), base().transcript.map(row => row.text))
    assert.deepEqual(input.evidenceTurnIds, ['t2', 't4'])
    assert.deepEqual(Object.keys(input).sort(), ['evidenceTurnIds', 'job', 'pairs', 'transcript'])
  })
  it('rejects oversized input without truncating and never calls the model', async () => {
    const report = base(); report.transcript[0]!.text = 'a'.repeat(160001)
    await assert.rejects(createInterviewSummaryGenerator(config, async () => { throw new Error('must not call') })
      .generate(report, { jobTitle: '人事', requirements: [], skills: [] }), /超出模型/)
  })
})

describe('summary request resilience and compact classifications', () => {
  const job = { jobTitle: '人事', requirements: [], skills: [] }
  const compact = () => ({ ...output(), turns: undefined, pairs: undefined,
    turnKinds: { assessment: ['t1', 't2'], logistics: ['t3', 't4'], unreviewed: [] },
    pairKinds: { assessment: ['p1'], logistics: ['p2'], unreviewed: [] },
    dimensions: output().dimensions.map(row => ({ ...row, evidence: row.evidence.map(item => ({ turnId: 't2', quote: item.quote })) })),
  })
  it('restores compact references to original IDs and retains the full report', async () => {
    const result = await createInterviewSummaryGenerator(config, async () => reply(compact())).generate(base(), job)
    assert.equal(result.overallScore, 75)
    assert.deepEqual(result.dimensions[0]!.evidence, [{ turnId: 'project-a', quote: '独立完成需求访谈和接口开发' }])
    assert.deepEqual(result.transcript.map(row => row.id), base().transcript.map(row => row.id))
    assert.deepEqual(result.pairs.map(row => row.id), base().pairs.map(row => row.id))
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
      assert.equal(attempts, 2); assert.equal(waits, 1); assert.equal(result.overallScore, 75)
      assert.notEqual(signals[0], signals[1])
    })
  }
  it('retries once when the model response fails evidence validation', async () => {
    let attempts = 0
    const invalid = compact()
    invalid.dimensions[0]!.evidence = []
    const result = await createInterviewSummaryGenerator(config, async () => {
      attempts++
      return reply(attempts === 1 ? invalid : compact())
    }).generate(base(), job)
    assert.equal(attempts, 2)
    assert.equal(result.overallScore, 75)
  })
  it('bounds repeated timeouts to two attempts with a useful error', async () => {
    let attempts = 0
    await assert.rejects(createInterviewSummaryGenerator(config, async () => {
      attempts++; throw new DOMException('expired', 'TimeoutError')
    }, async () => {}).generate(base(), job), /超时（1秒）.*完整转写已保留/)
    assert.equal(attempts, 2)
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
})

describe('summary background processing', () => {
  function fixture(rows = segments(), fetcher: typeof fetch = async () => reply(output()), failRead = false, previousReport: ReturnType<typeof base> | null = null) {
    const saved: Array<{ report: ReturnType<typeof base>; error: string | null }> = []
    let resolved = 0
    const job = { sessionId: 'session', applicationId: 'app', revision: 3, claim: 'claim', previousReport }
    const repository = { claim: async () => job, save: async (_job: unknown, report: ReturnType<typeof base>, error: string | null) => { saved.push({ report, error }); return true }, latest: async () => null, request: async () => { throw new Error('unused') } }
    const service = new InterviewSummaryService(repository, { get: async () => { if (failRead) throw new Error('读取转写暂时失败'); return { session: {} as never, segments: rows } } },
      { getApplicationJobContext: async () => ({ candidateName: '测试候选人', jobTitle: '人事', requirements: [], skills: [] }) },
      async appId => { assert.equal(appId, 'app'); resolved++; return { OPENAI_BASE_URL: config.baseUrl, OPENAI_API_KEY: config.apiKey, OPENAI_MODEL: config.model } }, fetcher)
    return { service, saved, get resolved() { return resolved } }
  }
  it('uses the application-specific model and saves a complete report', async () => {
    const f = fixture(); assert.equal(await f.service.processPending(), true)
    assert.equal(f.resolved, 1); assert.equal(f.saved[0]!.report.overallScore, 75); assert.equal(f.saved[0]!.error, null)
  })
  it('releases a claimed task as failed when reading the transcript fails', async () => {
    const f = fixture([], undefined, true)
    assert.equal(await f.service.processPending(), true)
    assert.equal(f.saved.length, 1); assert.match(f.saved[0]!.error!, /读取转写暂时失败/)
  })
  it('allows a five-minute attempt for long interviews and retains every turn', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => segment('turn-' + i, 'candidate', '完整发言' + i, i * 10000))
    let duration = 0
    const f = fixture(rows, async (_url, init) => {
      duration = Math.round(((init!.signal as AbortSignal & { testTimeout?: number }).testTimeout ?? 0))
      return reply({ summary: '证据待核实。', pairs: [], turns: rows.map(row => ({ id: row.id, kind: 'unreviewed' })), dimensions: [], strengths: [], concerns: [], unassessed: [] })
    })
    // Inspect the deadline without waiting for an actual five-minute abort.
    const timeout = AbortSignal.timeout
    AbortSignal.timeout = ms => Object.assign(timeout(ms), { testTimeout: ms })
    try { await f.service.processPending() } finally { AbortSignal.timeout = timeout }
    assert.equal(duration, 300000); assert.equal(f.saved[0]!.report.transcript.length, 120)
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
    const f = fixture(rows, async () => reply({ summary: '自述项目开发。', pairs: [], turns: [{ id: 'intro', kind: 'assessment' }],
      dimensions: [{ name: '项目开发', score: 82, text: '有实际发言证据。', evidence: [{ turnId: 'intro', quote: '独立完成项目开发' }] }],
      strengths: [], concerns: [], unassessed: [] }))
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
