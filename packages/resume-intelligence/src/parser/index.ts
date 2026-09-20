import type { ParsedResume, ResumeDocumentFormat, ResumeSection, ResumeSectionKind, ResumeTextInput } from '../contracts/types.js'

export const PARSER_VERSION = '0.1.0'

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
  '职业经历': 'experience',
  '项目经历': 'experience',
  '项目经验': 'experience',
  '实习经历': 'experience',
  '社会实践': 'experience',
  '教育经历': 'education',
  '教育背景': 'education',
  '学历': 'education',
  '学习经历': 'education',
  '技能': 'skills',
  '专业技能': 'skills',
  '技术技能': 'skills',
  '技能特长': 'skills',
  '个人技能': 'skills',
  '核心技能': 'skills',
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
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim()
}

function sectionKindForHeading(line: string): ResumeSectionKind | undefined {
  const normalized = line
    .replace(/[：:]$/, '')
    .trim()
    .toLowerCase()
  return SECTION_ALIASES[normalized]
}

function isLikelyHeading(line: string): boolean {
  if (!line || line.length > 60) return false
  if (sectionKindForHeading(line)) return true
  return /^[A-Z][A-Z\s&/-]{2,}$/.test(line.trim())
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
  const lines = normalizedText ? normalizedText.split('\n') : []
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
