import type { CandidateDraft, ExperienceRecord, EducationRecord, ParsedResume, ResumeExtractionResult, ResumeProfile } from '../contracts/types.js'
import { normalizeSkill } from '../normalizer/index.js'
import { positiveEvidenceText } from '../evidence-text/index.js'

export const EXTRACTOR_VERSION = '0.6.6'

// Exact template labels must never become a person's name. Shared with both
// persistence paths so reanalysis can repair earlier placeholder values.
export const RESUME_PLACEHOLDER_NAMES = [
  '待解析候选人', '待解析', '未命名候选人', 'personal resume', 'resume', 'curriculum vitae',
  '个人简历', '简历', '基本信息', '个人信息', '联系方式', '现居', '现居地',
  '居住地', '所在地', '姓名', '名字', '性别', '年龄', '教育背景', '教育经历',
  '工作经历', '工作经验', '项目经历', '相关技能', '专业技能', '技能', '技术栈', '学历', '应用统计学',
]

export function isResumePlaceholderName(value: string): boolean {
  return RESUME_PLACEHOLDER_NAMES.includes(value.normalize('NFKC').trim().toLowerCase().replace(/(?<=[\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, ''))
}

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const PHONE_RE = /(?<![\p{L}\d])\+?\d[\d ()-]{5,}\d(?![\p{L}\d])/gu
const URL_RE = /https?:\/\/[^\s]+/i

// PDF text extraction commonly inserts spaces around Chinese date units, for
// example "2022 年 1 月-2022 年 5 月". Keep the month-hyphen form guarded so
// a year range such as "2022-2025" is not mistaken for a month.
const RESUME_DATE_PART = '(?:19|20)\\d{2}(?:(?:\\s*[./]\\s*|\\s*年\\s*)\\d{1,2}\\s*月?|(?:\\s*-\\s*)\\d{1,2}\\s*月?(?!\\d))?'
const RESUME_DATE_RANGE_SOURCE = `(?<start>${RESUME_DATE_PART})\\s*(?:[-~～—–至到])\\s*(?<end>至今|${RESUME_DATE_PART})`

function extractPhone(text: string, labeled = false): string | undefined {
  // Remove complete employment/education ranges before looking for numbers;
  // otherwise the fractional months can resemble a local telephone number.
  const withoutDates = text.replace(new RegExp(`(?<!\\d)${RESUME_DATE_RANGE_SOURCE}(?!\\d)`, 'gu'), ' ')
  for (const match of withoutDates.matchAll(PHONE_RE)) {
    const value = match[0].trim()
    const compact = value.replace(/[ ()-]/gu, '')
    const digits = compact.replace(/^\+/u, '')
    if (digits.length < 7 || digits.length > 15) continue
    if (/^(?:\+?86)?1[3-9]\d{9}$/u.test(compact)
      || /^(?:\+?86)?0\d{9,11}$/u.test(compact)
      || /^\+[1-9]\d{7,14}$/u.test(compact)
      || (labeled && /^\d{7,8}$/u.test(compact))) return value
  }
  return undefined
}

function sectionText(parsed: ParsedResume, kind: string): string {
  return parsed.sections
    .filter((section) => section.kind === kind)
    .map((section) => section.text)
    .join('\n')
}

const CONTACT_LABELS = [
  '姓名', '名字', '性别', '出生年月', '出生日期', '电话', '手机', '邮箱', '电子邮箱',
  '现居地', '现居', '居住地', '所在地', '求职意向', '求职目标', '期望薪资', '到岗时间',
  '联系方式', '学历', '年龄',
  '政治面貌', '政治面目', '民族', '籍贯', '户籍所在地', '户籍', '户口所在地', '户口',
  '婚姻状况', '婚育状况', '婚姻', '身高', '体重', '健康状况', '国籍', '出生地',
  '工作年限', '工作经验', '毕业院校', '毕业学校', '毕业时间', '所学专业', '专业',
  '联系电话', '手机号码', '电话号码', '联系邮箱', '通讯地址', '联系地址', '居住地址',
  '最高学历', '学位', '出生年份', '生日', '求职状态', '目前状态', '期望城市', '意向城市',
]

const FIELD_SPACE = '[ \\t\\u3000]*'
const spacedLabel = (label: string) => [...label].join(FIELD_SPACE)
const CONTACT_LABEL_PATTERN = [...CONTACT_LABELS].sort((a, b) => b.length - a.length).map(spacedLabel).join('|')
const CONTACT_FIELD_START = new RegExp('(?:' + CONTACT_LABEL_PATTERN + ')' + FIELD_SPACE + '[:：]', 'iu')

function trimFieldValue(value: string): string {
  return value.trim().replace(/[，,；;|｜]+$/u, '').trim()
}

function labeledValue(text: string, labels: string[]): string | undefined {
  const expression = new RegExp(
    '(?:' + labels.map(spacedLabel).join('|') + ')' + FIELD_SPACE + '[:：]' + FIELD_SPACE + '(.*?)(?=(?:' + CONTACT_LABEL_PATTERN + ')' + FIELD_SPACE + '[:：]|[\\r\\n]|$)',
    'iu',
  )
  const match = text.match(expression)
  const value = match ? trimFieldValue(match[1]!) : undefined
  return value || undefined
}

/** Only normalize names supported by the source; never guess a name from a filename. */
export function normalizeResumeCandidateName(value: string): string | undefined {
  const name = trimFieldValue(value).normalize('NFKC').replace(/[ \t\u3000]+/gu, ' ')
    .replace(/(?<=\p{Script=Han}) +(?=\p{Script=Han})/gu, '')
  if (!name || name.length > 60 || isResumePlaceholderName(name)) return undefined
  if (/^\p{Script=Han}{2,6}$/u.test(name)) return name
  // Keep multiword Latin names and ethnic names with a middle dot intact.
  if (/^[\p{L}\p{M}]+(?:[ ·・.'’\-][\p{L}\p{M}]+){1,5}$/u.test(name)) return name
  if (/^[\p{Script=Latin}\p{M}]{2,40}$/u.test(name)) return name
  return undefined
}

/** A previous parser may have appended another labeled personal field to a
 * name. Repair only when its complete prefix agrees with the new source name. */
export function isResumeNameWithAppendedFields(existingName: string, extractedName: string): boolean {
  const boundary = existingName.search(CONTACT_FIELD_START)
  const name = normalizeResumeCandidateName(extractedName)
  return boundary > 0 && Boolean(name) && normalizeResumeCandidateName(existingName.slice(0, boundary)) === name
}

function likelyNameFromLine(line: string): string | undefined {
  const boundary = line.search(CONTACT_FIELD_START)
  const value = trimFieldValue(boundary < 0 ? line : line.slice(0, boundary))
    .replace(/(?:的)?个人简历$/u, '').trim()
  if (!value || value.length > 48 || URL_RE.test(value)) return undefined
  if (isResumePlaceholderName(value)) return undefined
  if (/(?:19|20)\d{2}(?:[./年-]\d{1,2})?/u.test(value)) return undefined
  if (/^(?:教育背景|教育经历|工作经历|工作经验|项目经历|项目经验|技能标签|专业技能|自我评价|求职意向|基本信息|联系方式)/u.test(value)) return undefined
  if (/^(?:姓名|名字|性别|出生年月|电话|手机|邮箱|现居地|居住地|所在地)\s*[:：]?/u.test(value)) return undefined
  if (/^\p{Script=Han}(?:[ \t\u3000]+\p{Script=Han}){1,5}$/u.test(value)) return normalizeResumeCandidateName(value)

  // A contact line may begin with a bare name followed by phone/email data
  // (for example, "张三 138... zhang@example.com"). Inspect the first token
  // only after rejecting the line as a heading or a date, rather than rejecting
  // it just because the rest of the line contains PII.
  const firstToken = value.split(/[\s|,，;；]+/u)[0]?.trim()
  if (firstToken && /^[\p{Script=Han}·]{2,12}$/u.test(firstToken)) return normalizeResumeCandidateName(firstToken)
  if (/^[\p{Lu}][\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+){1,3}$/u.test(value)) return normalizeResumeCandidateName(value)
  return undefined
}

function extractCandidate(parsed: ParsedResume): CandidateDraft {
  const contentStart = parsed.sections.find((section) => ['education', 'experience', 'skills', 'languages', 'certifications'].includes(section.kind))?.startLine
  const firstLines = parsed.lines.slice(0, Math.min(8, contentStart === undefined ? 8 : contentStart - 1))
  const email = parsed.normalizedText.match(EMAIL_RE)?.[0]
  const phone = extractPhone(labeledValue(parsed.normalizedText, ['联系电话', '手机号码', '电话号码', '电话', '手机', '联系方式']) ?? '', true)
    ?? extractPhone(parsed.normalizedText)
  const links = [...parsed.normalizedText.matchAll(new RegExp(URL_RE.source, 'gi'))].map((match) => match[0])
  const firstNameLine = firstLines.map(likelyNameFromLine).find((value): value is string => Boolean(value))
  const headline = labeledValue(parsed.normalizedText, ['求职意向', '求职目标'])
    ?? parsed.sections.find((section) => section.kind === 'summary')?.text.split('\n')[0]
  return {
    fullName: normalizeResumeCandidateName(labeledValue(parsed.normalizedText, ['姓名', '名字']) ?? '') ?? firstNameLine,
    email,
    phone,
    location: labeledValue(parsed.normalizedText, ['现居地', '现居', '居住地', '所在地']),
    headline,
    links: [...new Set(links)],
  }
}

interface ParsedDateRange {
  startDate: string
  endDate: string
  startMonth: number
  endMonth: number
  match: string
}

function dateMonthIndex(value: string, isEnd: boolean): number {
  const parts = value.match(/\d+/gu)?.map(Number) ?? []
  const year = parts[0] ?? new Date().getFullYear()
  const month = parts[1] ?? (isEnd ? 12 : 1)
  return year * 12 + month - 1
}

function formatResumeDate(value: string): string {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, '')
  if (normalized === '至今') return normalized
  const match = normalized.match(/^(?<year>(?:19|20)\d{2})(?:(?:[./-]|年)(?<month>\d{1,2})月?)?$/u)
  if (!match?.groups?.year) return normalized.replace(/年/gu, '.').replace(/月/gu, '').replace(/-/gu, '.')
  return match.groups.month ? `${match.groups.year}.${match.groups.month.padStart(2, '0')}` : match.groups.year
}

function parseDateRange(text: string): ParsedDateRange | undefined {
  const match = text.match(new RegExp(RESUME_DATE_RANGE_SOURCE, 'u'))
  const start = match?.groups?.start
  const end = match?.groups?.end
  if (!match || !start || !end) return undefined
  const normalizedEnd = end === '至今' ? String(new Date().getFullYear()) + '.' + String(new Date().getMonth() + 1).padStart(2, '0') : end
  return {
    startDate: formatResumeDate(start),
    endDate: formatResumeDate(end),
    startMonth: dateMonthIndex(start, false),
    endMonth: dateMonthIndex(normalizedEnd, true),
    match: match[0],
  }
}

function extractEducation(parsed: ParsedResume): EducationRecord[] {
  const records: EducationRecord[] = []
  const lines = sectionText(parsed, 'education')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const school = /(?:大学(?!生)|学院|学校|University|College|Institute|School)/iu
  let pendingMajor: string | undefined
  for (const [index, line] of lines.entries()) {
      if (!school.test(line) && !parseDateRange(line) && !/[:：]/u.test(line) && line.length <= 48
        && school.test(lines[index + 1] ?? '') && /博士|硕士|研究生|本科|学士|大专|专科/u.test(lines[index + 1] ?? '')) {
        pendingMajor = line
        continue
      }
      const previous = records.at(-1)
      if (previous && /^(?:研究方向|主修课程|主要课程|相关课程|研究课题|毕业论文|学业成绩|GPA)\s*[:：]/iu.test(line)) {
        previous.evidence += `\n${line}`
        continue
      }
      const range = parseDateRange(line)
      if (previous && range && !school.test(line) && !previous.startDate && !previous.endDate) {
        previous.startDate = range.startDate
        previous.endDate = range.endDate
        previous.evidence += `\n${line}`
        continue
      }
      const details = cleanEntryDetails(range ? line.replace(range.match, '') : line)
      const degreeMatch = details.match(/博士后|博士|硕士|研究生|本科|学士|大专|专科|高职/u)
      const degree = degreeMatch?.[0]
      const studyDetails = cleanEntryDetails(degree ? details.replace(degree, '') : details)
      const fields = studyDetails.replace(/[（(]QS\s*\d+[^)）]*[)）]/iu, '').trim().split(/[、,，|｜·\s]+/u).filter((value) => value && value !== '/')
      // A school/date header is often followed by major/degree and wrapped
      // courses or honours. These paragraphs are evidence for the same school.
      if (previous && !range && (!/(?:大学|学院|学校|University|College|Institute|School)/iu.test(line)
        || /^[^:：]{1,12}[:：]/u.test(line))) {
        previous.evidence += `\n${line}`
        if (degree && !previous.degree) {
          previous.degree = degree
          const major = studyDetails.replace(/(?:全日制|非全日制)/gu, '').trim()
          if (major) previous.fieldOfStudy = major
        }
        continue
      }
      // Do not create an education record from nearby awards, courses, or
      // other unlabeled paragraphs when no school/date is present.
      if (!school.test(line) && !range && !pendingMajor && !degree) {
        if (previous) previous.evidence += `\n${line}`
        continue
      }
      records.push({
        evidence: [pendingMajor, line].filter(Boolean).join('\n'),
        ...(fields[0] ? { institution: fields[0] } : {}),
        ...(degree ? { degree } : {}),
        ...(pendingMajor || fields.length > 1 ? { fieldOfStudy: pendingMajor ?? fields.slice(1).join(' ') } : {}),
        ...(range?.startDate ? { startDate: range.startDate } : {}),
        ...(range?.endDate ? { endDate: range.endDate } : {}),
      })
      pendingMajor = undefined
  }
  return records
}

function cleanRecordText(value: string): string {
  return value
    .replace(/[|｜·]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function cleanEntryDetails(value: string): string {
  return value.replace(/[（(]\s*[）)]/gu, '').replace(/(?:^|\s)[-–—](?=\s|$)/gu, ' ')
    .replace(/^[\s-]+|[\s-]+$/gu, '').replace(/\s+/gu, ' ').trim()
}

function makeExperienceRecord(header: string, lines: string[], range?: ParsedDateRange): ExperienceRecord {
  const rawDetails = cleanEntryDetails(range ? header.replace(range.match, '') : header)
  const separated = rawDetails.split(/[|｜]/u).map((part) => part.trim()).filter(Boolean)
  const details = cleanRecordText(rawDetails)
  const organization = details.match(/^(.+?(?:有限责任公司|有限公司|股份有限公司|集团|公司|研究院|大学|中心|工作室))(?=\s|$)/u)
  const employer = separated.length > 1 ? separated[0] : organization?.[1]?.trim() ?? details.split(/\s+/u)[0]
  let title = cleanEntryDetails(separated.length > 1 ? separated.slice(1).join(' ') : organization ? details.slice(organization[0].length).trim() : details.split(/\s+/u).slice(1).join(' '))
  const description = lines.map(cleanRecordText).filter(Boolean)
  const evidence = [cleanRecordText(header), ...description].filter(Boolean).join('\n')
  if (!title && description[0] && description[0].length <= 30
    && /^[^：:，,。●•]+(?:工程师|实习生|助理|经理|专员|研究员|主管)$/u.test(description[0])) {
    title = description.shift()!
  }
  return {
    ...(employer ? { employer } : {}),
    ...(title ? { title } : {}),
    ...(range?.startDate ? { startDate: range.startDate } : {}),
    ...(range?.endDate ? { endDate: range.endDate } : {}),
    ...(description.length ? { description: description.join('\n') } : {}),
    evidence,
    skills: [],
  }
}

const PROJECT_DETAIL_LABEL = /^(?:项目描述|项目简介|项目介绍|项目背景|项目职责|项目责任|项目成果|项目业绩|项目收获|项目内容|项目角色|项目亮点|核心职责|担任角色|所任职位|角色|职责|职务|工作内容|工作职责|主要职责|主要工作|负责内容|个人职责|个人贡献|主要贡献|技术栈|使用技术|开发环境|项目环境|项目规模|项目人数|项目时间|项目周期|项目链接|成果|业绩)(?:\s*[:：]|\s*$)/u
const DESCRIPTION_START = /^(?:负责|参与|主导|带领|领导|领带|开发|设计|实现|完成|搭建|使用|通过|基于|采用|运用|独立|协助|担任|在|为|将|对|该|本|其中|包括|主要|职员|团队|项目负责人|项目经理)/u
const PROJECT_ROLE_DATE = /^(?:独立负责|独立开发|项目负责人|担任角色|开发角色|后端开发|前端开发|全栈开发|后端工程师|前端工程师)(?:\s|[|｜：:])/u

function projectHeading(line: string, nextLine?: string): { title?: string; description?: string; range?: ParsedDateRange } | undefined {
  if (/^\s*[⚫•●▪◆*-]/u.test(line)) return undefined
  // Preserve pipes until project metadata is split from the project name.
  const value = line.replace(/\s+/gu, ' ').trim().replace(/^(?:[•●▪◆·*-]\s*|\d{1,2}[、.)）](?!\d)\s*)/u, '')
  if (PROJECT_DETAIL_LABEL.test(value)) return undefined
  const range = parseDateRange(value)
  // Dates within a responsibility sentence are evidence, not new project boundaries.
  const datedHeading = range && (value.startsWith(range.match) || value.endsWith(range.match))
    && (!DESCRIPTION_START.test(value) || /^基于[^，,。；;：:]{1,90}$/u.test(value))
  const details = (datedHeading ? value.replace(range.match, '') : value).trim()
  const named = details.match(/^(?:(?:项目名称|项目名|项目)\s*[:：]\s*|项目[一二三四五六七八九十\d]+\s+)(.+)$/u)
  const namedDetails = (named?.[1] ?? details).replace(/[|｜]\s*$/u, '').trim()
  const pipeParts = namedDetails.split(/[|｜]/u).map((part) => part.trim()).filter(Boolean)
  const pipeTitle = pipeParts.length > 1 ? pipeParts[0] : undefined
  const separator = (pipeTitle ?? namedDetails).match(/^([^：:]+)\s*[:：]\s*(.*)$/u)
  const title = (separator?.[1] ?? pipeTitle ?? namedDetails).trim()
  const pipeDescription = pipeParts.length > 1 ? pipeParts.slice(1).join(' | ') : undefined
  const shortTitle = title.length >= 2 && title.length <= 60 && !/[，,。；;！!?？]/u.test(title)
    && (!DESCRIPTION_START.test(title) || /^基于[^：:，,。；;]+的[^：:，,。；;]+(?:系统|平台|项目|工具|应用)$/u.test(title))
  const bareTitle = /(?:系统|平台|程序|项目|中台|工具|应用|网站|客户端|引擎|服务|APP)$/iu.test(title)
  const followedByDetails = nextLine && (PROJECT_DETAIL_LABEL.test(nextLine) || (PROJECT_ROLE_DATE.test(nextLine) && parseDateRange(nextLine)))
  if (!named && !datedHeading && !(shortTitle && (bareTitle || (!separator && followedByDetails)))) return undefined
  return {
    ...(title ? { title } : {}),
    ...(separator?.[2] ? { description: separator[2].trim() } : pipeDescription ? { description: pipeDescription } : {}),
    ...(datedHeading ? { range } : {}),
  }
}

/** Paragraphs and bullets belong to their project until an explicit new entry
 * starts. Subheadings such as 项目描述/职责/成果 must never become project names. */
function extractProjects(lines: string[], sectionTitle: string): ExperienceRecord[] {
  const normalizedLines: string[] = []
  for (const line of lines) {
    const previous = normalizedLines.at(-1)
    if (previous && /[-–—]$/u.test(previous) && /^[\p{L}\p{N}]/u.test(line)) {
      normalizedLines[normalizedLines.length - 1] = `${previous}${line}`
    } else {
      normalizedLines.push(line)
    }
  }
  const records: ExperienceRecord[] = []
  let title: string | undefined
  let range: ParsedDateRange | undefined
  let description: string[] = []
  let evidence: string[] = []
  let technologyListContinues = false
  const flush = () => {
    if (evidence.length) records.push({
      title: title || sectionTitle,
      ...(range ? { startDate: range.startDate, endDate: range.endDate } : {}),
      ...(description.length ? { description: description.join('\n') } : {}),
      evidence: evidence.join('\n'),
      skills: [],
    })
    title = undefined
    range = undefined
    description = []
    evidence = []
  }
  for (const [index, line] of normalizedLines.entries()) {
    const roleRange = PROJECT_ROLE_DATE.test(line) ? parseDateRange(line) : undefined
    if (title && !range && roleRange && description.length === 0) {
      range = roleRange
      description.push(cleanRecordText(line))
      evidence.push(cleanRecordText(line))
      continue
    }
    let heading = technologyListContinues ? undefined : projectHeading(line, normalizedLines[index + 1])
    // A colon subheading inside an already dated project (流程引擎：...) is
    // project detail unless another explicit project header supports a split.
    if (range && heading?.description && !heading.range && !/^项目(?:名称|名|[一二三四五六七八九十\d])/u.test(line)
        && !PROJECT_DETAIL_LABEL.test(normalizedLines[index + 1] ?? '')) heading = undefined
    technologyListContinues = (technologyListContinues || /^技术栈\s*[:：]/u.test(line)) && /[,，、;；·/]\s*$/u.test(line)
    if (heading) {
      // DOCX/PDF often put the date and project name in separate paragraphs.
      // Attach either part to an unfinished header rather than creating two entries.
      const completingHeader = evidence.length > 0 && description.length === 0
        && ((!title && range && heading.title && !heading.range) || (title && !range && !heading.title && heading.range)
          || (range && heading.title && !heading.range && /^项目[一二三四五六七八九十\d]+\s+/u.test(line)))
      if (!completingHeader) flush()
      title = heading.title || title
      range = heading.range || range
      if (heading.description) description.push(heading.description)
    } else {
      description.push(cleanRecordText(line))
    }
    evidence.push(cleanRecordText(line))
  }
  flush()
  return records
}

function extractExperience(parsed: ParsedResume): ExperienceRecord[] {
  const records: ExperienceRecord[] = []
  const projectSectionTitles = new Set(['项目经历', '项目经验', '项目实践'])

  for (const section of parsed.sections.filter((item) => item.kind === 'experience')) {
    const lines = section.text.split('\n').map((line) => line.trim()).filter(Boolean)
    if (projectSectionTitles.has(section.title.replace(/\s+/gu, ''))) {
      records.push(...extractProjects(lines, section.title))
      continue
    }

    let header: string | undefined
    let range: ParsedDateRange | undefined
    let details: string[] = []
    const flush = () => {
      if (header) records.push(makeExperienceRecord(header, details, range))
      header = undefined
      range = undefined
      details = []
    }

    for (const line of lines) {
      const lineRange = parseDateRange(line)
      const datedHeader = lineRange && (line.startsWith(lineRange.match) || line.replace(/[）)]\s*$/u, '').endsWith(lineRange.match)) && !DESCRIPTION_START.test(line)
      const employerHeader = !DESCRIPTION_START.test(line) && /^.{2,60}(?:有限公司|集团|公司|研究院|工作室)(?:\s|$)/u.test(line)
      const dateDetails = lineRange ? cleanRecordText(line.replace(lineRange.match, '')) : undefined
      const locationDate = dateDetails !== undefined && (!dateDetails || /^(?:中国|英国|美国|德国|法国|日本|瑞典|工作地点[：:]|地点[：:])/u.test(dateDetails))
      if (header && !range && datedHeader && !employerHeader && locationDate
        && details.length <= 1 && details.every((value) => value.length <= 30 && !/[。；;：:●•]/u.test(value))) {
        range = lineRange
        details.push(line)
        continue
      }
      if (datedHeader || employerHeader) {
        flush()
        header = line
        range = datedHeader ? lineRange : undefined
      } else if (header) {
        details.push(line)
      } else {
        header = line
      }
    }
    flush()
  }

  return records
}

function extractSkills(parsed: ParsedResume) {
  const lines: string[] = []
  const entryLabel = /^([^:：()（）]{1,48})(?:[（(](?:掌握|熟悉|精通|了解|熟练)[)）])?\s*[:：]/u
  for (const section of parsed.sections.filter((item) => item.kind === 'skills')) {
    const combined = /^技能证书(?:\/其他)?$/u.test(section.title.replace(/\s+/gu, ''))
    const sourceLines = section.text.split('\n').filter((line) => !combined || !/^(?:语言|语言能力|外语能力|证书|资格证书)\s*[:：]/u.test(line))
    const bulleted = sourceLines.some((line) => /^[\s]*[⚫●•▪]/u.test(line))
    if (sourceLines.some((line) => /^[\s]*[⚫●•▪]/u.test(line) || entryLabel.test(line))) {
      const entries: string[] = []
      // Both bulleted and unbulleted labelled skills can wrap across lines.
      for (const line of sourceLines) {
        const continuation = bulleted || (line.length > 25 && /\p{Script=Han}/u.test(line)) || /[。；，]|^(?:能|可|或|等|需|了解|熟悉|通过|掌握|采用|使用)/u.test(line)
          || /[,，、;；·/]\s*$/u.test(entries.at(-1) ?? '')
        if (/^[\s]*[⚫●•▪]/u.test(line) || entryLabel.test(line) || !entries.length || !continuation) entries.push(line)
        else entries[entries.length - 1] += ` ${line}`
      }
      lines.push(...entries)
    } else {
      const entries: string[] = []
      let previousLine = ''
      for (const [index, line] of sourceLines.entries()) {
        const category = line.length <= 20 && !/[,，、;；|·]/u.test(line)
          && /(?:系统|检索|数据|工程|多模态|技术|技能|能力|框架|语言|工具|数据库)$/u.test(line)
          && /[,，、;；|·]/u.test(sourceLines[index + 1] ?? '')
        if (category) { previousLine = ''; continue }
        if (entries.length && /[,，、;；|·]/u.test(previousLine)) entries[entries.length - 1] += `\n${line}`
        else entries.push(line)
        previousLine = line
      }
      lines.push(...entries)
    }
  }
  // Explicit project technology lists also provide evidence; their following
  // descriptions must remain experience content rather than skill tags.
  parsed.lines.forEach((line, index) => {
    if (!/^技术栈\s*[:：]/u.test(line.trim())) return
    let value = line.replace(/^技术栈\s*[:：]/u, '')
    let next = index + 1
    while (/[,，、;；·/]\s*$/u.test(value) && parsed.lines[next] && !/[:：⚫•。]/u.test(parsed.lines[next]!)) {
      value += ` ${parsed.lines[next++]}`
    }
    lines.push(value)
  })
  const raw = lines.flatMap((line) => {
    const positive = positiveEvidenceText(line.replace(/(?<=\p{Script=Han})\n(?=\p{Script=Han})/gu, '').replace(/\n/gu, ' '))
      .replace(/^[\s⚫●•▪\-·]+/u, '').replace(/^\d+[.)、]\s*/u, '').trim()
    // Skills written as “Python（掌握）：...” have a short explicit label.
    const match = positive.match(entryLabel)
    const label = match?.[1]
    if (label && /^(?:语言与证书|语言及证书)$/u.test(label)) return []
    const category = label && /(?:技能|能力|框架|工具|语言|数据库|数据|视觉|软件|编排|工程|服务|AI\s*应用|技术栈)$/iu.test(label)
      && !/[（(](?:掌握|熟悉|精通|了解|熟练)[)）]/u.test(match![0])
    const value = (category ? positive.slice(match![0].length).split(/[\n;；。]/u)[0]! : label ?? positive)
      .replace(/^(?:熟练掌握|熟练使用|熟练|掌握|精通|熟悉|了解)\s*/u, '')
    return value.split(/[,，、;；|·\n]/u).map((item) => item.trim().replace(/[。.]$/u, '')
      .replace(/^\d+[.)、]\s*/u, '').replace(/^(?:熟练掌握|熟练使用|熟练|掌握|精通|熟悉|了解)\s*/u, '')).filter((item) =>
      (item.length > 1 || /^(?:R|C)$/u.test(item)) && item.length <= 48 && !/[。；：:]/u.test(item)
      && !/(?:负责|项目描述|主要工作|核心职责|实现|完成|搭建|基于|能够|通过|进行|具备|采用|用于|设计|构建|提出|改进|验证|包括|流程经验|交付|跟进)/u.test(item))
      .map((item) => ({ ...normalizeSkill(item), evidence: [line.trim()] }))
  })
  return [...new Map(raw.map((skill) => [skill.canonical, skill])).values()]
}

function estimateExperienceYears(experience: ExperienceRecord[]): number | undefined {
  if (!experience.length) return undefined
  const ranges = experience.map((item) => parseDateRange(item.evidence)).filter((item): item is ParsedDateRange => Boolean(item)).sort((left, right) => left.startMonth - right.startMonth)
  if (ranges.length) {
    let start = ranges[0]!.startMonth
    let end = ranges[0]!.endMonth
    let totalMonths = 0
    for (const range of ranges.slice(1)) {
      if (range.startMonth <= end + 1) end = Math.max(end, range.endMonth)
      else {
        totalMonths += end - start + 1
        start = range.startMonth
        end = range.endMonth
      }
    }
    totalMonths += end - start + 1
    return Math.max(0, Math.floor(totalMonths / 12))
  }
  // If no complete range is available, only inspect each record's header. Do
  // not scan descriptions: metrics such as "2000 samples/s" are not dates.
  const yearMatches = experience.flatMap((item) => {
    const header = item.evidence.split('\n', 1)[0] ?? ''
    return [...header.matchAll(/(?<![\d.])(?:19|20)\d{2}(?![\d.])/gu)].map((match) => Number(match[0]))
  })
  if (!yearMatches.length) return undefined
  const earliest = Math.min(...yearMatches)
  return Math.max(0, new Date().getFullYear() - earliest)
}

export function extractResume(parsed: ParsedResume): ResumeExtractionResult {
  const candidate = extractCandidate(parsed)
  const experience = extractExperience(parsed)
  const splitQualifications = (text: string) => text.split(/[,，、;；|\n]/u).map((value) => value.trim()).filter(Boolean)
  const languages = splitQualifications(sectionText(parsed, 'languages'))
  const certifications = splitQualifications(sectionText(parsed, 'certifications'))
  for (const section of parsed.sections.filter((item) => /^技能证书(?:\/其他)?$/u.test(item.title.replace(/\s+/gu, '')))) {
    for (const line of section.text.split('\n')) {
      const language = line.match(/^(?:语言|语言能力|外语能力)\s*[:：](.+)$/u)
      const certificate = line.match(/^(?:证书|资格证书)\s*[:：](.+)$/u)
      if (language) languages.push(...splitQualifications(language[1]!))
      if (certificate) certifications.push(...splitQualifications(certificate[1]!))
    }
  }
  for (const line of parsed.lines) {
    const combined = line.trim().replace(/^[•●⚫▪\s-]+/u, '').match(/^(?:语言(?:与|及)证书|资格证书)\s*[:：](.+)$/u)
    if (!combined) continue
    for (const value of splitQualifications(combined[1]!).map((item) => item.replace(/[。.]$/u, ''))) {
      if (/IELTS|TOEFL|TOEIC|CET[-\s]?[46]|雅思|托福|英语|日语|法语|德语|韩语|普通话/iu.test(value)) languages.push(value)
      else if (/证书|资格|执照|认证|等级考试/u.test(value) || /资格证书/u.test(combined[0])) certifications.push(value)
    }
  }
  const profile: ResumeProfile = {
    headline: candidate.headline,
    summary: sectionText(parsed, 'summary').replace(/^(?:求职意向|求职目标)\s*[:：]?[^\n]*\n?/u, '').trim() || undefined,
    totalExperienceYears: estimateExperienceYears(experience),
    locations: candidate.location ? [candidate.location] : [],
  }
  return {
    candidate,
    profile,
    education: extractEducation(parsed),
    experience,
    skills: extractSkills(parsed),
    languages: [...new Set(languages)],
    certifications: [...new Set(certifications)],
    evidence: [],
    warnings: parsed.warnings.map((warning) => warning.message),
    extractorVersion: EXTRACTOR_VERSION,
  }
}
