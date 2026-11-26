import assert from 'node:assert/strict'
import { test } from 'node:test'
import { characterDistance, evaluateTranscriptSamples, normalizeTranscript } from '../evaluate-transcription.mjs'

test('normalization ignores punctuation, case, spacing and full-width forms', () => {
  assert.equal(normalizeTranscript('你好， ＪＡＶＡ！'), '你好java')
})
test('character errors include substitutions, insertions and omissions', () => {
  assert.equal(characterDistance('我做开发', '我做开花'), 1)
  assert.equal(characterDistance('开发', '做开发'), 1)
  assert.equal(characterDistance('开发', '开'), 1)
  assert.equal(characterDistance('', '开发'), 2)
})
test('corpus CER is weighted by reference characters and does not expose text', () => {
  const result = evaluateTranscriptSamples([{ id:'a',reference:'你好',hypothesis:'您好' },{ id:'b',reference:'我是开发工程师',hypothesis:'我是开发工程师' }])
  assert.equal(result.cer, 1/9)
  assert.equal(result.errors, 1)
  assert.equal(result.results[0].cer, .5)
  assert.equal(JSON.stringify(result).includes('开发'), false)
})
test('complete recognition failure is counted rather than silently excluded', () => {
  assert.equal(evaluateTranscriptSamples([{reference:'技术面试',hypothesis:''}]).cer, 1)
  assert.equal(evaluateTranscriptSamples([{reference:'面试',hypothesis:'技术面试面试'}]).cer, 2)
})
test('empty references, malformed samples and oversized segments are refused', () => {
  for(const samples of [[], [{}], [null], [{ reference:'！！！',hypothesis:'' }]]) assert.throws(() => evaluateTranscriptSamples(samples))
  assert.throws(() => characterDistance('a'.repeat(5001), 'a'), /5000/)
})
