import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { consolidateTranscript, rawSegmentsToEvidence, rawSnapshotFingerprint, correctedContentFingerprint, reviewRoleBoundaries, transcriptCoverageWarning, transcriptRoleReviewWarning, type CorrectedTranscriptTurn, type TranscriptEvidenceSegment } from './transcript-postprocessing.js'
import type { InterviewAudioManifestEntry } from './audio-recording-repository.js'

function evidence(id: string, routeId: string, text: string, startMs = 1000, endMs = 3000,
  role: TranscriptEvidenceSegment['role'] = 'candidate', confidence = .9): TranscriptEvidenceSegment {
  return { evidenceId: id, routeId, routeKind: routeId.startsWith('offline') ? 'offline' : 'live',
    engine: routeId.includes('faster-whisper') ? 'faster-whisper' : 'funasr', speakerId: 'voice-1', role,
    confidence, text, startMs, endMs, audioSource: routeId.includes('meeting') ? 'meeting' : 'microphone' }
}

describe('multi-route transcript consolidation', () => {
  const mixed: InterviewAudioManifestEntry = {
    id: 'audio-1', sessionId: 'session-1', sessionStartedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z',
    objectKey: 'audio-1', offsetMs: 0, endMs: 90_000, byteLength: 100, contentType: 'audio/webm',
    audioSource: 'microphone', sourceMultipleSpeakers: true, sourceRole: 'unknown',
  }
  const reviewedTurn = (speakerConfirmed = false): CorrectedTranscriptTurn => ({
    id: 'turn-1', speakerId: 'voice-1', role: 'candidate', confidence: 1, text: '我负责开发。',
    startMs: 1000, endMs: 2000, audioSource: 'microphone', evidenceIds: ['live:1'], roleReasons: [], speakerConfirmed,
  })

  it('requires manual speaker review on mixed audio even with high automatic confidence', () => {
    assert.match(transcriptRoleReviewWarning([mixed], [reviewedTurn()])!, /1 段.*暂不评分/u)
    assert.match(transcriptRoleReviewWarning([{ ...mixed, sourceRole: 'candidate' }], [reviewedTurn()])!, /人工确认/u)
  })

  it('treats legacy recordings without source metadata as needing review', () => {
    const { sourceRole, sourceMultipleSpeakers, ...legacy } = mixed
    assert.ok(transcriptRoleReviewWarning([legacy], [reviewedTurn()]))
  })

  it('allows reviewed mixed speech and explicitly separate single-person sources', () => {
    assert.equal(transcriptRoleReviewWarning([mixed], [reviewedTurn(true)]), undefined)
    assert.equal(transcriptRoleReviewWarning([{ ...mixed, sourceRole: 'candidate', sourceMultipleSpeakers: false }], [reviewedTurn()]), undefined)
    assert.equal(transcriptRoleReviewWarning([mixed], []), undefined)
  })

  it('does not apply an unrelated mixed source or recording interval to a turn', () => {
    assert.equal(transcriptRoleReviewWarning([{ ...mixed, audioSource: 'meeting' }], [reviewedTurn()]), undefined)
    assert.equal(transcriptRoleReviewWarning([{ ...mixed, offsetMs: 3000 }], [reviewedTurn()]), undefined)
    assert.equal(transcriptRoleReviewWarning([{ ...mixed, endMs: 1000 }], [reviewedTurn()]), undefined)
  })

  it('does not treat unknown or low-confidence roles as confirmed', () => {
    assert.ok(transcriptRoleReviewWarning([mixed], [{ ...reviewedTurn(true), role: 'unknown' }]))
    assert.ok(transcriptRoleReviewWarning([mixed], [{ ...reviewedTurn(true), confidence: .35 }]))
  })

  it('preserves manual confirmation through raw evidence, consolidation and role review', () => {
    const raw = { ...reviewedTurn(true), text: '请介绍你负责的项目？我负责开发。' }
    const result = consolidateTranscript([], rawSegmentsToEvidence([raw]))
    assert.equal(result.turns.length, 1)
    assert.equal(result.turns[0]!.role, 'candidate')
    assert.equal(result.turns[0]!.speakerConfirmed, true)
    assert.equal(transcriptRoleReviewWarning([mixed], result.turns), undefined)
  })

  it('invalidates fingerprints when manual confirmation or review state changes', () => {
    assert.notEqual(rawSnapshotFingerprint([reviewedTurn()], [mixed]), rawSnapshotFingerprint([reviewedTurn(true)], [mixed]))
    assert.notEqual(correctedContentFingerprint([], [], [], [], false), correctedContentFingerprint([], [], [], [], true))
  })

  it('merges duplicate display turns while retaining every route as evidence', () => {
    const result = consolidateTranscript([
      evidence('mic-funasr', 'offline:microphone:funasr', '我负责招聘系统的后端开发。'),
      evidence('meeting-funasr', 'offline:meeting:funasr', '我负责招聘系统后端开发。', 1050, 3050),
    ], [
      evidence('live', 'live-realtime', '我负责招聘系统的后端开发。', 950, 3100),
    ])

    assert.equal(result.turns.length, 1)
    assert.deepEqual(new Set(result.turns[0]!.evidenceIds), new Set(['mic-funasr', 'meeting-funasr', 'live']))
    assert.deepEqual(new Set(result.evidence.map(row => row.evidenceId)), new Set(['mic-funasr', 'meeting-funasr', 'live']))
    assert.ok(result.turns[0]!.roleReasons.includes('multi_route_agreement'))
  })

  it('uses the reviewed live turn as the anchor when offline engines segment and classify it differently', () => {
    const result = consolidateTranscript([
      evidence('long-offline', 'offline:microphone:funasr',
        '好，我们现在就开始我们今天的一个线上面试。', 13100, 17000, 'unknown'),
      evidence('short-offline', 'offline:meeting:faster-whisper',
        '现在开始。', 14500, 16400, 'candidate'),
    ], [
      evidence('live-anchor', 'live-realtime', '好，我们现在就开始。', 13260, 16500, 'interviewer', .99),
    ])

    assert.equal(result.turns.length, 1)
    assert.equal(result.turns[0]!.role, 'interviewer')
    assert.equal(result.turns[0]!.text, '好，我们现在就开始。')
    assert.deepEqual(new Set(result.turns[0]!.evidenceIds),
      new Set(['live-anchor', 'long-offline', 'short-offline']))
    assert.ok(result.turns[0]!.roleReasons.includes('live_time_anchor'))
    assert.ok(result.turns[0]!.roleReasons.includes('multi_route_agreement'))
  })

  it('keeps offline speech outside every live anchor as a separate turn', () => {
    const result = consolidateTranscript([
      evidence('late-offline', 'offline:microphone:funasr', '这是实时字幕没有覆盖的补充发言。', 20000, 23000, 'candidate'),
    ], [
      evidence('earlier-live', 'live-realtime', '请介绍一下你的项目。', 1000, 3000, 'interviewer', .99),
    ])

    assert.equal(result.turns.length, 2)
    assert.deepEqual(result.turns.map(turn => turn.text), ['请介绍一下你的项目。', '这是实时字幕没有覆盖的补充发言。'])
  })

  it('preserves a possible mixed question and answer for semantic review without invented timestamps', () => {
    const original = evidence('mixed', 'live-realtime', '请介绍一下你的项目？我负责后端开发和上线。', 0, 5000, 'interviewer', .8)
    const result = consolidateTranscript([], [original])

    assert.equal(result.turns.length, 1)
    assert.equal(result.turns[0]!.text, original.text)
    assert.equal(result.turns[0]!.startMs, original.startMs)
    assert.equal(result.turns[0]!.endMs, original.endMs)
    assert.ok(result.evidence.some(row => row.evidenceId === 'mixed' && row.text === original.text))
    assert.equal(result.evidence.filter(row => row.derivedFromEvidenceId === 'mixed').length, 0)
    assert.ok(result.turns.every(turn => turn.evidenceIds.includes('mixed')))
  })

  it('does not fabricate speaker changes inside a connection check', () => {
    const original = evidence('connection-check', 'live-realtime',
      '喂，能听到吗？能听到。嗯，你现在是已经毕业了是吧？', 0, 6000, 'interviewer', .8)
    const result = consolidateTranscript([], [original])

    assert.equal(result.turns.length, 1)
    assert.equal(result.turns[0]!.text, original.text)
    assert.equal(result.turns[0]!.startMs, 0)
    assert.equal(result.turns[0]!.endMs, 6000)
    assert.equal(result.evidence.filter(row => row.derivedFromEvidenceId === 'connection-check').length, 0)
  })

  it('does not invent a candidate reply from consecutive questions', () => {
    const original = evidence('only-questions', 'live-realtime',
      '喂，能听到吗？你现在能听清吗？', 0, 4000, 'interviewer', .8)
    const result = consolidateTranscript([], [original])

    assert.equal(result.turns.length, 1)
    assert.equal(result.turns[0]!.role, 'interviewer')
    assert.equal(result.turns[0]!.text, original.text)
    assert.equal(result.evidence.filter(row => row.derivedFromEvidenceId === 'only-questions').length, 0)
  })

  it('keeps a multi-sentence interview instruction in one interviewer turn', () => {
    const original = evidence('intro-instruction', 'live-realtime',
      '首先请您做一下自我介绍。自我介绍部分请您侧重于之前的工作经历，具体展开讲一下。然后如果您方便的话，可以开始了。',
      0, 13_690, 'interviewer', .8)
    const result = consolidateTranscript([], [original])

    assert.equal(result.turns.length, 1)
    assert.equal(result.turns[0]!.role, 'interviewer')
    assert.equal(result.turns[0]!.text, original.text)
  })

  it('does not split a first-person phrase inside an interviewer question', () => {
    const original = evidence('technical-stack-question', 'live-realtime',
      '你的技术栈不重合吗？我说的不是场景，我说的是技术栈。不是说场景重合，是说技术栈高度重合。',
      0, 18_500, 'interviewer', .8)
    const result = consolidateTranscript([], [original])

    assert.equal(result.turns.length, 1)
    assert.equal(result.turns[0]!.role, 'interviewer')
    assert.equal(result.turns[0]!.text, original.text)
  })

  it('uses an explicit question cue before a first-person phrase', () => {
    const [turn] = reviewRoleBoundaries([{ id: 'employment-question', speakerId: 'voice-1', role: 'unknown',
      confidence: .35, text: '我看你现在在克莱斯实习，那你现在是什么状态？属于离职状态吗？',
      startMs: 158_390, endMs: 168_630, evidenceIds: ['live:1'], roleReasons: [] }])

    assert.equal(turn!.role, 'interviewer')
    assert.ok(turn!.roleReasons.includes('reviewed_question_boundary'))
  })

  it('bridges short offline fragments into the adjacent realtime turn', () => {
    const result = consolidateTranscript([
      evidence('offline-prefix', 'offline:meeting:faster-whisper',
        'OK 我看了 我看你在之前', 206_900, 213_520, 'unknown'),
      evidence('offline-um', 'offline:meeting:funasr', '嗯，', 207_090, 207_535, 'unknown'),
      evidence('offline-ok', 'offline:meeting:funasr', 'OK，', 210_710, 211_090, 'unknown'),
      evidence('offline-look', 'offline:meeting:funasr', '我看你啊，', 211_090, 211_910, 'unknown'),
      evidence('offline-boundary', 'offline:meeting:funasr', '我看你在这之前，', 212_310, 213_830, 'unknown'),
    ], [
      evidence('previous-live', 'live-realtime', '要么就离职。', 198_720, 206_600, 'candidate', .99),
      evidence('next-live', 'live-realtime',
        'OK，我看你在这之前，就是你简历里写了三个项目。在我看来的话，它的技术应该是高度重合的呀。',
        213_730, 234_110, 'interviewer', .99),
    ])

    assert.deepEqual(result.turns.map(turn => turn.role), ['candidate', 'interviewer'])
    const interviewer = result.turns[1]!
    assert.deepEqual(new Set(interviewer.evidenceIds), new Set([
      'next-live', 'offline-prefix', 'offline-um', 'offline-ok', 'offline-look', 'offline-boundary',
    ]))
  })

  it('marks a content-role conflict uncertain instead of trusting it', () => {
    const [turn] = reviewRoleBoundaries([{ id: 'turn-1', speakerId: 'voice-1', role: 'candidate', confidence: .8,
      text: '请介绍你负责的项目。', startMs: 0, endMs: 1000, evidenceIds: ['live:1'], roleReasons: [] }])
    assert.equal(turn!.role, 'unknown')
    assert.equal(turn!.confidence, .35)
    assert.ok(turn!.roleReasons.includes('role_content_conflict'))
  })

  it('uses an explicit interviewer introduction over a conflicting realtime role', () => {
    const [turn] = reviewRoleBoundaries([{ id: 'opening-introduction', speakerId: 'live:1', role: 'candidate', confidence: .72,
      text: '我们今天是一个线上面试。然后我这边的话呢，是公司的人事；另外一位是我们公司技术部的负责人刘总。那我们今天主要是针对您专业技能这一块来进行沟通。',
      startMs: 16_690, endMs: 29_090, evidenceIds: ['live:1'], roleReasons: ['live_realtime_evidence'] }])

    assert.equal(turn!.role, 'interviewer')
    assert.equal(turn!.confidence, .9)
    assert.ok(turn!.roleReasons.includes('reviewed_interviewer_introduction'))
    assert.ok(turn!.roleReasons.includes('role_content_override'))
  })

  it('warns when the original audio ends well before the interview', () => {
    const warning = transcriptCoverageWarning(23 * 60_000 + 39_000, [{
      id: 'audio-1', sessionId: 'session-1', sessionStartedAt: '2026-01-01T00:00:00.000Z',
      offsetMs: 0, endMs: 5 * 60_000 + 22_000, byteLength: 100, contentType: 'audio/webm',
      createdAt: '2026-01-01T00:00:00.000Z', objectKey: 'audio-1', audioSource: 'microphone',
    }])

    assert.match(warning!, /5 分 22 秒/u)
    assert.match(warning!, /18 分 17 秒/u)
    assert.match(warning!, /不会被推测补写/u)
  })

  it('does not warn when original audio covers the full interview', () => {
    assert.equal(transcriptCoverageWarning(90_000, [{
      id: 'audio-1', sessionId: 'session-1', sessionStartedAt: '2026-01-01T00:00:00.000Z',
      offsetMs: 0, endMs: 89_000, byteLength: 100, contentType: 'audio/webm',
      createdAt: '2026-01-01T00:00:00.000Z', objectKey: 'audio-1', audioSource: 'microphone',
    }]), undefined)
  })
})
