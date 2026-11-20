import type { InterviewQuestionConversationMessage } from '../api'

// Keep recent complete turns within the independent discussion request budget.
export function questionConversationContext(messages: InterviewQuestionConversationMessage[]): InterviewQuestionConversationMessage[] {
  const recent: InterviewQuestionConversationMessage[] = []
  let size = 0
  for (let index = messages.length - 1; index >= 0 && recent.length < 12; index--) {
    const message = messages[index]!
    if (size + message.content.length > 6000) break
    recent.unshift({ ...message })
    size += message.content.length
  }
  while (recent[0]?.role === 'assistant') recent.shift()
  return recent
}
