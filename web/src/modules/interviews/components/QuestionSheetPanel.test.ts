// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import QuestionSheetPanel from './QuestionSheetPanel.vue'
import {
  loadQuestionSheets,
  recordStageDecision,
  scoreQuestion,
  updateStageWeights,
  type ApiApplicationQuestionSheets,
  type ApiInterviewQuestion,
  type ApiQuestionSheet,
  type QuestionSheetType,
} from '../api/question-sheets'
import { STAGE_DEFAULT_WEIGHTS, aggregateQuestions, recordingScoreOf, sheetScoresOf, stageScoreBreakdown } from '../utils/stage-score'

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
  const recording = recordingScoreOf(scoreable)
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

  it('点档位即保存档位与区间分，并展示 AI 默认分与依据', async () => {
    const element = await mount(buildView('scoring'))
    mockedScore.mockResolvedValue(question({ id: 'hr-1', finalTier: 'excellent', finalScore: 95 }))
    const firstQuestion = element.querySelector('.question-row') as HTMLElement
    expect(firstQuestion.textContent).toContain('AI 默认 80 分')
    expect(firstQuestion.textContent).toContain('回答结构清晰，但缺少量化结果')

    buttonByText(firstQuestion, '优秀').click()
    await flush()

    expect(mockedScore).toHaveBeenCalledWith('app-1', 'initial', 'hr_screen', 'hr-1', { finalTier: 'excellent', finalScore: 95 })
    expect(buttonByText(firstQuestion, '优秀').classList.contains('tier-active')).toBe(true)
    expect(element.querySelector('.sheet-card')?.textContent).toContain('表内平均')
    expect(element.querySelector('.sheet-card')?.textContent).toContain('95')
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
    const generate = buttonByText(element.querySelector('.sheet-card') as HTMLElement, '生成面试表')
    expect(generate.disabled).toBe(false)
  })
})
