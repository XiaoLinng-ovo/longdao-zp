import type { CandidateDraft, ExperienceRecord, EducationRecord, ParsedResume, ResumeExtractionResult, ResumeProfile } from '../contracts/types.js'
import { normalizeSkill } from '../normalizer/index.js'

export const EXTRACTOR_VERSION = '0.1.0'

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const PHONE_RE = /(?:\+?\d[\d ()-]{7,}\d)/
const URL_RE = /https?:\/\/[^\s]+/i

function sectionText(parsed: ParsedResume, kind: string): string {
  return parsed.sections
    .filter((section) => section.kind === kind)
    .map((section) => section.text)
    .join('\n')
}

function extractCandidate(parsed: ParsedResume): CandidateDraft {
  const firstLines = parsed.lines.slice(0, 8)
  const email = parsed.normalizedText.match(EMAIL_RE)?.[0]
  const phone = parsed.normalizedText.match(PHONE_RE)?.[0]?.trim()
  const links = [...parsed.normalizedText.matchAll(new RegExp(URL_RE.source, 'gi'))].map((match) => match[0])
  const firstNameLine = firstLines.find((line) => {
    const value = line.trim()
    return value && !EMAIL_RE.test(value) && !PHONE_RE.test(value) && !URL_RE.test(value) && value.length <= 60
  })
  return {
    fullName: firstNameLine,
    email,
    phone,
    headline: parsed.sections.find((section) => section.kind === 'summary')?.text.split('\n')[0],
    links: [...new Set(links)],
  }
}

function extractEducation(parsed: ParsedResume): EducationRecord[] {
  return sectionText(parsed, 'education')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ evidence: line, institution: line.split(/[,|·]/)[0]?.trim() }))
}

function extractExperience(parsed: ParsedResume): ExperienceRecord[] {
  return sectionText(parsed, 'experience')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ evidence: line, description: line, skills: [] }))
}

function extractSkills(parsed: ParsedResume) {
  const raw = sectionText(parsed, 'skills')
    .split(/[,，、;；|\n]/)
    .map((value) => value.trim())
    .filter(Boolean)
  return [...new Map(raw.map((value) => [normalizeSkill(value).canonical, normalizeSkill(value)])).values()]
}

function estimateExperienceYears(experience: ExperienceRecord[]): number | undefined {
  if (!experience.length) return undefined
  const yearMatches = experience.flatMap((item) => item.evidence.match(/20\d{2}/g) ?? []).map(Number)
  if (!yearMatches.length) return undefined
  const earliest = Math.min(...yearMatches)
  return Math.max(0, new Date().getFullYear() - earliest)
}

export function extractResume(parsed: ParsedResume): ResumeExtractionResult {
  const candidate = extractCandidate(parsed)
  const experience = extractExperience(parsed)
  const profile: ResumeProfile = {
    headline: candidate.headline,
    summary: sectionText(parsed, 'summary') || undefined,
    totalExperienceYears: estimateExperienceYears(experience),
    locations: [],
  }
  return {
    candidate,
    profile,
    education: extractEducation(parsed),
    experience,
    skills: extractSkills(parsed),
    languages: sectionText(parsed, 'languages').split(/[,，、;；|\n]/).map((value) => value.trim()).filter(Boolean),
    certifications: sectionText(parsed, 'certifications').split(/[,，、;；|\n]/).map((value) => value.trim()).filter(Boolean),
    evidence: [],
    warnings: parsed.warnings.map((warning) => warning.message),
    extractorVersion: EXTRACTOR_VERSION,
  }
}
