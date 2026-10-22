import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { QuestionSheetService, STAGE_DEFAULT_WEIGHTS, aggregateQuestionSheet, resolveStageWeights, stageScoreBreakdown } from './question-sheet-service.js'
import type { QuestionSheetRepository } from './question-sheet-repository.js'
import type { InterviewQuestionRecord, InterviewQuestionSheetRecord } from './question-sheet-repository.js'
import type { QuestionWriteInput } from './question-sheet-repository.js'

function question(overrides: Partial<InterviewQuestionRecord>): InterviewQuestionRecord {
  return {
    id: 'q1', seq: 1, question: '问题', dimension: '架构能力', category: 'technical', difficulty: 'hard',
    source: 'live_question', questionEventId: null, answerSegmentIds: [], answerText: '回答', tiers: [],
    aiTier: null, aiScore: null, aiRationale: null, aiEvidence: [],
    finalTier: null, finalScore: null, comment: null, scoredBy: null, scoredAt: null,
    createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
    ...overrides,
  }
}

function sheet(overrides: Partial<InterviewQuestionSheetRecord> = {}): InterviewQuestionSheetRecord {
  return {
    id: 'sheet-1', applicationId: 'app-1', stage: 'initial', sheetType: 'hr_screen', status: 'submitted',
    source: 'ai', generationModel: null, promptVersion: null, generationError: null, generationNotice: null,
    generatedBy: null, generatedAt: null, submittedAt: null, lockedAt: null,
    createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
    questions: [],
    ...overrides,
  }
}

describe('面试表汇总', () => {
  it('只统计已打分的题目，未打分的题不按 0 计', () => {
    const aggregate = aggregateQuestionSheet(sheet({
      questions: [
        question({ id: 'a', finalScore: 90 }),
        question({ id: 'b', finalScore: 70 }),
        question({ id: 'c', finalScore: null }),
      ],
    }))
    assert.equal(aggregate.score, 80)
    assert.equal(aggregate.scoredCount, 2)
    assert.equal(aggregate.totalCount, 3)
    assert.deepEqual(aggregate.ratings, { 架构能力: 80 })
  })

  it('一张表都没打分时为 null，而不是 0', () => {
    const aggregate = aggregateQuestionSheet(sheet({ questions: [question({ finalScore: null })] }))
    assert.equal(aggregate.score, null)
    assert.deepEqual(aggregate.ratings, {})
  })
})

describe('阶段权重与公式', () => {
  it('默认权重：初试两表各 0.35 + 录音 0.30；复试三表合计 0.70 + 录音 0.30', () => {
    assert.deepEqual(STAGE_DEFAULT_WEIGHTS.initial, { sheets: { hr_screen: 0.35, hiring_department: 0.35 }, recording: 0.3 })
    const finalSum = Object.values(STAGE_DEFAULT_WEIGHTS.final.sheets).reduce((sum, value) => sum + value, 0) + STAGE_DEFAULT_WEIGHTS.final.recording
    assert.ok(Math.abs(finalSum - 1) <= 0.01)
  })

  it('按公式计算综合分，并给出可展示的算式', () => {
    const weights = resolveStageWeights('initial')
    const breakdown = stageScoreBreakdown('initial', { hr_screen: 82, hiring_department: 76 }, 78, weights)
    assert.equal(breakdown.score, 79)
    assert.equal(breakdown.formula, '82 × 0.35 + 76 × 0.35 + 78 × 0.3 = 79')
    assert.deepEqual(breakdown.notes, [])
  })

  it('缺失项不按 0 计：权重在剩余项之间归一，并说明原因', () => {
    const breakdown = stageScoreBreakdown('initial', { hr_screen: 80 }, null, resolveStageWeights('initial'))
    assert.equal(breakdown.score, 80)
    assert.equal(breakdown.formula, '80 × 1 = 80')
    assert.ok(breakdown.notes.some((note) => note.includes('录音 AI 评分暂无分数')))
    assert.ok(breakdown.notes.some((note) => note.includes('归一')))
  })

  it('全部缺失时不给分数', () => {
    const breakdown = stageScoreBreakdown('final', {}, null, resolveStageWeights('final'))
    assert.equal(breakdown.score, null)
    assert.equal(breakdown.formula, '暂无可用于计算的分数')
    assert.equal(breakdown.notes.length, 4)
  })

  it('保存的权重覆盖默认值，非法键被忽略', () => {
    const resolved = resolveStageWeights('initial', { sheets: { hr_screen: 0.5, business: 0.5 }, recording: 0.2 })
    assert.equal(resolved.sheets.hr_screen, 0.5)
    assert.equal(resolved.sheets.hiring_department, 0.35)
    assert.equal(resolved.recording, 0.2)
    assert.equal('business' in resolved.sheets, false)
  })
})


describe('录音评分独立于参考题分数', () => {
  for (const recording of [null, 91]) {
    it('只采用整场对话分而不回退到参考题平均：' + recording, async () => {
      const repository = {
        listForApplication: async () => ({ sheets: [sheet({ questions: [question({ aiScore: 10, finalScore: 84 })] })], reviews: [] }),
        listCompletedLiveRecordingScores: async () => recording === null ? [] : [{ stage: 'initial', score: recording }],
        findNextRound: async () => null,
      } as unknown as QuestionSheetRepository
      const view = await new QuestionSheetService(repository).getApplicationView('app-1')
      const items = view.stages.find(stage => stage.stage === 'initial')!.breakdown.items
      assert.equal(items.find(item => item.key === 'recording')!.score, recording)
      assert.equal(items.find(item => item.key === 'hr_screen')!.score, 84)
    })
  }
})

describe('面试结束后自动准备角色考察点评分表', () => {
  it('初试结束自动排队人事和用人部门两张表', async () => {
    const calls: string[] = []
    const service = new QuestionSheetService({} as QuestionSheetRepository)
    service.requestAutomaticGeneration = async (_id, stage, type) => { assert.equal(stage, 'initial'); calls.push(type); return { queued: true } }
    const result = await service.requestStageGeneration('app-1', 'initial', 'user-1')
    assert.deepEqual(calls, ['hr_screen', 'hiring_department'])
    assert.equal(result.queued, true)
  })
  it('只有题库没有回答也排队生成可人工评价的表', async () => {
    let marked = false
    const repository = {
      listSheetQaPairs: async (_id: string, stage: string, type: string) => {
        assert.equal(stage, 'initial'); assert.equal(type, 'hr_screen')
        return [{ questionEventId: null, question: '已保存题库题目', answerSegmentIds: [], answerText: '' }]
      },
      find: async () => null, markGenerating: async () => { marked = true },
    } as unknown as QuestionSheetRepository
    const service = new QuestionSheetService(repository)
    service.getApplicationView = async () => ({ applicationId: 'app-1', sheets: [], reviews: [], stages: [], nextInterview: null })
    assert.deepEqual(await service.requestAutomaticGeneration('app-1', 'initial', 'hr_screen', 'user-1'), { queued: true })
    assert.equal(marked, true)
  })
  it('没有题库和提问记录时仍排队创建通用人工考察点', async () => {
    let marked = false
    const repository = {
      listSheetQaPairs: async () => [],
      find: async () => null,
      markGenerating: async () => { marked = true },
    } as unknown as QuestionSheetRepository
    const service = new QuestionSheetService(repository)
    service.getApplicationView = async () => ({ applicationId: 'app-1', sheets: [], reviews: [], stages: [], nextInterview: null })
    const result = await service.requestAutomaticGeneration('app-1', 'initial', 'hiring_department', 'user-1')
    assert.equal(result.queued, true)
    assert.equal(marked, true)
  })

  it('已有评分内容时保留原表，不因重复结束请求而覆盖', async () => {
    let marked = false
    const repository = {
      listSheetQaPairs: async () => [{ questionEventId: 'event-1', question: '问题', answerSegmentIds: ['segment-1'], answerText: '候选人回答' }],
      find: async () => sheet({ status: 'submitted', questions: [question({ aiScore: 82 })] }),
      markGenerating: async () => { marked = true },
    } as unknown as QuestionSheetRepository
    const service = new QuestionSheetService(repository)
    const result = await service.requestAutomaticGeneration('app-1', 'initial', 'hiring_department', 'user-1')
    assert.equal(result.queued, false)
    assert.equal(marked, false)
    assert.match(result.reason ?? '', /保留该阶段已有的考察点评分/)
  })
})


describe('按角色生成通用人工考察点评分表', () => {
  for (const [stage, types] of Object.entries({ initial: ['hr_screen', 'hiring_department'], final: ['business', 'hr', 'boss'] }) as Array<['initial' | 'final', Array<'hr_screen' | 'hiring_department' | 'business' | 'hr' | 'boss'>]>) {
    for (const type of types) {
      it(`${type}即使没有问答也生成5个对应角色考察点，不调用逐题模型`, async () => {
        let written: QuestionWriteInput[] = []
        let notice = ''
        const repository = {
          claimPendingGeneration: async () => ({ sheetId: 'sheet-1', applicationId: 'app-1', stage, sheetType: type }),
          replaceQuestions: async (_id: string, rows: QuestionWriteInput[]) => { written = rows },
          markGenerationNotice: async (_id: string, value: string) => { notice = value },
        } as unknown as QuestionSheetRepository
        const service = new QuestionSheetService(repository, { resolveAiEnv: async () => { throw new Error('无回答不应请求模型') } })
        assert.deepEqual(await service.processPendingGeneration(), { processed: true, applicationId: 'app-1' })
        assert.equal(written.length, 5)
        assert.ok(written.every(row => row.source === 'manual' && row.category?.startsWith('rubric:')))
        assert.ok(written.every(row => row.aiScore === null && row.aiTier === null && row.aiRationale === null && !row.aiEvidence?.length && row.answerText === null))
        assert.match(notice, /人工评分/)
        const expectedMax = type === 'boss' ? 20 : type === 'hiring_department' || type === 'business' ? 12 : 8
        assert.ok(written.every(row => Math.max(...(row.tiers ?? []).map(tier => tier.max)) === expectedMax))
      })
    }
  }
  it('排队业务、HR、BOSS三张表，不覆盖已提交表', async () => {
    const marked: string[] = []
    const repository = {
      find: async (_id: string, _stage: string, sheetType: string) => sheetType === 'hr' ? sheet({ stage: 'final', sheetType: 'hr', status: 'submitted', questions: [question({ finalScore: 88 })] }) : null,
      markGenerating: async (_id: string, _stage: string, sheetType: string) => { marked.push(sheetType) },
      listForApplication: async () => ({ sheets: [], reviews: [] }),
      listCompletedLiveRecordingScores: async () => [],
      findNextRound: async () => null,
    } as unknown as QuestionSheetRepository
    const service = new QuestionSheetService(repository)
    const result = await service.requestFinalStageGeneration('app-1', 'user-1')
    assert.deepEqual(marked, ['business', 'boss'])
    assert.deepEqual(result.sheets.map(item => [item.sheetType, item.queued]), [['business', true], ['hr', false], ['boss', true]])
    assert.match(result.reason ?? '', /HR 面试表.*未覆盖/)
  })
  it('无复试题库和提问时仍生成三类通用考察点评分表', async () => {
    const marked: string[] = []
    const repository = {
      find: async () => null,
      markGenerating: async (_id: string, _stage: string, type: string) => { marked.push(type) },
    } as unknown as QuestionSheetRepository
    const service = new QuestionSheetService(repository)
    service.getApplicationView = async () => ({ applicationId: 'app-1', sheets: [], reviews: [], stages: [], nextInterview: null })
    const result = await service.requestFinalStageGeneration('app-1', 'user-1')
    assert.equal(result.queued, true)
    assert.equal(result.sheets.length, 3)
    assert.ok(result.sheets.every(item => item.queued))
    assert.deepEqual(marked, ['business', 'hr', 'boss'])
  })
  it('单表失败后继续排队其余表，反馈具体表名', async () => {
    const service = new QuestionSheetService({} as QuestionSheetRepository)
    const called: string[] = []
    service.requestAutomaticGeneration = async (_id, stage, sheetType) => {
      assert.equal(stage, 'final'); called.push(sheetType)
      if (sheetType === 'business') throw Error('排队失败')
      return { queued: true }
    }
    const result = await service.requestFinalStageGeneration('app-1', 'user-1')
    assert.deepEqual(called, ['business', 'hr', 'boss'])
    assert.equal(result.queued, true)
    assert.match(result.reason ?? '', /业务面试表：排队失败/)
  })
  it('即使存在本轮真实问答也只生成BOSS通用考察点，不调用逐题模型', async () => {
    let written: QuestionWriteInput[] = []
    let modelCalled = false
    const repository = {
      claimPendingGeneration: async () => ({ sheetId: 'final-boss-sheet', applicationId: 'app-1', stage: 'final', sheetType: 'boss' }),
      listSheetQaPairs: async () => [{ questionEventId: 'final-event', question: '复试问题', answerSegmentIds: ['final-answer'], answerText: '本轮回答' }],
      replaceQuestions: async (_id: string, questions: QuestionWriteInput[]) => { written = questions },
      markGenerationNotice: async () => {},
    } as unknown as QuestionSheetRepository
    const service = new QuestionSheetService(repository, {
      resolveAiEnv: async () => { modelCalled = true; throw new Error('通用考察点评分不应请求模型') },
    })
    assert.deepEqual(await service.processPendingGeneration(), { processed: true, applicationId: 'app-1' })
    assert.equal(modelCalled, false)
    assert.equal(written.length, 5)
    assert.ok(written.every(row => row.category?.startsWith('rubric:boss:')))
    assert.ok(written.every(row => row.questionEventId === null && row.answerText === null && row.aiScore === null))
  })
})

describe('考察点评分表载入', () => {
  it('生成中的重复请求不重置任务或覆盖数据', async () => {
    let marked = false
    const repository = { find: async () => sheet({ status: 'generating' }), loadAssessmentRubric: async () => { marked = true } } as unknown as QuestionSheetRepository
    const service = new QuestionSheetService(repository)
    service.getApplicationView = async () => ({ applicationId: 'app-1', sheets: [], stages: [], reviews: [], nextInterview: null })
    await service.requestGeneration('app-1', 'initial', 'hr_screen', 'user-1')
    assert.equal(marked, false)
  })

  it('允许无人工评分的待打分表重新载入考察点', async () => {
    let marked = false
    const repository = {
      find: async () => sheet({ status: 'scoring', questions: [question({ finalScore: null, comment: null })] }),
      loadAssessmentRubric: async (...[applicationId, stage, type, actorId, questions, version]: Parameters<QuestionSheetRepository['loadAssessmentRubric']>) => {
        assert.deepEqual([applicationId, stage, type, actorId], ['app-1', 'initial', 'hr_screen', 'user-1'])
        assert.equal(version, 'manual-rubric-v1')
        assert.equal(questions.length, 5)
        assert.ok(questions.every(item => item.category?.startsWith('rubric:hr:')))
        marked = true
      },
    } as unknown as QuestionSheetRepository
    const service = new QuestionSheetService(repository)
    service.getApplicationView = async () => ({ applicationId: 'app-1', sheets: [], stages: [], reviews: [], nextInterview: null })

    await service.requestGeneration('app-1', 'initial', 'hr_screen', 'user-1')

    assert.equal(marked, true)
  })

  for (const [stage, type, group] of [
    ['initial', 'hr_screen', 'hr'], ['initial', 'hiring_department', 'department'],
    ['final', 'business', 'department'], ['final', 'hr', 'hr'], ['final', 'boss', 'boss'],
  ] as const) {
    it(type + '点击载入后立即返回人工评分表，不排队也不请求 AI', async () => {
      let stored = sheet({ stage, sheetType: type, status: 'draft', questions: [] })
      const repository = {
        find: async () => null,
        loadAssessmentRubric: async (...[, , , , questions]: Parameters<QuestionSheetRepository['loadAssessmentRubric']>) => {
          assert.equal(questions.length, 5)
          assert.ok(questions.every(item => item.category?.startsWith('rubric:' + group + ':')))
          assert.ok(questions.every(item => item.source === 'manual' && item.answerText === null && item.aiScore === null))
          stored = { ...stored, status: 'scoring', questions: questions.map((item, index) => question({ ...item, id: 'criterion-' + index })) }
        },
        markGenerating: async () => { throw new Error('人工载入不应排队') },
      } as unknown as QuestionSheetRepository
      const service = new QuestionSheetService(repository, { resolveAiEnv: async () => { throw new Error('人工载入不应请求 AI') } })
      service.getApplicationView = async () => ({ applicationId: 'app-1', sheets: [{ ...stored, aggregate: aggregateQuestionSheet(stored) }], stages: [], reviews: [], nextInterview: null })
      const result = await service.requestGeneration('app-1', stage, type, 'user-1')
      assert.equal(result.sheets[0]!.status, 'scoring')
      assert.equal(result.sheets[0]!.questions.length, 5)
    })
  }
})
