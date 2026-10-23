// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import QuestionSheetPanel from './QuestionSheetPanel.vue'
import {
  loadQuestionSheets,
  generateQuestionSheet,
  recordStageDecision,
  scoreQuestion,
  updateStageWeights,
  type ApiApplicationQuestionSheets,
  type ApiInterviewQuestion,
  type ApiQuestionSheet,
  type QuestionSheetType,
} from '../api/question-sheets'
import { STAGE_DEFAULT_WEIGHTS, aggregateQuestions, sheetScoresOf, stageScoreBreakdown } from '../utils/stage-score'

vi.mock('../api/question-sheets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/question-sheets')>()
  return {
    ...actual,
    loadQuestionSheets: vi.fn(),
    generateQuestionSheet: vi.fn(),
    scoreQuestion: vi.fn(),
    addSheetQuestion: vi.fn(),
    deleteSheetQuestion: vi.fn(),
    submitSheet: vi.fn(),
    lockSheet: vi.fn(),
    unlockSheet: vi.fn(),
    updateStageWeights: vi.fn(),
    recordStageDecision: vi.fn(),
  }
})

const mockedLoad = vi.mocked(loadQuestionSheets)
const mockedScore = vi.mocked(scoreQuestion)
const mockedSaveWeights = vi.mocked(updateStageWeights)
const mockedDecision = vi.mocked(recordStageDecision)

const defaultTiers = [
  { tier: 'excellent' as const, min: 90, max: 100, description: '超出预期' },
  { tier: 'pass' as const, min: 70, max: 89, description: '符合要求' },
  { tier: 'below' as const, min: 0, max: 69, description: '明显不足' },
]

function question(overrides: Partial<ApiInterviewQuestion> = {}): ApiInterviewQuestion {
  return {
    id: 'q1',
    seq: 1,
    question: '讲一个你主导的跨部门项目',
    dimension: '沟通能力',
    category: 'behavioral',
    difficulty: 'medium',
    source: 'live_question',
    questionEventId: null,
    answerSegmentIds: [],
    answerText: '我在上个季度主导了结算系统改造',
    tiers: defaultTiers,
    aiTier: 'pass',
    aiScore: 80,
    aiRationale: '回答结构清晰，但缺少量化结果',
    aiEvidence: ['结算系统改造由我牵头'],
    finalTier: null,
    finalScore: null,
    comment: null,
    scoredBy: null,
    scoredAt: null,
    ...overrides,
  }
}

function sheet(sheetType: QuestionSheetType, questions: ApiInterviewQuestion[], overrides: Partial<ApiQuestionSheet> = {}): ApiQuestionSheet {
  return {
    id: `sheet-${sheetType}`,
    applicationId: 'app-1',
    stage: 'initial',
    sheetType,
    status: 'submitted',
    source: 'ai',
    generationModel: 'gpt-5.6-sol',
    generationError: null,
    generationNotice: null,
    generatedAt: '2026-09-21T00:00:00.000Z',
    submittedAt: null,
    lockedAt: null,
    questions,
    aggregate: aggregateQuestions(questions),
    ...overrides,
  }
}

function buildView(status: ApiQuestionSheet['status'] = 'submitted'): ApiApplicationQuestionSheets {
  const sheets = [
    sheet('hr_screen', [question({ id: 'hr-1', finalScore: 82, aiScore: 80 }), question({ id: 'hr-2', seq: 2, finalScore: null, aiScore: null, answerText: null })], { status }),
    sheet('hiring_department', [question({ id: 'hd-1', finalScore: 76, aiScore: 78 })], { status }),
  ]
  const weights = STAGE_DEFAULT_WEIGHTS.initial
  const scoreable = sheets.filter((item) => item.status === 'submitted' || item.status === 'locked')
  const recording = 79 // 独立的整场对话总结分，与参考题逐题分数无关
  return {
    applicationId: 'app-1',
    sheets,
    reviews: [],
    stages: [
      { stage: 'initial', weights, breakdown: stageScoreBreakdown('initial', sheetScoresOf(scoreable), recording, weights) },
      { stage: 'final', weights: STAGE_DEFAULT_WEIGHTS.final, breakdown: stageScoreBreakdown('final', {}, null, STAGE_DEFAULT_WEIGHTS.final) },
    ],
  }
}

let app: App | undefined
let root: HTMLDivElement | undefined

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function mount(view: ApiApplicationQuestionSheets = buildView()): Promise<HTMLDivElement> {
  mockedLoad.mockResolvedValue(view)
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(QuestionSheetPanel, { applicationId: 'app-1' })
  app.mount(root)
  await flush()
  return root
}

function setInput(input: HTMLInputElement, value: string, event: 'input' | 'change' = 'input'): void {
  input.value = value
  input.dispatchEvent(new Event(event, { bubbles: true }))
}

function buttonByText(scope: HTMLElement, text: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll('button')].find((item) => item.textContent?.includes(text))
  if (!button) throw new Error(`未找到按钮：${text}`)
  return button as HTMLButtonElement
}

afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
  vi.resetAllMocks()
})

describe('QuestionSheetPanel', () => {
  it('按阶段展示该阶段的表，并直接展示综合分公式', async () => {
    const element = await mount()
    expect(mockedLoad).toHaveBeenCalledWith('app-1')
    expect(element.textContent).toContain('人事面试表')
    expect(element.textContent).toContain('用人部门面试表')
    expect(element.querySelectorAll('.sheet-card')).toHaveLength(2)

    const expected = stageScoreBreakdown('initial', { hr_screen: 82, hiring_department: 76 }, 79, STAGE_DEFAULT_WEIGHTS.initial)
    expect(element.querySelector('[data-testid="stage-formula"]')?.textContent?.trim()).toBe(expected.formula)
    expect(element.textContent).toContain('阶段综合分 = Σ(各表得分 × 表权重) + 录音 AI 评分 × 录音权重')
    expect(element.textContent).toContain('已打分 1/2')
  })

  it('点档位即保存档位与区间分，并展示 AI 参考分与依据', async () => {
    const element = await mount(buildView('scoring'))
    mockedScore.mockResolvedValue(question({ id: 'hr-1', finalTier: 'excellent', finalScore: 95 }))
    const firstQuestion = element.querySelector('.question-row') as HTMLElement
    expect(firstQuestion.textContent).toContain('AI 参考 80 分')
    expect(firstQuestion.textContent).toContain('回答结构清晰，但缺少量化结果')

    buttonByText(firstQuestion, '优秀').click()
    await flush()

    expect(mockedScore).toHaveBeenCalledWith('app-1', 'initial', 'hr_screen', 'hr-1', { finalTier: 'excellent', finalScore: 95 })
    expect(buttonByText(firstQuestion, '优秀').classList.contains('tier-active')).toBe(true)
    expect(element.querySelector('.sheet-card')?.textContent).toContain('标准化得分')
    expect(element.querySelector('.sheet-card')?.textContent).toContain('95')
  })

  it('权重预览只使用整场录音分，参考题局部分数不会替代它', async () => {
    const view = buildView()
    view.sheets.forEach(sheet => sheet.questions.forEach(question => { question.aiScore = 5 }))
    view.stages[0]!.breakdown = stageScoreBreakdown('initial', { hr_screen: 82, hiring_department: 76 }, 91, STAGE_DEFAULT_WEIGHTS.initial)
    const el = await mount(view)
    setInput(el.querySelector('input[aria-label="人事面试表权重"]') as HTMLInputElement, '50')
    setInput(el.querySelector('input[aria-label="用人部门面试表权重"]') as HTMLInputElement, '20')
    await flush()
    expect(el.querySelector('[data-testid="stage-formula"]')?.textContent).toContain('91 × 0.3')
    expect(el.querySelector('[data-testid="stage-formula"]')?.textContent).not.toContain('5 ×')
  })

  it('面试官调整权重后按新公式重算，保存时提交新权重', async () => {
    const element = await mount()
    mockedSaveWeights.mockResolvedValue({ review: {} as never, breakdown: stageScoreBreakdown('initial', { hr_screen: 82, hiring_department: 76 }, 79, { sheets: { hr_screen: 0.5, hiring_department: 0.2 }, recording: 0.3 }) })

    setInput(element.querySelector('input[aria-label="人事面试表权重"]') as HTMLInputElement, '50')
    setInput(element.querySelector('input[aria-label="用人部门面试表权重"]') as HTMLInputElement, '20')
    await flush()

    expect(element.querySelector('[data-testid="stage-formula"]')?.textContent).toContain('82 × 0.5 + 76 × 0.2 + 79 × 0.3')
    expect(element.textContent).toContain('权重合计 100%')

    buttonByText(element, '保存权重').click()
    await flush()

    expect(mockedSaveWeights).toHaveBeenCalledWith('app-1', 'initial', { sheets: { hr_screen: 0.5, hiring_department: 0.2 }, recording: 0.3 })
  })

  it('权重合计不是 100% 时不允许保存', async () => {
    const element = await mount()
    setInput(element.querySelector('input[aria-label="人事面试表权重"]') as HTMLInputElement, '60')
    await flush()

    expect(element.textContent).toContain('需为 100% 才能保存')
    expect(buttonByText(element, '保存权重').disabled).toBe(true)
  })

  it('缺失项按剩余权重归一，并在页面上说明', async () => {
    const view = buildView()
    view.sheets = [sheet('hr_screen', [question({ id: 'hr-1', finalScore: 80, aiScore: null }), question({ id: 'hr-2', seq: 2, finalScore: null, aiScore: null, answerText: null })])]
    view.stages = [{ stage: 'initial', weights: STAGE_DEFAULT_WEIGHTS.initial, breakdown: stageScoreBreakdown('initial', { hr_screen: 80 }, null, STAGE_DEFAULT_WEIGHTS.initial) }]
    const element = await mount(view)

    expect(element.textContent).toContain('录音 AI 评分暂无分数')
    expect(element.textContent).toContain('缺失项不参与计算，权重已在剩余项之间归一')
    expect(element.querySelector('[data-testid="stage-formula"]')?.textContent?.trim()).toBe('80 × 1 = 80')
  })

  it('阶段结论由人确认：确认弹窗后写入结论', async () => {
    const element = await mount()
    mockedDecision.mockResolvedValue({} as never)

    buttonByText(element, '淘汰').click()
    await flush()
    expect(document.body.textContent).toContain('确认初试结论')

    const dialog = document.querySelector('.dialog') as HTMLElement
    expect(dialog.textContent).toContain('结论由人确认，AI 不自动改申请状态')
    buttonByText(dialog, '确认结论').click()
    await flush()

    expect(mockedDecision).toHaveBeenCalledWith('app-1', 'initial', 'rejected')
  })

  it('未生成的表给出生成入口与提示', async () => {
    const view = buildView()
    view.sheets = []
    view.stages = []
    const element = await mount(view)

    expect(element.textContent).toContain('这张表还没有生成')
    const generate = buttonByText(element.querySelector('.sheet-card') as HTMLElement, '载入考察点')
    expect(generate.disabled).toBe(false)
  })
})

function advancedView(withInterview = true): ApiApplicationQuestionSheets {
  const view = buildView()
  view.reviews = [{ id: 'review-1', applicationId: 'app-1', stage: 'initial', sheetScores: {}, weights: STAGE_DEFAULT_WEIGHTS.initial, weightsHistory: [], recordingScore: null, aiScore: null, aiRecommendation: null, aiRationale: null, aiEvidence: [], decision: 'advanced', decidedBy: 'user-1', decidedAt: '2026-10-13T00:00:00Z' }]
  view.nextInterview = withInterview ? { id: 'round-2', round: 2, stage: 'final', status: 'scheduled' } : null
  return view
}
describe('复试阶段流转', () => {
  it('确认进入复试后展示复试三张表和第二轮入口，初试结论不再重复操作', async () => {
    const element = await mount()
    const next = advancedView()
    mockedDecision.mockResolvedValue({ ...next.reviews[0], nextInterview: next.nextInterview } as never)
    mockedLoad.mockResolvedValue(next)
    buttonByText(element, '进入复试').click(); await flush()
    buttonByText(document.querySelector('.dialog') as HTMLElement, '确认结论').click(); await flush()
    expect(mockedDecision).toHaveBeenCalledWith('app-1', 'initial', 'advanced')
    expect(element.querySelectorAll('.sheet-card')).toHaveLength(3)
    expect(element.textContent).toContain('业务面试表')
    expect(element.textContent).toContain('HR 面试表')
    expect(element.textContent).toContain('BOSS 面试表')
    expect(element.querySelector('a[href="/interviews/round-2/live"]')).not.toBeNull()
    expect(buttonByText(element.querySelector('.stage-decide')!, '录用')).toBeDefined()
    buttonByText(element, '初试（2/2）').click(); await flush()
    expect(element.querySelector('.stage-decide')?.textContent).toContain('已进入复试')
    expect([...element.querySelectorAll('.stage-decide button')].map(item => item.textContent?.trim())).toEqual(['查看复试评价'])
    buttonByText(element, '查看复试评价').click(); await flush()
    expect(element.querySelectorAll('.sheet-card')).toHaveLength(3)
  })
  it('重新打开已晋级记录时默认展示复试，不在读取时创建第二轮', async () => {
    const element = await mount(advancedView())
    expect(element.querySelectorAll('.sheet-card')).toHaveLength(3)
    expect(element.querySelector('a[href="/interviews/round-2"]')).not.toBeNull()
    expect(mockedDecision).not.toHaveBeenCalled()
  })
  it('已取消的第二轮显示状态，不提供重复创建和进入面试室入口', async () => {
    const view = advancedView()
    view.nextInterview!.status = 'cancelled'
    const element = await mount(view)
    expect(element.textContent).toContain('面试已取消')
    expect(element.querySelector('a[href="/interviews/round-2"]')).not.toBeNull()
    expect(element.querySelector('a[href="/interviews/round-2/live"]')).toBeNull()
    expect(element.textContent).not.toContain('创建第二轮面试')
    expect(mockedDecision).not.toHaveBeenCalled()
  })
  it('旧版只有晋级结论的记录可显式补齐第二轮，点击后反馈结果', async () => {
    const element = await mount(advancedView(false))
    expect(mockedDecision).not.toHaveBeenCalled()
    mockedDecision.mockResolvedValue({ ...advancedView().reviews[0], nextInterview: advancedView().nextInterview } as never)
    mockedLoad.mockResolvedValue(advancedView())
    buttonByText(element, '创建第二轮面试').click(); await flush()
    expect(mockedDecision).toHaveBeenCalledWith('app-1', 'initial', 'advanced')
    expect(element.querySelector('a[href="/interviews/round-2/live"]')).not.toBeNull()
    expect(element.textContent).toContain('第二轮面试已就绪')
  })
  it('晋级失败时保留初试与原记录，并显示失败原因', async () => {
    const element = await mount()
    mockedDecision.mockRejectedValue(new Error('当前应聘状态不能进入复试'))
    buttonByText(element, '进入复试').click(); await flush()
    buttonByText(document.querySelector('.dialog') as HTMLElement, '确认结论').click(); await flush()
    expect(element.textContent).toContain('当前应聘状态不能进入复试')
    expect(element.querySelector('a[href="/interviews/round-2/live"]')).toBeNull()
    expect(mockedLoad).toHaveBeenCalledTimes(1)
  })
})

describe('角色通用考察点评分模板', () => {
  function rubricCriterion(): ApiInterviewQuestion {
    return question({
      id: 'hr-rubric-motivation',
      seq: 1,
      question: '职业动机与职业规划',
      dimension: '职业动机与职业规划',
      category: 'rubric:hr:motivation',
      assessmentFocus: '跳槽合理性、职业规划清晰度、长期稳定性',
      source: 'manual',
      questionEventId: null,
      answerSegmentIds: [],
      answerText: null,
      tiers: [
        { tier: 'excellent', min: 8, max: 8, description: '动机清晰，规划合理' },
        { tier: 'pass', min: 6, max: 7, description: '动机基本合理' },
        { tier: 'below', min: 0, max: 5, description: '稳定性存疑' },
      ],
      aiTier: null,
      aiScore: null,
      aiRationale: null,
      aiEvidence: [],
      finalTier: null,
      finalScore: null,
    })
  }

  it('展示考察点、关注内容和各评分区间，不显示面试问答或 AI 逐题评分', async () => {
    const view = buildView('scoring')
    view.sheets = [sheet('hr_screen', [rubricCriterion()], { status: 'scoring' })]
    const element = await mount(view)

    expect(element.textContent).toContain('职业动机与职业规划')
    expect(element.textContent).toContain('跳槽合理性、职业规划清晰度、长期稳定性')
    expect(element.textContent).toContain('优秀')
    expect(element.textContent).toContain('合格')
    expect(element.textContent).toContain('淘汰信号')
    expect(element.textContent).toContain('8 分')
    expect(element.textContent).toContain('动机清晰，规划合理')
    expect(element.textContent).toContain('动机基本合理')
    expect(element.textContent).toContain('稳定性存疑')
    expect(element.textContent).toContain('6-7 分')
    expect(element.textContent).toContain('0-5 分')
    expect(element.querySelector('.question-block-answer')).toBeNull()
    expect(element.querySelector('.ai-score-btn')).toBeNull()
    expect(element.querySelector('.question-evidence')).toBeNull()

    const input = element.querySelector<HTMLInputElement>('.score-input input')!
    expect(input.max).toBe('8')
    mockedScore.mockResolvedValue({ ...rubricCriterion(), finalScore: 7, finalTier: 'pass' })
    setInput(input, '7')
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(mockedScore).toHaveBeenCalledWith('app-1', 'initial', 'hr_screen', 'hr-rubric-motivation', { finalScore: 7, finalTier: 'pass' })
  })

  it.each([
    ['initial', 'hr_screen', 8, 8, 6, 7],
    ['initial', 'hiring_department', 12, 8, 6, 7],
    ['final', 'business', 12, 8, 6, 7],
    ['final', 'hr', 8, 8, 6, 7],
    ['final', 'boss', 20, 17, 12, 16],
  ] as const)('%s/%s：按角色上限人工评分、保存档位和评语，展示原始分与百分制', async (stage, type, max, excellentMin, passMin, passMax) => {
    const criterion = rubricCriterion()
    criterion.maxScore = max
    criterion.tiers = [
      { tier: 'excellent', min: excellentMin, max: max === 12 ? 10 : max, description: '优秀表现描述' },
      { tier: 'pass', min: passMin, max: passMax, description: '合格表现描述' },
      { tier: 'below', min: 0, max: passMin - 1, description: '需警惕的表现描述' },
    ]
    const questions = Array.from({ length: 5 }, (_, index) => ({ ...criterion, id: 'criterion-' + index, seq: index + 1 }))
    const view = buildView('scoring')
    view.sheets = [sheet(type, questions, { stage, status: 'scoring' })]
    const element = await mount(view)
    if (stage === 'final') { buttonByText(element, '复试（').click(); await flush() }
    const card = [...element.querySelectorAll<HTMLElement>('.sheet-card')].find(item => item.querySelector('.rubric-row'))!
    const row = card.querySelector<HTMLElement>('.rubric-row')!
    const input = row.querySelector<HTMLInputElement>('.score-input input')!
    expect(input.max).toBe(String(max))
    expect(card.textContent).toContain('/ ' + max * 5)
    expect(row.querySelectorAll('.criterion-tier')).toHaveLength(3)
    expect(row.querySelector('.criterion-description')?.textContent).toContain('优秀表现描述')
    expect(card.querySelector('.question-delete')).toBeNull()
    expect(card.textContent).not.toContain('手工补录题目')

    const finalTier = max === 12 ? null : 'excellent' as const
    const scored = { ...questions[0]!, finalScore: max, finalTier }
    mockedScore.mockResolvedValueOnce(scored)
    setInput(input, String(max))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(mockedScore).toHaveBeenLastCalledWith('app-1', stage, type, 'criterion-0', { finalScore: max, finalTier })
    expect(row.querySelector('.criterion-excellent')?.getAttribute('aria-pressed')).toBe(String(finalTier === 'excellent'))
    expect(row.textContent).toContain('已保存')
    expect(card.textContent).toContain('标准化得分 100 / 100')

    mockedScore.mockResolvedValueOnce({ ...scored, finalTier: 'pass', finalScore: Math.round((passMin + passMax) / 2) })
    buttonByText(row, '合格').click()
    await flush()
    expect(mockedScore).toHaveBeenLastCalledWith('app-1', stage, type, 'criterion-0', { finalTier: 'pass', finalScore: Math.round((passMin + passMax) / 2) })

    const savedComment = '已按本项观察人工评估'
    mockedScore.mockResolvedValueOnce({ ...scored, comment: savedComment })
    const comment = row.querySelector<HTMLInputElement>('.criterion-comment input')!
    setInput(comment, savedComment)
    comment.dispatchEvent(new Event('blur', { bubbles: true }))
    await flush()
    expect(mockedScore).toHaveBeenLastCalledWith('app-1', stage, type, 'criterion-0', { comment: savedComment })
  })

  it('人工分数超出角色上限时明确提示，不写入错误分数', async () => {
    const view = buildView('scoring')
    view.sheets = [sheet('hr_screen', [rubricCriterion()], { status: 'scoring' })]
    const element = await mount(view)
    const input = element.querySelector<HTMLInputElement>('.score-input input')!
    setInput(input, '9')
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(element.textContent).toContain('分数需在 0-8 之间')
    expect(mockedScore).not.toHaveBeenCalled()
  })

  it.each(['submitted', 'locked'] as const)('%s 状态禁止重新载入考察点', async (status) => {
    const view = buildView(status)
    view.sheets = [sheet('hr_screen', [rubricCriterion()], { status })]
    const element = await mount(view)
    const reload = buttonByText(element.querySelector('.sheet-card') as HTMLElement, '重新载入考察点')
    expect(reload.disabled).toBe(true)
    reload.click()
    expect(generateQuestionSheet).not.toHaveBeenCalled()
  })

  it('待打分但尚无人工评分时可重新载入考察点', async () => {
    const view = buildView('scoring')
    view.sheets = [sheet('hr_screen', [rubricCriterion()], { status: 'scoring' })]
    const element = await mount(view)
    const refreshed = structuredClone(view)
    vi.mocked(generateQuestionSheet).mockResolvedValueOnce(refreshed)

    const reload = buttonByText(element.querySelector('.sheet-card') as HTMLElement, '重新载入考察点')
    expect(reload.disabled).toBe(false)
    reload.click()
    await flush()

    expect(generateQuestionSheet).toHaveBeenCalledWith('app-1', 'initial', 'hr_screen')
    expect(element.textContent).toContain('人事面试表考察点已载入，可以开始人工评分')
  })

  it('待打分表已有人工评分或评语时禁止重新载入', async () => {
    const view = buildView('scoring')
    view.sheets = [sheet('hr_screen', [{ ...rubricCriterion(), finalScore: 7 }], { status: 'scoring' })]
    const element = await mount(view)
    const reload = buttonByText(element.querySelector('.sheet-card') as HTMLElement, '重新载入考察点')

    expect(reload.disabled).toBe(true)
    reload.click()
    expect(generateQuestionSheet).not.toHaveBeenCalled()
  })

  it.each([
    { finalScore: 7 },
    { finalScore: 0 },
    { finalTier: 'pass' as const },
    { comment: '' },
    { comment: '已记录人工评价' },
  ])('已有评分或评语时禁止覆盖模板：%j', async (saved) => {
    const view = buildView('draft')
    view.sheets = [sheet('hr_screen', [{ ...rubricCriterion(), ...saved }], { status: 'draft' })]
    const element = await mount(view)
    const reload = buttonByText(element.querySelector('.sheet-card') as HTMLElement, '载入考察点')
    expect(reload.disabled).toBe(true)
    reload.click()
    expect(generateQuestionSheet).not.toHaveBeenCalled()
  })

  it('生成中的表禁用重复载入，其他待生成表仍可载入', async () => {
    const view = buildView('draft')
    view.sheets[0]!.status = 'generating'
    view.sheets.forEach(item => { item.questions = [] })
    const element = await mount(view)
    const cards = element.querySelectorAll<HTMLElement>('.sheet-card')
    expect(buttonByText(cards[0]!, '正在载入').disabled).toBe(true)
    expect(buttonByText(cards[1]!, '载入考察点').disabled).toBe(false)
    buttonByText(cards[0]!, '正在载入').click()
    expect(generateQuestionSheet).not.toHaveBeenCalled()
  })
})
