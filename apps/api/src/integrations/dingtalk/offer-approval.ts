export interface OfferApprovalRoutingInput<T> {
  offerId: string
  action: string
  actorId: string
  offer: {
    positionTitle: string
    departmentId: string
    baseSalary: { amount: number; currency: string }
  }
  performLocalAction(): Promise<T>
  getCurrentInstanceId(): Promise<string>
  resolveOriginatorUserId(internalUserId: string): Promise<string>
  startExternalApproval(input: {
    internalInstanceId: string
    departmentId: string
    subjectType: 'offer'
    originatorUserId: string
    formValues: Array<{ name: string; value: string }>
  }): Promise<unknown>
  assertLocalDecisionAllowed(subjectType: string, subjectId: string): Promise<void>
}

export async function executeOfferApprovalAction<T>(input: OfferApprovalRoutingInput<T>): Promise<T> {
  if (input.action === 'approve' || input.action === 'reject') {
    await input.assertLocalDecisionAllowed('offer', input.offerId)
  }

  const originatorUserId = input.action === 'submit_approval'
    ? await input.resolveOriginatorUserId(input.actorId)
    : undefined
  const result = await input.performLocalAction()

  if (input.action === 'submit_approval') {
    await input.startExternalApproval({
      internalInstanceId: await input.getCurrentInstanceId(),
      departmentId: input.offer.departmentId,
      subjectType: 'offer',
      originatorUserId: originatorUserId!,
      formValues: [
        { name: '职位名称', value: input.offer.positionTitle },
        { name: '基本薪资', value: `${input.offer.baseSalary.amount} ${input.offer.baseSalary.currency}` },
      ],
    })
  }

  return result
}
