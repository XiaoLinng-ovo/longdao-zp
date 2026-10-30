export const RECOMMENDATION_LABELS: Record<string, string> = {
  strong_match: '强匹配',
  match: '匹配',
  needs_review: '待复核',
  weak_match: '弱匹配',
}

export const HUMAN_REVIEW_STATUS_LABELS: Record<string, string> = {
  not_required: '无需复核',
  pending: '待复核',
  in_progress: '复核中',
  accepted: '已通过',
  needs_correction: '需修正',
}

export function recommendationLabel(value: string | null | undefined): string {
  return value ? RECOMMENDATION_LABELS[value] ?? value : '—'
}

export function humanReviewStatusLabel(value: string | null | undefined): string {
  return value ? HUMAN_REVIEW_STATUS_LABELS[value] ?? value : '—'
}
