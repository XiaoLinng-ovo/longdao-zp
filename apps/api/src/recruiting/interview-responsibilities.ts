import { RecruitingWorkflowError } from './workflow.js'

export const INTERVIEW_SHEET_TYPES = ['hr_screen', 'hiring_department', 'business', 'hr', 'boss'] as const
export type AssignedSheetType = typeof INTERVIEW_SHEET_TYPES[number]
export interface AssignedParticipant {
  userId: string
  name?: string
  role: 'interviewer' | 'coordinator' | 'observer'
  required: boolean
  lead?: boolean
  sheetTypes?: AssignedSheetType[]
}
const fail = (message: string): never => { throw new RecruitingWorkflowError('VALIDATION_ERROR', message, 400) }
export function normalizeInterviewParticipants(value: unknown, stage?: 'initial' | 'final'): AssignedParticipant[] {
  if (!Array.isArray(value) || value.length > 100) fail('面试官列表无效')
  const users = new Set<string>(), sheets = new Set<string>()
  const participants = (value as unknown[]).map((item): AssignedParticipant => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('面试官信息无效')
    const input = item as Record<string, unknown>
    if (Object.keys(input).some(key => !['userId', 'name', 'role', 'required', 'lead', 'sheetTypes'].includes(key))) fail('面试官信息无效')
    const userId = typeof input.userId === 'string' ? input.userId.trim() : ''
    const role = input.role ?? 'interviewer'
    if (!userId || users.has(userId) || !['interviewer', 'coordinator', 'observer'].includes(String(role))) fail('面试官无效或重复')
    users.add(userId)
    if (input.name !== undefined && typeof input.name !== 'string') fail('面试官姓名必须是文本')
    for (const field of ['required', 'lead']) if (input[field] !== undefined && typeof input[field] !== 'boolean') fail('面试官责任设置无效')
    let sheetTypes: AssignedSheetType[] | undefined
    if (input.sheetTypes !== undefined) {
      if (!Array.isArray(input.sheetTypes)) fail('评分分工无效')
      sheetTypes = (input.sheetTypes as unknown[]).map(type => {
        if (!INTERVIEW_SHEET_TYPES.includes(type as AssignedSheetType) || sheets.has(String(type))) fail('同一面试表只能指定一名评分人')
        if (stage && !(stage === 'initial' ? ['hr_screen', 'hiring_department'] : ['business', 'hr', 'boss']).includes(String(type))) fail('评分分工与面试阶段不匹配')
        sheets.add(String(type)); return type as AssignedSheetType
      })
    }
    if (role !== 'interviewer' && (input.lead === true || sheetTypes?.length)) fail('只有面试官可以负责面试或评分')
    return { userId, ...(typeof input.name === 'string' && input.name.trim() ? { name: input.name.trim() } : {}), role: role as AssignedParticipant['role'], required: input.required !== false,
      ...(input.lead === undefined ? {} : { lead: input.lead as boolean }), ...(sheetTypes === undefined ? {} : { sheetTypes }) }
  })
  const explicit = participants.some(person => person.lead !== undefined || person.sheetTypes !== undefined)
  if (explicit && participants.filter(person => person.lead).length !== 1) fail('请选择且仅选择一名面试负责人')
  if (explicit && stage && (stage === 'initial' ? ['hr_screen', 'hiring_department'] : ['business', 'hr', 'boss']).some(type => !sheets.has(type))) fail('请为每张面试表指定评分人')
  return participants
}

export function interviewAssignees(participants: AssignedParticipant[], sheetType?: string): string[] {
  return participants.filter(person => person.role === 'interviewer' && (sheetType ? person.sheetTypes?.includes(sheetType as AssignedSheetType) : true)).map(person => person.userId)
}
