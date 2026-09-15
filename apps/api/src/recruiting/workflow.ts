import type { JobRecord, RecruitmentRequestRecord } from './types.js'

export class RecruitingWorkflowError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message)
    this.name = 'RecruitingWorkflowError'
  }
}

export function requireReason(reason: unknown): string {
  if (typeof reason !== 'string' || !reason.trim()) throw new RecruitingWorkflowError('REASON_REQUIRED', '该操作必须填写原因', 400)
  return reason.trim()
}

export function transitionRequest(request: RecruitmentRequestRecord, action: string, reason?: unknown): void {
  const require = ['reject', 'withdraw', 'close', 'cancel'].includes(action)
  const normalizedReason = require ? requireReason(reason) : ''
  const from = request.status
  if (action === 'submit' || action === 'resubmit') {
    if (from !== 'draft' && from !== 'rejected') throw new RecruitingWorkflowError('RECRUITMENT_REQUEST_INVALID_TRANSITION', `需求状态 ${from} 不允许提交`)
    request.status = 'pending_approval'
    request.approval.status = 'pending'
  } else if (action === 'approve') {
    if (from !== 'pending_approval') throw new RecruitingWorkflowError('RECRUITMENT_REQUEST_INVALID_TRANSITION', `需求状态 ${from} 不允许审批`)
    request.status = 'approved'
    request.approval.status = 'approved'
    request.approval.actedAt = new Date().toISOString()
  } else if (action === 'reject') {
    if (from !== 'pending_approval') throw new RecruitingWorkflowError('RECRUITMENT_REQUEST_INVALID_TRANSITION', `需求状态 ${from} 不允许驳回`)
    request.status = 'rejected'
    request.approval.status = 'rejected'
    request.approval.comment = normalizedReason
    request.approval.actedAt = new Date().toISOString()
  } else if (action === 'withdraw') {
    if (!['draft', 'pending_approval', 'approved'].includes(from)) throw new RecruitingWorkflowError('RECRUITMENT_REQUEST_INVALID_TRANSITION', `需求状态 ${from} 不允许撤回`)
    request.status = 'withdrawn'
  } else if (action === 'close') {
    if (!['approved', 'converted', 'withdrawn'].includes(from)) throw new RecruitingWorkflowError('RECRUITMENT_REQUEST_INVALID_TRANSITION', `需求状态 ${from} 不允许关闭`)
    request.status = 'closed'
  } else if (action === 'cancel') {
    if (!['draft', 'pending_approval', 'rejected'].includes(from)) throw new RecruitingWorkflowError('RECRUITMENT_REQUEST_INVALID_TRANSITION', `需求状态 ${from} 不允许取消`)
    request.status = 'cancelled'
  } else if (action === 'convert') {
    if (from !== 'approved' || request.convertedJobIds.length === 0) throw new RecruitingWorkflowError('RECRUITMENT_REQUEST_NOT_CONVERTIBLE', '需求必须审批通过且已创建岗位')
    request.status = 'converted'
  } else {
    throw new RecruitingWorkflowError('UNKNOWN_WORKFLOW_ACTION', `不支持的需求动作：${action}`, 400)
  }
  request.version += 1
  request.updatedAt = new Date().toISOString()
}

export function assertJobPublishable(job: JobRecord, request: RecruitmentRequestRecord): void {
  if (request.status !== 'approved' && request.status !== 'converted') throw new RecruitingWorkflowError('RECRUITMENT_REQUEST_NOT_APPROVED', '只有审批通过的需求才能发布岗位')
  if (!job.spec?.confirmed || !job.jd?.confirmed) throw new RecruitingWorkflowError('JOB_DOCUMENT_NOT_CONFIRMED', '岗位说明书和 JD 必须确认后才能发布')
}

export function transitionJob(job: JobRecord, action: string, request: RecruitmentRequestRecord, reason?: unknown): void {
  const from = job.status
  const normalizedReason = ['pause', 'close'].includes(action) ? requireReason(reason) : ''
  if (action === 'publish') {
    if (from !== 'ready' && from !== 'draft') throw new RecruitingWorkflowError('JOB_INVALID_TRANSITION', `岗位状态 ${from} 不允许发布`)
    assertJobPublishable(job, request)
    job.status = 'published'
  } else if (action === 'pause') {
    if (from !== 'published') throw new RecruitingWorkflowError('JOB_INVALID_TRANSITION', `岗位状态 ${from} 不允许暂停`)
    job.status = 'paused'
  } else if (action === 'resume') {
    if (from !== 'paused') throw new RecruitingWorkflowError('JOB_INVALID_TRANSITION', `岗位状态 ${from} 不允许恢复`)
    job.status = 'published'
  } else if (action === 'close') {
    if (!['ready', 'published', 'paused'].includes(from)) throw new RecruitingWorkflowError('JOB_INVALID_TRANSITION', `岗位状态 ${from} 不允许关闭`)
    job.status = 'closed'
  } else if (action === 'confirm_spec') {
    if (!job.spec) throw new RecruitingWorkflowError('JOB_DOCUMENT_REQUIRED', '请先创建岗位说明书', 400)
    job.spec.confirmed = true; job.spec.confirmedAt = new Date().toISOString()
    if (job.jd?.confirmed) job.status = 'ready'
  } else if (action === 'confirm_jd') {
    if (!job.jd) throw new RecruitingWorkflowError('JOB_DOCUMENT_REQUIRED', '请先创建 JD', 400)
    job.jd.confirmed = true; job.jd.confirmedAt = new Date().toISOString()
    if (job.spec?.confirmed) job.status = 'ready'
  } else {
    throw new RecruitingWorkflowError('UNKNOWN_WORKFLOW_ACTION', `不支持的岗位动作：${action}`, 400)
  }
  void normalizedReason
  job.version += 1
  job.updatedAt = new Date().toISOString()
}
