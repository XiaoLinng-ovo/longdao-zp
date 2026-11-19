import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ASSESSMENT_RUBRICS, assessmentCriterion, questionMaximum, rubricTypeForSheet, tiersForCriterion } from './question-sheet-rubrics.js'
import { aggregateQuestionSheet } from './question-sheet-service.js'
import type { InterviewQuestionSheetRecord } from './question-sheet-repository.js'

describe('角色考察点标准', () => {
  for (const [group, maximum, total] of [['hr', 8, 40], ['department', 12, 60], ['boss', 20, 100]] as const) {
    it(group + '包含五项考察点，评分区间完整覆盖且无重叠，总分为' + total, () => {
      const criteria = ASSESSMENT_RUBRICS[group]
      assert.equal(criteria.length, 5)
      assert.equal(criteria.reduce((sum, item) => sum + item.maxScore, 0), total)
      for (const criterion of criteria) {
        assert.equal(criterion.maxScore, maximum)
        assert.ok(criterion.title)
        assert.equal(Boolean(criterion.focus), group === 'hr')
        assert.equal(assessmentCriterion('rubric:' + group + ':' + criterion.id), criterion)
        const tiers = tiersForCriterion(group, criterion)
        assert.equal(questionMaximum({ category: 'rubric:' + group + ':' + criterion.id, tiers }), maximum)
        assert.equal(tiers[0]!.max, group === 'department' ? 10 : maximum)
        for (let score = 0; score <= tiers[0]!.max; score++) {
          assert.equal(tiers.filter(tier => score >= tier.min && score <= tier.max).length, 1)
        }
        assert.ok(tiers.every(tier => tier.description.length > 0))
      }
    })

    it(group + '原始分按各项满分换算百分制，未评分项不计零分', () => {
      const questions = ASSESSMENT_RUBRICS[group].map((item, index) => ({
        category: 'rubric:' + group + ':' + item.id, dimension: item.title,
        tiers: tiersForCriterion(group, item), finalScore: index === 4 ? null : maximum as number,
      }))
      const aggregate = aggregateQuestionSheet({ questions } as InterviewQuestionSheetRecord)
      assert.equal(aggregate.score, 100)
      assert.equal(aggregate.scoredCount, 4)
      assert.equal(aggregate.totalCount, 5)
      questions[0]!.finalScore = 0
      assert.equal(aggregateQuestionSheet({ questions } as InterviewQuestionSheetRecord).score, 75)
    })
  }

  it('初试和复试角色映射不串表', () => {
    assert.equal(rubricTypeForSheet('initial', 'hr_screen'), 'hr')
    assert.equal(rubricTypeForSheet('initial', 'hiring_department'), 'department')
    assert.equal(rubricTypeForSheet('final', 'business'), 'department')
    assert.equal(rubricTypeForSheet('final', 'hr'), 'hr')
    assert.equal(rubricTypeForSheet('final', 'boss'), 'boss')
    assert.equal(assessmentCriterion('technical'), undefined)
    assert.equal(assessmentCriterion('rubric:unknown:item'), undefined)
  })
})
