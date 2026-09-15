/** Stable public contracts for the first internal resume-intelligence package. */

export type EntityId = string
export type ISODateTime = string

export type ResumeDocumentFormat = 'pdf' | 'docx' | 'txt' | 'html' | 'unknown'

export interface ResumeTextInput {
  documentId?: EntityId
  fileName: string
  mimeType?: string
  text: string
  source?: 'upload' | 'paste' | 'test' | 'migration'
}

export type ResumeSectionKind =
  | 'contact'
  | 'summary'
  | 'experience'
  | 'education'
  | 'skills'
  | 'certifications'
  | 'languages'
  | 'other'

export interface ResumeSection {
  kind: ResumeSectionKind
  title: string
  text: string
  startLine: number
  endLine: number
}

export type ParseWarningCode =
  | 'empty_text'
  | 'unknown_format'
  | 'unrecognized_section'
  | 'malformed_line'

export interface ParseWarning {
  code: ParseWarningCode
  message: string
  line?: number
}

export interface ParsedResume {
  documentId?: EntityId
  format: ResumeDocumentFormat
  originalText: string
  normalizedText: string
  lines: string[]
  sections: ResumeSection[]
  warnings: ParseWarning[]
  parserVersion: string
}

export interface CandidateDraft {
  fullName?: string
  email?: string
  phone?: string
  location?: string
  headline?: string
  source?: string
  links: string[]
}

export interface ResumeProfile {
  headline?: string
  summary?: string
  totalExperienceYears?: number
  locations: string[]
}

export interface EducationRecord {
  institution?: string
  degree?: string
  fieldOfStudy?: string
  startDate?: string
  endDate?: string
  evidence: string
}

export interface ExperienceRecord {
  employer?: string
  title?: string
  startDate?: string
  endDate?: string
  description?: string
  skills: string[]
  evidence: string
}

export interface NormalizedSkill {
  value: string
  canonical: string
  aliases: string[]
  evidence: string[]
}

export type EvidenceRelevance = 'supporting' | 'conflicting' | 'neutral'

export interface EvidenceItem {
  id: EntityId
  requirementId?: EntityId
  sourceText: string
  normalizedValue?: string
  relevance: EvidenceRelevance
  confidence: number
}

export interface ResumeExtractionResult {
  candidate: CandidateDraft
  profile: ResumeProfile
  education: EducationRecord[]
  experience: ExperienceRecord[]
  skills: NormalizedSkill[]
  languages: string[]
  certifications: string[]
  evidence: EvidenceItem[]
  warnings: string[]
  extractorVersion: string
}

export type RequirementKind =
  | 'skill'
  | 'experience'
  | 'education'
  | 'language'
  | 'location'
  | 'certification'
  | 'other'

export interface JobRequirement {
  id: EntityId
  label: string
  kind: RequirementKind
  keywords?: string[]
  minYears?: number
  weight?: number
  hard?: boolean
}

export interface JobRequirements {
  jobId?: EntityId
  title: string
  summary?: string
  requirements: JobRequirement[]
}

export interface RequirementAssessment {
  requirementId: EntityId
  label: string
  kind: RequirementKind
  hard: boolean
  matched: boolean
  score: number
  evidence: EvidenceItem[]
  rationale: string
}

export interface MatchDimensions {
  hardRequirement: number
  experience: number
  skills: number
  education: number
  potential: number
}

export type Recommendation = 'strong_match' | 'match' | 'needs_review' | 'weak_match'

export interface MatchAssessment {
  score: number
  recommendation: Recommendation
  dimensions: MatchDimensions
  matchedRequirements: RequirementAssessment[]
  conflicts: RequirementAssessment[]
  missingRequirements: RequirementAssessment[]
  strengths: string[]
  risks: string[]
  interviewQuestions: string[]
  confidence: number
  /** The result is advisory evidence for a human reviewer. */
  advisoryOnly: true
  /** Explicitly prevents this package from mutating an Application state. */
  applicationStatusMutation: 'none'
}

export interface AnalysisSubject {
  applicationId?: EntityId
  candidateId?: EntityId
  resumeId?: EntityId
  jobId?: EntityId
}

export type AnalysisEngine = 'deterministic-rules' | 'llm-suggestion'

export interface AnalysisProvenance {
  engine: AnalysisEngine
  parserVersion: string
  extractorVersion: string
  normalizerVersion: string
  matcherVersion: string
  scorerVersion: string
  promptVersion?: string
  modelProvider?: string
  modelName?: string
}

export type HumanReviewStatus = 'pending' | 'accepted' | 'needs_correction' | 'not_required'

export interface HumanReviewState {
  status: HumanReviewStatus
  reviewedBy?: EntityId
  reviewedAt?: ISODateTime
  comment?: string
}

export interface AnalysisSafety {
  advisoryOnly: true
  applicationStatusMutation: 'none'
  autoReject: false
  autoHire: false
  autoOffer: false
}

export interface AnalysisReport {
  reportId?: EntityId
  subject: AnalysisSubject
  parsedResume: ParsedResume
  extraction: ResumeExtractionResult
  assessment: MatchAssessment
  provenance: AnalysisProvenance
  humanReview: HumanReviewState
  safety: AnalysisSafety
  generatedAt?: ISODateTime
}

export interface AnonymizationReplacement {
  kind: 'email' | 'phone' | 'url' | 'name'
  token: string
  start: number
  end: number
  originalLength: number
}

export interface AnonymizedText {
  text: string
  replacements: AnonymizationReplacement[]
}

export interface AnonymizeOptions {
  name?: string
  replaceUrls?: boolean
  replaceNames?: boolean
}

export interface RequirementMatchResult {
  assessments: RequirementAssessment[]
  matchedKeywordCount: number
  totalKeywordCount: number
  matchedSkillCount: number
  totalSkillRequirementCount: number
}

export interface ScoreMatchInput {
  extraction: ResumeExtractionResult
  job: JobRequirements
  requirementMatches?: RequirementMatchResult
}

export interface BuildReportInput {
  parsedResume: ParsedResume
  extraction: ResumeExtractionResult
  assessment: MatchAssessment
  subject?: AnalysisSubject
  provenance?: Partial<AnalysisProvenance>
  humanReview?: Partial<HumanReviewState>
  generatedAt?: ISODateTime
}

export interface BuildRuleBasedReportInput {
  resume: ResumeTextInput
  job: JobRequirements
  subject?: AnalysisSubject
  generatedAt?: ISODateTime
}

export interface PromptInput {
  anonymizedResumeText: string
  job: JobRequirements
}
