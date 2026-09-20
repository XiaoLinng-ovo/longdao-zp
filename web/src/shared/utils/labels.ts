/**
 * 后端枚举码 → 界面中文文案。
 * 流程审计、状态标签与基础信息展示共用这一份字典，避免各处显示原始英文码。
 */

export const STATUS_LABEL: Record<string, string> = {
  active: '进行中', pending: '待处理', approved: '已通过', rejected: '已拒绝', draft: '草稿',
  scheduled: '已安排', completed: '已完成', sent: '已发送', accepted: '已接受', declined: '已拒绝',
  published: '已发布', paused: '已暂停', configured: '已配置', disabled: '未配置', pending_approval: '待审批',
  withdrawn: '已撤回', closed: '已关闭', cancelled: '已取消', ready: '待发布', converted: '已转岗位',
  pending_analysis: '待分析', analysis_queued: '分析排队中', human_review: '人工复核', interviewing: '面试中',
  offer_approval: 'Offer 审批中', offer_sent: 'Offer 已发送', offer_accepted: 'Offer 已接受', onboarding_archived: '已入职归档',
  offer_declined: 'Offer 已拒绝', offer_cancelled: 'Offer 已取消', offer_expired: 'Offer 已过期', expired: '已过期', interview: '面试中',
  not_required: '无需复核', in_progress: '复核中', needs_correction: '需修正',
}

export const ACTION_LABEL: Record<string, string> = {
  create: '创建', update: '更新', revise: '修订', status_changed: '变更申请状态',
  submit: '提交审批', submit_approval: '提交审批', resubmit: '重新提交', approve: '审批通过', reject: '审批驳回', withdraw: '撤回',
  request_submitted: '提交审批', request_approved: '审批通过', request_rejected: '审批驳回', converted: '转为岗位', convert: '转为岗位',
  approval_instance_created: '生成审批实例',
  create_job: '新建岗位', job_created: '新建岗位', update_job: '更新岗位', spec_created: '新建说明书', jd_created: '新建 JD',
  confirm_spec: '确认说明书', spec_confirmed: '确认说明书', confirm_jd: '确认 JD', jd_confirmed: '确认 JD',
  published_job_requires_reconfirmation: '发布岗位需重新确认',
  publish: '发布', pause: '暂停', resume: '恢复', close: '关闭', cancel: '取消',
  send: '发送', accept: '接受', decline: '拒绝', expire: '过期',
  archive_onboarding: '入职归档', schedule: '安排入职', complete: '完成入职',
  feedback_submitted: '提交反馈', feedback_locked: '锁定反馈', conclude: '面试结论',
  'admin.user.update': '修改用户', 'admin.role.update': '修改角色',
  'admin.department.create': '新建部门', 'admin.department.update': '修改部门', 'admin.department.delete': '删除部门',
  'admin.settings.update': '修改系统设置', 'admin.dingtalk_settings.update': '修改钉钉配置',
  'admin.resume_virus_scan.update': '修改简历扫描设置',
  'admin.ai_settings.update': '修改模型配置',
}

/** 用工类型：后端 full_time / part_time / internship */
export const EMPLOYMENT_TYPE_LABEL: Record<string, string> = {
  full_time: '全职', part_time: '兼职', internship: '实习',
}

/** 工作模式：后端 onsite / hybrid / remote */
export const WORK_MODE_LABEL: Record<string, string> = {
  onsite: '现场办公', hybrid: '混合办公', remote: '远程',
}

export function statusLabel(status?: string): string {
  if (!status) return '-'
  return STATUS_LABEL[status] ?? status
}

export function actionLabel(action?: string): string {
  if (!action) return '-'
  return ACTION_LABEL[action] ?? action
}

export function employmentTypeLabel(value?: string): string {
  if (!value) return '-'
  return EMPLOYMENT_TYPE_LABEL[value] ?? value
}

export function workModeLabel(value?: string): string {
  if (!value) return '-'
  return WORK_MODE_LABEL[value] ?? value
}

/** 申请下拉项：展示候选人姓名与岗位名称，不暴露内部编码。 */
export function applicationOptionLabel(app: {
  id: string
  code?: string
  candidateId?: string
  jobId?: string
  candidateName?: string
  jobTitle?: string
}): string {
  const subject = [app.candidateName?.trim() || app.candidateId?.trim(), app.jobTitle?.trim() || app.jobId?.trim()].filter(Boolean).join(' · ')
  return subject || app.code?.trim() || app.id
}
