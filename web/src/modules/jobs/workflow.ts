import type { JobAction } from './api'
import { externalJobPublishingEnabled } from '../../shared/config/features'

export const JOB_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  ready: '待发布',
  published: '已发布',
  paused: '已暂停',
  closed: '已关闭',
}

export const JOB_ACTION_LABEL: Record<JobAction, string> = {
  'confirm-spec': '确认说明书',
  'confirm-jd': '确认 JD',
  publish: '发布',
  pause: '暂停',
  resume: '恢复',
  close: '关闭',
}

export const JOB_ACTION_HINT: Record<JobAction, string> = {
  'confirm-spec': '确认后将锁定当前说明书版本。',
  'confirm-jd': '确认后将锁定当前 JD 版本。',
  publish: '发布前需确认岗位说明书和 JD；如保留历史需求关联，该需求也需审批通过。',
  pause: '暂停发布并说明原因。',
  resume: '恢复岗位到已发布状态。',
  close: '关闭后岗位进入归档状态。',
}

export const JOB_REASON_REQUIRED: JobAction[] = ['pause', 'close']

export function jobStatusLabel(status: string): string {
  return JOB_STATUS_LABEL[status] ?? status
}

export function jobActionsFor(job: { status: string; spec?: { confirmed?: boolean }; jd?: { confirmed?: boolean } }): JobAction[] {
  const actions: JobAction[] = []
  if (job.spec && !job.spec.confirmed) actions.push('confirm-spec')
  if (job.jd && !job.jd.confirmed) actions.push('confirm-jd')
  if (job.status === 'draft' || job.status === 'ready') actions.push('publish')
  if (job.status === 'published') actions.push('pause')
  if (job.status === 'paused') actions.push('resume')
  if (['ready', 'published', 'paused'].includes(job.status)) actions.push('close')
  return actions
}

export function isJobActionVisible(action: JobAction): boolean {
  return externalJobPublishingEnabled || !['publish', 'pause', 'resume', 'close'].includes(action)
}

export function visibleJobActionsFor(job: Parameters<typeof jobActionsFor>[0]): JobAction[] {
  return jobActionsFor(job).filter(isJobActionVisible)
}

export function jobPublishHint(job: { status: string; recruitmentRequestId?: string; spec?: { confirmed?: boolean }; jd?: { confirmed?: boolean } }): string {
  if (job.status === 'closed') return '已关闭岗位不能发布。'
  if (!job.spec?.confirmed) return '岗位说明书尚未确认，请先在详情页确认说明书。'
  if (!job.jd?.confirmed) return 'JD 尚未确认，请先在详情页确认 JD。'
  return job.recruitmentRequestId ? '说明书和 JD 已就绪；历史关联需求需审批通过后发布。' : '说明书和 JD 已就绪，可发布岗位。'
}

export function editableFieldsForStatus(status: string): string[] {
  if (status === 'draft' || status === 'ready') return ['title', 'departmentId', 'hiringManagerId', 'employmentType', 'workMode', 'location']
  return ['title', 'departmentId', 'hiringManagerId', 'employmentType', 'workMode', 'location', 'headcount']
}

export function validateJobForm(form: Record<string, unknown>): string {
  const title = typeof form.title === 'string' ? form.title.trim() : ''
  const departmentId = typeof form.departmentId === 'string' ? form.departmentId.trim() : ''
  const headcount = Number(form.headcount)
  const employmentType = typeof form.employmentType === 'string' ? form.employmentType.trim() : ''
  const workMode = typeof form.workMode === 'string' ? form.workMode.trim() : ''
  if (!title) return '请填写岗位名称'
  if (!departmentId) return '请填写部门'
  if (!Number.isInteger(headcount) || headcount < 1) return '招聘人数必须大于 0'
  if (!employmentType) return '请选择用工类型'
  if (!workMode) return '请选择工作模式'
  return ''
}
