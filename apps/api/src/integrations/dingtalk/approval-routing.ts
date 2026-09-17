export interface RecruitmentApprovalRoutingInput<T> {
  requestId: string
  action: string
  actorId: string
  request: { title: string; departmentId: string; headcount: number }
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

export async function executeRecruitmentApprovalAction<T>(input: RecruitmentApprovalRoutingInput<T>): Promise<T> {
  if (input.action === 'approve' || input.action === 'reject') {
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
      formValues: [
        { name: '岗位名称', value: input.request.title },
        { name: '招聘人数', value: String(input.request.headcount) },
      ],
    })
  }
  return result
}
