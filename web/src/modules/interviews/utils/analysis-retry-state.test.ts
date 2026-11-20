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

  it('holds nonretryable failures until relevant transcript state changes', () => {
    const state = createAnalysisRetryState()
    expect(state.claim('answer', 'initial')).toBe(true)
    state.block('answer', 'initial')
    expect(state.isBlocked('answer', 'initial')).toBe(true)
    expect(state.claim('answer', 'initial')).toBe(false)
    expect(state.claim('answer', 'corrected')).toBe(true)
    expect(state.isBlocked('answer', 'corrected')).toBe(false)
  })

  it('enforces backoff even if polling or another answer triggers the scheduler', () => {
    const state = createAnalysisRetryState()
    state.claim('answer')
    expect(state.retryDelay('answer')).toBe(2000)
    state.fail('answer', 2000)
    expect(state.claim('answer')).toBe(false)
    expect(state.claim('another-answer')).toBe(true)
  })
})
