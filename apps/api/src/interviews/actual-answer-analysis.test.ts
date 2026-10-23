import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { analyzeActualAnswer } from './actual-answer-analysis.js'
import type { InterviewAnswerAnalysis, InterviewAnswerAnalysisInput } from './answer-analyzer.js'
import type { LiveSegment } from './live-session-repository.js'

const row = (id: string, role: LiveSegment['role'], text: string, startMs: number, confidence = 1): LiveSegment =>
  ({ id, role, text, startMs, endMs: startMs + 1000, confidence, sessionId: 's', speakerId: role, status: 'transcribed' })
const job = { jobTitle: '工程师', jobRequirements: ['开发'] }
const analysis: InterviewAnswerAnalysis = { summary: '项目经历', evidence: [], scores: [], concerns: [], confidence: .8, nextQuestion: '未问的建议题', advisoryOnly: true, applicationStatusMutation: 'none' }

describe('actual answer analysis', () => {
  it('refines complete interviewer speech without scoring candidates or mutating model output', async () => {
    const rows = [row('a', 'interviewer', '请介绍使用微付务的项目。', 0), row('b', 'interviewer', '重点说说你负责的部分。', 2000)]
    const original = structuredClone(rows)
    const modelResult: InterviewAnswerAnalysis = { ...analysis, evidence: ['请介绍'], concerns: ['不应进入候选人风险'],
      scores: [{ dimension: '错误评分', score: 9, rationale: '不应采用' }],
      transcriptRefinement: { text: '请介绍使用微服务的项目，重点说说你负责的部分。', corrections: [{ original: '微付务', corrected: '微服务' }], uncertainties: [] } }
    const snapshot = structuredClone(modelResult)
    let received: InterviewAnswerAnalysisInput | undefined
    const result = await analyzeActualAnswer(rows, ['a', 'b'], job, async input => { received = input; return modelResult })
    assert.equal(received?.speechRole, 'interviewer')
    assert.equal(received?.refineTranscript, true)
    assert.equal(received?.candidateAnswer, rows.map(row => row.text).join('\n'))
    assert.equal(result.question, '')
    assert.deepEqual(result.analysis.scores, [])
    assert.deepEqual(result.analysis.evidence, [])
    assert.deepEqual(result.analysis.concerns, [])
    assert.equal(result.analysis.nextQuestion, '')
    assert.deepEqual(result.analysis.transcriptRefinement, modelResult.transcriptRefinement)
    assert.deepEqual(result.analysis.sourceSegments, rows.map(({ id, text, role, speakerId }) => ({ id, text, role, speakerId })))
    assert.deepEqual(rows, original)
    assert.deepEqual(modelResult, snapshot)
  })
  for (const scenario of ['mixed-role', 'low-confidence', 'overlap', 'unknown']) {
    it('rejects ambiguous interviewer speech before model calls: ' + scenario, async () => {
      const rows = [row('a', 'interviewer', '请介绍你的项目。', 0), row('b', 'interviewer', '请说明你的职责。', 2000)]
      if (scenario === 'mixed-role') rows[1]!.role = 'candidate'
      if (scenario === 'low-confidence') rows[0]!.confidence = .4
      if (scenario === 'overlap') rows.push(row('other', 'candidate', '交叠的声音', 500))
      if (scenario === 'unknown') rows[1]!.role = 'unknown'
      await assert.rejects(analyzeActualAnswer(rows, ['a', 'b'], job, async () => { throw new Error('must not call model') }), /重叠|待确认|先核实/)
    })
  }
  it('analyzes the complete manually confirmed answer across different acoustic identities', async () => {
    const rows = [row('q', 'interviewer', '介绍一下项目。', 0),
      { ...row('a', 'candidate', '我完成了开发。', 2000), speakerId: 'voice_1', speakerConfirmed: true },
      { ...row('b', 'candidate', '并完成了验收。', 4000), speakerId: 'voice_2', speakerConfirmed: true }]
    let received: InterviewAnswerAnalysisInput | undefined
    const result = await analyzeActualAnswer(rows, ['a', 'b'], job, async input => {
      received = input
      rows[1]!.text = '模型等待时已修改'
      return { ...analysis, sourceSegments: [{ id: 'forged', text: 'forged', role: 'candidate', speakerId: 'forged' }] }
    })
    assert.equal(received?.candidateAnswer, '我完成了开发。\n并完成了验收。')
    assert.equal(received?.question, '介绍一下项目。')
    assert.equal(received?.refineTranscript, true)
    assert.deepEqual(result.analysis.sourceSegments, [
      { id: 'a', text: '我完成了开发。', role: 'candidate', speakerId: 'voice_1' },
      { id: 'b', text: '并完成了验收。', role: 'candidate', speakerId: 'voice_2' },
    ])
    rows[2]!.speakerConfirmed = false
    await assert.rejects(analyzeActualAnswer(rows, ['a', 'b'], job, async () => { throw new Error('must not call model') }), /重叠|待确认/)
  })
  it('uses the saved actual question and complete answer, not selected references or a later unrelated question', async () => {
    const rows = [row('q', 'interviewer', '请介绍你的项目经历。', 0), row('a', 'candidate', '我负责工单系统。', 2000),
      row('a2', 'candidate', '完成了接口和回归测试。', 3500), row('q2', 'interviewer', '毕业后还需要回学校吗？', 7000), row('a3', 'candidate', '需要两天。', 9000)]
    let received: InterviewAnswerAnalysisInput | undefined
    const result = await analyzeActualAnswer(rows.reverse(), ['a', 'a2'], job, async input => { received = input; return analysis })
    assert.equal(result.question, '请介绍你的项目经历。')
    assert.equal(received?.candidateAnswer, ['我负责工单系统。', '完成了接口和回归测试。'].join(String.fromCharCode(10)))
    assert.ok(!JSON.stringify(received).includes('请求执行顺序'))
    assert.ok(!JSON.stringify(received).includes('回学校'))
    assert.equal(result.analysis.nextQuestion, '未问的建议题')
  })
  it('keeps all prior turns and cross-question additions, rather than the last eight turns', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => row('q' + i, i % 2 ? 'candidate' : 'interviewer', '上下文' + i, i * 3000))
    rows.push(row('a', 'candidate', '补充之前的项目，我还完成了压测。', 40000))
    let received: InterviewAnswerAnalysisInput | undefined
    await analyzeActualAnswer(rows, ['a'], job, async input => { received = input; return analysis })
    assert.equal(received?.priorContext.length, 12)
    assert.equal(received?.transcript?.length, 13)
    assert.equal(received?.transcript?.[0]?.text, '上下文0')
  })
  for (const scenario of ['no-question', 'unconfirmed-question']) {
    it('uses actual candidate speech without inventing a question: ' + scenario, async () => {
      const rows = [row('q', 'interviewer', '请介绍项目。', 0), row('a', 'candidate', '我完成了开发。', 2000)]
      if (scenario === 'no-question') rows.shift()
      else rows[0]!.confidence = .4
      let received: InterviewAnswerAnalysisInput | undefined
      const result = await analyzeActualAnswer(rows, ['a'], job, async input => { received = input; return analysis })
      assert.equal(result.question, '')
      assert.equal(received?.question, '')
      assert.equal(received?.candidateAnswer, '我完成了开发。')
      assert.deepEqual(result.analysis.scores, [])
    })
  }
  for (const scenario of ['unknown-boundary', 'overlap', 'mixed-answers']) {
    it('rejects ambiguous speech instead of calling a model or creating zero scores: ' + scenario, async () => {
      let rows = [row('q', 'interviewer', '请介绍项目。', 0), row('a', 'candidate', '我完成了开发。', 2000)]
      let ids = ['a']
      if (scenario === 'unknown-boundary') rows.splice(1, 0, row('mixed', 'unknown', '混合声音', 1200))
      if (scenario === 'overlap') rows[0]!.endMs = 3000
      if (scenario === 'mixed-answers') { rows.push(row('q2', 'interviewer', '下一题？', 5000), row('a2', 'candidate', '另一个回答', 7000)); ids = ['a', 'a2'] }
      await assert.rejects(analyzeActualAnswer(rows, ids, job, async () => { throw new Error('must not call model') }), /重叠|待确认/)
    })
  }
})
