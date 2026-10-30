// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import LiveQuestionBank from './LiveQuestionBank.vue'
import type { GeneratedInterviewQuestion } from '../api'
import { COMMON_QUESTION_GROUPS, isCommonQuestion } from '../utils/common-question-templates'
const questions: GeneratedInterviewQuestion[] = Array.from({ length: 5 }, (_, i) => ({ question: '请核实简历项目 ' + (i + 1) + ' 的个人贡献。', category: 'experience', difficulty: 'medium', rationale: '核实项目成果。', groundedIn: ['简历记载负责系统上线'], scoringRubric: [{ criterion: '个人贡献证据', points: 3 }] }))
let app: App | undefined, root: HTMLDivElement
let selected: Array<[string, string]>
function mount(overrides: Record<string, unknown> = {}) { selected = []; root=document.createElement('div');document.body.appendChild(root);app=createApp(LiveQuestionBank,{questions,currentQuestion:questions[0].question,round:1,...overrides,onSelect:(question:string,source:string)=>selected.push([question,source])});app.mount(root) }
afterEach(()=>{app?.unmount();root?.remove()})
describe('all interview questions by source', () => {
  it('shows only saved personal questions, never static template questions for missing groups', () => {
    mount()
    expect(root.querySelectorAll('[data-group="ai"] .question-select')).toHaveLength(5)
    for (const group of ['hr', 'department']) {
      expect(root.querySelectorAll('[data-group="' + group + '"] .question-select')).toHaveLength(0)
      expect(root.querySelector('[data-group="' + group + '"]')!.textContent).toContain('尚未就绪')
    }
    expect(root.querySelector('[data-group="boss"]')).toBeNull()
    for (const group of COMMON_QUESTION_GROUPS) for (const dimension of group.dimensions) for (const question of dimension.questions) expect(root.textContent).not.toContain(question)
    expect(root.textContent).not.toContain('任选其一')
    expect(root.textContent).not.toContain('HR 40 分 + 用人部门 60 分')
  })
  it('keeps final-round role dimensions available without substituting template questions', () => {
    mount({ round: 2 })
    expect(root.querySelectorAll('[data-group="boss"] .question-select')).toHaveLength(0)
    expect(root.querySelectorAll('[data-group="boss"] .template-dimension')).toHaveLength(5)
    expect(root.textContent).toContain('不自动计分')
  })
  it('emits exact generated question text for every available role', async () => {
    const bank = capabilityBank(); mount({ questions: bank })
    for (const group of ['ai', 'hr', 'department']) root.querySelector<HTMLButtonElement>('[data-group="' + group + '"] .question-select')!.click()
    await nextTick()
    expect(selected).toEqual([[bank[0].question, 'ai_adopted'], [bank[10].question, 'ai_adopted'], [bank[15].question, 'ai_adopted']])
  })
  it('restores a historical current question without presenting its entire old template as generated', () => {
    const question = COMMON_QUESTION_GROUPS[0].dimensions[2].questions[1]
    mount({ currentQuestion: question })
    expect(root.querySelector('.current-custom-question')!.textContent).toContain(question)
    expect(root.querySelectorAll('.question-item.selected')).toHaveLength(1)
    expect(root.querySelectorAll('[data-group="hr"] .question-select')).toHaveLength(0)
  })
  it('does not claim an absent question bank is an AI-generated bank', () => {
    mount({ questions: [], currentQuestion: '', engine: 'local_fallback' })
    expect(root.textContent).toContain('并非大模型结果')
    expect(root.textContent).toContain('待生成')
    expect(root.querySelectorAll('.question-select')).toHaveLength(0)
  })
  it('shows resume evidence and separate AI follow-up suggestions', () => {
    mount({ followUps: ['请补充量化结果。'] })
    expect(root.textContent).toContain('简历记载负责系统上线')
    expect(root.textContent).toContain('个人贡献证据')
    root.querySelector<HTMLButtonElement>('.follow-up .question-select')!.click()
    expect(selected).toEqual([['请补充量化结果。', 'ai_adopted']])
  })
  it('disables question selection while busy', () => {
    mount({ questions: capabilityBank(), round: 2, disabled: true })
    for (const button of root.querySelectorAll<HTMLButtonElement>('.question-select')) { expect(button.disabled).toBe(true); button.click() }
    expect(selected).toEqual([])
  })
  it('keeps reference dimensions and point totals intact', () => {
    expect(new Set(COMMON_QUESTION_GROUPS.map(group => group.id)).size).toBe(3)
    for (const group of COMMON_QUESTION_GROUPS) {
      expect(new Set(group.dimensions.map(dimension => dimension.id)).size).toBe(group.dimensions.length)
      expect(group.dimensions.reduce((sum, dimension) => sum + dimension.maxScore, 0)).toBe(group.maxScore)
    }
    expect(isCommonQuestion('模型生成的自定义问题')).toBe(false)
  })
})


function capabilityBank(): GeneratedInterviewQuestion[] {
  return [
    ...Array.from({ length: 10 }, (_, i) => ({ ...questions[0], group: 'ai' as const, question: `简历核实题 ${i + 1}` })),
    ...COMMON_QUESTION_GROUPS.filter(group => group.id !== 'boss').flatMap(group => group.dimensions.map(dimension => ({ ...questions[0], group: group.id as 'hr' | 'department', dimension: dimension.id, question: `AI新情境：${group.id}/${dimension.title}`, groundedIn: [dimension.focus], scoringRubric: [{ criterion: '可观察的能力证据', points: dimension.maxScore }] }))),
  ]
}
describe('generated capability questions', () => {
  it('shows the actual saved count instead of claiming a missing group has five questions', () => {
    const bank = capabilityBank().filter(question => question.group === 'hr').slice(0, 2)
    mount({ questions: bank, engine: 'llm', group: 'hr' })
    expect(root.querySelector('header')!.textContent).toContain('AI 生成 · 2 题')
    expect(root.querySelectorAll('.question-select')).toHaveLength(2)
    expect(root.textContent).toContain('HR 简历针对性提问')
  })
  it('renders 10 + 5 + 5 questions together and never mixes common questions into the resume group', () => {
    const bank = capabilityBank(); mount({ questions: bank, currentQuestion: bank[10].question, engine: 'llm' })
    expect(root.querySelectorAll('[data-group="ai"] .question-select')).toHaveLength(10)
    expect(root.querySelectorAll('[data-group="hr"] .question-select')).toHaveLength(5)
    expect(root.querySelectorAll('[data-group="department"] .question-select')).toHaveLength(5)
    expect(root.textContent).toContain('AI 生成 · 5 题')
    expect(root.textContent).toContain('本题生成依据与评分要点')
    expect(root.textContent).not.toContain(COMMON_QUESTION_GROUPS[0].dimensions[0].questions[0])
    expect(root.querySelector('[data-group="ai"]')!.textContent).not.toContain(bank[10].question)
    expect(root.querySelector('[data-group="hr"] [aria-pressed="true"]')!.textContent).toBe(bank[10].question)
  })
  it('persists HR and department AI questions as AI-adopted, not manual templates', () => {
    const bank = capabilityBank(); mount({ questions: bank, engine: 'llm' })
    root.querySelector<HTMLButtonElement>('[data-group="hr"] .question-select')!.click()
    root.querySelector<HTMLButtonElement>('[data-group="department"] .question-select')!.click()
    expect(selected).toEqual([[bank[10].question, 'ai_adopted'], [bank[15].question, 'ai_adopted']])
  })
  it('clearly marks all locally-generated groups as fallback instead of claiming AI random generation', () => {
    mount({ questions: capabilityBank(), engine: 'local_fallback' })
    expect(root.querySelector('[data-group="hr"]')!.textContent).toContain('并非大模型随机结果')
    expect(root.querySelector('[data-group="department"]')!.textContent).toContain('本地规则 · 5 题')
    expect(root.textContent).not.toContain('AI 生成 · 5 题')
  })
})

it('混合题库按各表实际来源标记，不把成功的AI表误标为本地规则', () => {
  const bank = capabilityBank().map(question => ({ ...question, sourceEngine: question.group === 'department' ? 'llm' as const : 'local_fallback' as const }))
  mount({ questions: bank, engine: 'local_fallback' })
  expect(root.querySelector('[data-group="department"]')!.textContent).toContain('AI 生成 · 5 题')
  expect(root.querySelector('[data-group="department"] .fallback-note')).toBeNull()
  expect(root.querySelector('[data-group="hr"]')!.textContent).toContain('本地规则 · 5 题')
})

describe('independent complete reference sheets', () => {
  it.each(['ai', 'hr', 'department'])('renders only the %s group with expanded reference details', group => {
    const bank = capabilityBank(); mount({ group, questions: bank, engine: 'llm' })
    expect([...root.querySelectorAll('[data-group]')].map(item => item.getAttribute('data-group'))).toEqual([group])
    expect(root.querySelectorAll('.question-select')).toHaveLength(group === 'ai' ? 10 : 5)
    expect(root.querySelector('nav')).toBeNull()
    const references = [...root.querySelectorAll<HTMLDetailsElement>('details')]
    expect(references.length).toBeGreaterThan(0)
    expect(references.every(item => item.open)).toBe(true)
    expect(selected).toEqual([])
  })
  it('keeps the final-round BOSS reference in its own sheet', () => {
    mount({ group: 'boss', round: 2 })
    expect([...root.querySelectorAll('[data-group]')].map(item => item.getAttribute('data-group'))).toEqual(['boss'])
    expect(root.querySelectorAll('.question-select')).toHaveLength(0)
    expect(root.textContent).toContain('尚未就绪')
  })
})

it('复试的BOSS组使用生成题，替换静态模板并标记AI来源', async () => {
  const generated = COMMON_QUESTION_GROUPS.find(group => group.id === 'boss')!.dimensions.map(dimension => ({ ...questions[0], group: 'boss' as const, dimension: dimension.id, question: 'AI BOSS考核：' + dimension.title }))
  mount({ round: 2, questions: generated, engine: 'llm' })
  expect(root.querySelectorAll('[data-group="boss"] .question-select')).toHaveLength(5)
  root.querySelector<HTMLButtonElement>('[data-group="boss"] .question-select')!.click(); await nextTick()
  expect(selected).toEqual([[generated[0].question, 'ai_adopted']])
  expect(root.querySelector('[data-group="boss"] .fallback-note')).toBeNull()
})
