import type { InterviewView } from '../api'

export const INTERVIEW_RESULT_LABELS = {
  initial_pass: '初试通过', final_pass: '复试通过',
  initial_reject: '初试未通过', final_reject: '复试未通过',
  pending: '待完成', cancelled: '已取消',
} as const
export type InterviewResultKey = keyof typeof INTERVIEW_RESULT_LABELS

export function isFinalInterview(row: Pick<InterviewView, 'stage' | 'round'>): boolean {
  return row.stage === 'final' || (!row.stage && Number.parseInt(row.round, 10) >= 2)
}

export function interviewResult(row: InterviewView): InterviewResultKey {
  if (row.status === 'cancelled') return 'cancelled'
  const final = isFinalInterview(row)
  if (row.outcome === 'reject') return final ? 'final_reject' : 'initial_reject'
  if (row.outcome === 'continue' || row.outcome === 'offer') return final ? 'final_pass' : 'initial_pass'
  return 'pending'
}

export function aiScoreLabel(row: InterviewView): string {
  if (row.aiScore !== null && row.aiScore !== undefined && Number.isFinite(row.aiScore)) return row.aiScore.toFixed(1)
  if (row.aiScoreStatus === 'failed') return '分析失败'
  if (row.aiScoreStatus === 'stale') return '待重新评分'
  if (row.aiScoreStatus === 'insufficient') return '证据不足'
  return row.aiScoreStatus === 'pending' || row.aiScoreStatus === 'generating' ? '分析中' : '暂无评分'
}
