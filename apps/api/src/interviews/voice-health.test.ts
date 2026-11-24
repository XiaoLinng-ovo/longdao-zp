import assert from 'node:assert/strict'
import { test } from 'node:test'
import { voiceCapabilities } from './voice-health.js'

test('备用引擎存活不能冒充实时、片段或整场转写可用', () => {
  assert.deepEqual(voiceCapabilities('unavailable', 'ok'), { streaming: false, chunks: false, fullRecording: false, secondaryReview: false })
  assert.deepEqual(voiceCapabilities('ok', 'not_configured'), { streaming: true, chunks: true, fullRecording: true, secondaryReview: false })
  assert.equal(voiceCapabilities('ok', 'ok').secondaryReview, true)
})
