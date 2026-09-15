import type { Money } from './common.js'
import { JobStatus, RecruitmentRequestStatus } from './status.js'
import type { EmploymentType, WorkMode } from './recruitment.js'

export type RecruitmentRequestAction =
  | 'submit'
  | 'approve'
  | 'reject'
  | 'withdraw'
  | 'resubmit'
  | 'convert'
  | 'close'
  | 'cancel'

export type JobAction =
  | 'confirm_spec'
  | 'confirm_jd'
  | 'publish'
  | 'pause'
  | 'resume'
  | 'close'

export type WorkflowErrorCode =
  | 'INVALID_TRANSITION'
  | 'REASON_REQUIRED'
  | 'PRECONDITION_FAILED'

export interface ActionCommandInput {
  reason?: string
  comment?: string
}

export interface CreateRecruitmentRequestInput {
  title: string
  departmentId: string
  hiringManagerId?: string
  headcount: number
  employmentType: EmploymentType
  workMode: WorkMode
  location?: string
  salaryRange?: { min?: Money; max?: Money }
  justification: string
}

/** Only draft business fields can be edited; status and audit fields are excluded. */
export type UpdateRecruitmentRequestInput = Partial<CreateRecruitmentRequestInput>

export interface CreateJobInput {
  title: string
  departmentId: string
  hiringManagerId?: string
  recruitmentRequestId: string
  headcount: number
  employmentType: EmploymentType
  workMode: WorkMode
  location?: string
}

export type UpdateJobInput = Partial<Omit<CreateJobInput, 'recruitmentRequestId'>>

export interface CreateJobSpecInput {
  title: string
  summary: string
  responsibilities: string[]
  requirements: Array<{
    label: string
    description: string
    required: boolean
    weight?: number
  }>
  skills: string[]
  education?: string[]
  experienceYears?: { min?: number; max?: number }
}

export interface CreateJobDescriptionInput {
  language: string
  content: string
  generatedBy?: 'human' | 'ai_assisted'
}

export interface ValidationIssue {
  field: string
  message: string
}

export function validateCreateRecruitmentRequest(input: CreateRecruitmentRequestInput): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!input.title.trim()) issues.push({ field: 'title', message: '岗位名称不能为空' })
  if (!input.departmentId.trim()) issues.push({ field: 'departmentId', message: '部门不能为空' })
  if (!Number.isInteger(input.headcount) || input.headcount < 1) {
    issues.push({ field: 'headcount', message: '招聘人数必须是大于 0 的整数' })
  }
  if (!input.justification.trim()) issues.push({ field: 'justification', message: '招聘理由不能为空' })
  if (input.salaryRange?.min && input.salaryRange.max && input.salaryRange.min.amount > input.salaryRange.max.amount) {
    issues.push({ field: 'salaryRange', message: '预算下限不能高于预算上限' })
  }
  return issues
}

export function validateCreateJob(input: CreateJobInput): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!input.title.trim()) issues.push({ field: 'title', message: '岗位名称不能为空' })
  if (!input.departmentId.trim()) issues.push({ field: 'departmentId', message: '部门不能为空' })
  if (!input.recruitmentRequestId.trim()) issues.push({ field: 'recruitmentRequestId', message: '招聘需求不能为空' })
  if (!Number.isInteger(input.headcount) || input.headcount < 1) {
    issues.push({ field: 'headcount', message: '岗位人数必须是大于 0 的整数' })
  }
  return issues
}

export class WorkflowTransitionError extends Error {
  readonly code: WorkflowErrorCode
  readonly from: string
  readonly action: string

  constructor(code: WorkflowErrorCode, from: string, action: string, message: string) {
    super(message)
    this.name = 'WorkflowTransitionError'
    this.code = code
    this.from = from
    this.action = action
  }
}

export interface RecruitmentRequestTransitionContext {
  reason?: string
  hasApprovalInstance?: boolean
  approvalComplete?: boolean
  hasConvertedJob?: boolean
}

export interface JobTransitionContext {
  specConfirmed?: boolean
  jdConfirmed?: boolean
  recruitmentRequestApproved?: boolean
}

const reasonRequiredActions = new Set<RecruitmentRequestAction>(['reject', 'withdraw', 'close', 'cancel'])

function requireReason(action: RecruitmentRequestAction, reason: string | undefined): void {
  if (reasonRequiredActions.has(action) && !reason?.trim()) {
    throw new WorkflowTransitionError('REASON_REQUIRED', '', action, `动作 ${action} 必须填写原因`)
  }
}

function invalidRequestTransition(status: RecruitmentRequestStatus, action: RecruitmentRequestAction): never {
  throw new WorkflowTransitionError(
    'INVALID_TRANSITION',
    status,
    action,
    `招聘需求状态 ${status} 不允许执行动作 ${action}`
  )
}

/**
 * Centralizes request lifecycle rules. Persistence, permissions, locking, and
 * audit events remain the responsibility of the application service.
 */
export function transitionRecruitmentRequest(
  status: RecruitmentRequestStatus,
  action: RecruitmentRequestAction,
  context: RecruitmentRequestTransitionContext = {}
): RecruitmentRequestStatus {
  requireReason(action, context.reason)

  switch (action) {
    case 'submit':
    case 'resubmit':
      if (status === RecruitmentRequestStatus.Draft || status === RecruitmentRequestStatus.Rejected) {
        return RecruitmentRequestStatus.PendingApproval
      }
      return invalidRequestTransition(status, action)
    case 'approve':
      if (status === RecruitmentRequestStatus.PendingApproval && context.approvalComplete !== false) {
        return RecruitmentRequestStatus.Approved
      }
      return invalidRequestTransition(status, action)
    case 'reject':
      if (status === RecruitmentRequestStatus.PendingApproval) {
        return RecruitmentRequestStatus.Rejected
      }
      return invalidRequestTransition(status, action)
    case 'withdraw':
      if (
        status === RecruitmentRequestStatus.Draft ||
        status === RecruitmentRequestStatus.PendingApproval ||
        status === RecruitmentRequestStatus.Approved
      ) {
        return RecruitmentRequestStatus.Withdrawn
      }
      return invalidRequestTransition(status, action)
    case 'convert':
      if (status === RecruitmentRequestStatus.Approved && context.hasConvertedJob) {
        return RecruitmentRequestStatus.Converted
      }
      throw new WorkflowTransitionError(
        'PRECONDITION_FAILED',
        status,
        action,
        '招聘需求必须已通过审批，且至少关联一个已创建岗位后才能标记为已转换'
      )
    case 'close':
      if (
        status === RecruitmentRequestStatus.Approved ||
        status === RecruitmentRequestStatus.Converted ||
        status === RecruitmentRequestStatus.Withdrawn
      ) {
        return RecruitmentRequestStatus.Closed
      }
      return invalidRequestTransition(status, action)
    case 'cancel':
      if (
        status === RecruitmentRequestStatus.Draft ||
        status === RecruitmentRequestStatus.PendingApproval ||
        status === RecruitmentRequestStatus.Rejected
      ) {
        return RecruitmentRequestStatus.Cancelled
      }
      return invalidRequestTransition(status, action)
  }
}

function invalidJobTransition(status: JobStatus, action: JobAction): never {
  throw new WorkflowTransitionError('INVALID_TRANSITION', status, action, `岗位状态 ${status} 不允许执行动作 ${action}`)
}

function requireJobPrecondition(condition: boolean, action: JobAction, message: string): void {
  if (!condition) {
    throw new WorkflowTransitionError('PRECONDITION_FAILED', '', action, message)
  }
}

/**
 * JD/spec confirmation is modeled as a pair of idempotent document actions.
 * The job becomes ready only after both current versions are confirmed.
 */
export function transitionJob(
  status: JobStatus,
  action: JobAction,
  context: JobTransitionContext = {}
): JobStatus {
  switch (action) {
    case 'confirm_spec':
      if (status === JobStatus.Draft || status === JobStatus.Ready) {
        return context.jdConfirmed ? JobStatus.Ready : status
      }
      return invalidJobTransition(status, action)
    case 'confirm_jd':
      if (status === JobStatus.Draft || status === JobStatus.Ready) {
        return context.specConfirmed ? JobStatus.Ready : status
      }
      return invalidJobTransition(status, action)
    case 'publish':
      if (status !== JobStatus.Ready) {
        return invalidJobTransition(status, action)
      }
      requireJobPrecondition(
        context.specConfirmed === true && context.jdConfirmed === true,
        action,
        '岗位发布前必须确认当前岗位说明书和 JD 版本'
      )
      requireJobPrecondition(
        context.recruitmentRequestApproved === true,
        action,
        '岗位发布前必须关联已通过审批的招聘需求'
      )
      return JobStatus.Published
    case 'pause':
      if (status === JobStatus.Published) return JobStatus.Paused
      return invalidJobTransition(status, action)
    case 'resume':
      if (status === JobStatus.Paused) return JobStatus.Published
      return invalidJobTransition(status, action)
    case 'close':
      if (status === JobStatus.Published || status === JobStatus.Paused || status === JobStatus.Ready) {
        return JobStatus.Closed
      }
      return invalidJobTransition(status, action)
  }
}

export function assertJobCanBeCreatedFromRequest(
  requestStatus: RecruitmentRequestStatus,
  action: 'create_job' = 'create_job'
): void {
  if (requestStatus !== RecruitmentRequestStatus.Approved && requestStatus !== RecruitmentRequestStatus.Converted) {
    throw new WorkflowTransitionError('PRECONDITION_FAILED', requestStatus, action, '只有已通过审批的招聘需求才能创建岗位')
  }
}
