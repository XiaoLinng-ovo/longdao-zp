import { RecruitingWorkflowError } from './workflow.js'

export interface InterviewScheduleUpdate {
  scheduledStartAt?: string
  scheduledEndAt?: string | null
  location?: string | null
  meetingUrl?: string | null
}

const fields = ['scheduledStartAt', 'scheduledEndAt', 'location', 'meetingUrl'] as const

function invalid(message: string): never {
  throw new RecruitingWorkflowError('VALIDATION_ERROR', message, 400)
}

function timestamp(value: string, label: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) invalid(`${label}必须是带时区的有效日期时间`)
  const calendar = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`)
  if (calendar.getUTCMonth() + 1 !== Number(match[2]) || calendar.getUTCDate() !== Number(match[3])) invalid(`${label}日期无效`)
  return new Date(value).toISOString()
}

export function prepareInterviewScheduleUpdate(current: { status: string; scheduledStartAt?: string | null; scheduledEndAt?: string | null; location?: string | null; meetingUrl?: string | null }, input: unknown): InterviewScheduleUpdate {
  if (current.status !== 'scheduled') throw new RecruitingWorkflowError('INTERVIEW_NOT_EDITABLE', '已完成或已取消的面试不能修改安排')
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('面试安排必须是对象')
  if (Object.keys(input).some((key) => !fields.includes(key as typeof fields[number]))) invalid('只允许修改面试时间、地点和会议链接')
  const patch: InterviewScheduleUpdate = {}
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue
    const value = (input as Record<string, unknown>)[field]
    if (value !== null && typeof value !== 'string') invalid('面试安排字段必须是文本或空值')
    const text = value?.trim() || null
    if (field === 'scheduledStartAt') {
      if (!text) invalid('请选择面试开始时间')
      patch.scheduledStartAt = timestamp(text, '开始时间')
    } else if (field === 'scheduledEndAt') {
      patch.scheduledEndAt = text ? timestamp(text, '结束时间') : null
    } else {
      if (text && text.length > (field === 'location' ? 1000 : 2048)) invalid('地点或会议链接过长')
      if (field === 'meetingUrl' && text) {
        let url: URL
        try { url = new URL(text) } catch { invalid('请输入有效的会议链接') }
        if (!['http:', 'https:'].includes(url.protocol)) invalid('会议链接必须以 http:// 或 https:// 开头')
      }
      patch[field] = text
    }
    if ((patch[field] ?? null) === (current[field] ?? null)) delete patch[field]
  }
  const start = patch.scheduledStartAt ?? current.scheduledStartAt
  const end = patch.scheduledEndAt !== undefined ? patch.scheduledEndAt : current.scheduledEndAt
  if (!start) invalid('请选择面试开始时间')
  if (end && Date.parse(end) <= Date.parse(start)) invalid('面试结束时间必须晚于开始时间')
  return patch
}
