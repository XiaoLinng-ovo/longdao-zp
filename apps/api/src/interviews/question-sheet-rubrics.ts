import type { InterviewStage, QuestionSheetType, QuestionTier } from './question-sheet-repository.js'

export interface AssessmentCriterion {
  id: string
  title: string
  focus: string
  maxScore: number
  excellent: string
  pass: string
  below: string
}

export const ASSESSMENT_RUBRICS: Record<'hr' | 'department' | 'boss', AssessmentCriterion[]> = {
  hr: [
    { id: 'motivation', title: '离职动机与职业规划', focus: '跳槽理性程度、职业规划清晰度、长期稳定性', maxScore: 8, excellent: '离职原因客观理性，职业规划清晰且与公司方向匹配', pass: '能说出原因和规划，但略显模糊或理想化', below: '频繁抱怨前公司/领导，职业规划空白，只看短期利益' },
    { id: 'expectation', title: '薪酬期望与市场定位', focus: '自我认知合理性、薪资匹配度、对成长与金钱的平衡观', maxScore: 8, excellent: '期望合理有市场依据，理性看待总包与成长，不只看钱', pass: '期望略高但可协商，或市场定位不够清晰', below: '期望远超岗位范围且毫无弹性，完全不了解市场' },
    { id: 'collaboration', title: '工作风格与团队适配', focus: '协作方式、沟通习惯、对团队角色的自我认知', maxScore: 8, excellent: '协作方式、沟通习惯、对团队角色的自我认知', pass: '风格清晰有自我认知，能与团队互补，沟通成熟', below: '能描述风格但缺乏案例，或适配性一般' },
    { id: 'pressure', title: '抗压能力与职业成熟度', focus: '面对批评/失败/高压时的情绪与行为反应', maxScore: 8, excellent: '能正视压力，主动寻求解决方案，事后复盘，情绪稳定', pass: '能承受压力但应对方式单一，或偶有情绪化', below: '逃避责任、情绪失控、指责他人，或轻描淡写不面对' },
    { id: 'values', title: '价值观与公司文化匹配', focus: '诚信、责任感、对规则与公平的认知、与公司文化契合度', maxScore: 8, excellent: '价值观清晰正向，与公司文化高度契合，行为一致性高', pass: '无明显冲突，但表达泛泛或缺少真实案例', below: '价值观明显冲突（如不诚信、极度躺平或内卷），或无法回答' },
  ],
  department: [
    { id: 'results', title: '专业能力、结果导向', focus: '', maxScore: 12, excellent: '结构清晰（背景-动作-难点-结果），有量化数据，角色明确', pass: '有成果但数据模糊，或角色不清晰、难点轻描淡写', below: '无成果、无数据，或夸大但经不起追问' },
    { id: 'learning', title: '学习能力、问题拆解', focus: '', maxScore: 12, excellent: '清晰的步骤：信息收集→拆解目标→找标杆→最小闭环→快速迭代', pass: '有步骤但跳跃或缺少闭环验证', below: '等人教、等资源，或说“先学三个月”' },
    { id: 'initiative', title: '主动性、业务敏感度', focus: '', maxScore: 12, excellent: '主动观察→提出方案→推动落地→有可衡量的改善', pass: '发现但未主动解决，或效果不明确', below: '从未主动发现过问题，全是上级安排' },
    { id: 'innovation', title: '创新执行、资源受限下的决策', focus: '', maxScore: 12, excellent: '先分析痛点→设计低成本实验→验证→迭代方向', pass: '有想法但缺乏验证环节', below: '直接说要买工具/软件，不考虑预算' },
    { id: 'adaptation', title: '适应性、职业成熟度', focus: '', maxScore: 12, excellent: '先理解业务需要，主动沟通调整优先级，从中找到学习点', pass: '有情绪但能配合，或选择忍耐', below: '直接抱怨、消极怠工或轻易离职' },
  ],
  boss: [
    { id: 'breakthrough', title: '创新、追求卓越、复盘能力', focus: '', maxScore: 20, excellent: '经历有突破性，清晰描述困境与行动，复盘有深刻洞察，体现成长', pass: '经历有价值但创新性或难度一般，复盘较浅', below: '没有独立负责经历，或复盘全是外部原因' },
    { id: 'strategy', title: '结果导向、资源整合、决策逻辑', focus: '', maxScore: 20, excellent: '目标拆解清晰，有优先级判断，能识别关键风险，体现共赢思维', pass: '有基本思路但不够具体，或缺少风险应对', below: '思路混乱，或只说“按领导要求做”' },
    { id: 'alignment', title: '共赢、向上管理、冲突处理', focus: '', maxScore: 20, excellent: '能坚持原则的同时寻找共识，推动事情向好处发展，关系未破裂', pass: '有沟通但效果一般，或妥协后仍有情绪', below: '对抗、回避，或事后关系恶化' },
    { id: 'resilience', title: '保证结果、抗压能力、韧性', focus: '', maxScore: 20, excellent: '能坦诚面对失败，主动复盘并采取行动扭转或止损，心态成熟', pass: '能接受但行动不足，或需要较长时间恢复', below: '抱怨资源/环境，或一蹶不振' },
    { id: 'vision', title: '战略视野、岗位理解、追求卓越', focus: '', maxScore: 20, excellent: '有独立判断，观点清晰且有依据，能结合公司实际，体现进取心', pass: '有一定了解但较表面，或回答空泛', below: '完全不了解行业和公司，或回答与岗位无关' },
  ],
}

export const ASSESSMENT_RUBRIC_VERSION = 'manual-rubric-v2'

export function rubricTypeForSheet(_stage: InterviewStage, type: QuestionSheetType): 'hr' | 'department' | 'boss' {
  if (type === 'boss') return 'boss'
  if (type === 'hr' || type === 'hr_screen') return 'hr'
  return 'department'
}

export function assessmentCriterion(category?: string | null): AssessmentCriterion | undefined {
  const [, group, id] = category?.split(':') ?? []
  if (!category?.startsWith('rubric:') || !group || !Object.hasOwn(ASSESSMENT_RUBRICS, group)) return undefined
  return ASSESSMENT_RUBRICS[group as keyof typeof ASSESSMENT_RUBRICS].find(item => item.id === id)
}

export function questionMaximum(question: { category?: string | null; tiers: QuestionTier[] }): number {
  if (!question.category?.startsWith('rubric:')) return 100
  const criterion = assessmentCriterion(question.category)
  if (criterion) return criterion.maxScore
  const maxima = question.tiers.map(tier => tier.max).filter(value => Number.isFinite(value) && value > 0)
  return maxima.length ? Math.max(...maxima) : 100
}

export function tiersForCriterion(group: 'hr' | 'department' | 'boss', criterion: AssessmentCriterion): QuestionTier[] {
  const excellentMin = group === 'hr' ? 8 : group === 'department' ? 8 : 17
  const passMin = group === 'boss' ? 12 : 6
  const passMax = group === 'boss' ? 16 : 7
  return [
    { tier: 'excellent', min: excellentMin, max: group === 'department' ? 10 : criterion.maxScore, description: criterion.excellent },
    { tier: 'pass', min: passMin, max: passMax, description: criterion.pass },
    { tier: 'below', min: 0, max: group === 'boss' ? 11 : 5, description: criterion.below },
  ]
}
