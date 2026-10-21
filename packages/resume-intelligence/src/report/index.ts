import type {
  AnalysisProvenance,
  AnalysisReport,
  BuildReportInput,
  BuildRuleBasedReportInput,
  HumanReviewState,
  AnalysisSafety,
} from '../contracts/types.js'
import { anonymizeText } from '../anonymizer/index.js'
import { extractResume } from '../extractor/index.js'
import { NORMALIZER_VERSION } from '../normalizer/index.js'
import { parseResume } from '../parser/index.js'
import { PARSER_VERSION } from '../parser/index.js'
import { EXTRACTOR_VERSION } from '../extractor/index.js'
import { MATCHER_VERSION } from '../matcher/index.js'
import { scoreResumeMatch } from '../scorer/index.js'
import { SCORER_VERSION } from '../scorer/index.js'
import { matchResumeToJob } from '../matcher/index.js'
import { resumeBodyCharacterCount, resumeTextHasEncodingDamage } from '../text-cleaning/index.js'

export const REPORT_VERSION = '0.1.0'

export const DEFAULT_ANALYSIS_SAFETY: AnalysisSafety = {
  advisoryOnly: true,
  applicationStatusMutation: 'none',
  autoReject: false,
  autoHire: false,
  autoOffer: false,
}

export const DEFAULT_HUMAN_REVIEW: HumanReviewState = { status: 'pending' }

export function buildAnalysisReport(input: BuildReportInput): AnalysisReport {
  const provenance: AnalysisProvenance = {
    engine: 'deterministic-rules',
    parserVersion: PARSER_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    matcherVersion: MATCHER_VERSION,
    scorerVersion: SCORER_VERSION,
    ...input.provenance,
  }
  return {
    subject: input.subject ?? {},
    parsedResume: input.parsedResume,
    extraction: input.extraction,
    assessment: input.assessment,
    provenance,
    humanReview: { ...DEFAULT_HUMAN_REVIEW, ...input.humanReview },
    safety: DEFAULT_ANALYSIS_SAFETY,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  }
}

export function buildRuleBasedReport(input: BuildRuleBasedReportInput): AnalysisReport {
  if (resumeTextHasEncodingDamage(input.resume.text)) {
    throw new Error('简历正文存在明显乱码或缺失字形，无法可靠评分。请先完成 OCR 识别或重新导出原文件。')
  }
  if (resumeBodyCharacterCount(input.resume.text) < 5) {
    throw new Error('未提取到有效简历正文，无法评分。扫描件或仅包含水印的 PDF 需要先完成 OCR 识别。')
  }
  const parsedResume = parseResume(input.resume)
  const extraction = extractResume(parsedResume)
  // Anonymization is intentionally deterministic and does not alter persisted source text.
  // It is used here to exercise the same privacy boundary that the LLM adapter will use.
  const anonymized = anonymizeText(parsedResume.normalizedText, {
    name: extraction.candidate.fullName,
    replaceNames: Boolean(extraction.candidate.fullName),
  })
  const safeExtraction = {
    ...extraction,
    warnings: anonymized.replacements.length ? [...extraction.warnings, `anonymized ${anonymized.replacements.length} PII value(s)`] : extraction.warnings,
  }
  const assessment = scoreResumeMatch({ extraction: safeExtraction, job: input.job, requirementMatches: matchResumeToJob(safeExtraction, input.job) })
  return buildAnalysisReport({ parsedResume, extraction: safeExtraction, assessment, subject: input.subject, generatedAt: input.generatedAt })
}
