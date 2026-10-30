import type { ApplicationRecord } from './types.js'

/** Cancelled interviews do not block scheduling a replacement. */
export function interviewProgressByApplication(interviews: Array<{
  id: string; applicationId: string; round: number; stage?: 'initial' | 'final'
  status: string; scheduledStartAt?: string | null; createdAt: string
}>): Map<string, NonNullable<ApplicationRecord['interviewProgress']>> {
  const progress = new Map<string, NonNullable<ApplicationRecord['interviewProgress']>>()
  const ordered = [...interviews].sort((a, b) => b.round - a.round || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  for (const interview of ordered) {
    if (progress.has(interview.applicationId) || !['scheduled', 'completed'].includes(interview.status)) continue
    progress.set(interview.applicationId, {
      id: interview.id, round: interview.round,
      stage: interview.stage ?? (interview.round >= 2 ? 'final' : 'initial'),
      status: interview.status as 'scheduled' | 'completed',
      ...(interview.scheduledStartAt ? { scheduledStartAt: interview.scheduledStartAt } : {}),
    })
  }
  return progress
}
