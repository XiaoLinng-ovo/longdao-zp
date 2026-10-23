import { describe, expect, it } from 'vitest'
import { analysisMatchesUtterance, analysisSourceKey, analysisSourceSegments, buildUtterances, priorUtteranceContext } from './utterance-state'
import type { LiveAnswerAnalysis } from '../api'

describe('live interview utterance state', () => {
  it('restores interviewer refinements only for exact speech without candidate scoring', () => {
    const row = { id: 'q', sessionId: 's', role: 'interviewer' as const, speakerId: 'voice', confidence: 1, text: '请介绍项目。', startMs: 0, endMs: 1000, status: 'transcribed' as const }
    const group = buildUtterances([row], 20000, 15000)[0]!
    const result = { summary: '已整理', scores: [], evidence: [], concerns: [], nextQuestion: '', confidence: 1,
      sourceSegments: analysisSourceSegments(group), transcriptRefinement: { text: row.text, corrections: [], uncertainties: [] } } as unknown as LiveAnswerAnalysis
    expect(analysisMatchesUtterance(result, group)).toBe(true)
    for (const changed of [{ ...result, sourceSegments: undefined }, { ...result, transcriptRefinement: undefined },
      { ...result, scores: [{ dimension: '评分', score: 8, rationale: '错误' }] }, { ...result, nextQuestion: '下一题' }, { ...result, evidence: ['错误证据'] }]) {
      expect(analysisMatchesUtterance(changed, group)).toBe(false)
    }
    expect(analysisMatchesUtterance(result, buildUtterances([{ ...row, role: 'candidate' }], 20000, 15000)[0]!)).toBe(false)
    expect(analysisMatchesUtterance(result, buildUtterances([{ ...row, text: '修改后的提问' }], 20000, 15000)[0]!)).toBe(false)
  })
  it('ties refined answers to exact raw membership and invalidates changed speech or identity', () => {
    const a = { id: 'a', sessionId: 's', role: 'candidate' as const, speakerId: 'voice', confidence: 1, text: '第一段，嗯嗯嗯。', startMs: 0, endMs: 1000, status: 'transcribed' as const }
    const b = { ...a, id: 'b', text: '第二段。', startMs: 1000, endMs: 2000 }
    const group = buildUtterances([a, b], 20000, 15000)[0]!
    const sourceSegments = analysisSourceSegments(group)
    const result = { sourceSegments, transcriptRefinement: { text: '第一段和第二段。', corrections: [], uncertainties: [] } } as unknown as LiveAnswerAnalysis
    expect(sourceSegments.map(row => row.text)).toEqual([a.text, b.text])
    expect(analysisMatchesUtterance(result, group)).toBe(true)
    expect(analysisSourceKey(sourceSegments)).not.toEqual(analysisSourceKey([...sourceSegments].reverse()))
    for (const rows of [[a], [a, { ...b, text: '新内容。' }], [a, { ...b, speakerId: 'other' }], [a, { ...b, role: 'interviewer' as const }], [a, b, { ...b, id: 'c', startMs: 2000, endMs: 3000 }]]) {
      expect(analysisMatchesUtterance(result, buildUtterances(rows, 20000, 15000)[0]!)).toBe(false)
    }
    expect(analysisMatchesUtterance({} as LiveAnswerAnalysis, group)).toBe(false)
    const single = buildUtterances([a], 20000, 15000)[0]!
    expect(analysisMatchesUtterance({} as LiveAnswerAnalysis, single)).toBe(true)
    expect(analysisMatchesUtterance({ transcriptRefinement: result.transcriptRefinement } as LiveAnswerAnalysis, single)).toBe(false)
    expect(analysisMatchesUtterance(result, { ...group, confidence: .3 })).toBe(false)
  })
  it('merges five minutes of manually confirmed speech with different acoustic identities without changing originals', () => {
    const source = Array.from({ length: 20 }, (_, index) => ({
      id: `confirmed-${index}`, sessionId: 's', speakerId: `chunk-${index}:voice_0`,
      role: 'candidate' as const, speakerConfirmed: true, confidence: 1,
      text: `第${index + 1}部分。`, startMs: index * 15_000, endMs: (index + 1) * 15_000,
      status: 'transcribed' as const, audioSource: 'microphone' as const,
    }))
    const snapshot = structuredClone(source)
    const result = buildUtterances([...source].reverse(), 315_000, 15_000)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ speakerConfirmed: true, startMs: 0, endMs: 300_000, final: true })
    expect(result[0]?.text).toBe(source.map(row => row.text).join(''))
    expect(result[0]?.sourceIds).toEqual(source.map(row => row.id))
    expect(result[0]?.sourceSegments).toEqual(snapshot)
    expect(source).toEqual(snapshot)
  })

  it('does not treat automatic confidence of one or a partially confirmed group as manual confirmation', () => {
    const first = { id: 'a', sessionId: 's', speakerId: 'voice_a', role: 'candidate' as const, confidence: 1, text: '第一段', startMs: 0, endMs: 1000, status: 'transcribed' as const }
    const second = { ...first, id: 'b', startMs: 1000, endMs: 2000, speakerConfirmed: true }
    const third = { ...second, id: 'c', speakerId: 'voice_b', startMs: 2000, endMs: 3000 }
    expect(buildUtterances([first, { ...third, speakerConfirmed: false }], 20000, 15000)).toHaveLength(2)
    const result = buildUtterances([first, second, third], 20000, 15000)
    expect(result.map(row => row.sourceIds)).toEqual([['a', 'b'], ['c']])
    expect(result[0]?.speakerConfirmed).toBe(false)
  })

  it('keeps confirmed speech separate across interruptions, sources, sessions, overlaps and long pauses', () => {
    const first = { id: 'a', sessionId: 's', speakerId: 'voice_a', role: 'candidate' as const, confidence: 1, speakerConfirmed: true, text: '第一段', startMs: 0, endMs: 1000, status: 'transcribed' as const, audioSource: 'microphone' as const }
    const next = { ...first, id: 'b', speakerId: 'voice_b', startMs: 3000, endMs: 4000 }
    for (const boundary of [{ ...next, audioSource: 'meeting' as const }, { ...next, sessionId: 'other' }, { ...next, startMs: 500 }, { ...next, startMs: 17000, endMs: 18000 }]) {
      expect(buildUtterances([first, boundary], 40000, 15000)).toHaveLength(2)
    }
    for (const role of ['interviewer', 'unknown'] as const) {
      const interruption = { ...first, id: 'interrupt', role, startMs: 1000, endMs: 2000 }
      expect(buildUtterances([first, interruption, next], 40000, 15000)).toHaveLength(3)
    }
  })

  it('limits each merged group to the analysis API maximum of 100 source fragments', () => {
    const source = Array.from({ length: 101 }, (_, index) => ({
      id: `part-${index}`, sessionId: 's', speakerId: `voice_${index}`, role: 'candidate' as const,
      speakerConfirmed: true, confidence: 1, text: '回答。', startMs: index * 1000,
      endMs: (index + 1) * 1000, status: 'transcribed' as const,
    }))
    expect(buildUtterances(source, 120000, 15000).map(row => row.sourceIds.length)).toEqual([100, 1])
  })
  it('marks simultaneous sources as overlapping and keeps their order stable when responses arrive out of order', () => {
    const first = {id:'a',sessionId:'s',speakerId:'microphone:one',audioSource:'microphone' as const,role:'interviewer' as const,confidence:1,text:'你负责了哪些项目，具体做了什么？',startMs:0,endMs:2000,status:'transcribed' as const}
    const second = {...first,id:'b',speakerId:'meeting:one',audioSource:'meeting' as const,role:'candidate' as const,text:'我负责了项目开发，然后进行了测试。',startMs:1000,endMs:3000}
    const result = buildUtterances([second,first],10000,1600)
    expect(result.map(row=>[row.id,row.overlapping])).toEqual([['a',true],['b',true]])
    expect(result[0]?.text).toBe(first.text); expect(result[1]?.text).toBe(second.text)
    expect(buildUtterances([first,second],10000,1600)).toEqual(result)
    expect('overlapping' in first).toBe(false)
    const tied = {...second,startMs:0,endMs:2000}
    expect(buildUtterances([tied,first],10000,1600).map(row=>row.id)).toEqual(['a','b'])
  })
  const speech = (id: string, text: string, startMs: number, endMs: number, role: 'candidate' | 'interviewer' | 'unknown' = 'unknown') => ({
    id, text, startMs, endMs, role, sessionId: 's', speakerId: `voice_${role}`, confidence: .9, status: 'transcribed' as const,
  })

  it('keeps uncertain and overlapping segments separate instead of hiding their boundaries', () => {
    expect(buildUtterances([speech('a', '提问', 0, 1000), speech('b', '回答', 1000, 2000)], 20000, 15000)).toHaveLength(2)
    expect(buildUtterances([speech('a', '第一段', 0, 2000, 'candidate'), speech('b', '交叠段', 1000, 3000, 'candidate')], 20000, 15000)).toHaveLength(2)
    expect(buildUtterances([{ ...speech('a', '不确定', 0, 1000, 'candidate'), confidence: .35 }, speech('b', '回答', 1000, 2000, 'candidate')], 20000, 15000)).toHaveLength(2)
  })

  it('shows historical Traditional text in Simplified without changing source records or roles', () => {
    const source = [speech('old', '對於學校的項目，然後提交發票。', 1000, 2500, 'candidate')]
    const result = buildUtterances(source, 10000, 1000)
    expect(result[0]).toMatchObject({ id: 'old', text: '对于学校的项目，然后提交发票。', startMs: 1000, endMs: 2500, role: 'candidate', sourceIds: ['old'] })
    expect(source[0]?.text).toBe('對於學校的項目，然後提交發票。')
  })

  it('orders late network results by audio time without mixing question-answer topics', () => {
    const source = [
      speech('school-answer', '答辩时需要回学校。', 9000, 11000, 'candidate'),
      speech('project-answer', '我负责了项目开发。', 3000, 5000, 'candidate'),
      speech('school-question', '没毕业还要回学校吗？', 6000, 8000, 'interviewer'),
      speech('project-question', '介绍一下你的项目？', 0, 2000, 'interviewer'),
    ]
    const result = buildUtterances(source, 20000, 15000)
    expect(result.map(row => row.id)).toEqual(['project-question', 'project-answer', 'school-question', 'school-answer'])
    expect(result.map(row => row.sourceIds)).toEqual([['project-question'], ['project-answer'], ['school-question'], ['school-answer']])
    expect(source[0]?.id).toBe('school-answer')
    expect(priorUtteranceContext(result, 'project-answer')).toEqual(['面试官：介绍一下你的项目？'])
    expect(priorUtteranceContext(result, 'school-answer')).toEqual(['面试官：介绍一下你的项目？', '候选人：我负责了项目开发。', '面试官：没毕业还要回学校吗？'])
    expect(priorUtteranceContext(result, 'missing')).toEqual([])
  })

  it('excludes overlapping speech and the analyzed answer itself from prior context', () => {
    const result = buildUtterances([
      speech('earlier', '之前的提问', 0, 1000, 'interviewer'),
      speech('overlap', '交叠的发言', 2000, 7000),
      speech('answer', '正在分析的回答', 3000, 5000, 'candidate'),
      speech('continuation', '回答的后续', 5100, 6000, 'candidate'),
    ], 20000, 1600)
    expect(priorUtteranceContext(result, 'continuation')).toEqual(['面试官：之前的提问'])
  })

  it('does not merge speech with a missing speaker identity or from different sessions', () => {
    const result = buildUtterances([
      { ...speech('a', '第一段', 0, 1000, 'candidate'), speakerId: '' },
      { ...speech('b', '第二段', 1100, 2000, 'candidate'), speakerId: '' },
      speech('c', '第三段', 2100, 3000, 'candidate'),
      { ...speech('d', '其他会话', 3100, 4000, 'candidate'), sessionId: 'other' },
    ], 20000, 15000)
    expect(result).toHaveLength(4)
  })

  it('limits context to the eight preceding turns, never the most recent eight future turns', () => {
    const rows = Array.from({ length: 20 }, (_, index) => speech(String(index), `发言${index}`, index * 2000, index * 2000 + 1000, index % 2 ? 'candidate' : 'interviewer'))
    const result = buildUtterances(rows, 50000, 1600)
    expect(priorUtteranceContext(result, '10')).toEqual(result.slice(2, 10).map(row => `${row.role === 'candidate' ? '候选人' : '面试官'}：${row.text}`))
  })

  it('never joins different acoustic speakers merely because their guessed roles are equal', () => {
    const result = buildUtterances([
      { id: 'a', sessionId: 's', speakerId: 'voice_a', role: 'candidate', confidence: .82, text: '这是提问。', startMs: 0, endMs: 1000, status: 'transcribed' },
      { id: 'b', sessionId: 's', speakerId: 'voice_b', role: 'candidate', confidence: .82, text: '这是回答。', startMs: 1000, endMs: 2000, status: 'transcribed' },
    ], 4000, 1600)
    expect(result).toHaveLength(2)
    expect(result[0]?.sourceIds).toEqual(['a'])
    expect(result[1]?.sourceIds).toEqual(['b'])
  })

  it('keeps unknown speech separate from a recognized answer by the same voice', () => {
    const result = buildUtterances([
      { id: 'a', sessionId: 's', speakerId: 'voice_a', role: 'unknown', confidence: .35, text: '混合片段。', startMs: 0, endMs: 1000, status: 'transcribed' },
      { id: 'b', sessionId: 's', speakerId: 'voice_a', role: 'candidate', confidence: .82, text: '候选人的完整回答。', startMs: 1000, endMs: 2000, status: 'transcribed' },
    ], 4000, 1600)
    expect(result).toHaveLength(2)
    expect(result.map(row => row.role)).toEqual(['unknown', 'candidate'])
  })

  it('finalizes the latest candidate answer after silence without waiting for another speaker', () => {
    const result = buildUtterances([
      { id: 'a', sessionId: 's', speakerId: 'speaker_1', role: 'candidate', confidence: .9, text: '完整回答。', startMs: 0, endMs: 3000, status: 'transcribed' },
    ], 5000, 1600)
    expect(result[0]?.final).toBe(true)
  })

  it('keeps the latest answer open before the silence threshold', () => {
    const result = buildUtterances([
      { id: 'a', sessionId: 's', speakerId: 'speaker_1', role: 'candidate', confidence: .9, text: '仍在回答', startMs: 0, endMs: 3000, status: 'transcribed' },
    ], 4200, 1600)
    expect(result[0]?.final).toBe(false)
  })


  it('joins short same-role fragments across independently recorded chunks', () => {
    const result = buildUtterances([
      { id: 'a', sessionId: 's', speakerId: 'role_candidate', role: 'candidate', confidence: .82, text: '假设你需要整理一份', startMs: 14000, endMs: 15000, status: 'transcribed' },
      { id: 'b', sessionId: 's', speakerId: 'role_candidate', role: 'candidate', confidence: .82, text: '包含用户数量和渠道来源的数据表。', startMs: 15080, endMs: 17600, status: 'transcribed' },
    ], 20000, 1600)
    expect(result).toHaveLength(1)
    expect(result[0]?.text).toBe('假设你需要整理一份包含用户数量和渠道来源的数据表。')
    expect(result[0]?.sourceIds).toEqual(['a', 'b'])
  })




  it('does not merge separate topics by the same recognized speaker across long silences', () => {
    const result = buildUtterances([
      { id: 'a', sessionId: 's', speakerId: 'role_candidate', role: 'candidate', confidence: .9, text: '第一段回答。', startMs: 0, endMs: 12_000, status: 'transcribed' },
      { id: 'b', sessionId: 's', speakerId: 'role_candidate', role: 'candidate', confidence: .9, text: '中间继续说明。', startMs: 90_000, endMs: 102_000, status: 'transcribed' },
      { id: 'c', sessionId: 's', speakerId: 'role_candidate', role: 'candidate', confidence: .9, text: '最后补充结果。', startMs: 240_000, endMs: 252_000, status: 'transcribed' },
    ], 300_000, 15_000)

    expect(result).toHaveLength(3)
    expect(result.map(row => row.text)).toEqual(['第一段回答。', '中间继续说明。', '最后补充结果。'])
    expect(result.map(row => row.sourceIds)).toEqual([['a'], ['b'], ['c']])
  })

  it('keeps same-speaker speech together through a natural pause and does not finalize early', () => {
    const result = buildUtterances([
      { id: 'a', sessionId: 's', speakerId: 'role_candidate', role: 'candidate', confidence: .9, text: '我先介绍一下项目背景，', startMs: 0, endMs: 12_000, status: 'transcribed' },
      { id: 'b', sessionId: 's', speakerId: 'role_candidate', role: 'candidate', confidence: .9, text: '然后再说我负责的部分。', startMs: 20_000, endMs: 32_000, status: 'transcribed' },
    ], 40_000, 15_000)

    expect(result).toHaveLength(1)
    expect(result[0]?.text).toBe('我先介绍一下项目背景，然后再说我负责的部分。')
    expect(result[0]?.final).toBe(false)
  })

  it('shows a multi-minute continuous answer as one complete utterance across recording chunks', () => {
    const segments = Array.from({ length: 20 }, (_, index) => ({
      id: `chunk-${index}`,
      sessionId: 's',
      speakerId: 'role_candidate',
      role: 'candidate' as const,
      confidence: .9,
      text: `第${index + 1}部分，`,
      startMs: index * 15_000,
      endMs: index * 15_000 + 10_000,
      status: 'transcribed' as const,
    }))

    const duringAnswer = buildUtterances(segments, 296_000, 5_000)
    expect(duringAnswer).toHaveLength(1)
    expect(duringAnswer[0]?.sourceIds).toHaveLength(20)
    expect(duringAnswer[0]?.final).toBe(false)

    const afterAnswer = buildUtterances(segments, 300_000, 5_000)
    expect(afterAnswer[0]?.final).toBe(true)
  })

  it('merges transport segments and preserves all source ids for complete analysis', () => {
    const result = buildUtterances([
      { id: 'a', sessionId: 's', speakerId: 'speaker_1', role: 'candidate', confidence: .9, text: '第一部分，', startMs: 0, endMs: 1000, status: 'transcribed' },
      { id: 'b', sessionId: 's', speakerId: 'speaker_1', role: 'candidate', confidence: .8, text: '第二部分。', startMs: 1200, endMs: 2200, status: 'transcribed' },
    ], 4000, 1600)
    expect(result[0]?.text).toBe('第一部分，第二部分。')
    expect(result[0]?.sourceIds).toEqual(['a', 'b'])
  })
})
