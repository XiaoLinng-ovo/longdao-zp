import { randomUUID } from 'node:crypto'
import type { SpeakerSegment } from './role-mapper.js'

interface Profile { id: string; vector: number[]; source?: string; samples: number }
interface Session { touched: number; profiles: Profile[] }

export function validSpeakerEmbedding(value: unknown): value is number[] {
  return Array.isArray(value) && value.length >= 2 && value.length <= 1024
    && value.every(item => typeof item === 'number' && Number.isFinite(item))
    && Number.isFinite(Math.hypot(...value)) && Math.hypot(...value) > 0
}

function normalize(vector: number[]): number[] {
  const norm = Math.hypot(...vector)
  return vector.map(value => value / norm)
}

export interface VoiceprintOptions {
  /**
   * 实时切片只有几秒，同一说话人跨切片的声纹余弦相似度中位约 0.52，
   * 而不同人之间约 0.20。阈值必须落在这两者之间，0.8 会永远匹配不上。
   */
  matchThreshold?: number
  matchMargin?: number
  maxProfiles?: number
  /** 名额用满时的兜底阈值，避免同一说话人退化成每个切片一个匿名身份。 */
  fallbackThreshold?: number
  /** 声纹中心向新样本靠拢的比例：切片越短越需要累计才稳定。 */
  adaptationRate?: number
}

interface ResolvedOptions { matchThreshold: number; matchMargin: number; maxProfiles: number; fallbackThreshold: number; adaptationRate: number }

const DEFAULT_OPTIONS: ResolvedOptions = {
  matchThreshold: 0.45,
  matchMargin: 0.03,
  maxProfiles: 64,
  fallbackThreshold: 0.3,
  adaptationRate: 0.3,
}

/** Voice vectors stay in bounded process memory; only opaque IDs reach the database. */
export class SessionVoiceprintTracker {
  private sessions = new Map<string, Session>()
  private readonly options: ResolvedOptions
  constructor(private readonly now = Date.now, private readonly ttlMs = 2 * 60 * 60 * 1000,
    private readonly maxSessions = 128, options: VoiceprintOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

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
    const { matchThreshold, matchMargin, maxProfiles, fallbackThreshold, adaptationRate } = this.options
    const assigned = new Map<string, string>()
    const used = new Set<string>()
    const pending: Array<{ profile: Profile; vector: number[] }> = []
    const prior = session.profiles.filter(profile => profile.source === source)
    for (const segment of segments) {
      const vector = segment.speakerEmbedding
      if (!segment.speakerVerified || segment.speakerMixed || !validSpeakerEmbedding(vector)
        || assigned.has(segment.speakerId)) continue
      const normalized = normalize(vector)
      const ranked = prior.filter(profile => profile.vector.length === vector.length)
        .map(profile => ({ profile, similarity: profile.vector.reduce((sum, value, index) => sum + value * normalized[index]!, 0) }))
        .sort((left, right) => right.similarity - left.similarity)
      const best = ranked[0]
      const runnerUp = ranked[1]?.similarity ?? -1
      let id: string | undefined
      if (best && !used.has(best.profile.id) && best.similarity >= matchThreshold
        && best.similarity - runnerUp >= matchMargin) {
        id = best.profile.id
        pending.push({ profile: best.profile, vector: normalized })
      } else if (session.profiles.length < maxProfiles) {
        // A local speaker label that cannot be placed keeps its own identity
        // instead of being merged into a neighbour.
        id = `voice_${randomUUID()}`
        const profile: Profile = { id, vector: normalized, samples: 1, ...(source ? { source } : {}) }
        session.profiles.push(profile)
        prior.push(profile)
      } else {
        // Probes exhausted: reuse the closest usable voice rather than dropping
        // identity, which would strand the turn as an anonymous every-chunk id.
        const fallback = ranked.find(row => !used.has(row.profile.id) && row.similarity >= fallbackThreshold)
        if (fallback) {
          id = fallback.profile.id
          pending.push({ profile: fallback.profile, vector: normalized })
        }
      }
      if (!id) continue
      assigned.set(segment.speakerId, id)
      used.add(id)
    }
    // Short chunks score low on their own; adapting the centre makes the next
    // chunk more likely to land on the same identity.
    for (const { profile, vector } of pending) {
      profile.vector = normalize(profile.vector.map((value, index) => value * (1 - adaptationRate) + vector[index]! * adaptationRate))
      profile.samples += 1
    }
    return segments.map(segment => {
      const { speakerEmbedding: _vector, ...plain } = segment
      const id = segment.speakerVerified && !segment.speakerMixed ? assigned.get(segment.speakerId) : undefined
      return id ? { ...plain, speakerId: id } : plain
    })
  }

  forget(sessionId: string): void { this.sessions.delete(sessionId) }
}
