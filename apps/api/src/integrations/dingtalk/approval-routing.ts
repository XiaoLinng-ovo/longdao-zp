export interface RecruitmentApprovalRoutingInput<T> {
  requestId: string
  action: string
  actorId: string
  request: {
    title: string
    departmentId: string
    headcount: number
    salaryRange?: { min?: { amount: number; currency?: string }; max?: { amount: number; currency?: string } } | undefined
    justification?: string
  }
  performLocalAction(): Promise<T>
  getCurrentInstanceId(): Promise<string>
  resolveOriginatorUserId(internalUserId: string): Promise<string>
  startExternalApproval(input: {
    internalInstanceId: string
    departmentId: string
    originatorUserId: string
    formValues: Array<{ name: string; value: string }>
  }): Promise<unknown>
  assertLocalDecisionAllowed(subjectType: string, subjectId: string): Promise<void>
}

export interface PlatformRecruitmentApprovalInput<T> {
  requestId: string
  action: string
  performLocalAction(): Promise<T>
  assertLocalDecisionAllowed?(subjectType: string, subjectId: string): Promise<void>
}

function formatSalaryRange(salaryRange: RecruitmentApprovalRoutingInput<unknown>['request']['salaryRange']): string {
  const min = salaryRange?.min?.amount
  const max = salaryRange?.max?.amount
  const currency = salaryRange?.min?.currency ?? salaryRange?.max?.currency ?? ''
  const suffix = currency ? ` ${currency}` : ''
  if (min !== undefined && max !== undefined) return `${min} - ${max}${suffix}`
  if (min !== undefined) return `${min}${suffix}`
  if (max !== undefined) return `${max}${suffix}`
  return '未填写'
}

/**
 * 将平台招聘需求转换为钉钉审批模板「招聘需求」的字段名。
 * 部门字段的真实钉钉 ID 由 approval-workflow 根据部门审批策略注入，避免把平台 UUID 传给钉钉。
 */
function buildDingTalkFormValues(request: RecruitmentApprovalRoutingInput<unknown>['request']): Array<{ name: string; value: string }> {
  const justification = request.justification?.trim() || '未填写'
  return [
    { name: '需求岗位', value: request.title },
    { name: '需求人数', value: String(request.headcount) },
    { name: '岗位职责', value: justification },
    { name: '任职要求', value: justification },
    { name: '薪资水平', value: formatSalaryRange(request.salaryRange) },
  ]
}

export async function executeRecruitmentApprovalAction<T>(input: RecruitmentApprovalRoutingInput<T>): Promise<T> {
  if (input.action === 'approve' || input.action === 'reject' || input.action === 'withdraw' || input.action === 'cancel') {
    await input.assertLocalDecisionAllowed('recruitment_request', input.requestId)
  }
  const originatorUserId = input.action === 'submit' || input.action === 'resubmit'
    ? await input.resolveOriginatorUserId(input.actorId)
    : undefined
  const result = await input.performLocalAction()
  if (input.action === 'submit' || input.action === 'resubmit') {
    const internalInstanceId = await input.getCurrentInstanceId()
    await input.startExternalApproval({
      internalInstanceId,
      departmentId: input.request.departmentId,
      originatorUserId: originatorUserId!,
      formValues: buildDingTalkFormValues(input.request),
    })
  }
  return result
}


/** Run a request entirely in the platform; no DingTalk identity mapping is needed. */
export async function executePlatformRecruitmentApprovalAction<T>(input: PlatformRecruitmentApprovalInput<T>): Promise<T> {
  if (input.action === 'approve' || input.action === 'reject' || input.action === 'withdraw' || input.action === 'cancel') {
    // Keep the cross-provider safety check: an already-running external approval
    // must not also be decided locally, even after the enterprise changes its mode.
    await input.assertLocalDecisionAllowed?.('recruitment_request', input.requestId)
  }
  return input.performLocalAction()
}
