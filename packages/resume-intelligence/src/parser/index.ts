import type { ParsedResume, ResumeDocumentFormat, ResumeSection, ResumeSectionKind, ResumeTextInput } from '../contracts/types.js'
import { cleanResumeText } from '../text-cleaning/index.js'

export const PARSER_VERSION = '0.4.4'

const SECTION_ALIASES: Record<string, ResumeSectionKind> = {
  summary: 'summary',
  profile: 'summary',
  objective: 'summary',
  experience: 'experience',
  experiences: 'experience',
  employment: 'experience',
  'work experience': 'experience',
  education: 'education',
  academic: 'education',
  skills: 'skills',
  'technical skills': 'skills',
  competencies: 'skills',
  certifications: 'certifications',
  certificates: 'certifications',
  languages: 'languages',
  language: 'languages',
  contact: 'contact',
  // 中文简历常见栏目
  '个人简介': 'summary',
  '自我评价': 'summary',
  '自我介绍': 'summary',
  '个人概述': 'summary',
  '个人总结': 'summary',
  '求职意向': 'summary',
  '求职目标': 'summary',
  '工作经历': 'experience',
  '工作经验': 'experience',
  '工作履历': 'experience',
  '任职经历': 'experience',
  '职业经历': 'experience',
  '项目经历': 'experience',
  '项目经验': 'experience',
  '项目实践': 'experience',
  '实习经历': 'experience',
  '实习工作经历': 'experience',
  '社会实践': 'experience',
  '教育经历': 'education',
  '教育背景': 'education',
  '学历': 'education',
  '学习经历': 'education',
  '技能': 'skills',
  '专业技能': 'skills',
  '相关技能': 'skills',
  '技术技能': 'skills',
  '技能特长': 'skills',
  '个人技能': 'skills',
  '核心技能': 'skills',
  '技能证书/其他': 'skills',
  '技能证书': 'skills',
  '技能标签': 'skills',
  '技术栈': 'skills',
  '证书': 'certifications',
  '资格证书': 'certifications',
  '专业证书': 'certifications',
  '资质证书': 'certifications',
  '认证': 'certifications',
  '语言能力': 'languages',
  '外语能力': 'languages',
  '语言': 'languages',
  '联系方式': 'contact',
  '基本信息': 'contact',
  '个人信息': 'contact',
  '基本资料': 'contact',
  '荣誉与成果': 'other',
  '荣誉奖项': 'other',
  '个人荣誉': 'other',
  '奖励与证书': 'other',
  '校园经历': 'other',
  '校园经历与荣誉': 'other',
  '岗位关键词': 'other',
}

function detectFormat(input: ResumeTextInput): ResumeDocumentFormat {
  const mime = input.mimeType?.toLowerCase()
  if (mime === 'application/pdf') return 'pdf'
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
  if (mime === 'text/plain') return 'txt'
  if (mime === 'text/html') return 'html'

  const extension = input.fileName.split('.').pop()?.toLowerCase()
  if (extension === 'pdf' || extension === 'docx' || extension === 'txt' || extension === 'html') return extension
  return 'unknown'
}

function normalizeText(text: string): string {
  return cleanResumeText(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    // DOCX extraction can emit several empty paragraphs between each run.
    // Keep paragraph separation, but avoid turning one page into dozens of
    // visually and semantically empty lines.
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeSectionHeading(line: string): string {
  return line
    .replace(/[：:]$/, '')
    .trim()
    // Icon fonts in exported PDFs may map a leading icon to a Latin glyph.
    .replace(/^[^\p{Script=Han}\p{N}]{1,4}\s+(?=\p{Script=Han})/u, '')
}

function sectionKindForHeading(line: string): ResumeSectionKind | undefined {
  const normalized = normalizeSectionHeading(line).toLowerCase()
  return SECTION_ALIASES[normalized] ?? SECTION_ALIASES[normalized.replace(/(?<=[\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, '')]
}

function isLikelyHeading(line: string): boolean {
  if (!line || line.length > 60) return false
  if (sectionKindForHeading(line)) return true
  // Bare acronyms (MCP, SQL, HTML) often wrap from a technology list.
  return /^[A-Z][A-Z&/-]+(?:\s+[A-Z&/-]+)+$/.test(line.trim())
}

/**
 * DOCX-to-text converters commonly preserve paragraph boundaries but not
 * run boundaries. A heading and its first content can therefore arrive as a
 * single line (for example, "教育背景2010.09-2014.06 ..."). Split a known
 * section heading from its inline content before building sections.
 */
function splitInlineHeading(line: string): string[] {
  const trimmed = line.trim()
  // A project's technology list is content, not a new skills section extending
  // over all subsequent responsibilities and projects.
  if (/^技术栈\s*[:：]/u.test(trimmed)) return [line]
  // A category such as “语言与证书：...” is not the shorter “语言” heading.
  if (/^语言(?:与|及)(?:证书|技能|能力)\s*[:：]/u.test(trimmed)) return [line]
  if (sectionKindForHeading(trimmed)) return [normalizeSectionHeading(trimmed)]
  const heading = Object.keys(SECTION_ALIASES)
    .sort((left, right) => right.length - left.length)
    .find((candidate) => trimmed.toLocaleLowerCase().startsWith(candidate.toLocaleLowerCase()))

  if (!heading) return [line]
  if (/^[a-z]/iu.test(heading) && /[a-z]/iu.test(trimmed.charAt(heading.length))) return [line]
  const remainder = trimmed.slice(heading.length).replace(/^[：:\s]+/u, '')
  return remainder ? [heading, remainder] : [heading]
}

function buildSections(lines: string[]): { sections: ResumeSection[]; warnings: ParsedResume['warnings'] } {
  const sections: ResumeSection[] = []
  const warnings: ParsedResume['warnings'] = []
  let current: { kind: ResumeSectionKind; title: string; startLine: number; content: string[] } | undefined

  const flush = (endLine: number) => {
    if (!current) return
    const text = current.content.join('\n').trim()
    if (text) {
      sections.push({
        kind: current.kind,
        title: current.title,
        text,
        startLine: current.startLine,
        endLine,
      })
    } else {
      warnings.push({ code: 'malformed_line', message: `Section "${current.title}" has no content`, line: current.startLine })
    }
    current = undefined
  }

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const headingKind = sectionKindForHeading(line)
    // Some exported templates repeat a decorative skills heading on later
    // project pages. Keep its explicitly labelled work content in experience.
    if (headingKind === 'skills' && current?.kind === 'experience'
      && sections.some((section) => section.kind === 'skills')
      && [current.content.filter(Boolean).at(-1), lines.slice(index + 1).find(Boolean)]
        .some((value) => /^(?:主要工作|核心职责|项目描述|项目职责|项目亮点)\s*[:：]?/u.test(value ?? ''))) return
    if (headingKind || isLikelyHeading(line)) {
      flush(lineNumber - 1)
      current = {
        kind: headingKind ?? 'other',
        title: line.replace(/[：:]$/, '').trim(),
        startLine: lineNumber,
        content: [],
      }
      return
    }

    if (!current) {
      current = { kind: 'contact', title: 'Contact', startLine: lineNumber, content: [] }
    }
    current.content.push(line)
  })

  flush(lines.length)
  return { sections, warnings }
}

export function parseResume(input: ResumeTextInput): ParsedResume {
  const normalizedText = normalizeText(input.text)
  let inCombinedSkills = false
  const lines = normalizedText ? normalizedText.split('\n').flatMap((line) => {
    const heading = normalizeSectionHeading(line).replace(/\s+/gu, '')
    if (/^技能证书(?:\/其他)?$/u.test(heading)) inCombinedSkills = true
    else if (sectionKindForHeading(line)) inCombinedSkills = false
    // Inline language/certificate labels are entries in a combined skills
    // block, not headings swallowing every subsequent programming skill.
    if (inCombinedSkills && /^(?:语言|语言能力|外语能力|证书|资格证书)\s*[:：]/u.test(line)) return [line]
    return splitInlineHeading(line)
  }) : []
  const { sections, warnings } = buildSections(lines)
  if (!normalizedText) warnings.unshift({ code: 'empty_text', message: 'Resume text is empty' })
  if (detectFormat(input) === 'unknown') warnings.push({ code: 'unknown_format', message: `Unable to infer format for ${input.fileName}` })

  return {
    documentId: input.documentId,
    format: detectFormat(input),
    originalText: input.text,
    normalizedText,
    lines,
    sections,
    warnings,
    parserVersion: PARSER_VERSION,
  }
}

export function normalizeResumeText(text: string): string {
  return normalizeText(text)
}
