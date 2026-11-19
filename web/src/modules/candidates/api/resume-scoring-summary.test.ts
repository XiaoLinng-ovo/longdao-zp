// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { getResumeScoreSummary, type ApiAnalysisResult } from './index'
const scoringSkill = { id: 'skill-1', name: '后端项目优先', content: '项目 80 分，技术 20 分', updatedAt: '2026-10-08T00:00:00.000Z' }
describe('resume scoring Skill presentation', () => {
  it('presents the rule snapshot and model explanation from Worker reports', () => {
    const result = { id: 'result-1', result: { analysis: { report: { assessment: { score: 85, strengths: ['项目证据'], risks: [] }, provenance: { scoringSkill } }, suggestion: { summary: '项目 70 + 技术 15 = 85 分' } }, scoring: { humanScore: 90 } } } as unknown as ApiAnalysisResult
    const summary = getResumeScoreSummary(result)!
    expect(summary.scoringSkill).toEqual(scoringSkill)
    expect(summary.scoringExplanation).toBe('项目 70 + 技术 15 = 85 分')
    expect(summary.aiScore).toBe(85); expect(summary.finalScore).toBe(85)
  })
  it('keeps older reports compatible without implying they used a custom Skill', () => {
    const result = { id: 'legacy', result: { assessment: { score: 70, strengths: [], risks: [] } } } as unknown as ApiAnalysisResult
    const summary = getResumeScoreSummary(result)!
    expect(summary.scoringSkill).toBeUndefined(); expect(summary.scoringExplanation).toBeUndefined()
    expect(summary.aiScore).toBe(70)
  })
})

it('preserves semantic partial scores, missing evidence and model provenance', () => {
  const result = { id: 'semantic', result: { analysis: { report: { provenance: { engine: 'llm-suggestion', modelName: 'test-model' }, assessment: {
    score: 45, matchedRequirements: [{ label: '独立负责人事管理', status: 'partial', score: 50, rationale: '只有协助经验', evidence: [{ sourceText: '协助办理入职手续' }] }],
    missingRequirements: [{ label: '独立薪资核算', status: 'not_mentioned', score: 0, rationale: '简历未提及，待核实', evidence: [] }],
  } } } } } as unknown as ApiAnalysisResult
  const summary = getResumeScoreSummary(result)!
  expect(summary.analysisEngine).toBe('llm-suggestion')
  expect(summary.modelName).toBe('test-model')
  expect(summary.evidence[0]).toMatchObject({ outcome: 'partial', score: 50, sourceTexts: ['协助办理入职手续'] })
  expect(summary.evidence[1]).toMatchObject({ outcome: 'missing', score: 0, sourceTexts: [] })
})

it('hides communication and collaboration scoring evidence from legacy reports', () => {
  const result = { id: 'legacy-soft-skill', result: { assessment: {
    score: 80,
    strengths: ['沟通协作：具备团队合作意识', 'Python：项目应用'],
    risks: ['待核实：跨部门沟通能力', '待核实：接口设计能力'],
    matchedRequirements: [{ label: '沟通协作', status: 'met', score: 100, evidence: [{ sourceText: '良好沟通能力' }] }],
    missingRequirements: [{ label: '团队协作', status: 'not_mentioned', score: 0, evidence: [] }, { label: '通信协议设计', status: 'not_mentioned', score: 0, evidence: [] }],
  } } } as unknown as ApiAnalysisResult
  const summary = getResumeScoreSummary(result)!
  expect(summary.evidence.map((item) => item.label)).toEqual(['通信协议设计'])
  expect(summary.strengths).toEqual(['Python：项目应用'])
  expect(summary.risks).toEqual(['待核实：接口设计能力'])
})
