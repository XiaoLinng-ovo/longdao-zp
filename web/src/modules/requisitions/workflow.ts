import type { RequisitionAction } from './api'
import type { ApiRequisition } from './api'

export const REQ_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  pending_approval: '待审批',
  approved: '已通过',
  rejected: '已驳回',
  withdrawn: '已撤回',
  converted: '已转岗位',
  closed: '已关闭',
  cancelled: '已取消',
}

export const REQ_ACTION_LABEL: Record<RequisitionAction, string> = {
  submit: '提交审批',
  resubmit: '重新提交',
  approve: '审批通过',
  reject: '驳回',
  withdraw: '撤回',
  close: '关闭',
  cancel: '取消',
  convert: '转换为岗位',
}

export const REQ_ACTION_HINT: Record<RequisitionAction, string> = {
  submit: '将生成审批实例并通知当前审批人处理。',
  resubmit: '重新提交会重建审批实例，保留旧审批记录。',
  approve: '当前审批步骤通过后，状态将变为已通过。',
  reject: '驳回后需求返回待修正状态，需补充原因。',
  withdraw: '撤回后需求进入已撤回状态，不可再继续流程。',
  close: '关闭需求并归档当前编制申请。',
  cancel: '取消需求后流程终止，仅草稿/待审批/已驳回可取消。',
  convert: '将已通过需求转换为招聘岗位，进入岗位管理。',
}

export const REQ_REASON_REQUIRED: RequisitionAction[] = ['reject', 'withdraw', 'close', 'cancel']

export function requisitionStatusLabel(status: string): string {
  return REQ_STATUS_LABEL[status] ?? status
}

export function validateRequisitionForm(form: Record<string, unknown>): string {
  const title = typeof form.title === 'string' ? form.title.trim() : ''
  const departmentId = typeof form.departmentId === 'string' ? form.departmentId.trim() : ''
  const headcount = Number(form.headcount)
  const employmentType = typeof form.employmentType === 'string' ? form.employmentType.trim() : ''
  const workMode = typeof form.workMode === 'string' ? form.workMode.trim() : ''
  const justification = typeof form.justification === 'string' ? form.justification.trim() : ''
  if (!title) return '请填写岗位名称'
  if (!departmentId) return '请填写部门'
  if (!Number.isInteger(headcount) || headcount < 1) return '招聘人数必须大于 0'
  if (!employmentType) return '请选择用工类型'
  if (!workMode) return '请选择工作模式'
  if (!justification) return '请填写招聘理由'
  return ''
}

export function requisitionActionsFor(status: string): RequisitionAction[] {
  switch (status) {
    case 'draft':
      return ['submit', 'cancel']
    case 'pending_approval':
      return ['approve', 'reject', 'withdraw']
    case 'rejected':
      return ['resubmit', 'cancel']
    case 'approved':
      return ['withdraw', 'close']
    case 'converted':
      return ['close']
    case 'withdrawn':
      return ['close']
    default:
      return []
  }
}

export function describeApproval(request: ApiRequisition | null): { approver: string; status: string; history: Array<{ actedAt?: string; status?: string; approver?: string; comment?: string }> } {
  if (!request) return { approver: '待指定', status: 'unknown', history: [] }
  const approval = request.approval
  return {
    approver: approval?.approver?.trim() || '待指定',
    status: approval?.status || 'pending',
    history: approval?.actedAt ? [{ actedAt: approval.actedAt, status: approval.status, approver: approval.approver, comment: approval.comment }] : [],
  }
}

export function conversionHint(request: ApiRequisition | null): string {
  if (!request) return ''
  if (request.status === 'approved') return '该需求已通过审批，可继续创建关联岗位后执行转换。'
  if (request.convertedJobIds && request.convertedJobIds.length) return `该需求已生成 ${request.convertedJobIds.length} 个关联岗位，可执行转换。`
  if (request.status === 'converted') return '该需求已转换为岗位，无需重复转换。'
  return ''
}
