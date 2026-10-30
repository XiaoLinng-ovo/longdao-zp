import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseLiveSessionPath } from './live-route.js'

describe('live interview session route parser', () => {
  it('parses session detail and action paths', () => {
    const id = '673ae0aa-0e35-4116-ab3c-d3a1c4ddaabe'
    assert.deepEqual(parseLiveSessionPath(`/api/v1/interview-live-sessions/${id}`), { sessionId: id })
    assert.deepEqual(parseLiveSessionPath(`/api/v1/interview-live-sessions/${id}/segments`), { sessionId: id, action: 'segments' })
    assert.deepEqual(parseLiveSessionPath(`/api/v1/interview-live-sessions/${id}/question`), { sessionId: id, action: 'question' })
    assert.deepEqual(parseLiveSessionPath(`/api/v1/interview-live-sessions/${id}/end`), { sessionId: id, action: 'end' })
  })

  it('rejects unknown or nested actions', () => {
    assert.equal(parseLiveSessionPath('/api/v1/interview-live-sessions/id/unknown'), undefined)
    assert.equal(parseLiveSessionPath('/api/v1/interview-live-sessions/id/segments/more'), undefined)
  })
})
