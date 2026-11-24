import type {
  AnalysisResultDTO,
  ApplicationDTO,
  ApiResponse,
  CandidateDTO,
  InterviewDTO,
  JobDTO,
  OfferDTO,
  RecruitmentRequestDTO,
  ResumeDTO,
} from '../src/index.js'
import {
  AnalysisResultStatus,
  ApplicationStatus,
  CandidateStatus,
  HumanReviewStatus,
  InterviewStatus,
  Recommendation,
  JobStatus,
  OfferStatus,
  RecruitmentRequestStatus,
  ResumeStatus,
  VirusScanStatus,
} from '../src/index.js'

const audit = {
  createdAt: '2026-09-08T00:00:00.000Z',
  createdBy: 'user-1',
  updatedAt: '2026-09-08T00:00:00.000Z',
  updatedBy: 'user-1',
  revision: 1,
}

const request: RecruitmentRequestDTO = {
  id: 'rr-1',
  ...audit,
  version: 1,
  versionId: 'rrv-1',
  isCurrentVersion: true,
  code: 'RR-001',
  title: 'Backend Engineer',
  departmentId: 'dept-1',
  requesterId: 'user-1',
  headcount: 1,
  employmentType: 'full_time',
  workMode: 'hybrid',
  justification: 'Team growth',
  status: RecruitmentRequestStatus.Draft,
}

const job: JobDTO = {
  id: 'job-1',
  ...audit,
  version: 1,
  versionId: 'jobv-1',
  isCurrentVersion: true,
  code: 'JOB-001',
  title: request.title,
  departmentId: request.departmentId,
  headcount: 1,
  filledCount: 0,
  employmentType: request.employmentType,
  workMode: request.workMode,
  status: JobStatus.Draft,
}

const candidate: CandidateDTO = {
  id: 'candidate-1',
  ...audit,
  version: 1,
  versionId: 'candidatev-1',
  isCurrentVersion: true,
  fullName: 'Test Candidate',
  status: CandidateStatus.Active,
  consentStatus: 'granted',
}

const application: ApplicationDTO = {
  id: 'application-1',
  ...audit,
  version: 1,
  versionId: 'applicationv-1',
  isCurrentVersion: true,
  candidateId: candidate.id,
  jobId: job.id,
  status: ApplicationStatus.Screening,
  appliedAt: '2026-09-08T00:00:00.000Z',
}

const resume: ResumeDTO = {
  id: 'resume-1',
  ...audit,
  version: 1,
  versionId: 'resumev-1',
  isCurrentVersion: true,
  candidateId: candidate.id,
  applicationId: application.id,
  file: {
    fileName: 'resume.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    storageKey: 'clean/resume-1.pdf',
    sha256: 'hash',
  },
  status: ResumeStatus.Clean,
  virusScanStatus: VirusScanStatus.Clean,
}

const analysis: AnalysisResultDTO = {
  id: 'analysis-1',
  ...audit,
  version: 1,
  versionId: 'analysisv-1',
  isCurrentVersion: true,
  taskId: 'task-1',
  resumeId: resume.id,
  applicationId: application.id,
  status: AnalysisResultStatus.Ready,
  extraction: {
    profile: {},
    education: [],
    experience: [],
    skills: [],
    evidence: [],
    warnings: [],
  },
  assessment: {
    score: 80,
    recommendation: Recommendation.Match,
    dimensions: { hardRequirement: 80, experience: 80, skills: 80 },
    matchedRequirements: [],
    conflicts: [],
    strengths: [],
    risks: [],
    interviewQuestions: [],
    confidence: 0.9,
  },
  modelProvider: 'openai-compatible',
  modelName: 'test-model',
  promptVersion: 'v1',
  parserVersion: 'v1',
  analyzerVersion: 'v1',
  inputHash: 'input-hash',
  humanReviewStatus: HumanReviewStatus.Pending,
}

const interview: InterviewDTO = {
  id: 'interview-1',
  ...audit,
  version: 1,
  versionId: 'interviewv-1',
  isCurrentVersion: true,
  applicationId: application.id,
  round: 1,
  type: 'technical',
  title: 'Technical interview',
  status: InterviewStatus.Planned,
  participants: [],
}

const offer: OfferDTO = {
  id: 'offer-1',
  ...audit,
  version: 1,
  versionId: 'offerv-1',
  isCurrentVersion: true,
  applicationId: application.id,
  status: OfferStatus.Draft,
}

const response: ApiResponse<ApplicationDTO> = {
  ok: true,
  data: application,
  requestId: 'request-1',
}

void [request, job, candidate, application, resume, analysis, interview, offer, response]



