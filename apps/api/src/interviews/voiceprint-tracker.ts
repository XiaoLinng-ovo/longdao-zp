import { randomUUID } from 'node:crypto'
import type { SpeakerSegment } from './role-mapper.js'

interface Profile { id: string; vector: number[]; source?: string }
interface Session { touched: number; profiles: Profile[] }

export function validSpeakerEmbedding(value: unknown): value is number[] {
  return Array.isArray(value) && value.length >= 2 && value.length <= 1024
    && value.every(item => typeof item === 'number' && Number.isFinite(item))
    && Number.isFinite(Math.hypot(...value)) && Math.hypot(...value) > 0
}

/** Voice vectors stay in bounded process memory; only opaque IDs reach the database. */
export class SessionVoiceprintTracker {
  private sessions = new Map<string, Session>()
  constructor(private readonly now = Date.now, private readonly ttlMs = 2 * 60 * 60 * 1000, private readonly maxSessions = 128) {}

  identify(sessionId: string, segments: SpeakerSegment[], source?: string): SpeakerSegment[] {
    const now = this.now()
    for (const [id, session] of this.sessions) if (now - session.touched >= this.ttlMs) this.sessions.delete(id)
    let session = this.sessions.get(sessionId)
    if (!session) {
      if (this.sessions.size >= this.maxSessions) {
        const oldest = [...this.sessions].sort((left, right) => left[1].touched - right[1].touched)[0]
        if (oldest) this.sessions.delete(oldest[0])
      }
      session = { touched: now, profiles: [] }
      this.sessions.set(sessionId, session)
    }
    session.touched = now
    const assigned = new Map<string, string>()
    const used = new Set<string>()
    const prior = session.profiles.filter(profile => profile.source === source)
    for (const segment of segments) {
      const vector = segment.speakerEmbedding
      if (!segment.speakerVerified || segment.speakerMixed || !validSpeakerEmbedding(vector) || assigned.has(segment.speakerId)) continue
      let id: string | undefined
      {
        const norm = Math.hypot(...vector)
        const normalized = vector.map(value => value / norm)
        const ranked = prior.filter(profile => profile.vector.length === vector.length)
          .map(profile => ({ profile, similarity: profile.vector.reduce((sum, value, index) => sum + value * normalized[index]!, 0) }))
          .sort((left, right) => right.similarity - left.similarity)
        const best = ranked[0]
        // Conservative defaults; these are similarity thresholds, not accuracy claims.
        if (best && !used.has(best.profile.id) && best.similarity >= 0.8 && best.similarity - (ranked[1]?.similarity ?? -1) >= 0.1) id = best.profile.id
        else if (session.profiles.length < 16) {
          id = `voice_${randomUUID()}`
          session.profiles.push({ id, vector: normalized, ...(source ? { source } : {}) })
        }
        if (!id) continue
        assigned.set(segment.speakerId, id)
        used.add(id)
      }
    }
    return segments.map(segment => {
      const { speakerEmbedding: _vector, ...plain } = segment
      const id = segment.speakerVerified && !segment.speakerMixed ? assigned.get(segment.speakerId) : undefined
      return id ? { ...plain, speakerId: id } : plain
    })
  }

  forget(sessionId: string): void { this.sessions.delete(sessionId) }
}
