import type { SpeakerSegment } from './role-mapper.js'
import { validSpeakerEmbedding } from './voiceprint-tracker.js'
import { simplifyTranscript } from './transcript-text.js'

/** Normalize the small response variations used by local ASR services. */
export function parseSpeakerSegment(value: unknown): SpeakerSegment | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const text = simplifyTranscript(typeof row.text === 'string' ? row.text.trim() : typeof row.sentence === 'string' ? row.sentence.trim() : '')
  const speakerId = typeof row.speakerId === 'string' ? row.speakerId : typeof row.spk === 'string' || typeof row.spk === 'number' ? `speaker_${row.spk}` : ''
  const startMs = Number(row.startMs ?? row.start ?? 0); const endMs = Number(row.endMs ?? row.end ?? 0)
  if (!text || !speakerId || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined
  return { id: typeof row.id === 'string' ? row.id : `${speakerId}:${startMs}`, speakerId, text, startMs, endMs,
    ...(validSpeakerEmbedding(row.speakerEmbedding) ? { speakerEmbedding: row.speakerEmbedding } : {}),
    speakerVerified: row.speakerVerified === true,
    ...(row.speakerMixed === true ? { speakerMixed: true } : {}) }
}

export function parseSpeakerSegments(payload: unknown): SpeakerSegment[] {
  const rows = Array.isArray(payload) ? payload : payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).segments)
    ? (payload as Record<string, unknown>).segments : payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).result)
      ? (payload as Record<string, unknown>).result : undefined
  if (!Array.isArray(rows)) throw new Error('ASR response has no segments.')
  const segments = rows.map(parseSpeakerSegment)
  if (segments.some((item) => !item)) throw new Error('ASR response contains an invalid segment.')
  return segments as SpeakerSegment[]
}
