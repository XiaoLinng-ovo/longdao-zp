import type {
  EvidenceItem,
  JobRequirement,
  JobRequirements,
  RequirementAssessment,
  RequirementKind,
  RequirementMatchResult,
  ResumeExtractionResult,
} from '../contracts/types.js'
import { normalizeSkill, normalizeToken } from '../normalizer/index.js'
import { requirementKeywords } from '../job-requirements/index.js'
import { positiveEvidenceText } from '../evidence-text/index.js'

export const MATCHER_VERSION = '0.2.0'

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

function extractionSources(extraction: ResumeExtractionResult): string[] {
  // Identity/contact fields are deliberately excluded: a name or company name
  // mentioning a technology is not evidence of professional competence.
  return [
    extraction.profile.summary ?? '',
    ...extraction.education.map((item) => `${item.degree ?? ''} ${item.fieldOfStudy ?? ''} ${item.evidence}`),
    ...extraction.experience.map((item) => `${item.title ?? ''} ${item.description ?? ''} ${item.evidence} ${item.skills.join(' ')}`),
    ...extraction.skills.map((skill) => skill.evidence.length ? skill.evidence.join('\n') : skill.value),
    ...extraction.languages,
    ...extraction.certifications,
  ].flatMap((value) => positiveEvidenceText(value).split('\n')).filter((value) => value.trim())
}

function keywordsFor(requirement: JobRequirement): string[] {
  // Explicit atoms must not have the full label added to their denominator.
  return unique((requirement.keywords?.length ? requirement.keywords : requirementKeywords(requirement.label)).map((value) => normalizeSkill(value).canonical))
}

const EVIDENCE_ALIASES: Record<string, string[]> = {
  '编程语言': ['python', 'java', 'c++', 'javascript', 'typescript', 'golang', 'c#'],
  '模型评估': ['效果评估', '交叉验证', 'auc', 'rmse'],
  '特征工程': ['特征构建', '特征筛选'],
  '实验设计': ['设计实验', 'a/b测试', 'a/b test'],
  '技术文档': ['接口文档', '评估报告'],
}

function containsKeyword(source: string, keyword: string): boolean {
  const corpus = normalizeToken(source)
  const terms = [keyword, ...(EVIDENCE_ALIASES[keyword] ?? [])]
  return terms.some((term) => {
    if (!term) return false
    if (/^[a-z]/iu.test(term)) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'iu').test(corpus)
    }
    return corpus.includes(term)
  })
}

function requirementEvidence(requirement: JobRequirement, extraction: ResumeExtractionResult): { matched: boolean; score: number; evidence: EvidenceItem[]; rationale: string } {
  const sources = extractionSources(extraction)
  const keywords = keywordsFor(requirement)
  const hits = keywords.flatMap((keyword) => {
    const sourceText = sources.find((source) => containsKeyword(source, keyword) || normalizeSkill(source).canonical === keyword)
    return sourceText ? [{ keyword, sourceText }] : []
  })
  const matchedKeywords = hits.map((hit) => hit.keyword)
  const evidence: EvidenceItem[] = hits.map((hit, index) => ({
    id: `evidence-${requirement.id}-${index + 1}`,
    requirementId: requirement.id,
    sourceText: hit.sourceText,
    normalizedValue: hit.keyword,
    relevance: 'supporting',
    confidence: 0.78,
  }))

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

  // Degree and major are separate constraints; majors are alternatives, not
  // an impossible requirement to have studied every listed discipline.
  if (requirement.kind === 'education') {
    const required = educationLevelOf(requirement.label)
    const majors = ['计算机', '数学', '统计学', '人工智能'].filter((major) => requirement.label.includes(major))
    const records = extraction.education.map((record) => ({
      text: positiveEvidenceText([record.degree, record.fieldOfStudy, record.evidence].filter(Boolean).join(' ')),
      major: positiveEvidenceText(record.fieldOfStudy ?? record.evidence),
    }))
    if (required.level > 0 || majors.length > 0) {
      const outcomes = records.map((record) => {
        const degreeOk = required.level === 0 || educationLevelOf(record.text).level >= required.level
        const majorOk = majors.length === 0 || majors.some((major) => record.major.includes(major))
        const constraints = [ ...(required.level > 0 ? [degreeOk] : []), ...(majors.length > 0 ? [majorOk] : []) ]
        return { record, matched: degreeOk && majorOk, score: clamp(constraints.filter(Boolean).length / constraints.length * 100) }
      }).sort((a, b) => b.score - a.score)
      const best = outcomes[0]
      const matched = best?.matched ?? false
      return {
        matched,
        score: best?.score ?? 0,
        evidence: best && best.score > 0 ? [{ id: `evidence-${requirement.id}-education`, requirementId: requirement.id, sourceText: best.record.text, relevance: 'supporting', confidence: 0.7 }] : [],
        rationale: matched ? '教育经历满足岗位的学历/专业要求' : '教育经历未完整证明岗位的学历/专业要求，需人工核实',
      }
    }
  }

  const score = keywords.length ? (matchedKeywords.length / keywords.length) * 100 : 0
  return {
    matched: matchedKeywords.length > 0,
    score: clamp(score),
    evidence,
    rationale: matchedKeywords.length ? `发现相关证据（${matchedKeywords.length}/${keywords.length}）：${matchedKeywords.join('、')}` : '未找到明确的肯定性证据',
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
  return assessment.hard && (assessment.status ? assessment.status === 'contradicted' : !assessment.matched)
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
