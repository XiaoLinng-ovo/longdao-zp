import type { ApplicationRecord, OfferRecord } from './types.js'
import { RecruitingWorkflowError, requireReason } from './workflow.js'

export type OfferWorkflowAction = 'send' | 'resend' | 'resend_cancelled' | 'accept' | 'decline' | 'cancel' | 'expire'

export interface OfferWorkflowTransition {
  fromOfferStatus: OfferRecord['status']
  offerStatus: OfferRecord['status']
  applicationStatus: ApplicationRecord['status']
  reason?: string
}

const allowedSourceStatuses: Record<OfferWorkflowAction, readonly string[]> = {
  send: ['draft', 'pending_approval', 'approved'],
  resend: ['sent'],
  resend_cancelled: ['cancelled'],
  accept: ['sent'],
  decline: ['sent'],
  expire: ['sent'],
  cancel: ['draft', 'pending_approval', 'approved', 'sent'],
}

const targetStatuses: Record<OfferWorkflowAction, { offer: OfferRecord['status']; application: ApplicationRecord['status'] }> = {
  send: { offer: 'sent', application: 'offer_sent' },
  resend: { offer: 'sent', application: 'offer_sent' },
  resend_cancelled: { offer: 'sent', application: 'offer_sent' },
  accept: { offer: 'accepted', application: 'offer_accepted' },
  decline: { offer: 'declined', application: 'offer_declined' },
  cancel: { offer: 'cancelled', application: 'offer_cancelled' },
  expire: { offer: 'expired', application: 'offer_expired' },
}

export function transitionOfferWorkflow(offerStatus: string, action: string, reason?: unknown): OfferWorkflowTransition {
  if (!(action in allowedSourceStatuses)) {
    throw new RecruitingWorkflowError('UNKNOWN_WORKFLOW_ACTION', `不支持的 Offer 动作：${action}`, 400)
  }
  const normalizedAction = action as OfferWorkflowAction
  if (!allowedSourceStatuses[normalizedAction].includes(offerStatus)) {
    throw new RecruitingWorkflowError('OFFER_INVALID_TRANSITION', `Offer 状态 ${offerStatus} 不允许执行 ${normalizedAction}`)
  }
  return {
    fromOfferStatus: offerStatus as OfferRecord['status'],
    offerStatus: targetStatuses[normalizedAction].offer,
    applicationStatus: targetStatuses[normalizedAction].application,
    ...(normalizedAction === 'decline' || normalizedAction === 'cancel' ? { reason: requireReason(reason) } : {}),
  }
}
