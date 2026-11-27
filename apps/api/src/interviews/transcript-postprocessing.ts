import { createHash } from 'node:crypto'
import type { InterviewAudioManifestEntry } from './audio-recording-repository.js'
import type { LiveSegment } from './live-session-repository.js'
import type { InterviewRole } from './role-mapper.js'
import { semanticRolePending, semanticRoleResolved, type SemanticRoleReview } from './semantic-role-review.js'

export type TranscriptRouteKind = 'offline' | 'live'
export type TranscriptPostprocessPhase = 'offline_reidentification' | 'deduplication' | 'role_review' | 'context_correction' | 'publishing'

export interface TranscriptEvidenceSegment {
  roleReview?: SemanticRoleReview
  evidenceId: string
  routeId: string
  routeKind: TranscriptRouteKind
  engine: string
  audioSource?: 'microphone' | 'meeting'
  rawSegmentId?: string
  derivedFromEvidenceId?: string
  speakerConfirmed?: boolean
  speakerId: string
  role: InterviewRole
  confidence: number
  text: string
  startMs: number
  endMs: number
  roleReasons?: string[]
}

export interface CorrectedTranscriptTurn {
  roleReview?: SemanticRoleReview
  id: string
  speakerConfirmed?: boolean
  speakerId: string
  role: InterviewRole
  confidence: number
  text: string
  startMs: number
  endMs: number
  audioSource?: 'microphone' | 'meeting'
  evidenceIds: string[]
  roleReasons: string[]
}

export interface TranscriptCorrection {
  turnId: string
  original: string
  corrected: string
  reason: string
}

export interface TranscriptUncertainty {
  turnId: string
  original: string
  reason: string
}

export interface RawTranscriptSegment {
  roleReview?: SemanticRoleReview
  id: string
  speakerConfirmed?: boolean
  speakerId: string
  role: InterviewRole
  confidence: number
  text: string
  startMs: number
  endMs: number
  audioSource?: 'microphone' | 'meeting'
  audioObjectKey?: string
  transcriptComparison?: unknown
}

export interface RawTranscriptSnapshot {
  fingerprint: string
  sessionDurationMs: number
  segments: RawTranscriptSegment[]
  manifest: InterviewAudioManifestEntry[]
}

export interface ConsolidatedTranscript {
  turns: CorrectedTranscriptTurn[]
  evidence: TranscriptEvidenceSegment[]
}

const textOnly = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s，。！？、,.!?;；:：'"“”‘’()（）\-—_]/gu, '')

function overlapScore(a: Pick<TranscriptEvidenceSegment, 'startMs' | 'endMs'>, b: Pick<TranscriptEvidenceSegment, 'startMs' | 'endMs'>): number {
  const overlap = Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs))
  const shortest = Math.max(1, Math.min(a.endMs - a.startMs, b.endMs - b.startMs))
  if (overlap > 0) return overlap / shortest
  const aCenter = (a.startMs + a.endMs) / 2
  const bCenter = (b.startMs + b.endMs) / 2
  return Math.abs(aCenter - bCenter) <= 1500 ? 0.25 : 0
}

export function transcriptTextSimilarity(left: string, right: string): number {
  const a = textOnly(left), b = textOnly(right)
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return 0.9
  const grams = (value: string) => {
    if (value.length < 2) return new Set([value])
    return new Set(Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2)))
  }
  const leftGrams = grams(a), rightGrams = grams(b)
  let intersection = 0
  for (const gram of leftGrams) if (rightGrams.has(gram)) intersection++
  return intersection / Math.max(leftGrams.size, rightGrams.size, 1)
}

function rolesCompatible(left: InterviewRole, right: InterviewRole): boolean {
  return left === 'unknown' || right === 'unknown' || left === right
}


function representative(rows: TranscriptEvidenceSegment[]): TranscriptEvidenceSegment {
  return [...rows].sort((a, b) => {
    const score = (row: TranscriptEvidenceSegment) => (row.speakerConfirmed && row.role !== 'unknown' ? 1000 : 0)
      + (row.roleReview ? 500 : 0) + (row.routeKind === 'offline' ? 100 : 0)
      + (row.engine === 'funasr' ? 30 : row.engine === 'faster-whisper' ? 20 : 10)
      + (row.audioSource === 'microphone' || row.audioSource === 'meeting' ? 5 : 0)
      + row.confidence + Math.min(textOnly(row.text).length, 40) / 100
    return score(b) - score(a) || a.startMs - b.startMs || a.evidenceId.localeCompare(b.evidenceId)
  })[0]!
}

function consolidateCluster(rows: TranscriptEvidenceSegment[]): CorrectedTranscriptTurn {
  const chosen = representative(rows)
  const votes = new Map<Exclude<InterviewRole, 'unknown'>, number>()
  for (const row of rows) {
    if (row.role === 'unknown') continue
    const weight = (row.routeKind === 'offline' ? 2 : 1) + Math.max(0, row.confidence)
    votes.set(row.role, (votes.get(row.role) ?? 0) + weight)
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1])
  const tied = ranked.length > 1 && Math.abs(ranked[0]![1] - ranked[1]![1]) < 0.01
  const manual = rows.filter(row => row.speakerConfirmed && row.role !== 'unknown')
  const reviews = rows.filter(row => row.roleReview && !row.speakerConfirmed)
  const reviewConflict = reviews.some(row => row !== chosen && (semanticRolePending(row) || row.role !== chosen.role))
  const manualConflict = new Set(manual.map(row => row.role)).size > 1
  const role: InterviewRole = manual.length ? manualConflict ? 'unknown' : manual[0]!.role
    : chosen.roleReview ? semanticRolePending(chosen) || reviewConflict ? 'unknown' : chosen.role
      : tied ? 'unknown' : ranked[0]?.[0] ?? 'unknown'
  const roleReview = chosen.roleReview && !manual.length && reviewConflict
    ? { ...chosen.roleReview, status: reviews.some(row => row.roleReview?.status === 'mixed') ? 'mixed' as const : 'uncertain' as const,
      reason: '多路语义证据存在存疑或冲突；' + chosen.roleReview.reason }
    : chosen.roleReview
  return {
    ...(roleReview ? { roleReview } : {}),
    id: `turn-${chosen.evidenceId.replace(/[^a-z0-9_-]+/giu, '-')}`,
    speakerId: chosen.speakerId,
    speakerConfirmed: manual.length > 0 && !manualConflict,
    role,
    confidence: role === 'unknown' ? Math.min(chosen.confidence, .35)
      : chosen.roleReview || manual.length ? chosen.confidence : Math.max(chosen.confidence, .72),
    text: chosen.text,
    startMs: chosen.startMs,
    endMs: chosen.endMs,
    ...(chosen.audioSource ? { audioSource: chosen.audioSource } : {}),
    evidenceIds: [...new Set(rows.flatMap(row => [row.evidenceId, ...(row.derivedFromEvidenceId ? [row.derivedFromEvidenceId] : [])]))].sort(),
    roleReasons: [...new Set([...(chosen.roleReasons ?? []), ...(manualConflict ? ['manual_role_conflict'] : []),
      rows.length > 1 ? 'multi_route_agreement' : 'single_route'])],
  }
}


function evidenceReferenceIds(row: TranscriptEvidenceSegment): string[] {
  return [row.evidenceId, ...(row.derivedFromEvidenceId ? [row.derivedFromEvidenceId] : [])]
}

function clusterByRouteAgreement(rows: TranscriptEvidenceSegment[]): TranscriptEvidenceSegment[][] {
  const parent = rows.map((_, index) => index)
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!))
  const union = (left: number, right: number) => {
    const a = find(left), b = find(right)
    if (a !== b) parent[b] = a
  }
  for (let left = 0; left < rows.length; left++) for (let right = left + 1; right < rows.length; right++) {
    const a = rows[left]!, b = rows[right]!
    if (a.routeId === b.routeId) continue
    if (!rolesCompatible(a.role, b.role)) continue
    if (overlapScore(a, b) < .45 || transcriptTextSimilarity(a.text, b.text) < .64) continue
    union(left, right)
  }
  const clusters = new Map<number, TranscriptEvidenceSegment[]>()
  rows.forEach((row, index) => {
    const root = find(index)
    clusters.set(root, [...(clusters.get(root) ?? []), row])
  })
  return [...clusters.values()]
}

function overlapMilliseconds(
  left: Pick<TranscriptEvidenceSegment, 'startMs' | 'endMs'>,
  right: Pick<TranscriptEvidenceSegment, 'startMs' | 'endMs'>,
): number {
  return Math.max(0, Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs))
}

function gapMilliseconds(
  left: Pick<TranscriptEvidenceSegment, 'startMs' | 'endMs'>,
  right: Pick<TranscriptEvidenceSegment, 'startMs' | 'endMs'>,
): number {
  if (overlapMilliseconds(left, right) > 0) return 0
  return left.endMs <= right.startMs ? right.startMs - left.endMs : left.startMs - right.endMs
}

function longestCommonSubsequenceLength(left: string, right: string): number {
  const previous = Array<number>(right.length + 1).fill(0)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    let diagonal = 0
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const prior = previous[rightIndex]!
      previous[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? diagonal + 1
        : Math.max(previous[rightIndex]!, previous[rightIndex - 1]!)
      diagonal = prior
    }
  }
  return previous[right.length]!
}

function boundaryTextSimilarity(left: string, right: string): number {
  const a = textOnly(left), b = textOnly(right)
  const shortest = Math.min(a.length, b.length)
  if (shortest < 4) return 0
  return longestCommonSubsequenceLength(a, b) / shortest
}

function consolidateAnchor(anchor: TranscriptEvidenceSegment, rows: TranscriptEvidenceSegment[]): CorrectedTranscriptTurn {
  const cluster = [anchor, ...rows]
  const routes = new Set(cluster.map(row => row.routeId))
  return {
    ...(anchor.roleReview ? { roleReview: anchor.roleReview } : {}),
    id: `turn-${anchor.evidenceId.replace(/[^a-z0-9_-]+/giu, '-')}`,
    speakerId: anchor.speakerId,
    speakerConfirmed: anchor.speakerConfirmed === true,
    role: anchor.role,
    confidence: anchor.confidence,
    text: anchor.text,
    startMs: anchor.startMs,
    endMs: anchor.endMs,
    ...(anchor.audioSource ? { audioSource: anchor.audioSource } : {}),
    evidenceIds: [...new Set(cluster.flatMap(evidenceReferenceIds))].sort(),
    roleReasons: [...new Set([...(anchor.roleReasons ?? []), 'live_time_anchor',
      routes.size > 1 ? 'multi_route_agreement' : 'single_route'])],
  }
}

function roleCue(text: string): { role: InterviewRole; reason: string; strong?: boolean } | undefined {
  const question = /[？?]|^(?:请|能否|可以|能不能|是否|为什么|怎么|什么|哪|谁|多少|介绍一下|说说|谈谈)|(?:吗|呢|么|嘛)[，。！!？?]?\s*$/u.test(text)
  const answer = /^(?:我(?:当时|之前|现在|目前|负责|参与|使用|实现|解决|做过|工作过|在|是)|我们(?:当时|团队|这边|负责|参与|使用|实现|解决|做过|工作过))|我.{0,16}(?:负责|参与|使用|实现|解决|做过|工作过)/u.test(text)
  const interviewerIntroduction = /我.{0,12}(?:是|来自).{0,12}(?:人事|面试官|招聘负责人|招聘经理)/u.test(text)
  // An explicit question wins over a first-person pronoun in phrases such as
  // "我看你现在……吗？". The pronoun alone is not evidence of a candidate turn.
  if (question) return { role: 'interviewer', reason: 'reviewed_question_boundary' }
  // Opening remarks that identify the speaker as HR/interviewer are stronger
  // than an automatically inferred candidate role from realtime captions.
  if (interviewerIntroduction) return { role: 'interviewer', reason: 'reviewed_interviewer_introduction', strong: true }
  if (answer) return { role: 'candidate', reason: 'reviewed_answer_boundary' }
  return undefined
}

export function reviewRoleBoundaries(turns: CorrectedTranscriptTurn[]): CorrectedTranscriptTurn[] {
  return turns.map(turn => {
    if (turn.speakerConfirmed && turn.role !== 'unknown') return turn
    if (turn.roleReasons.includes('manual_role_conflict')) return turn
    if (turn.roleReview) return semanticRolePending(turn)
      ? { ...turn, role: 'unknown', confidence: Math.min(turn.confidence, .49) } : turn
    const cue = roleCue(turn.text)
    if (!cue) return turn
    if (turn.role === 'unknown') return { ...turn, role: cue.role, confidence: Math.max(turn.confidence, .72), roleReasons: [...turn.roleReasons, cue.reason] }
    if (cue.strong && turn.role !== cue.role) return { ...turn, role: cue.role, confidence: Math.max(turn.confidence, .9),
      roleReasons: [...turn.roleReasons, cue.reason, 'role_content_override'] }
    if (turn.role !== cue.role && turn.confidence < .99) return { ...turn, role: 'unknown', confidence: .35,
      roleReasons: [...turn.roleReasons, 'role_content_conflict'] }
    return turn
  })
}

/** Semantic inference resolves a role, but never confirms the acoustic speaker. */
export function unresolvedTranscriptTurns(manifest: InterviewAudioManifestEntry[], turns: CorrectedTranscriptTurn[]): CorrectedTranscriptTurn[] {
  const mixedSources = manifest.filter(row => row.sourceMultipleSpeakers !== false)
  return turns.filter(turn => {
    if (!turn.text.trim()) return false
    if (turn.role === 'unknown') return true
    if (!Number.isFinite(turn.confidence) || turn.confidence < .6) return true
    if (turn.speakerConfirmed) return false
    if (semanticRolePending(turn)) return true
    return !semanticRoleResolved(turn) && mixedSources.some(source =>
      (!turn.audioSource || !source.audioSource || turn.audioSource === source.audioSource)
      && turn.endMs > source.offsetMs && (source.endMs === null || turn.startMs < source.endMs))
  })
}

export function transcriptRoleReviewWarning(
  manifest: InterviewAudioManifestEntry[],
  turns: CorrectedTranscriptTurn[],
): string | undefined {
  const unresolved = unresolvedTranscriptTurns(manifest, turns)
  if (!unresolved.length) return undefined
  const unresolvedChars = unresolved.reduce((sum, turn) => sum + turn.text.replace(/\s/gu, '').length, 0)
  return `角色复核未完成：仍有 ${unresolved.length} 段（约 ${unresolvedChars} 字）缺少可靠的角色依据，仅这些片段暂不评分；总结继续依据可靠发言生成。可在总结后回听并选择是否调整角色，调整后可重新评分。`
}

/** Multiple acoustic routes are merged only when their clocks and texts agree. */
export function consolidateTranscript(offline: TranscriptEvidenceSegment[], live: TranscriptEvidenceSegment[]): ConsolidatedTranscript {
  const sourceEvidence = [...offline, ...live]
  // Keep acoustic boundaries intact; semantic review must see the complete utterance.
  const offlineRows = offline
  const liveRows = live

  let turns: CorrectedTranscriptTurn[]
  if (liveRows.length) {
    const anchorClusters = liveRows.map(anchor => ({ anchor, rows: [] as TranscriptEvidenceSegment[] }))
    const orphans: TranscriptEvidenceSegment[] = []
    for (const row of offlineRows) {
      let best: { cluster: (typeof anchorClusters)[number]; overlapMs: number } | undefined
      for (const cluster of anchorClusters) {
        const overlapMs = overlapMilliseconds(row, cluster.anchor)
        if (overlapMs > 0 && (!best || overlapMs > best.overlapMs)) best = { cluster, overlapMs }
      }
      if (best) best.cluster.rows.push(row)
      else orphans.push(row)
    }

    // Realtime captions occasionally start a few hundred milliseconds after an
    // offline engine. Attach that overlapping boundary fragment as evidence only,
    // so it cannot create a duplicate display turn.
    const bridged: Array<{ row: TranscriptEvidenceSegment; cluster: (typeof anchorClusters)[number] }> = []
    let remaining = orphans.filter(row => {
      let best: { cluster: (typeof anchorClusters)[number]; gapMs: number } | undefined
      for (const cluster of anchorClusters) {
        const gapMs = gapMilliseconds(row, cluster.anchor)
        if (gapMs > 1500 || boundaryTextSimilarity(row.text, cluster.anchor.text) < .7) continue
        if (!best || gapMs < best.gapMs) best = { cluster, gapMs }
      }
      if (!best) return true
      best.cluster.rows.push(row)
      bridged.push({ row, cluster: best.cluster })
      return false
    })

    // Short ASR fragments inside an already bridge-matched offline interval are
    // part of the same acoustic boundary (for example "嗯" and "OK").
    remaining = remaining.filter(row => {
      const containing = bridged.find(({ row: anchor }) =>
        row.startMs >= anchor.startMs && row.endMs <= anchor.endMs)
      if (!containing) return true
      containing.cluster.rows.push(row)
      return false
    })
    turns = [
      ...anchorClusters.map(cluster => consolidateAnchor(cluster.anchor, cluster.rows)),
      ...clusterByRouteAgreement(remaining).map(consolidateCluster),
    ]
  } else {
    turns = clusterByRouteAgreement(offlineRows).map(consolidateCluster)
  }

  turns = reviewRoleBoundaries(turns.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id)))
  const allEvidence = [...sourceEvidence].sort((a, b) => a.startMs - b.startMs || a.evidenceId.localeCompare(b.evidenceId))
  return { turns, evidence: allEvidence }
}

export function liveSegmentsToEvidence(segments: LiveSegment[]): TranscriptEvidenceSegment[] {
  return segments.map(segment => ({
    ...(segment.roleReview ? { roleReview: segment.roleReview } : {}),
    evidenceId: `live:${segment.id}`,
    routeId: 'live-realtime',
    routeKind: 'live',
    engine: 'live-funasr',
    ...(segment.audioSource ? { audioSource: segment.audioSource } : {}),
    rawSegmentId: segment.id,
    speakerConfirmed: segment.speakerConfirmed === true,
    speakerId: segment.speakerId,
    role: segment.role,
    confidence: segment.confidence,
    text: segment.text,
    startMs: segment.startMs,
    endMs: segment.endMs,
    roleReasons: ['live_realtime_evidence'],
  }))
}

export function rawSegmentsToEvidence(segments: RawTranscriptSegment[]): TranscriptEvidenceSegment[] {
  return segments.map(segment => ({
    ...(segment.roleReview ? { roleReview: segment.roleReview } : {}),
    evidenceId: `live:${segment.id}`,
    routeId: 'live-realtime',
    routeKind: 'live',
    engine: 'live-funasr',
    ...(segment.audioSource ? { audioSource: segment.audioSource } : {}),
    rawSegmentId: segment.id,
    speakerConfirmed: segment.speakerConfirmed === true,
    speakerId: segment.speakerId,
    role: segment.role,
    confidence: segment.confidence,
    text: segment.text,
    startMs: segment.startMs,
    endMs: segment.endMs,
    roleReasons: ['live_realtime_evidence'],
  }))
}

function durationLabel(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`
}

export function transcriptCoverageWarning(
  sessionDurationMs: number,
  manifest: InterviewAudioManifestEntry[],
): string | undefined {
  const audioEndMs = Math.max(0, ...manifest.map(row => row.endMs ?? row.offsetMs))
  const missingMs = sessionDurationMs - audioEndMs
  if (audioEndMs <= 0 || missingMs <= 60_000) return undefined
  return `原始录音只覆盖到本场第 ${durationLabel(audioEndMs)}，距面试结束还有约 ${durationLabel(missingMs)} 没有原音频证据；该部分不会被推测补写。`
}

export function rawSnapshotFingerprint(
  segments: RawTranscriptSegment[],
  manifest: InterviewAudioManifestEntry[],
  sessionDurationMs = 0,
): string {
  return createHash('sha256').update(JSON.stringify({
    version: 3,
    sessionDurationMs,
    segments: segments.map(row => [row.id, row.speakerId, row.role, row.confidence, row.text, row.startMs, row.endMs,
      row.audioSource ?? null, row.audioObjectKey ?? null, row.transcriptComparison ?? null, row.speakerConfirmed === true,
      ...(row.roleReview ? [row.roleReview] : [])]),
    recordings: manifest.map(row => [row.id, row.objectKey, row.offsetMs, row.endMs, row.byteLength, row.audioSource ?? null,
      row.sourceRole ?? null, row.sourceMultipleSpeakers ?? null]),
  })).digest('hex')
}

export function correctedContentFingerprint(turns: CorrectedTranscriptTurn[], corrections: TranscriptCorrection[],
  uncertainties: TranscriptUncertainty[], warnings: string[], roleReviewRequired = false): string {
  return createHash('sha256').update(JSON.stringify({ turns, corrections, uncertainties, warnings, roleReviewRequired })).digest('hex')
}
