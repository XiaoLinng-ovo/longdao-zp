import { COMMON_CAPABILITY_DIMENSIONS, type GeneratedInterviewQuestion, type InterviewQuestionGroup } from './question-generator.js'
import type { InterviewQaPair, QuestionSheetType } from './question-sheet-repository.js'

export interface SheetQuestionBank { interviewId: string; questions: GeneratedInterviewQuestion[] }

const SHEET_GROUP: Record<QuestionSheetType, InterviewQuestionGroup> = {
  hr_screen: 'hr', hiring_department: 'department', business: 'department', hr: 'hr', boss: 'boss',
}

export function normalizeSheetQuestion(question: string): string {
  return question.normalize('NFKC').replace(/\s+/gu, '').trim()
}

/** Keep actual answers attached to their event; a bank entry alone is never answer evidence. */
export function mergeSheetQuestionSources(pairs: InterviewQaPair[], banks: SheetQuestionBank[], sheetType: QuestionSheetType): InterviewQaPair[] {
  const belongs = (question: GeneratedInterviewQuestion) => !question.group || question.group === 'ai' || question.group === SHEET_GROUP[sheetType]
  const metadata = (question: GeneratedInterviewQuestion) => ({
    dimension: question.group && question.group !== 'ai'
      ? COMMON_CAPABILITY_DIMENSIONS[question.group].find(item => item.id === question.dimension)?.title ?? question.dimension ?? '综合能力'
      : question.dimension ?? '综合能力',
    category: question.category,
    difficulty: question.difficulty,
  })
  const entries = banks.flatMap(bank => bank.questions.filter(question => typeof question?.question === 'string' && question.question.trim())
    .map(question => ({ interviewId: bank.interviewId, question, key: normalizeSheetQuestion(question.question) })))
  const result = pairs.flatMap(pair => {
    const matches = entries.filter(entry => (!pair.interviewId || entry.interviewId === pair.interviewId) && entry.key === normalizeSheetQuestion(pair.question))
    const matching = matches.find(entry => belongs(entry.question))
    if (matches.length && !matching) return []
    return [{ ...pair, ...(matching ? metadata(matching.question) : {}) }]
  })
  const included = new Set(result.map(pair => normalizeSheetQuestion(pair.question)))
  for (const entry of entries) {
    if (!belongs(entry.question) || included.has(entry.key)) continue
    included.add(entry.key)
    result.push({
      interviewId: entry.interviewId, questionEventId: null, question: entry.question.question,
      answerSegmentIds: [], answerText: '', ...metadata(entry.question),
    })
  }
  return result
}
