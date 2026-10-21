import { describe, expect, it } from 'vitest'
import { createAnalysisRetryState } from './analysis-retry-state'

describe('automatic answer analysis retry state', () => {
  it('releases an utterance after a failed analysis so it can be retried', () => {
    const state = createAnalysisRetryState()

    expect(state.claim('utterance-1')).toBe(true)
    state.fail('utterance-1')

    expect(state.claim('utterance-1')).toBe(true)
  })

  it('does not retry an utterance after its analysis has been saved', () => {
    const state = createAnalysisRetryState()

    state.claim('utterance-1')
    state.succeed('utterance-1')

    expect(state.claim('utterance-1')).toBe(false)
  })

  it('stops automatic retries after three failed attempts', () => {
    const state = createAnalysisRetryState(3)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(state.claim('utterance-1')).toBe(true)
      state.fail('utterance-1')
    }

    expect(state.claim('utterance-1')).toBe(false)
  })
})
