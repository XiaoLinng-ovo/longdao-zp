import type {
  EvidenceItem,
  JobRequirement,
  JobRequirements,
  RequirementAssessment,
  RequirementKind,
  RequirementMatchResult,
  ResumeExtractionResult,
} from '../contracts/types.js'
import { normalizeSkillNames, normalizeToken } from '../normalizer/index.js'

export const MATCHER_VERSION = '0.1.0'

/** 学历层次：用于把「本科及以上」这类要求与简历中的教育经历做量化比对。 */
const EDUCATION_LEVELS: Array<{ pattern: RegExp; level: number; label: string }> = [
  { pattern: /博士/u, level: 4, label: '博士' },
  { pattern: /硕士|研究生/u, level: 3, label: '硕士' },
  { pattern: /本科|学士/u, level: 2, label: '本科' },
  { pattern: /大专|专科|高职/u, level: 1, label: '大专' },
]

function educationLevelOf(text: string): { level: number; label: string } {
  for (const entry of EDUCATION_LEVELS) if (entry.pattern.test(text)) return { level: entry.level, label: entry.label }
  return { level: 0, label: '未识别' }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => normalizeToken(value)).filter(Boolean))]
}

function extractionCorpus(extraction: ResumeExtractionResult): string {
  return normalizeToken([
    extraction.candidate.fullName,
    extraction.candidate.headline,
    extraction.profile.summary,
    extraction.profile.locations.join(' '),
    extraction.education.map((item) => `${item.institution ?? ''} ${item.degree ?? ''} ${item.fieldOfStudy ?? ''} ${item.evidence}`).join(' '),
    extraction.experience.map((item) => `${item.employer ?? ''} ${item.title ?? ''} ${item.description ?? ''} ${item.evidence} ${item.skills.join(' ')}`).join(' '),
    extraction.skills.map((skill) => `${skill.canonical} ${skill.value} ${skill.aliases.join(' ')}`).join(' '),
    extraction.languages.join(' '),
    extraction.certifications.join(' '),
  ].filter(Boolean).join(' '))
}

function keywordsFor(requirement: JobRequirement): string[] {
  return unique([requirement.label, ...(requirement.keywords ?? [])])
}

function containsKeyword(corpus: string, keyword: string): boolean {
  if (!keyword) return false
  if (corpus.includes(keyword)) return true
  const tokens = keyword.split(/[\s/+#.-]+/).filter(Boolean)
  return tokens.length > 1 && tokens.every((token) => corpus.includes(token))
}

function skillsFor(extraction: ResumeExtractionResult): string[] {
  return normalizeSkillNames(extraction.skills.flatMap((skill) => [skill.value, skill.canonical, ...skill.aliases]))
}

function requirementEvidence(requirement: JobRequirement, extraction: ResumeExtractionResult): { matched: boolean; score: number; evidence: EvidenceItem[]; rationale: string } {
  const corpus = extractionCorpus(extraction)
  const keywords = keywordsFor(requirement)
  const matchedKeywords = keywords.filter((keyword) => containsKeyword(corpus, keyword))
  const evidence: EvidenceItem[] = matchedKeywords.map((keyword, index) => ({
    id: `evidence-${requirement.id}-${index + 1}`,
    requirementId: requirement.id,
    sourceText: keyword,
    normalizedValue: keyword,
    relevance: 'supporting',
    confidence: 0.78,
  }))

  if (requirement.kind === 'skill') {
    const skills = skillsFor(extraction)
    const matchedSkills = keywords.filter((keyword) => skills.some((skill) => skill === keyword || skill.includes(keyword) || keyword.includes(skill)))
    const score = keywords.length ? (matchedSkills.length / keywords.length) * 100 : 0
    return {
      matched: matchedSkills.length > 0,
      score: clamp(score),
      evidence: matchedSkills.map((skill, index) => ({
        id: `evidence-${requirement.id}-${index + 1}`,
        requirementId: requirement.id,
        sourceText: skill,
        normalizedValue: skill,
        relevance: 'supporting',
        confidence: 0.9,
      })),
      rationale: matchedSkills.length ? `匹配到技能：${matchedSkills.join('、')}` : '未在技能字段中找到明确匹配',
    }
  }

  if (requirement.kind === 'experience' && requirement.minYears !== undefined) {
    const years = extraction.profile.totalExperienceYears ?? 0
    const score = requirement.minYears <= 0 ? 100 : clamp((years / requirement.minYears) * 100)
    const matched = years >= requirement.minYears
    return {
      matched,
      score,
      evidence: matched ? [{ id: `evidence-${requirement.id}-years`, requirementId: requirement.id, sourceText: `${years} years`, normalizedValue: String(years), relevance: 'supporting', confidence: 0.72 }] : [],
      rationale: matched ? `估算经验 ${years} 年，达到要求 ${requirement.minYears} 年` : `估算经验 ${years} 年，低于要求 ${requirement.minYears} 年`,
    }
  }

  // 学历要求必须按层次比对：整句关键字匹配永远不可能命中，会把「本科」这样的明确满足判成 0 分。
  if (requirement.kind === 'education') {
    const required = educationLevelOf(requirement.label)
    // 岗位没写具体层次时退回通用关键字匹配，不做无依据的判定。
    if (required.level > 0) {
      const achieved = educationLevelOf(extraction.education.map((record) => [record.evidence, record.degree, record.institution].filter(Boolean).join(' ')).join(' '))
      const matched = achieved.level >= required.level
      return {
        matched,
        score: matched ? 100 : 0,
        evidence: matched ? [{ id: `evidence-${requirement.id}-education`, requirementId: requirement.id, sourceText: achieved.label, normalizedValue: achieved.label, relevance: 'supporting', confidence: 0.7 }] : [],
        rationale: matched
          ? `学历满足要求：简历为${achieved.label}，要求${required.label}及以上`
          : `学历低于要求：简历为${achieved.label}，要求${required.label}及以上`,
      }
    }
  }

  const score = keywords.length ? (matchedKeywords.length / keywords.length) * 100 : 0
  return {
    matched: matchedKeywords.length > 0,
    score: clamp(score),
    evidence,
    rationale: matchedKeywords.length ? `发现相关证据：${matchedKeywords.join('、')}` : '未找到明确证据',
  }
}

function toAssessment(requirement: JobRequirement, extraction: ResumeExtractionResult): RequirementAssessment {
  const result = requirementEvidence(requirement, extraction)
  return {
    requirementId: requirement.id,
    label: requirement.label,
    kind: requirement.kind,
    hard: requirement.hard === true,
    matched: result.matched,
    score: result.score,
    evidence: result.evidence,
    rationale: result.rationale,
  }
}

export function matchResumeToJob(extraction: ResumeExtractionResult, job: JobRequirements): RequirementMatchResult {
  const assessments = job.requirements.map((requirement) => toAssessment(requirement, extraction))
  const keywords = job.requirements.flatMap(keywordsFor)
  return {
    assessments,
    matchedKeywordCount: assessments.reduce((sum, assessment) => sum + assessment.evidence.length, 0),
    totalKeywordCount: keywords.length,
    matchedSkillCount: assessments.filter((assessment) => assessment.kind === 'skill' && assessment.matched).length,
    totalSkillRequirementCount: job.requirements.filter((requirement) => requirement.kind === 'skill').length,
  }
}

export function isRequirementConflicted(assessment: RequirementAssessment): boolean {
  return assessment.hard && !assessment.matched
}

export function requirementKindLabel(kind: RequirementKind): string {
  const labels: Record<RequirementKind, string> = {
    skill: '技能',
    experience: '经验',
    education: '学历',
    language: '语言',
    location: '地点',
    certification: '证书',
    other: '要求',
  }
  return labels[kind]
}
