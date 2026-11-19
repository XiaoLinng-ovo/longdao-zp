import type { ApplicationRecord, RecruitingStoreState } from './types.js'

// Completion is not a pass: an explicit human decision is required.
export const OFFER_ELIGIBILITY_SQL = `a.status IN ('interviewing', 'offer_approval', 'offer_cancelled')
  AND NOT EXISTS (SELECT 1 FROM offers o
    WHERE o.application_id = a.id AND o.organization_id = a.organization_id AND o.status <> 'cancelled')
  AND (a.status <> 'offer_cancelled' OR EXISTS (
    SELECT 1 FROM offers cancelled_offer
    JOIN workflow_events e ON e.subject_type = 'offer' AND e.subject_id = cancelled_offer.id
      AND e.organization_id = a.organization_id
      AND e.to_status = 'cancelled' AND e.event_type = 'cancel'
    WHERE cancelled_offer.application_id = a.id
      AND cancelled_offer.organization_id = a.organization_id
      AND cancelled_offer.status = 'cancelled'
      AND e.id = (SELECT latest.id FROM workflow_events latest
        JOIN offers latest_offer ON latest_offer.id = latest.subject_id
        WHERE latest.subject_type = 'offer' AND latest.organization_id = a.organization_id
          AND latest_offer.application_id = a.id AND latest_offer.organization_id = a.organization_id
        ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
  ))
  AND EXISTS (SELECT 1 FROM interviews i WHERE i.application_id = a.id
    AND i.organization_id = a.organization_id AND i.round = 2 AND i.stage = 'final'
    AND i.status <> 'cancelled')
  AND (EXISTS (SELECT 1 FROM interview_stage_reviews r WHERE r.application_id = a.id
    AND r.organization_id = a.organization_id AND r.stage = 'final' AND r.decision = 'hired')
    OR (NOT EXISTS (SELECT 1 FROM interview_stage_reviews r WHERE r.application_id = a.id
      AND r.organization_id = a.organization_id AND r.stage = 'final')
      AND EXISTS (SELECT 1 FROM interviews i
        WHERE i.application_id = a.id AND i.organization_id = a.organization_id
          AND i.round = 2 AND i.stage = 'final' AND i.status = 'completed'
          AND (SELECT e.metadata->>'outcome' FROM workflow_events e WHERE e.subject_id = i.id
            AND e.organization_id = i.organization_id AND e.subject_type = 'interview'
            AND e.event_type = 'conclude' ORDER BY e.created_at DESC, e.id DESC LIMIT 1) = 'offer')))`

export function isLocalOfferEligible(application: ApplicationRecord, state: RecruitingStoreState): boolean {
  const offers = state.offers.filter(offer => offer.applicationId === application.id)
  const latestOfferEvent = state.workflowEvents
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.subjectType === 'offer' && offers.some(offer => offer.id === event.subjectId))
    // Local events are appended in transaction order; UUIDs do not encode time.
    .sort((left, right) => left.event.createdAt.localeCompare(right.event.createdAt) || left.index - right.index)
    .at(-1)?.event
  const cancelledApplicationIsCurrent = application.status !== 'offer_cancelled'
    || (latestOfferEvent?.action === 'cancel' && latestOfferEvent.toStatus === 'cancelled')

  return ['interviewing', 'offer_approval', 'offer_cancelled'].includes(application.status)
    && !offers.some(offer => offer.status !== 'cancelled')
    && cancelledApplicationIsCurrent
    && state.interviews.some(interview => interview.applicationId === application.id
      && interview.round === 2 && interview.status === 'completed'
      && state.workflowEvents.filter(event => event.subjectType === 'interview'
        && event.subjectId === interview.id && event.action === 'conclude')
        .at(-1)?.metadata?.outcome === 'offer')
}
