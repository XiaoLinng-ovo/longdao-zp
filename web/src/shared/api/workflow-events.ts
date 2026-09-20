import { apiClient } from './index'

export type WorkflowEventSubjectType = 'recruitment_request' | 'job' | 'offer' | 'onboarding' | 'candidate' | 'application' | 'interview'

export interface WorkflowEvent {
  id: string
  subjectType: WorkflowEventSubjectType
  subjectId: string
  subjectLabel: string
  action: string
  fromStatus?: string
  toStatus?: string
  actorId: string
  actorName?: string
  reason?: string
  createdAt: string
}

export async function loadWorkflowEvents(subjectType?: WorkflowEventSubjectType, limit = 50): Promise<WorkflowEvent[]> {
  const params = new URLSearchParams()
  if (subjectType) params.set('subjectType', subjectType)
  params.set('limit', String(limit))
  return (await apiClient.getJson<WorkflowEvent[]>(`/workflow-events?${params.toString()}`)).data
}

