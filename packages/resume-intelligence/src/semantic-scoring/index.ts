import type { JobRequirements, RequirementAssessment, ResumeExtractionResult, SemanticRequirementStatus, SemanticScoringDimension } from '../contracts/types.js'
import { scoreResumeMatch } from '../scorer/index.js'

export const SEMANTIC_SCORER_VERSION = '0.1.0'
const statuses = new Set<SemanticRequirementStatus>(['met', 'partial', 'not_mentioned', 'contradicted'])
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('评分条目必须是对象')
  return value as Record<string, unknown>
}
function number(value: unknown, field: string): number {
  const result = typeof value === 'string' && value.trim() ? Number(value) : value
  if (typeof result !== 'number' || !Number.isFinite(result)) throw new TypeError(field + ' 必须是有限数字')
  return result
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(field + ' 不能为空')
  return value.trim()
}
// Only normalize whitespace/Unicode representation. Never use fuzzy/synonym matching for quotations.
function comparable(value: string): string { return value.normalize('NFKC').replace(/\s+/gu, '') }
function entry(value: unknown, resume: string, maxScore: number) {
  const input = object(value)
  const status = input.status as SemanticRequirementStatus
  if (!statuses.has(status)) throw new TypeError('评分状态无效')
  const score = number(input.score, 'score')
  if (score < 0 || score > maxScore) throw new TypeError('分项得分超出范围')
  if (!Array.isArray(input.sourceTexts) || input.sourceTexts.some((v) => typeof v !== 'string')) throw new TypeError('sourceTexts 必须是简历原句数组')
  const sourceTexts = [...new Set((input.sourceTexts as string[]).map((v) => v.trim()).filter(Boolean))]
  if (status === 'not_mentioned') {
    if (score !== 0 || sourceTexts.length) throw new TypeError('未提及的能力不能得分或附带推测证据')
  } else {
    if (!sourceTexts.length || sourceTexts.some((quote) => comparable(quote).length < 2 || !comparable(resume).includes(comparable(quote)))) throw new TypeError('评分证据必须逐字引用本次送给模型的简历原文')
    if (status === 'contradicted' && score !== 0) throw new TypeError('明确不满足的项目不能得分')
    if ((status === 'met' || status === 'partial') && score <= 0) throw new TypeError('满足或部分满足的项目必须有证据得分')
    if (status === 'partial' && score >= maxScore) throw new TypeError('部分满足不能得到满分')
  }
  return { status, score, sourceTexts, rationale: text(input.rationale, 'rationale') }
}

/** Validate every requirement and recalculate totals; a model cannot award an unsupported overall score. */
export function assessSemanticResume(input: {
  response: Record<string, unknown>
  job: JobRequirements
  extraction: ResumeExtractionResult
  anonymizedResumeText: string
  hasScoringSkill?: boolean
}) {
  const values = input.response.requirementAssessments
  if (!Array.isArray(values) || values.length !== input.job.requirements.length) throw new TypeError('必须逐项返回所有岗位要求的分析，不能遗漏或增加要求')
  const byId = new Map<string, Record<string, unknown>>()
  for (const value of values) {
    const item = object(value)
    const id = text(item.requirementId, 'requirementId')
    if (byId.has(id) || !input.job.requirements.some((r) => r.id === id)) throw new TypeError('岗位要求 ID 重复或不存在')
    byId.set(id, item)
  }
  const assessments: RequirementAssessment[] = input.job.requirements.map((requirement) => {
    const item = entry(byId.get(requirement.id), input.anonymizedResumeText, 100)
    return {
      requirementId: requirement.id, label: requirement.label, kind: requirement.kind, hard: requirement.hard === true,
      status: item.status, score: item.score, matched: item.status === 'met' || item.status === 'partial',
      rationale: item.status === 'not_mentioned' ? '简历未提及，待核实；不认定具备，也不认定明确不符合。' : item.rationale,
      evidence: item.sourceTexts.map((quote, i) => ({ id: 'semantic-' + requirement.id + '-' + i, requirementId: requirement.id, sourceText: quote, relevance: item.status === 'contradicted' ? 'conflicting' as const : 'supporting' as const, confidence: 0.8 })),
    }
  })
  const assessment = scoreResumeMatch({ job: input.job, extraction: input.extraction, requirementMatches: { assessments, matchedKeywordCount: 0, totalKeywordCount: 0, matchedSkillCount: 0, totalSkillRequirementCount: 0 } })
  assessment.conflicts = assessments.filter((item) => item.status === 'contradicted')
  assessment.missingRequirements = assessments.filter((item) => item.status === 'not_mentioned')
  assessment.strengths = assessments.filter((item) => item.matched).map((item) => (item.status === 'partial' ? '部分满足' : '满足') + '：' + item.label)
  assessment.risks = assessments.filter((item) => item.status !== 'met').map((item) => (item.status === 'not_mentioned' ? '待核实' : item.status === 'partial' ? '部分满足' : '明确不符合') + '：' + item.label)
  let dimensions: SemanticScoringDimension[] | undefined
  if (input.hasScoringSkill) {
    const raw = input.response.scoringDimensions
    if (!Array.isArray(raw) || !raw.length || raw.length > 50) throw new TypeError('评分 Skill 必须返回有证据的分项得分与满分')
    dimensions = raw.map((value) => {
      const row = object(value)
      const maxScore = number(row.maxScore, 'maxScore')
      if (maxScore <= 0 || maxScore > 100) throw new TypeError('分项满分必须大于 0 且不超过 100')
      return { label: text(row.label, 'label'), maxScore, ...entry(row, input.anonymizedResumeText, maxScore) }
    })
    if (new Set(dimensions.map((d) => d.label)).size !== dimensions.length) throw new TypeError('评分维度不能重复')
    const maximum = dimensions.reduce((sum, item) => sum + item.maxScore, 0)
    assessment.score = Math.round(dimensions.reduce((sum, item) => sum + item.score, 0) / maximum * 100)
    assessment.scoringDimensions = dimensions
    assessment.strengths = dimensions.filter((d) => d.score > 0).map((d) => d.label + '：' + d.rationale)
    assessment.risks = [...assessment.risks, ...dimensions.filter((d) => d.status !== 'met').map((d) => (d.status === 'not_mentioned' ? '待核实' : d.status === 'partial' ? '部分满足' : '明确不符合') + '：' + d.label)]
  }
  if (assessment.score === null) throw new TypeError('没有可评分的岗位要求或 Skill')
  // The declared score is required for protocol consistency but never trusted for the persisted total.
  const declared = number(input.response.score ?? input.response.matchScore, 'score')
  if (declared < 0 || declared > 100) throw new TypeError('总分必须在 0–100 之间')
  const conflicts = assessment.conflicts
  assessment.recommendation = conflicts.length ? 'needs_review' : assessment.score >= 85 ? 'strong_match' : assessment.score >= 70 ? 'match' : assessment.score >= 50 ? 'needs_review' : 'weak_match'
  const items = dimensions ?? assessments.map((item) => ({ ...item, maxScore: 100, sourceTexts: item.evidence.map((e) => e.sourceText) }))
  const summary = '基于简历直接证据的语义评分：' + assessment.score + '/100。未提及的能力不加分，需人工核实。\n' + items.map((item) => item.label + '：' + item.score + '/' + item.maxScore + '；' + item.rationale + (item.sourceTexts.length ? '；简历原文：' + item.sourceTexts.join(' / ') : '')).join('\n')
  return { assessment, summary }
}
