import type { ApplicationRecord, RecruitingStoreState } from './types.js'

// Completion is not a pass: an explicit human decision is required.
export const OFFER_ELIGIBILITY_SQL = `a.status IN ('interviewing', 'offer_approval')
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
  return ['interviewing', 'offer_approval'].includes(application.status)
    && state.interviews.some(interview => interview.applicationId === application.id
      && interview.round === 2 && interview.status === 'completed'
      && state.workflowEvents.filter(event => event.subjectType === 'interview'
        && event.subjectId === interview.id && event.action === 'conclude')
        .at(-1)?.metadata?.outcome === 'offer')
}
