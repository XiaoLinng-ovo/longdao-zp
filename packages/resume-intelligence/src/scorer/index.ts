import type { MatchAssessment, RequirementAssessment, RequirementMatchResult, ScoreMatchInput } from '../contracts/types.js'
import { isRequirementConflicted, matchResumeToJob, requirementKindLabel, MATCHER_VERSION } from '../matcher/index.js'

export const SCORER_VERSION = '0.1.0'

function average(values: number[], fallback = 0): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function assessDimension(assessments: RequirementAssessment[], kind: RequirementAssessment['kind']): number {
  const values = assessments.filter((assessment) => assessment.kind === kind).map((assessment) => assessment.score)
  return clamp(average(values, 0))
}

function potentialScore(input: ScoreMatchInput, assessments: RequirementAssessment[]): number {
  const completeness = [
    input.extraction.candidate.fullName,
    input.extraction.candidate.email,
    input.extraction.profile.summary,
    input.extraction.experience.length ? 'experience' : '',
    input.extraction.skills.length ? 'skills' : '',
  ].filter(Boolean).length
  const hardConflicts = assessments.filter(isRequirementConflicted).length
  return clamp(Math.max(0, completeness * 18 - hardConflicts * 10))
}

function recommendation(score: number, conflicts: RequirementAssessment[]): MatchAssessment['recommendation'] {
  if (conflicts.length > 0) return score >= 65 ? 'needs_review' : 'weak_match'
  if (score >= 85) return 'strong_match'
  if (score >= 70) return 'match'
  if (score >= 50) return 'needs_review'
  return 'weak_match'
}

function buildQuestions(missing: RequirementAssessment[]): string[] {
  return missing.slice(0, 5).map((item) => `请结合具体项目说明你在“${item.label}”方面的经验和成果。`)
}

export function scoreResumeMatch(input: ScoreMatchInput): MatchAssessment {
  const matches: RequirementMatchResult = input.requirementMatches ?? matchResumeToJob(input.extraction, input.job)
  const assessments = matches.assessments
  const conflicts = assessments.filter(isRequirementConflicted)
  const missingRequirements = assessments.filter((assessment) => !assessment.matched)
  const matchedRequirements = assessments.filter((assessment) => assessment.matched)
  const hard = assessments.filter((assessment) => assessment.hard)
  const hardRequirement = hard.length ? average(hard.map((assessment) => assessment.score), 0) : 100
  const experience = assessDimension(assessments, 'experience')
  const skills = assessDimension(assessments, 'skill')
  const education = assessDimension(assessments, 'education')
  const potential = potentialScore(input, assessments)
  const weighted = [
    { value: hardRequirement, weight: 0.35 },
    { value: experience, weight: 0.2 },
    { value: skills, weight: 0.25 },
    { value: education || 50, weight: 0.1 },
    { value: potential, weight: 0.1 },
  ]
  const score = clamp(weighted.reduce((sum, item) => sum + item.value * item.weight, 0))
  const evidenceCount = assessments.reduce((sum, assessment) => sum + assessment.evidence.length, 0)
  const confidence = Math.max(0.25, Math.min(0.95, 0.45 + Math.min(0.45, evidenceCount * 0.06) - Math.min(0.2, conflicts.length * 0.04)))
  const strengths = matchedRequirements.slice(0, 6).map((assessment) => `${requirementKindLabel(assessment.kind)}匹配：${assessment.label}`)
  const risks = missingRequirements.slice(0, 6).map((assessment) => `${assessment.hard ? '硬性要求冲突' : '待核实'}：${assessment.label}`)

  return {
    score,
    recommendation: recommendation(score, conflicts),
    dimensions: { hardRequirement, experience, skills, education, potential },
    matchedRequirements,
    conflicts,
    missingRequirements,
    strengths,
    risks,
    interviewQuestions: buildQuestions(missingRequirements),
    confidence: Number(confidence.toFixed(2)),
    advisoryOnly: true,
    applicationStatusMutation: 'none',
  }
}

export { MATCHER_VERSION }
