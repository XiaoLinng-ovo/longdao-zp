import { cleanResumeFieldValues, extractResume, parseResume, EXTRACTOR_VERSION } from '@smartrecruit-pro/resume-intelligence'

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function cleanExtractionReport(report: Record<string, unknown>): Record<string, unknown> {
  const extraction = object(report.extraction)
  if (!extraction) return report
  const parsed = object(report.parsedResume)
  const source = typeof parsed?.originalText === 'string' ? parsed.originalText
    : typeof parsed?.normalizedText === 'string' ? parsed.normalizedText : ''
  const skills = Array.isArray(extraction.skills) ? extraction.skills : []
  const skillText = (skill: unknown) => {
    const row = object(skill)
    return typeof row?.value === 'string' ? row.value : typeof row?.canonical === 'string' ? row.canonical : ''
  }
  const languages = Array.isArray(extraction.languages) ? extraction.languages : []
  const certifications = Array.isArray(extraction.certifications) ? extraction.certifications : []
  const context = source || [...skills.map(skillText), ...languages.filter((value): value is string => typeof value === 'string'), ...certifications.filter((value): value is string => typeof value === 'string')].join('\n')
  const cleaned = { ...extraction }
  let changed = false
  for (const key of ['skills', 'languages', 'certifications'] as const) {
    const values = extraction[key]
    if (!Array.isArray(values)) continue
    const text = key === 'skills' ? values.map(skillText) : values.filter((value): value is string => typeof value === 'string')
    const kept = new Set(cleanResumeFieldValues(text, context))
    const filtered = values.filter(value => key === 'skills' ? kept.has(skillText(value)) : typeof value !== 'string' || kept.has(value))
    if (filtered.length !== values.length) { cleaned[key] = filtered; changed = true }
  }
  return changed ? { ...report, extraction: cleaned } : report
}

function repairReport(report: Record<string, unknown>): Record<string, unknown> {
  report = cleanExtractionReport(report)
  const extraction = object(report.extraction)
  const parsed = object(report.parsedResume)
  // Rebuild only the display of old deterministic extraction from its own saved
  // source text. Scores, human reviews, provenance and stored records stay intact.
  if (!extraction || !parsed || extraction.extractorVersion === EXTRACTOR_VERSION) return report
  const version = extraction.extractorVersion
  if (typeof version !== 'string' || !/^0\.[0-4]\.\d+$/u.test(version)) return report
  const text = typeof parsed.originalText === 'string' && parsed.originalText.trim()
    ? parsed.originalText : parsed.normalizedText
  if (typeof text !== 'string' || !text.trim()) return report
  const corrected = extractResume(parseResume({ fileName: 'saved-resume.txt', text, source: 'migration' }))
  if (!corrected.experience.length) return report
  return { ...report, extraction: { ...extraction, experience: corrected.experience } }
}

export function resumeExperienceView(result: Record<string, unknown>): Record<string, unknown>
export function resumeExperienceView(result: unknown): unknown
export function resumeExperienceView(result: unknown): unknown {
  const row = object(result)
  if (!row) return result
  const repaired = repairReport(row)
  const analysis = object(row.analysis)
  const report = object(analysis?.report)
  if (!analysis || !report) return repaired
  const nested = repairReport(report)
  return nested === report ? repaired : { ...repaired, analysis: { ...analysis, report: nested } }
}
