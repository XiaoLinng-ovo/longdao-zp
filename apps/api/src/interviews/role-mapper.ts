export type InterviewRole = 'interviewer' | 'candidate' | 'unknown'

export interface SpeakerSegment {
  id: string
  speakerId: string
  text: string
  startMs: number
  endMs: number
}

export interface RoleMapping extends SpeakerSegment {
  role: InterviewRole
  confidence: number
  reasons: string[]
}

export type ConfirmedSpeakerRoles = Record<string, Exclude<InterviewRole, 'unknown'>>

const QUESTION_PATTERNS = [/请.{0,8}(介绍|说明|讲)/u, /你.{0,12}(如何|怎么|为什么|是否|负责)/u, /[？?]$/u]
const ANSWER_PATTERNS = [/^(我|我们|当时|之前|在.{0,12}(公司|项目))/u, /(负责|参与|使用|实现|解决|经验)/u]

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text.trim()))
}

export function mapInterviewRoles(segments: SpeakerSegment[], previous: ConfirmedSpeakerRoles): RoleMapping[] {
  const roles: ConfirmedSpeakerRoles = { ...previous }
  const knownSpeakers = new Set(Object.keys(roles))
  const hasInterviewer = () => Object.values(roles).includes('interviewer')
  const hasCandidate = () => Object.values(roles).includes('candidate')

  return segments.map((segment, index) => {
    const confirmed = roles[segment.speakerId]
    if (confirmed) return { ...segment, role: confirmed, confidence: 0.98, reasons: ['confirmed_speaker_continuity'] }

    const questionLike = matchesAny(segment.text, QUESTION_PATTERNS)
    const answerLike = matchesAny(segment.text, ANSWER_PATTERNS)
    let role: InterviewRole = 'unknown'
    let confidence = 0.35
    const reasons: string[] = []

    if (!hasInterviewer() && (index === 0 || questionLike)) {
      role = 'interviewer'; confidence = questionLike ? 0.88 : 0.65; reasons.push(questionLike ? 'opening_question' : 'first_stable_speaker')
    } else if (hasInterviewer() && !hasCandidate() && answerLike) {
      role = 'candidate'; confidence = 0.88; reasons.push('answer_after_interviewer')
    } else if (knownSpeakers.size < 2 && hasInterviewer()) {
      role = 'candidate'; confidence = answerLike ? 0.82 : 0.62; reasons.push('second_primary_speaker')
    } else if (knownSpeakers.size < 2 && hasCandidate()) {
      role = 'interviewer'; confidence = questionLike ? 0.82 : 0.62; reasons.push('second_primary_speaker')
    } else {
      reasons.push('ambiguous_additional_speaker')
    }

    if (role !== 'unknown' && confidence >= 0.6) {
      roles[segment.speakerId] = role
      knownSpeakers.add(segment.speakerId)
    }
    return { ...segment, role, confidence, reasons }
  })
}
