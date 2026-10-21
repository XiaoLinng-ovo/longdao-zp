export type InterviewRole = 'interviewer' | 'candidate' | 'unknown'

export interface SpeakerSegment {
  audioSource?: 'microphone' | 'meeting'
  id: string
  speakerId: string
  text: string
  startMs: number
  endMs: number
  speakerEmbedding?: number[]
  speakerVerified?: boolean
  speakerMixed?: boolean
}

export interface RoleMapping extends SpeakerSegment {
  role: InterviewRole
  confidence: number
  reasons: string[]
}

export type ConfirmedSpeakerRoles = Record<string, Exclude<InterviewRole, 'unknown'>>

const QUESTION_PATTERNS = [/请.{0,12}(介绍|说明|讲|谈|分享)/u, /你.{0,20}(如何|怎么|为什么|是否|负责|经历|使用|结果)/u, /[？?]$/u, /(吗|呢)[，。！!？?]?$/u]
const ANSWER_PATTERNS = [/^(我|我们|当时|之前|在.{0,12}(公司|项目))/u, /我.{0,12}(当时|之前|负责|参与|使用|实现|解决)/u, /(负责|参与|使用|实现|解决|经验)/u]

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text.trim()))
}

/** FunASR speaker labels are scoped to one uploaded audio chunk, not an interview session. */
export function scopeSpeakersToChunk(segments: SpeakerSegment[], chunkOffsetMs: number): SpeakerSegment[] {
  return segments.map((segment) => ({ ...segment, speakerId: segment.speakerId.startsWith('voice_') ? segment.speakerId : `chunk_${chunkOffsetMs}:${segment.speakerId}` }))
}

/** Preserve acoustic identity: a role label is not a speaker identity. */
export function stableRoleSpeakerId(segment: Pick<RoleMapping, 'speakerId' | 'role'>): string {
  return segment.speakerId
}

export function hasMixedSpeakerContent(text: string): boolean {
  return /[？?][\s，,]*(?:我|我们|当时|之前|首先|然后|(?:这个|我的)?[^。？?]{0,16}(?:就是|是指))/u.test(text)
}

export function mapInterviewRoles(segments: SpeakerSegment[], previous: ConfirmedSpeakerRoles, previousInferred: ConfirmedSpeakerRoles = {}): RoleMapping[] {
  const roles: ConfirmedSpeakerRoles = { ...previousInferred }
  const conflicts = new Set<string>()
  const inferred = new Map<string, InterviewRole>()
  for (const segment of segments) {
    if (previous[segment.speakerId]) continue
    const questionLike = matchesAny(segment.text, QUESTION_PATTERNS)
    const answerLike = matchesAny(segment.text, ANSWER_PATTERNS)
    if (questionLike === answerLike) continue
    const role = questionLike ? 'interviewer' : 'candidate'
    if (inferred.has(segment.speakerId) && inferred.get(segment.speakerId) !== role) conflicts.add(segment.speakerId)
    inferred.set(segment.speakerId, role)
  }

  return segments.map((segment) => {
    if (segment.speakerVerified === false || segment.speakerMixed || hasMixedSpeakerContent(segment.text) || conflicts.has(segment.speakerId)) {
      return { ...segment, role: 'unknown', confidence: 0.35, reasons: ['possible_mixed_speakers'] }
    }
    const confirmed = previous[segment.speakerId]
    if (confirmed) return { ...segment, role: confirmed, confidence: 1, reasons: ['confirmed_speaker_continuity'] }

    const questionLike = matchesAny(segment.text, QUESTION_PATTERNS)
    const answerLike = matchesAny(segment.text, ANSWER_PATTERNS)
    let role: InterviewRole = 'unknown'
    let confidence = 0.35
    const reasons: string[] = []

    if (questionLike !== answerLike) {
      role = questionLike ? 'interviewer' : 'candidate'
      if (previousInferred[segment.speakerId] && previousInferred[segment.speakerId] !== role) {
        return { ...segment, role: 'unknown', confidence: 0.35, reasons: ['speaker_role_conflict'] }
      }
      confidence = 0.82
      reasons.push(questionLike ? 'question_content' : 'answer_content')
    } else if (!questionLike && roles[segment.speakerId]) {
      role = roles[segment.speakerId]!
      confidence = 0.82
      reasons.push('inferred_speaker_continuity')
    } else {
      reasons.push('ambiguous_utterance_content')
    }

    if (role !== 'unknown' && confidence >= 0.6) {
      roles[segment.speakerId] = role
    }
    return { ...segment, role, confidence, reasons }
  })
}
