import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { QuestionSheetService, STAGE_DEFAULT_WEIGHTS, aggregateQuestionSheet, resolveStageWeights, stageScoreBreakdown } from './question-sheet-service.js'
import type { QuestionSheetRepository } from './question-sheet-repository.js'
import type { InterviewQuestionRecord, InterviewQuestionSheetRecord } from './question-sheet-repository.js'
import { DEFAULT_QUESTION_TIERS, QuestionSheetGenerationError, type GeneratedSheetQuestion } from './question-sheet-generator.js'
import type { QuestionWriteInput } from './question-sheet-repository.js'

function generated(question: string, seq = 1): GeneratedSheetQuestion {
  return { seq, question, dimension: '综合能力', category: 'experience', difficulty: 'medium', tiers: DEFAULT_QUESTION_TIERS, aiTier: 'pass', aiScore: 80, aiRationale: '有回答证据', aiEvidence: ['回答'] }
}

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

describe('面试结束后自动创建逐题评价', () => {
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
  it('既没有题库也没有提问记录时不排队', async () => {
    const repository = {
      listSheetQaPairs: async () => [],
      find: async () => null,
      markGenerating: async () => { throw new Error('不应生成空表') },
    } as unknown as QuestionSheetRepository
    const service = new QuestionSheetService(repository)
    const result = await service.requestAutomaticGeneration('app-1', 'initial', 'hiring_department', 'user-1')
    assert.equal(result.queued, false)
    assert.match(result.reason ?? '', /已保存题库或提问记录/)
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
    assert.match(result.reason ?? '', /保留该阶段已有的逐题评价/)
  })
})


describe('第二轮评价表自动生成', () => {
  for (const [stage, types] of Object.entries({ initial: ['hr_screen', 'hiring_department'], final: ['business', 'hr', 'boss'] }) as Array<['initial' | 'final', Array<'hr_screen' | 'hiring_department' | 'business' | 'hr' | 'boss'>]>) {
    for (const type of types) {
      it(`${type}题库无回答时完整保存16题且不调用模型、不伪造回答或分数`, async () => {
        const pairs = Array.from({ length: 16 }, (_, index) => ({ question: `题目${index}`, questionEventId: index ? null : 'opening', answerSegmentIds: [], answerText: '', dimension: '职业动机与规划' }))
        let written: QuestionWriteInput[] = []
        let notice = ''
        const repository = {
          claimPendingGeneration: async () => ({ sheetId: 'sheet-1', applicationId: 'app-1', stage, sheetType: type }),
          listSheetQaPairs: async (_id: string, receivedStage: string, receivedType: string) => { assert.equal(receivedStage, stage); assert.equal(receivedType, type); return pairs },
          getApplicationJobContext: async () => null,
          replaceQuestions: async (_id: string, rows: QuestionWriteInput[]) => { written = rows },
          markGenerationNotice: async (_id: string, value: string) => { notice = value },
        } as unknown as QuestionSheetRepository
        const service = new QuestionSheetService(repository, { resolveAiEnv: async () => { throw new Error('无回答不应请求模型') } })
        assert.deepEqual(await service.processPendingGeneration(), { processed: true, applicationId: 'app-1' })
        assert.equal(written.length, 16)
        assert.equal(written[0]!.source, 'live_question')
        assert.ok(written.slice(1).every(row => row.source === 'ai_generated' && row.questionEventId === null))
        assert.ok(written.every(row => row.aiScore === null && row.aiTier === null && row.aiRationale === null && !row.aiEvidence?.length && row.answerText === null))
        assert.match(notice, /未采集到可用回答/)
      })
    }
  }
  it('只读取复试问答，排队业务、HR、BOSS三张表，不覆盖已提交表', async () => {
    const marked: string[] = []
    const stages: string[] = []
    const repository = {
      listSheetQaPairs: async (_id: string, stage: string) => { stages.push(stage); return [{ questionEventId: 'final-event', question: '复试实际问题', answerSegmentIds: ['final-answer'], answerText: '复试回答' }] },
      find: async (_id: string, _stage: string, sheetType: string) => sheetType === 'hr' ? sheet({ stage: 'final', sheetType: 'hr', status: 'submitted', questions: [question({ finalScore: 88 })] }) : null,
      markGenerating: async (_id: string, _stage: string, sheetType: string) => { marked.push(sheetType) },
      listForApplication: async () => ({ sheets: [], reviews: [] }),
      listCompletedLiveRecordingScores: async () => [],
      findNextRound: async () => null,
    } as unknown as QuestionSheetRepository
    const service = new QuestionSheetService(repository)
    const result = await service.requestFinalStageGeneration('app-1', 'user-1')
    assert.deepEqual(marked, ['business', 'boss'])
    assert.deepEqual(stages, ['final', 'final', 'final'])
    assert.deepEqual(result.sheets.map(item => [item.sheetType, item.queued]), [['business', true], ['hr', false], ['boss', true]])
    assert.match(result.reason ?? '', /HR 面试表.*未覆盖/)
  })
  it('无复试题库和提问时三张表均不生成，不借用初试问答', async () => {
    const repository = { listSheetQaPairs: async (_id: string, stage: string) => { assert.equal(stage, 'final'); return [] } } as unknown as QuestionSheetRepository
    const result = await new QuestionSheetService(repository).requestFinalStageGeneration('app-1', 'user-1')
    assert.equal(result.queued, false)
    assert.equal(result.sheets.length, 3)
    assert.ok(result.sheets.every(item => !item.queued))
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
  it('后台生成将复试阶段与当前表类型送入模型，使用本轮真实问答', async () => {
    let input: unknown
    let written: unknown
    const repository = {
      claimPendingGeneration: async () => ({ sheetId: 'final-boss-sheet', applicationId: 'app-1', stage: 'final', sheetType: 'boss' }),
      listSheetQaPairs: async (_id: string, stage: string) => { assert.equal(stage, 'final'); return [{ questionEventId: 'final-event', question: '复试问题', answerSegmentIds: ['final-answer'], answerText: '本轮回答' }] },
      getApplicationJobContext: async () => ({ jobTitle: '负责人', requirements: [], skills: [] }),
      replaceQuestions: async (_id: string, questions: unknown) => { written = questions },
    } as unknown as QuestionSheetRepository
    const service = new QuestionSheetService(repository, {
      resolveAiEnv: async () => ({ OPENAI_BASE_URL: 'https://model.example.invalid/v1', OPENAI_API_KEY: 'test-only', OPENAI_MODEL: 'test-model' }),
      createGenerator: () => ({ generate: async next => { input = next; return next.pairs.map((pair, index) => generated(pair.question, index + 1)) } }),
    })
    assert.deepEqual(await service.processPendingGeneration(), { processed: true, applicationId: 'app-1' })
    assert.equal((input as { stage: string }).stage, 'final')
    assert.equal((input as { sheetType: string }).sheetType, 'boss')
    assert.deepEqual((input as { pairs: unknown }).pairs, [{ question: '复试问题', answerText: '本轮回答' }])
    assert.equal((written as Array<{ questionEventId: string }>)[0]!.questionEventId, 'final-event')
  })
})

describe('面试表分批生成与故障保留', () => {
  function setup(count = 43) {
    const pairs = Array.from({ length: count }, (_, index) => ({ questionEventId: `event-${index}`, question: `实际问题${index}`, answerSegmentIds: [`answer-${index}`], answerText: `实际回答${index}` }))
    const state = { written: [] as QuestionWriteInput[], notice: '', failed: '' }
    const repository = {
      claimPendingGeneration: async () => ({ sheetId: 'sheet-1', applicationId: 'app-1', stage: 'initial', sheetType: 'hr_screen' }),
      listSheetQaPairs: async () => pairs,
      getApplicationJobContext: async () => ({ jobTitle: '人事', requirements: ['招聘'], skills: [] }),
      replaceQuestions: async (_id: string, questions: QuestionWriteInput[]) => { state.written = questions },
      markGenerationNotice: async (_id: string, message: string) => { state.notice = message },
      markGenerationFailed: async (_id: string, message: string) => { state.failed = message },
    } as unknown as QuestionSheetRepository
    return { pairs, state, repository }
  }
  const resolveAiEnv = async () => ({ OPENAI_BASE_URL: 'https://model.example.invalid/v1', OPENAI_API_KEY: 'test-only', OPENAI_MODEL: 'enterprise-model' })

  it('43 组问答每批最多 5 题、最多 2 个并发，乱序完成后仍完整保存原问答与引用', async () => {
    const { pairs, state, repository } = setup()
    let active = 0
    let peak = 0
    const sizes: number[] = []
    const service = new QuestionSheetService(repository, { resolveAiEnv, createGenerator: config => {
      assert.equal(config.model, 'enterprise-model')
      return { generate: async input => {
        sizes.push(input.pairs.length)
        active++
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, input.pairs[0]!.question === '实际问题0' ? 10 : 1))
        active--
        return input.pairs.map((_pair, index) => generated('不采用模型改写的题干', index + 1))
      } }
    } })
    assert.deepEqual(await service.processPendingGeneration(), { processed: true, applicationId: 'app-1' })
    assert.equal(sizes.length, 9)
    assert.ok(sizes.every(size => size <= 5))
    assert.equal(peak, 2)
    assert.equal(state.written.length, 43)
    state.written.forEach((row, index) => {
      assert.equal(row.seq, index + 1)
      assert.equal(row.question, pairs[index]!.question)
      assert.equal(row.questionEventId, pairs[index]!.questionEventId)
      assert.deepEqual(row.answerSegmentIds, pairs[index]!.answerSegmentIds)
      assert.equal(row.answerText, pairs[index]!.answerText)
      assert.equal(row.aiScore, 80)
    })
    assert.equal(state.notice, '')
    assert.equal(state.failed, '')
  })

  for (const code of ['MODEL_REQUEST_FAILED', 'MODEL_HTTP_ERROR', 'MODEL_RESPONSE_INVALID'] as const) {
    it(`${code} 仅保留失败批次的真实问答为空分，其他题继续生成`, async () => {
      const { pairs, state, repository } = setup(12)
      const service = new QuestionSheetService(repository, { resolveAiEnv, createGenerator: () => ({ generate: async input => {
        if (input.pairs[0]!.question === '实际问题5') throw new QuestionSheetGenerationError(code, '模型测试故障')
        return input.pairs.map(pair => generated(pair.question))
      } }) })
      assert.deepEqual(await service.processPendingGeneration(), { processed: true, applicationId: 'app-1' })
      assert.equal(state.written.length, 12)
      for (let index = 0; index < 12; index++) {
        const row = state.written[index]!
        assert.equal(row.answerText, pairs[index]!.answerText)
        assert.equal(row.aiScore, index >= 5 && index < 10 ? null : 80)
        if (index >= 5 && index < 10) {
          assert.equal(row.aiTier, null)
          assert.equal(row.aiRationale, null)
          assert.deepEqual(row.aiEvidence, [])
        }
      }
      assert.match(state.notice, /全部 12.*5 道.*6-10.*未填入 AI 分数/)
      assert.equal(state.failed, '')
    })
  }

  it('模型全部超时也生成可人工评分的真实问答表，不伪造 AI 分数', async () => {
    const { state, repository } = setup(7)
    const service = new QuestionSheetService(repository, { resolveAiEnv, createGenerator: () => ({ generate: async () => { throw new QuestionSheetGenerationError('MODEL_REQUEST_FAILED', '请求超时') } }) })
    await service.processPendingGeneration()
    assert.equal(state.written.length, 7)
    assert.ok(state.written.every(row => row.aiScore === null))
    assert.match(state.notice, /7 道未获得 AI 评价/)
    assert.equal(state.failed, '')
  })

  it('鉴权、租户配置或程序异常不能伪装为模型降级成功', async () => {
    const { state, repository } = setup(8)
    let active = 0
    const service = new QuestionSheetService(repository, { resolveAiEnv, createGenerator: () => ({ generate: async input => {
      active++
      await new Promise(resolve => setTimeout(resolve, input.pairs[0]!.question === '实际问题0' ? 1 : 10))
      active--
      throw new Error('unexpected internal failure')
    } }) })
    const result = await service.processPendingGeneration()
    assert.equal(active, 0)
    assert.equal(result.failed, 'unexpected internal failure')
    assert.equal(state.written.length, 0)
    assert.equal(state.notice, '')
  })

  it('生成中的重复请求不重置任务或覆盖数据', async () => {
    let marked = false
    const repository = { find: async () => sheet({ status: 'generating' }), markGenerating: async () => { marked = true } } as unknown as QuestionSheetRepository
    const service = new QuestionSheetService(repository)
    service.getApplicationView = async () => ({ applicationId: 'app-1', sheets: [], stages: [], reviews: [], nextInterview: null })
    await service.requestGeneration('app-1', 'initial', 'hr_screen', 'user-1')
    assert.equal(marked, false)
  })
})
