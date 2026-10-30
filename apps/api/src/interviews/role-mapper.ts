export type InterviewRole = 'interviewer' | 'candidate' | 'unknown'

export interface TranscriptComparison {
  streamingText: string
  offlineText: string
  streamingComplete: boolean
  selectedSource: 'streaming' | 'offline'
  startMs: number
  endMs: number
}

export interface SpeakerSegment {
  transcriptComparison?: TranscriptComparison
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

type RoleCue = { role: InterviewRole; reason: string; anchor: boolean; identity?: boolean }

function roleCue(text: string): RoleCue {
  const interviewerIdentity = /我(?:是|来担任).{0,12}面试官|(?:今天|本次|这次).{0,6}面试(?:由我|我来)|今天由我.{0,8}面试/u.test(text)
  const candidateIdentity = /我(?:来|想|本次|这次)?(?:应聘|求职)/u.test(text)
  if (interviewerIdentity !== candidateIdentity) return { role: interviewerIdentity ? 'interviewer' : 'candidate', reason: 'explicit_role_identity', anchor: true, identity: true }
  if (interviewerIdentity && candidateIdentity) return { role: 'unknown', reason: 'ambiguous_utterance_content', anchor: false }
  const interviewer = /(?:请|能否|可以|能不能).{0,12}(?:自我介绍|介绍.{0,6}(?:自己|你|工作|经历|项目)|谈谈.{0,6}(?:你|经历|项目))/u.test(text)
  const candidate = /我.{0,8}(?:毕业于|毕业后|上一家|之前在|曾在|工作了)|我有.{0,6}年.{0,12}经验/u.test(text)
  if (interviewer !== candidate) return { role: interviewer ? 'interviewer' : 'candidate', reason: 'opening_role_context', anchor: true }
  if (interviewer && candidate) return { role: 'unknown', reason: 'ambiguous_utterance_content', anchor: false }
  const question = matchesAny(text, QUESTION_PATTERNS)
  const answer = matchesAny(text, ANSWER_PATTERNS)
  if (question && (/^(?:这个岗位|贵公司|贵司|入职后|试用期|薪资|薪酬|福利)/u.test(text.trim())
    || /(?:想问|请问|问一下).{0,16}(?:贵公司|贵司|岗位|薪资|薪酬|福利)/u.test(text))) {
    return { role: 'candidate', reason: 'candidate_question_context', anchor: false }
  }
  return { role: question !== answer ? (question ? 'interviewer' : 'candidate') : 'unknown',
    reason: question !== answer ? (question ? 'question_content' : 'answer_content') : 'ambiguous_utterance_content', anchor: false }
}

function unsafeSpeaker(segment: SpeakerSegment): boolean {
  return segment.speakerVerified === false || !!segment.speakerMixed || hasMixedSpeakerContent(segment.text)
}

function stableVerifiedSpeaker(segment: SpeakerSegment): boolean {
  return segment.speakerVerified === true && /(^|:)voice_/.test(segment.speakerId)
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
  const cues = new Map(segments.map(segment => [segment, roleCue(segment.text)]))
  const chronological = [...segments].sort((a, b) => a.startMs - b.startMs)
  for (let index = 1; index < chronological.length; index++) {
    const segment = chronological[index]!, prompt = chronological[index - 1]!
    // A short factual answer can borrow meaning from the preceding question,
    // but turn order alone must never assign a role to greetings or mixed audio.
    if (cues.get(segment)!.role !== 'unknown' || segment.speakerVerified !== true || prompt.speakerVerified !== true
      || unsafeSpeaker(segment) || unsafeSpeaker(prompt) || segment.speakerId === prompt.speakerId
      || segment.audioSource !== prompt.audioSource || segment.startMs < prompt.endMs || segment.startMs - prompt.endMs > 10000
      || (previous[prompt.speakerId] ?? previousInferred[prompt.speakerId] ?? cues.get(prompt)!.role) !== 'interviewer') continue
    if ((/(?:几年|多少年|多久|多长时间)/u.test(prompt.text) && /^(?:大概|大约|差不多|已经)?\s*[一二两三四五六七八九十百零\d]+(?:年|个月)[。！!\s]*$/u.test(segment.text.trim()))
      || (/(?:学历|学位)/u.test(prompt.text) && /^(?:高中|中专|大专|本科|学士|硕士|博士)(?:毕业)?[。！!\s]*$/u.test(segment.text.trim()))) {
      cues.set(segment, { role: 'candidate', reason: 'opening_answer_context', anchor: false })
    }
  }
  const conflicts = new Set<string>()
  const evidence = new Map<string, { roles: Set<InterviewRole>; anchors: Set<InterviewRole>; identities: Set<InterviewRole>; stable: boolean }>()
  for (const segment of segments) {
    if (unsafeSpeaker(segment)) continue
    const item = evidence.get(segment.speakerId) ?? { roles: new Set<InterviewRole>(), anchors: new Set<InterviewRole>(), identities: new Set<InterviewRole>(), stable: true }
    const cue = cues.get(segment)!
    item.stable &&= stableVerifiedSpeaker(segment)
    if (cue.role !== 'unknown') {
      item.roles.add(cue.role)
      if (cue.anchor) item.anchors.add(cue.role)
      if (cue.identity) item.identities.add(cue.role)
    }
    evidence.set(segment.speakerId, item)
  }
  const roles: ConfirmedSpeakerRoles = {}
  for (const [speakerId, item] of evidence) {
    if (item.identities.size > 1 || (item.roles.size > 1 && !(item.stable && (previousInferred[speakerId] || item.identities.size === 1 || item.anchors.size === 1)))) {
      conflicts.add(speakerId)
    } else {
      const role = [...(item.identities.size ? item.identities : item.anchors.size ? item.anchors : item.roles)][0]
      if (role && role !== 'unknown') roles[speakerId] = role
    }
  }
  return segments.map((segment) => {
    if (unsafeSpeaker(segment)) {
      return { ...segment, role: 'unknown', confidence: 0.35, reasons: ['possible_mixed_speakers'] }
    }
    const confirmed = previous[segment.speakerId]
    if (confirmed) return { ...segment, role: confirmed, confidence: 1, reasons: ['confirmed_speaker_continuity'] }
    if (conflicts.has(segment.speakerId)) {
      return { ...segment, role: 'unknown', confidence: 0.35, reasons: ['possible_mixed_speakers'] }
    }
    const prior = previousInferred[segment.speakerId], cue = cues.get(segment)!
    const identity = [...(evidence.get(segment.speakerId)?.identities ?? [])][0]
    if (prior && ((identity && identity !== prior) || (!stableVerifiedSpeaker(segment) && cue.role !== 'unknown' && cue.role !== prior))) {
      return { ...segment, role: 'unknown', confidence: 0.35, reasons: ['speaker_role_conflict'] }
    }
    const role = prior ?? roles[segment.speakerId] ?? 'unknown'
    return { ...segment, role, confidence: role === 'unknown' ? 0.35 : 0.82,
      reasons: [prior || (role !== 'unknown' && cue.role !== role) ? 'inferred_speaker_continuity' : cue.reason] }
  })
}
