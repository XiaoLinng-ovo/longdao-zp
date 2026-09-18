import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mapInterviewRoles } from './role-mapper.js'

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
})
