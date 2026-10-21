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

/** Controlled phrases keep matching evidence-based; generic verbs (“具备/能够”)
 * and the descriptive heading are not requirements in their own right. */
const REQUIREMENT_TERMS = [
  '机器学习', '深度学习', '算法建模', '数据结构', '算法基础', '算法设计',
  '数据分析', '数据处理', '数据清洗', '特征工程', '特征构建', '模型训练',
  '模型评估', '效果评估', '模型开发', '算法验证', '模型部署', '算法工程化',
  '工程化', '落地', '系统集成', '实验设计', '结果分析', '逻辑分析', '技术文档',
  '沟通', '协作', '编程语言', '计算机', '数学', '统计学', '人工智能',
  '数据库', '分布式系统', '微服务', '高并发', '接口设计', '性能优化',
  'JavaScript', 'TypeScript', 'Spring Boot', 'Spring Cloud', 'Node.js',
  'Python', 'Java', 'C++', 'SQL', 'PostgreSQL', 'MySQL', 'Redis', 'Docker',
  'Kubernetes', 'PyTorch', 'TensorFlow', 'Scikit-learn', 'XGBoost', 'React', 'Vue',
]

/** Extract atomic concepts from prose without requiring verbatim JD sentences. */
export function requirementKeywords(label: string): string[] {
  const content = label.replace(/^([^：:]{1,10})[：:]/u, (heading, title: string) => LEADING_VERB_PATTERN.test(title) ? heading : '').replace(LEADING_VERB_PATTERN, '').trim() || label
  const expanded = content
    .replace(/数据分析与处理/gu, '数据分析、数据处理')
    .replace(/模型训练与(?:效果)?评估/gu, '模型训练、模型评估')
    .replace(/实验设计与结果分析/gu, '实验设计、结果分析')
  const terms = REQUIREMENT_TERMS.filter((term) => {
    if (/^[A-Za-z]/u.test(term)) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'iu').test(expanded)
    }
    return expanded.includes(term)
  }).filter((term, _, all) => !all.some((other) => other !== term && other.toLowerCase().includes(term.toLowerCase())))
  if (terms.length) return terms.sort((a, b) => expanded.toLowerCase().indexOf(a.toLowerCase()) - expanded.toLowerCase().indexOf(b.toLowerCase()))
  const parts = content.split(/[、,，/|;；]+/u).map((part) => part.trim()).filter(Boolean)
  return parts.length > 1 ? parts : [content]
}

export function buildJobRequirements(input: {
  jobId?: string
  requirementLabels?: string[]
  skills?: string[]
  /** Persisted per-requirement flags; do not infer hard requirements from order. */
  requirementRequired?: boolean[]
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
      keywords,
      ...(minYears === undefined ? {} : { minYears }),
      hard: input.requirementRequired?.[index] ?? (index === 0),
    })
  })

  return requirements
}

export { buildJobAnalysisContext, type JobAnalysisContext } from './context.js'
