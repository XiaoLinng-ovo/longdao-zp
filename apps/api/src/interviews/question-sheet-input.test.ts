import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { COMMON_CAPABILITY_DIMENSIONS, type GeneratedInterviewQuestion, type InterviewQuestionGroup } from './question-generator.js'
import { mergeSheetQuestionSources } from './question-sheet-input.js'
import type { InterviewQaPair } from './question-sheet-repository.js'

const question = (group: InterviewQuestionGroup, index: number): GeneratedInterviewQuestion => ({
  group, question: `${group}问题${index}`, ...(group !== 'ai' ? { dimension: COMMON_CAPABILITY_DIMENSIONS[group][index]!.id } : {}),
  category: 'experience', difficulty: 'medium', rationale: '能力考核', groundedIn: ['岗位要求'], scoringRubric: [{ criterion: '说明具体做法', points: 10 }],
})
const questions = [
  ...Array.from({ length: 10 }, (_, index) => question('ai', index)),
  ...(['hr', 'department', 'boss'] as const).flatMap(group => Array.from({ length: 5 }, (_, index) => question(group, index))),
]
const opening: InterviewQaPair = { interviewId: 'interview-1', questionEventId: 'opening-event', question: '请做自我介绍', answerSegmentIds: [], answerText: '' }
const bank = { interviewId: 'interview-1', questions }

describe('面试表题库与真实提问合并', () => {
  for (const [sheetType, group] of [['hr_screen', 'hr'], ['hiring_department', 'department'], ['business', 'department'], ['hr', 'hr'], ['boss', 'boss']] as const) {
    it(`${sheetType}保留开场题、10道简历题及5道${group}能力题，不再只有1道题`, () => {
      const rows = mergeSheetQuestionSources([opening], [bank], sheetType)
      assert.equal(rows.length, 16)
      assert.deepEqual(rows[0], opening)
      assert.equal(rows.filter(row => row.question.startsWith('ai')).length, 10)
      assert.equal(rows.filter(row => row.question.startsWith(group)).length, 5)
      assert.ok(rows.slice(1).every(row => row.questionEventId === null && !row.answerText && !row.answerSegmentIds.length))
      assert.ok(rows.find(row => row.question === `${group}问题0`)?.dimension)
    })
  }
  it('已提问的题不重复追加，真实回答和事件引用不变', () => {
    const actual = { ...opening, questionEventId: 'hr-event', question: 'hr问题0', answerText: '我的职业规划', answerSegmentIds: ['segment-1'] }
    const rows = mergeSheetQuestionSources([opening, actual], [bank], 'hr_screen')
    assert.equal(rows.length, 16)
    assert.equal(rows.filter(row => row.question === actual.question).length, 1)
    assert.equal(rows[1]!.questionEventId, actual.questionEventId)
    assert.equal(rows[1]!.answerText, actual.answerText)
    assert.deepEqual(rows[1]!.answerSegmentIds, actual.answerSegmentIds)
    assert.equal(rows[1]!.dimension, '职业动机与规划')
  })
  it('同一会话的其他分类题不串入当前表；自定义追问仍保留', () => {
    const rows = mergeSheetQuestionSources([opening, { ...opening, question: 'department问题0' }], [bank], 'hr_screen')
    assert.equal(rows.length, 16)
    assert.ok(!rows.some(row => row.question.startsWith('department')))
  })
  it('相同文本不跨面试借用分类或回答', () => {
    const other = { ...opening, interviewId: 'interview-2', question: 'department问题0', answerText: '另一次面试回答' }
    const rows = mergeSheetQuestionSources([other], [bank], 'hr_screen')
    assert.equal(rows[0]!.answerText, other.answerText)
    assert.equal(rows[0]!.questionEventId, other.questionEventId)
    assert.ok(rows.slice(1).every(row => !row.answerText))
  })
  it('没有已保存题库时仍保留全部真实问答', () => {
    assert.deepEqual(mergeSheetQuestionSources([opening], [], 'boss'), [opening])
  })
  it('旧版无group题库与重复题兼容，空白和全角差异不重复追加', () => {
    const { group: _group, ...legacyBase } = question('ai', 0)
    const legacy = { ...legacyBase, question: 'ＡＩ 问题' }
    const rows = mergeSheetQuestionSources([{ ...opening, question: 'AI问题' }], [{ interviewId: bank.interviewId, questions: [legacy, legacy] }], 'hr')
    assert.equal(rows.length, 1)
  })
})
