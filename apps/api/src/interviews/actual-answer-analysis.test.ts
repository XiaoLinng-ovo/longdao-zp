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
