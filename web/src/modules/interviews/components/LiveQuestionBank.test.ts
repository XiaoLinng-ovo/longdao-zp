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
describe('all interview questions by source',()=>{
  it('does not show the removed footer scoring explanation',()=>{mount({round:2});expect(root.textContent).not.toContain('HR 40 分 + 用人部门 60 分');expect(root.textContent).not.toContain('平台阶段评分仍按现有权重计算');expect(root.querySelectorAll('[data-group="hr"] .question-select')).toHaveLength(15);expect(root.querySelectorAll('[data-group="department"] .question-select')).toHaveLength(5)})
  it('shows all AI, HR alternatives, and departmental questions together, not a one-question carousel',()=>{mount();expect(root.querySelectorAll('[data-group="ai"] .question-select')).toHaveLength(5);expect(root.querySelectorAll('[data-group="hr"] .question-select')).toHaveLength(15);expect(root.querySelectorAll('[data-group="department"] .question-select')).toHaveLength(5);expect(root.querySelectorAll('[data-group="boss"]')).toHaveLength(0);for(const question of questions)expect(root.textContent).toContain(question.question);expect(root.textContent).toContain('任选其一');expect(root.querySelector('.question-group details[open]')).toBeNull()})
  it('adds all boss questions for final interviews and keeps their reference total separate',()=>{mount({round:2});expect(root.querySelectorAll('[data-group="boss"] .question-select')).toHaveLength(5);expect(root.textContent).toContain('不与 HR、部门分值直接相加');expect(root.textContent).toContain('不自动计分')})
  it('emits exact question text and the correct persistence source for AI versus templates',async()=>{mount();root.querySelector<HTMLButtonElement>('[data-group="ai"] .question-select')!.click();root.querySelector<HTMLButtonElement>('[data-group="hr"] .question-select')!.click();root.querySelector<HTMLButtonElement>('[data-group="department"] .question-select')!.click();await nextTick();expect(selected).toEqual([[questions[0].question,'ai_adopted'],[COMMON_QUESTION_GROUPS[0].dimensions[0].questions[0],'manual'],[COMMON_QUESTION_GROUPS[1].dimensions[0].questions[0],'manual']])})
  it('restores and highlights a template question while leaving all sources visible',()=>{const question=COMMON_QUESTION_GROUPS[0].dimensions[2].questions[1];mount({currentQuestion:question});const active=root.querySelector<HTMLButtonElement>('[aria-pressed="true"]')!;expect(active.textContent).toBe(question);expect(root.textContent).toContain('当前来源：HR 通用提问');expect(root.querySelectorAll('.question-item.selected')).toHaveLength(1)})
  it('leaves general templates usable without an AI response, and labels rule-generated questions accurately',()=>{mount({questions:[],engine:'local_fallback'});expect(root.textContent).toContain('并非大模型结果');expect(root.textContent).toContain('下面的通用模板仍可使用');root.querySelector<HTMLButtonElement>('[data-group="hr"] .question-select')!.click();expect(selected).toHaveLength(1)})
  it('shows resume evidence and separate AI follow-up suggestions',()=>{mount({followUps:['请补充量化结果。']});expect(root.textContent).toContain('简历记载负责系统上线');expect(root.textContent).toContain('个人贡献证据');expect(root.textContent).toContain('AI 追问建议');root.querySelector<HTMLButtonElement>('.follow-up .question-select')!.click();expect(selected).toEqual([['请补充量化结果。','ai_adopted']])})
  it('disables all question selection during start/stop',()=>{mount({round:2,disabled:true});for(const button of root.querySelectorAll<HTMLButtonElement>('.question-select')){expect(button.disabled).toBe(true);button.click()}expect(selected).toEqual([])})
  it('keeps template IDs unique, dimensions and total points consistent, and matches only known template text',()=>{expect(new Set(COMMON_QUESTION_GROUPS.map(group=>group.id)).size).toBe(3);for(const group of COMMON_QUESTION_GROUPS){expect(group.dimensions).toHaveLength(5);expect(group.dimensions.reduce((sum,dimension)=>sum+dimension.maxScore,0)).toBe(group.maxScore);expect(new Set(group.dimensions.map(dimension=>dimension.id)).size).toBe(5)}expect(isCommonQuestion('  '+COMMON_QUESTION_GROUPS[0].dimensions[0].questions[0]+'  ')).toBe(true);expect(isCommonQuestion('模型生成的自定义问题')).toBe(false)})
})


function capabilityBank(): GeneratedInterviewQuestion[] {
  return [
    ...Array.from({ length: 10 }, (_, i) => ({ ...questions[0], group: 'ai' as const, question: `简历核实题 ${i + 1}` })),
    ...COMMON_QUESTION_GROUPS.filter(group => group.id !== 'boss').flatMap(group => group.dimensions.map(dimension => ({ ...questions[0], group: group.id as 'hr' | 'department', dimension: dimension.id, question: `AI新情境：${group.id}/${dimension.title}`, groundedIn: [dimension.focus], scoringRubric: [{ criterion: '可观察的能力证据', points: dimension.maxScore }] }))),
  ]
}
describe('generated capability questions', () => {
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
    expect(root.querySelectorAll('.question-select')).toHaveLength(5)
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
