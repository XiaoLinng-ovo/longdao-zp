import { describe, expect, it } from 'vitest'
import { questionConversationContext } from './question-conversation'
import type { InterviewQuestionConversationMessage } from '../api'

describe('question conversation context', () => {
  it('bounds long histories without changing the visible messages or latest requirement', () => {
    const messages: InterviewQuestionConversationMessage[] = Array.from({ length: 31 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) + 'x'.repeat(700) }))
    const recent = questionConversationContext(messages)
    expect(recent.length).toBeLessThanOrEqual(12)
    expect(recent.reduce((size, message) => size + message.content.length, 0)).toBeLessThanOrEqual(6000)
    expect(recent[0]?.role).toBe('user')
    expect(recent.at(-1)).toEqual(messages.at(-1))
    expect(messages).toHaveLength(31)
    expect(recent.at(-1)).not.toBe(messages.at(-1))
  })
  it('keeps short conversations intact and trims an orphan assistant', () => {
    expect(questionConversationContext([{ role: 'assistant', content: '旧回复' }, { role: 'user', content: '最新要求' }])).toEqual([{ role: 'user', content: '最新要求' }])
    expect(questionConversationContext([])).toEqual([])
  })
})
