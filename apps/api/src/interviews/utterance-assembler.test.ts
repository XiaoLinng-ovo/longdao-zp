import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assembleUtterances } from './utterance-assembler.js'

describe('interview utterance assembly', () => {
  it('merges transport chunks from the same speaker into one unfinished answer', () => {
    const result = assembleUtterances([
      { id: 'a', speakerId: 'speaker_1', text: '我在上一家公司', startMs: 0, endMs: 2800 },
      { id: 'b', speakerId: 'speaker_1', text: '主要负责订单系统，', startMs: 3000, endMs: 6100 },
      { id: 'c', speakerId: 'speaker_1', text: '并将接口延迟降低了百分之三十。', startMs: 6300, endMs: 9800 },
    ], 1600)
    assert.equal(result.length, 1)
    assert.equal(result[0]?.text, '我在上一家公司主要负责订单系统，并将接口延迟降低了百分之三十。')
    assert.equal(result[0]?.final, false)
  })

  it('finalizes an answer after a long silence and starts a new turn', () => {
    const result = assembleUtterances([
      { id: 'a', speakerId: 'speaker_1', text: '第一段回答。', startMs: 0, endMs: 2000 },
      { id: 'b', speakerId: 'speaker_1', text: '补充内容。', startMs: 2400, endMs: 3400 },
      { id: 'c', speakerId: 'speaker_1', text: '这是下一个回答。', startMs: 6200, endMs: 7600 },
    ], 1600)
    assert.equal(result.length, 2)
    assert.equal(result[0]?.final, true)
    assert.equal(result[1]?.final, false)
  })

  it('finalizes the current turn when the other speaker begins', () => {
    const result = assembleUtterances([
      { id: 'a', speakerId: 'speaker_1', text: '这是候选人的回答。', startMs: 0, endMs: 2200 },
      { id: 'b', speakerId: 'speaker_0', text: '请继续说明具体结果。', startMs: 2500, endMs: 3900 },
    ], 1600)
    assert.equal(result[0]?.final, true)
    assert.equal(result[1]?.speakerId, 'speaker_0')
  })
})
