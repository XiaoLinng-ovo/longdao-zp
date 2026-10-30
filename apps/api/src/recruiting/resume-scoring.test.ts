import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { applyResumeReview, resumeScoreSummary } from './resume-scoring.js'
import { RecruitingWorkflowError } from './workflow.js'

const report = { assessment: {
  score: 90,
  matchedRequirements: [{ label: 'Java', rationale: '有多年项目经验', evidence: [{ sourceText: 'Java 开发 8 年' }] }],
  strengths: ['有后端项目经验'], risks: ['云平台经验需确认'],
} }
function errorCode(code: string) {
  return (error: unknown) => error instanceof RecruitingWorkflowError && error.code === code
}

test('仅 AI 评分生成当前得分，保留历史人工记录但不加权', () => {
  const history = [{ humanScore: 20, finalScore: 48, comment: '历史记录', actorId: 'u0', updatedAt: '2026-10-01' }]
  const source = { ...report, scoring: { humanScore: 20, finalScore: 48, history } }
  const before = structuredClone(source)
  const result = applyResumeReview('r1', source, 'human_review', { decision: 'passed' }, 'u1')
  assert.equal(result.summary.aiScore, 90)
  assert.equal(result.summary.humanScore, 20)
  assert.equal(result.summary.finalScore, 90)
  assert.deepEqual(result.summary.history, history)
  assert.deepEqual(source, before)
})

test('高分进入初试，低分也可人工放行且不改变 AI 评分', () => {
  for (const score of [80, 80.01, 100]) {
    const passed = applyResumeReview('r1', { assessment: { score }, scoring: { humanScore: 0, finalScore: 0 } }, 'human_review', { decision: 'passed' }, 'u1')
    assert.equal(passed.nextStatus, 'interviewing')
    assert.equal((passed.report.humanDecision as { stage: string }).stage, 'initial_interview')
    assert.equal(passed.summary.finalScore, score)
    const eliminated = applyResumeReview('r1', { assessment: { score } }, 'human_review', { decision: 'eliminated' }, 'u1')
    assert.equal(eliminated.nextStatus, 'rejected')
    assert.equal(eliminated.summary.aiScore, score)
    assert.equal(eliminated.summary.decision, 'eliminated')
    assert.match((eliminated.report.humanDecision as { reason: string }).reason, /AI 建议通过，人工确认淘汰/)
  }
  for (const score of [0, 27, 79.99]) {
    const source = { assessment: { score }, scoring: { humanScore: 100, finalScore: 100 } }
    const before = structuredClone(source)
    const passed = applyResumeReview('r1', source, 'human_review', { decision: 'passed' }, 'u1')
    assert.equal(passed.nextStatus, 'interviewing')
    assert.equal(passed.summary.aiScore, score)
    assert.equal(passed.summary.finalScore, score)
    assert.equal(passed.summary.decision, 'passed')
    assert.deepEqual(passed.report.assessment, source.assessment)
    const decision = passed.report.humanDecision as { stage: string; reason: string; decidedBy: string; decidedAt: string }
    assert.equal(decision.stage, 'initial_interview')
    assert.equal(decision.decidedBy, 'u1')
    assert.ok(Number.isFinite(Date.parse(decision.decidedAt)))
    assert.match(decision.reason, /人工确认通过/)
    assert.deepEqual(source, before)
  }
})

test('人工低分放行保留填写的处理说明', () => {
  const result = applyResumeReview('r1', { assessment: { score: 27 } }, 'human_review', { decision: 'passed', comment: '  已电话核实相关经验，进入初试  ' }, 'u1')
  assert.equal((result.report.humanDecision as { reason: string }).reason, '已电话核实相关经验，进入初试')
})

test('无人工评分也直接产生 AI 得分，并能读取嵌套报告原文依据', () => {
  const summary = resumeScoreSummary('r1', { analysis: { report } })
  assert.equal(summary.aiScore, 90)
  assert.equal(summary.finalScore, 90)
  assert.equal(summary.humanScore, undefined)
  assert.deepEqual(summary.evidence[0]?.sourceTexts, ['Java 开发 8 年'])
})

test('拒绝所有新增人工评分，并把缺失或无效 AI 分与真实 0 分区分', () => {
  for (const humanScore of [-1, 101, 80, Number.NaN, '80', null]) {
    assert.throws(() => applyResumeReview('r1', report, 'human_review', { humanScore: humanScore as number }, 'u1'), errorCode('HUMAN_SCORING_DISABLED'))
  }
  for (const score of [undefined, null, -1, 101, Number.NaN, Infinity, '80']) {
    const source = { assessment: { score }, scoring: { humanScore: 100, finalScore: 100 } }
    assert.equal(resumeScoreSummary('r1', source).finalScore, undefined)
    for (const decision of ['passed', 'eliminated'] as const) {
      assert.throws(() => applyResumeReview('r1', source, 'human_review', { decision }, 'u1'), errorCode('AI_SCORE_REQUIRED'))
    }
  }
})

test('低分可淘汰并加入人才库，保留 AI 评分；高分不加入淘汰人才库', () => {
  const low = applyResumeReview('r1', { assessment: { score: 27 } }, 'human_review', { decision: 'eliminated', talentPool: true }, 'u1')
  assert.equal(low.nextStatus, 'rejected')
  assert.equal(low.summary.talentPool, true)
  assert.equal(low.summary.finalScore, 27)
  assert.match((low.report.humanDecision as { reason: string }).reason, /AI 评分低于 80/)
  assert.throws(() => applyResumeReview('r1', report, 'human_review', { talentPool: true }, 'u1'), RecruitingWorkflowError)
})

test('已进入面试或关闭的申请不可重复做筛选决定', () => {
  for (const status of ['interviewing', 'rejected', 'offer', 'hired']) {
    assert.throws(() => applyResumeReview('r1', report, status, { decision: 'passed' }, 'u1'), errorCode('APPLICATION_REVIEW_CLOSED'))
    assert.throws(() => applyResumeReview('r1', { assessment: { score: 40 } }, status, { decision: 'passed' }, 'u1'), errorCode('APPLICATION_REVIEW_CLOSED'))
    assert.throws(() => applyResumeReview('r1', { assessment: { score: 40 } }, status, { decision: 'eliminated' }, 'u1'), errorCode('APPLICATION_REVIEW_CLOSED'))
    assert.throws(() => applyResumeReview('r1', report, status, { decision: 'eliminated' }, 'u1'), errorCode('APPLICATION_REVIEW_CLOSED'))
  }
})

test('语义评分展示部分满足、待核实与真实模型来源，不混为明确冲突', () => {
  const summary = resumeScoreSummary('semantic', { analysis: { report: { provenance: { engine: 'llm-suggestion', modelName: 'test-model' }, assessment: {
    score: 45, matchedRequirements: [{ label: '独立负责人事管理', status: 'partial', score: 50, evidence: [{ sourceText: '协助办理入职手续' }] }],
    missingRequirements: [{ label: '独立薪资核算', status: 'not_mentioned', score: 0, evidence: [] }],
  } } } })
  assert.equal(summary.analysisEngine, 'llm-suggestion'); assert.equal(summary.modelName, 'test-model')
  assert.equal(summary.evidence[0]?.outcome, 'partial'); assert.equal(summary.evidence[0]?.score, 50)
  assert.equal(summary.evidence[1]?.outcome, 'missing'); assert.deepEqual(summary.evidence[1]?.sourceTexts, [])
})
