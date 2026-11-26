import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mapInterviewRoles, scopeSpeakersToChunk, stableRoleSpeakerId } from './role-mapper.js'

describe('interview speaker role mapping', () => {
  it('uses opening question and speaker continuity to map interviewer and candidate', () => {
    const result = mapInterviewRoles([
      { id: 's1', speakerId: 'speaker_0', text: '你好，请先做一下自我介绍。', startMs: 0, endMs: 3200 },
      { id: 's2', speakerId: 'speaker_1', text: '我有五年后端开发经验，主要负责订单系统。', startMs: 3600, endMs: 9200 },
      { id: 's3', speakerId: 'speaker_1', text: '我在项目中使用 PostgreSQL 解决了查询性能问题。', startMs: 9500, endMs: 14200 },
    ], {})
    assert.equal(result[0]?.role, 'interviewer')
    assert.equal(result[1]?.role, 'candidate')
    assert.equal(result[2]?.role, 'candidate')
    assert.ok((result[2]?.confidence ?? 0) >= 0.8)
  })


  it('scopes FunASR speaker labels to each independently uploaded chunk', () => {
    const source = [{ id: 's1', speakerId: 'speaker_0', text: '请介绍一下。', startMs: 0, endMs: 1200 }]
    const first = scopeSpeakersToChunk(source, 0)
    const second = scopeSpeakersToChunk(source, 5000)
    assert.equal(first[0]?.speakerId, 'chunk_0:speaker_0')
    assert.equal(second[0]?.speakerId, 'chunk_5000:speaker_0')
    assert.notEqual(first[0]?.speakerId, second[0]?.speakerId)
  })

  it('classifies answer-like utterances from their content, not reused local speaker ids', () => {
    const firstChunk = scopeSpeakersToChunk([
      { id: 'q', speakerId: 'speaker_0', text: '请介绍一下你的工作经历？', startMs: 0, endMs: 2000 },
    ], 0)
    const secondChunk = scopeSpeakersToChunk([
      { id: 'a', speakerId: 'speaker_0', text: '那个月我当时做了运营活动。', startMs: 0, endMs: 2500 },
    ], 5000)
    const firstRole = mapInterviewRoles(firstChunk, {})
    const secondRole = mapInterviewRoles(secondChunk, { [firstChunk[0]!.speakerId]: 'interviewer' })
    assert.equal(firstRole[0]?.role, 'interviewer')
    assert.equal(secondRole[0]?.role, 'candidate')
  })


  it('does not replace different acoustic identities with the same role identity', () => {
    assert.equal(stableRoleSpeakerId({ speakerId: 'chunk_0:speaker_0', role: 'candidate' }), 'chunk_0:speaker_0')
    assert.equal(stableRoleSpeakerId({ speakerId: 'voice_a', role: 'candidate' }), 'voice_a')
    assert.equal(stableRoleSpeakerId({ speakerId: 'chunk_15000:speaker_1', role: 'unknown' }), 'chunk_15000:speaker_1')
  })

  it('leaves utterances without clear question or answer cues for manual confirmation', () => {
    const [result] = mapInterviewRoles([
      { id: 's6', speakerId: 'chunk_0:speaker_0', text: '嗯，好的。', startMs: 0, endMs: 500 },
    ], {})
    assert.equal(result?.role, 'unknown')
    assert.ok((result?.confidence ?? 1) < 0.6)
  })

  it('does not swap a confirmed candidate merely because they ask a question', () => {
    const [result] = mapInterviewRoles([
      { id: 's4', speakerId: 'speaker_1', text: '这个岗位的团队规模大概是多少？', startMs: 0, endMs: 2100 },
    ], { speaker_1: 'candidate' })
    assert.equal(result?.role, 'candidate')
  })

  it('marks ambiguous extra speakers as unknown', () => {
    const [result] = mapInterviewRoles([
      { id: 's5', speakerId: 'speaker_2', text: '好的。', startMs: 0, endMs: 500 },
    ], { speaker_0: 'interviewer', speaker_1: 'candidate' })
    assert.equal(result?.role, 'unknown')
    assert.ok((result?.confidence ?? 1) < 0.6)
  })

  it('keeps a mixed question and answer unknown even for a previously confirmed voice', () => {
    const [result] = mapInterviewRoles([
      { id: 'mixed', speakerId: 'voice_a', text: '你是怎么做意图识别的？意图识别就是首先用户有一个问题。', startMs: 0, endMs: 12000 },
    ], { voice_a: 'candidate' })
    assert.equal(result?.role, 'unknown')
    assert.ok(result!.confidence < 0.6)
  })

  it('rejects an acoustically mixed or unverified sentence regardless of its semantic cues', () => {
    for (const flags of [{ speakerMixed: true }, { speakerVerified: false }]) {
      const [result] = mapInterviewRoles([
        { id: 'mixed', speakerId: 'voice_a', text: '我负责整个项目的实现。', startMs: 0, endMs: 2000, ...flags },
      ], { voice_a: 'candidate' })
      assert.equal(result?.role, 'unknown')
    }
  })

  it('does not inherit the first guess when one local speaker contains conflicting role evidence', () => {
    const result = mapInterviewRoles([
      { id: 'q', speakerId: 'speaker_0', text: '请介绍一下你的经历？', startMs: 0, endMs: 2000 },
      { id: 'a', speakerId: 'speaker_0', text: '我负责招聘系统。', startMs: 2100, endMs: 5000 },
    ], {})
    assert.deepEqual(result.map(row => row.role), ['unknown', 'unknown'])
  })

  it('preserves acoustic IDs across chunks without promoting role guesses to human confirmation', () => {
    const [segment] = scopeSpeakersToChunk([{ id: 'a', speakerId: 'voice_a', text: '接着继续说明。', startMs: 0, endMs: 2000 }], 15000)
    const [result] = mapInterviewRoles([segment!], {}, { voice_a: 'candidate' })
    assert.equal(result?.speakerId, 'voice_a')
    assert.equal(result?.role, 'candidate')
    assert.equal(result?.confidence, 0.82)
    assert.deepEqual(result?.reasons, ['inferred_speaker_continuity'])
  })

  it('keeps a verified candidate voice when they ask about the employer', () => {
    const [result] = mapInterviewRoles([
      { id: 'q', speakerId: 'voice_a', text: '这个岗位的团队规模是多少？', startMs: 0, endMs: 2000, speakerVerified: true },
    ], {}, { voice_a: 'candidate' })
    assert.equal(result?.role, 'candidate')
    assert.equal(result?.confidence, 0.82)
    assert.deepEqual(result?.reasons, ['inferred_speaker_continuity'])
  })

  it('recognizes the candidate speaking first instead of assigning roles by turn order', () => {
    const result = mapInterviewRoles([
      { id: 'a', speakerId: 'voice_a', text: '我来应聘后端开发岗位。', startMs: 0, endMs: 1800, speakerVerified: true },
      { id: 'q', speakerId: 'voice_b', text: '我是今天的面试官，我主要负责研发团队。', startMs: 2000, endMs: 4000, speakerVerified: true },
    ], {})
    assert.deepEqual(result.map(row => row.role), ['candidate', 'interviewer'])
    assert.ok(result.every(row => row.confidence < 1))
  })

  it('uses opening role anchors for verified voices throughout the chunk, including earlier greetings', () => {
    const result = mapInterviewRoles([
      { id: 'g', speakerId: 'voice_a', text: '你好。', startMs: 0, endMs: 500, speakerVerified: true },
      { id: 'q', speakerId: 'voice_a', text: '请介绍一下你的工作经历？', startMs: 600, endMs: 2200, speakerVerified: true },
      { id: 'a', speakerId: 'voice_b', text: '我有五年后端开发经验。', startMs: 2400, endMs: 4400, speakerVerified: true },
      { id: 'reverse', speakerId: 'voice_b', text: '你们采用什么开发语言？', startMs: 4500, endMs: 6000, speakerVerified: true },
      { id: 'company', speakerId: 'voice_a', text: '我们使用 Java，也参与开源项目。', startMs: 6100, endMs: 8000, speakerVerified: true },
    ], {})
    assert.deepEqual(result.map(row => row.role), ['interviewer', 'interviewer', 'candidate', 'candidate', 'interviewer'])
  })

  it('interprets a short factual answer using the preceding verified interviewer question', () => {
    const result = mapInterviewRoles([
      { id: 'q', speakerId: 'voice_a', text: '你工作了几年？', startMs: 0, endMs: 2000, speakerVerified: true },
      { id: 'a', speakerId: 'voice_b', text: '五年。', startMs: 2200, endMs: 3500, speakerVerified: true },
    ], {})
    assert.equal(result[1]?.role, 'candidate')
    assert.deepEqual(result[1]?.reasons, ['opening_answer_context'])
  })

  it('does not transfer question context across sources, overlaps, long gaps, or unverified speech', () => {
    for (const flags of [{ audioSource: 'meeting' as const }, { startMs: 1500 }, { startMs: 15000, endMs: 16000 }, { speakerVerified: false }]) {
      const result = mapInterviewRoles([
        { id: 'q', speakerId: 'voice_a', text: '你工作了几年？', startMs: 0, endMs: 2000, audioSource: 'microphone', speakerVerified: true },
        { id: 'a', speakerId: 'voice_b', text: '五年。', startMs: 2200, endMs: 3500, audioSource: 'microphone', speakerVerified: true, ...flags },
      ], {})
      assert.equal(result[1]?.role, 'unknown')
    }
  })

  it('does not treat a neutral second speaker as the candidate just because they reply', () => {
    const result = mapInterviewRoles([
      { id: 'q', speakerId: 'voice_a', text: '请先做一下自我介绍。', startMs: 0, endMs: 2000, speakerVerified: true },
      { id: 'g', speakerId: 'voice_b', text: '好的。', startMs: 2200, endMs: 3000, speakerVerified: true },
    ], {})
    assert.equal(result[1]?.role, 'unknown')
  })

  it('does not flip a known interviewer voice when explaining their company', () => {
    const [result] = mapInterviewRoles([
      { id: 'a', speakerId: 'microphone:voice_a', text: '我负责研发团队，我们使用 Java。', startMs: 0, endMs: 2000, speakerVerified: true },
    ], {}, { 'microphone:voice_a': 'interviewer' })
    assert.equal(result?.role, 'interviewer')
    assert.deepEqual(result?.reasons, ['inferred_speaker_continuity'])
  })

  it('keeps stable roles for a candidate requesting a company introduction and an interviewer sharing experience', () => {
    const result = mapInterviewRoles([
      { id: 'q', speakerId: 'voice_a', text: '请介绍一下你们团队的项目？', startMs: 0, endMs: 2000, speakerVerified: true },
      { id: 'a', speakerId: 'voice_b', text: '我有十年研发经验，我之前在技术部带团队。', startMs: 2100, endMs: 4000, speakerVerified: true },
    ], {}, { voice_a: 'candidate', voice_b: 'interviewer' })
    assert.deepEqual(result.map(row => row.role), ['candidate', 'interviewer'])
  })

  it('leaves strong contradictory identity evidence unresolved instead of silently changing a voice role', () => {
    const [result] = mapInterviewRoles([
      { id: 'a', speakerId: 'voice_a', text: '我是今天的面试官。', startMs: 0, endMs: 2000, speakerVerified: true },
    ], {}, { voice_a: 'candidate' })
    assert.equal(result?.role, 'unknown')
    assert.deepEqual(result?.reasons, ['speaker_role_conflict'])
  })

  it('does not let an unverified question poison a verified candidate voice in the same chunk', () => {
    const result = mapInterviewRoles([
      { id: 'bad', speakerId: 'voice_a', text: '请介绍一下你的经历？', startMs: 0, endMs: 2000, speakerVerified: false },
      { id: 'a', speakerId: 'voice_a', text: '我有五年开发经验。', startMs: 2200, endMs: 4000, speakerVerified: true },
    ], {})
    assert.deepEqual(result.map(row => row.role), ['unknown', 'candidate'])
  })

  it('preserves manual corrections even when the same voice asks questions and describes experience', () => {
    const result = mapInterviewRoles([
      { id: 'q', speakerId: 'voice_a', text: '请介绍一下你的经历？', startMs: 0, endMs: 2000, speakerVerified: true },
      { id: 'a', speakerId: 'voice_a', text: '我有五年开发经验。', startMs: 2200, endMs: 4000, speakerVerified: true },
    ], { voice_a: 'candidate' })
    assert.ok(result.every(row => row.role === 'candidate' && row.confidence === 1))
  })
})
