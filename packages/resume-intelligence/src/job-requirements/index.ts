import type { JobRequirement, RequirementKind } from '../contracts/types.js'

/**
 * 把岗位说明书里的「任职要求」与「技能」转成可评分的 JobRequirement。
 *
 * 此前的实现把所有条目一律标成 kind: 'other'，而维度评分是按 kind 统计的，
 * 于是「工作经验 / 技能匹配 / 教育背景」永远拿不到分数，只能显示 0。
 */

const EDUCATION_PATTERN = /(本科|硕士|博士|大专|专科|研究生|学历|学位)/u
const SKILL_PATTERN = /(熟悉|掌握|精通|了解|熟练|具备|技术栈|技能)/u
const LEADING_VERB_PATTERN = /^(熟练掌握|熟练使用|熟悉|掌握|精通|了解|熟练|具备|会用|会|有)/u

/** 从「5 年以上工作经验」里取出年限，用于工作经验维度的量化比对。 */
export function minYearsFromLabel(label: string): number | undefined {
  const matched = label.match(/(\d+)\s*年/u)
  if (!matched) return undefined
  const years = Number(matched[1])
  return Number.isFinite(years) && years > 0 ? years : undefined
}

export function inferRequirementKind(label: string): RequirementKind {
  if (minYearsFromLabel(label) !== undefined) return 'experience'
  if (EDUCATION_PATTERN.test(label)) return 'education'
  if (SKILL_PATTERN.test(label)) return 'skill'
  return 'other'
}

/** 「Java/Python、PostgreSQL」这类条目要拆成独立关键字，才能命中简历的技能字段。 */
export function requirementKeywords(label: string): string[] {
  const cleaned = label.replace(LEADING_VERB_PATTERN, '').trim() || label
  // 只按分隔符拆分：按空格拆会把 “Spring Boot” 这类多词技能切碎。
  const parts = cleaned.split(/[、,，/|;；]+/u).map((part) => part.trim()).filter(Boolean)
  return parts.length > 1 ? parts : [cleaned]
}

export function buildJobRequirements(input: {
  jobId?: string
  requirementLabels?: string[]
  skills?: string[]
}): JobRequirement[] {
  const prefix = input.jobId ?? 'job'
  const requirements: JobRequirement[] = []

  const skills = (input.skills ?? []).map((skill) => skill.trim()).filter(Boolean)
  skills.forEach((skill, index) => {
    requirements.push({ id: `${prefix}-skill-${index + 1}`, label: skill, kind: 'skill', keywords: requirementKeywords(skill), hard: false })
  })

  const labels = (input.requirementLabels ?? []).map((label) => label.trim()).filter(Boolean)
  labels.forEach((label, index) => {
    const keywords = requirementKeywords(label)
    const inferred = inferRequirementKind(label)
    // 「熟悉 Java、Spring Boot」是技能清单，按技能维度计分；
    // 「熟悉数据库与分布式系统基础：能够处理性能、并发…」是整句要求，拆不出多个关键字，
    // 仍按通用要求走全文匹配，避免用整句去比对技能字段、把技能维度拖成 0。
    const looksLikeProse = /[：:]/u.test(label) || keywords.some((keyword) => keyword.length > 12)
    const kind = inferred === 'skill' && (keywords.length < 2 || looksLikeProse) ? 'other' : inferred
    const minYears = minYearsFromLabel(label)
    requirements.push({
      id: `${prefix}-requirement-${index + 1}`,
      label,
      kind,
      keywords: kind === 'skill' ? keywords : [label],
      ...(minYears === undefined ? {} : { minYears }),
      hard: index === 0,
    })
  })

  return requirements
}
