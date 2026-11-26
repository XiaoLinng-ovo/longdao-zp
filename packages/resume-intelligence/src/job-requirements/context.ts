/** Inputs must already be restricted to confirmed versions by the data store. */
export interface JobAnalysisContext {
  title: string
  requirements: string[]
  skills: string[]
  requirementRequired: boolean[]
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Only explicit qualification/skill sections count, never duties or benefits. */
function jdSections(content: string): { requirements: string[]; skills: string[] } {
  const result = { requirements: [] as string[], skills: [] as string[] }
  let section: 'requirements' | 'skills' | undefined
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.trim()
    const clean = line.replace(/^#{1,6}\s*/u, '').replace(/\*\*/gu, '').replace(/^(?:[一二三四五六七八九十]+[、.．]|\d+[、.．)）])\s*/u, '')
    const heading = clean.match(/^(任职要求|岗位要求|任职资格|职位要求|应聘要求|技能要求|专业技能|岗位职责|主要职责|工作职责|职责描述|工作内容|岗位概述|岗位名称|薪资待遇|薪酬福利|福利待遇|工作地点|联系方式|公司介绍|申请方式|Qualifications|Requirements|Skills|Responsibilities|Benefits)\s*[:：]?\s*(.*)$/iu)
    if (heading) {
      const title = heading[1]!
      section = /^(任职要求|岗位要求|任职资格|职位要求|应聘要求|Qualifications|Requirements)$/iu.test(title) ? 'requirements'
        : /^(技能要求|专业技能|Skills)$/iu.test(title) ? 'skills' : undefined
      if (section && heading[2]?.trim()) result[section].push(heading[2].trim())
      continue
    }
    // Any other explicit heading ends the section too.
    if (/^#{1,6}\s/u.test(line) || /^\*\*[^*]+\*\*[:：]?$/u.test(line) || /^[^:：]{1,20}[:：]$/u.test(clean)) {
      section = undefined
      continue
    }
    const item = clean.replace(/^(?:[-*•●]\s*|\d+[、.．)）]\s*)/u, '').trim()
    if (section && item) result[section].push(item)
  }
  return result
}

export function buildJobAnalysisContext(input: { title: string; specContent?: unknown; jdContent?: unknown }): JobAnalysisContext {
  const spec = input.specContent && typeof input.specContent === 'object' ? input.specContent as Record<string, unknown> : {}
  const entries = new Map<string, boolean>()
  for (const value of Array.isArray(spec.requirements) ? spec.requirements : []) {
    const entry = value && typeof value === 'object' ? value as Record<string, unknown> : undefined
    const parts = entry ? [...new Set([text(entry.label), text(entry.description)].filter(Boolean))] : [text(value)]
    const label = parts.join('：')
    if (label) entries.set(label, (entries.get(label) ?? false) || entry?.required === true)
  }
  const jd = jdSections(text(input.jdContent))
  if (!entries.size) for (const label of jd.requirements) entries.set(label, false)
  const specSkills = (Array.isArray(spec.skills) ? spec.skills : []).map(text).filter(Boolean)
  const skills = [...new Set(specSkills.length ? specSkills : jd.skills)]
  return { title: text(spec.title) || input.title, requirements: [...entries.keys()], requirementRequired: [...entries.values()], skills }
}
