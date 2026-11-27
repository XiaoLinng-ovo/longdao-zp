import assert from 'node:assert/strict'
import { test } from 'node:test'
import { characterErrors, fixtureMetrics } from '../interview-transcript-metrics.mjs'

test('CER separates missing, extra and substituted characters while retaining fillers', () => {
  assert.equal(characterErrors('嗯，A。', '文a').substitutions, 1)
  assert.equal(characterErrors('先检索再回答', '先检索回答').deletions, 1)
  assert.equal(characterErrors('你刚才说做了', '你刚才说多做了').insertions, 1)
  assert.equal(characterErrors('你好。', '你，好').edits, 0)
  assert.equal(characterErrors('', '').characterErrorRate, null)
})

test('fixture scoring does not interleave simultaneous audio sources or force unknown roles', () => {
  const result = fixtureMetrics([{ role: 'interviewer', text: '你好' }, { role: 'candidate', text: '嗯介绍' }], [
    { id: 'a', audio_source: 'meeting', text: '文', role: 'unknown', start_ms: 0 },
    { id: 'b', audio_source: 'microphone', text: '你好', role: 'interviewer', start_ms: 1 },
    { id: 'c', audio_source: 'meeting', text: '介绍', role: 'candidate', start_ms: 3 },
  ])
  assert.equal(result.total.edits, 1)
  assert.equal(result.total.correctRole, 2)
  assert.equal(result.total.wrongRole, 0)
  assert.equal(result.total.unresolved, 1)
})
