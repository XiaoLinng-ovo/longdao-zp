import type { ConfirmedSpeakerRoles, InterviewRole, RoleMapping, SpeakerSegment } from './role-mapper.js'
import { mapInterviewRoles } from './role-mapper.js'

export type InterviewAudioSource = 'microphone' | 'meeting'
export interface AudioSourceConfig { id: InterviewAudioSource; role: InterviewRole; multipleSpeakers: boolean }

export function parseAudioSource(value: unknown): AudioSourceConfig | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_AUDIO_SOURCE')
  const row = value as Record<string, unknown>
  if ((row.id !== 'microphone' && row.id !== 'meeting')
    || !['interviewer', 'candidate', 'unknown'].includes(String(row.role))
    || typeof row.multipleSpeakers !== 'boolean') throw new Error('INVALID_AUDIO_SOURCE')
  return { id: row.id, role: row.role as InterviewRole, multipleSpeakers: row.multipleSpeakers }
}

/** Source is transport provenance, never inferred from a sentence or a voice. */
export function mapAudioSourceRoles(segments: SpeakerSegment[], source: AudioSourceConfig | undefined,
  confirmed: ConfirmedSpeakerRoles, inferred: ConfirmedSpeakerRoles): RoleMapping[] {
  if (!source) return mapInterviewRoles(segments, confirmed, inferred)
  const tagged = segments.map(row => ({ ...row, audioSource: source.id, speakerId: `${source.id}:${row.speakerId}` }))
  if (!source.multipleSpeakers && source.role !== 'unknown') {
    return tagged.map(row => ({ ...row, speakerId: source.id + ':single', role: source.role, confidence: 1, reasons: ['confirmed_single_person_source'] }))
  }
  // Multi-person sources retain acoustic identities. A source role is not a
  // license to assign that role to everyone sharing the microphone.
  return mapInterviewRoles(tagged, confirmed, inferred)
}
