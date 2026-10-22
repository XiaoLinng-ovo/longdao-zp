// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App, type Ref } from 'vue'
import InterviewSummaryDialog from './InterviewSummaryDialog.vue'
import { loadInterviewSummary, requestInterviewSummary, type InterviewSummaryView } from '../api/summary'
import { loadQuestionSheets, type ApiApplicationQuestionSheets, type ApiStageReview, type InterviewStage } from '../api/question-sheets'

vi.mock('../api/summary', () => ({ loadInterviewSummary: vi.fn(), requestInterviewSummary: vi.fn() }))
vi.mock('../api/question-sheets', async importOriginal => ({ ...await importOriginal<typeof import('../api/question-sheets')>(), loadQuestionSheets: vi.fn() }))
const load = vi.mocked(loadInterviewSummary), request = vi.mocked(requestInterviewSummary)
let app: App | undefined, root: HTMLDivElement | undefined, open: Ref<boolean>
const ready = (): InterviewSummaryView => ({ sessionId: 's', status: 'ready', revision: 1, error: null, report: {
  version: 'actual-dialogue-v1', generatedAt: '2026-10-16T01:00:00Z', model: 'model', overallScore: 82,
  summary: '候选人自述完成招聘项目，成果待核实。', dimensions: [{ name: '项目经验', score: 82, text: '有实际项目自述。', evidence: [{ pairId: 'q', quote: '我完成招聘项目' }] }],
  strengths: [], concerns: [], unassessed: ['管理经验未考察'], warnings: ['存在说话人待确认的发言。'],
  pairs: [{ id: 'q', question: '介绍项目？', answer: '我完成招聘项目。', questionSegmentIds: ['q'], answerSegmentIds: ['a'], startMs: 1000, endMs: 5000, kind: 'assessment' },
    { id: 'q2', question: '何时到岗？', answer: '下周。', questionSegmentIds: ['q2'], answerSegmentIds: ['a2'], startMs: 6000, endMs: 9000, kind: 'logistics' }],
  transcript: [{ id: 'u', segmentIds: ['u'], role: 'unknown', text: '完整保留的混合发言。', startMs: 10000, endMs: 12000 }],
  advisoryOnly: true, applicationStatusMutation: 'none',
} })
async function flush() { for (let i = 0; i < 15; i++) { await Promise.resolve(); await nextTick() } }
async function mount(initial = true, props: { applicationId?: string; stage?: InterviewStage; candidateName?: string; jobTitle?: string; interviewDate?: string } = {}) {
  open = ref(initial); root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(defineComponent({ setup: () => () => h(InterviewSummaryDialog, { ...props, open: open.value, interviewId: 'i', onClose: () => { open.value = false } }) }))
  app.mount(root); await flush(); return root
}
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.useRealTimers(); vi.resetAllMocks(); document.body.style.overflow = '' })

describe('InterviewSummaryDialog', () => {
  it('presents candidate information, advantages, improvement areas and AI recommendation as separate report sections', async () => {
    const data = ready()
    data.report!.strengths = [{ text: '候选人自述具备项目交付经验。', evidence: [{ pairId: 'q', quote: '我完成招聘项目' }] }]
    data.report!.concerns = [{ text: '项目成果量化表达不足。', evidence: [{ pairId: 'q', quote: '我完成招聘项目' }] }]
    data.report!.recommendation = { outcome: 'hold', text: '建议补充核实项目成果。', evidence: [] }
    load.mockResolvedValue(data)
    const el = await mount(true, { candidateName: '张三', jobTitle: '招聘专员', interviewDate: '2026-10-22T02:00:00Z' })
    expect(el.querySelector('.report-info')?.textContent).toContain('张三')
    expect(el.querySelector('.report-info')?.textContent).toContain('招聘专员')
    expect(el.querySelector('.report-info')?.textContent).toContain('2026')
    expect(el.querySelector('[aria-label="优势分析"]')?.textContent).toContain('具备项目交付经验')
    expect(el.querySelector('[aria-label="劣势与待提升"]')?.textContent).toContain('项目成果量化表达不足')
    expect(el.querySelector('[aria-label="推荐建议"]')?.textContent).toContain('建议补充评估')
    expect(el.querySelector('[aria-label="推荐建议"]')?.textContent).toContain('建议补充核实项目成果')
    expect(el.querySelector('.human-result')?.textContent).toContain('待人工确认')
    expect(request).not.toHaveBeenCalled()
  })
  it.each(['advance', 'reject'] as const)('does not turn the AI %s advice into the human interview decision', async outcome => {
    const data = ready()
    data.report!.recommendation = { outcome, text: '基于已考察能力给出建议。', evidence: [{ pairId: 'q', quote: '我完成招聘项目' }] }
    load.mockResolvedValue(data)
    vi.mocked(loadQuestionSheets).mockResolvedValue({ reviews: [] } as unknown as ApiApplicationQuestionSheets)
    const el = await mount(true, { applicationId: 'app', stage: 'initial' })
    expect(el.querySelector('.recommendation-value')?.textContent).toBe(outcome === 'advance' ? '建议推进后续流程' : '不建议推进后续流程')
    expect(el.querySelector('.result-value')?.textContent).toBe('待人工确认')
  })
  it('shows the matching stage decision separately from AI advice', async () => {
    load.mockResolvedValue(ready())
    vi.mocked(loadQuestionSheets).mockResolvedValue({ reviews: [
      { stage: 'initial', decision: 'advanced' },
      { stage: 'final', decision: 'hired', decidedAt: '2026-10-22T02:00:00Z' },
    ] as ApiStageReview[] } as ApiApplicationQuestionSheets)
    const el = await mount(true, { applicationId: 'app', stage: 'final' })
    expect(loadQuestionSheets).toHaveBeenCalledWith('app')
    expect(el.querySelector('.report-info')?.textContent).toContain('复试')
    expect(el.querySelector('.human-result')?.textContent).toContain('人工确认')
    expect(el.querySelector('.result-value')?.textContent).toBe('录用')
  })
  it('does not disguise a result read failure as a pending human decision', async () => {
    load.mockResolvedValue(ready()); vi.mocked(loadQuestionSheets).mockRejectedValue(new Error('网络中断'))
    const el = await mount(true, { applicationId: 'app', stage: 'initial' })
    expect(el.querySelector('.result-value')?.textContent).toBe('暂时无法读取')
    expect(el.querySelector('.human-result')?.textContent).not.toContain('待人工确认')
  })
  it('shows strengths, risks and result without exposing actual Q&A or transcript', async () => {
    load.mockResolvedValue(ready()); const el = await mount()
    expect(el.querySelector('.report-score')?.textContent).toContain('82')
    expect(el.querySelectorAll('.report-pair')).toHaveLength(0)
    expect(el.querySelector('details')).toBeNull()
    expect(el.textContent).not.toContain('介绍项目？'); expect(el.textContent).not.toContain('何时到岗？')
    expect(el.textContent).not.toContain('完整保留的混合发言。')
    expect(el.querySelector('[aria-label="优势分析"]')?.textContent).toContain('暂无有充分原文依据的评价')
    expect(el.querySelector('[aria-label="推荐建议"]')?.textContent).toContain('暂无有充分依据的推荐建议')
    expect(el.textContent).toContain('管理经验未考察')
    expect(el.textContent).toContain('面试结果')
    expect(el.textContent).toContain('待人工确认')
  })
  it('does not load when closed or disturb a scroll lock owned by another dialog', async () => {
    document.body.style.overflow = 'hidden'; await mount(false)
    expect(load).not.toHaveBeenCalled(); expect(document.body.style.overflow).toBe('hidden')
    app?.unmount(); app = undefined; expect(document.body.style.overflow).toBe('hidden')
  })
  it('polls a pending summary to completion and stops when closed', async () => {
    vi.useFakeTimers(); load.mockResolvedValueOnce({ ...ready(), status: 'pending', report: null }).mockResolvedValue(ready())
    const el = await mount(); expect(el.textContent).toContain('总结生成中')
    await vi.advanceTimersByTimeAsync(2500); await flush()
    expect(el.querySelector('.report-score')?.textContent).toContain('82')
    el.querySelector<HTMLButtonElement>('[aria-label="关闭面试总结表"]')!.click(); await flush()
    await vi.advanceTimersByTimeAsync(10000); expect(load).toHaveBeenCalledTimes(2)
    expect(document.body.style.overflow).toBe('')
  })
  it('keeps summary context after AI failure and permits retry without stale scores', async () => {
    vi.useFakeTimers(); load.mockResolvedValue({ ...ready(), status: 'failed', error: '模型超时' })
    request.mockResolvedValue({ ...ready(), status: 'pending', report: null })
    const el = await mount(); expect(el.textContent).toContain('模型超时'); expect(el.textContent).toContain('项目经验')
    expect(el.querySelector('.report-score')?.textContent).toBe('待评分')
    const button = [...el.querySelectorAll('button')].find(b => b.textContent === '重新生成')!
    button.click(); await flush(); expect(request).toHaveBeenCalledWith('i')
    expect(el.querySelector('.report-score')).toBeNull(); expect(el.textContent).toContain('总结生成中')
  })
  it('ignores an old response after closing the dialog', async () => {
    let resolve!: (value: InterviewSummaryView) => void
    load.mockReturnValue(new Promise(r => { resolve = r })); const el = await mount()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await flush()
    resolve(ready()); await flush(); expect(el.querySelector('[role="dialog"]')).toBeNull()
  })
  it('automatically recovers when the initial read fails', async () => {
    vi.useFakeTimers(); load.mockRejectedValueOnce(new Error('网络中断')).mockResolvedValue(ready())
    const el = await mount()
    expect(el.textContent).toContain('正在自动重试')
    await vi.advanceTimersByTimeAsync(2500); await flush()
    expect(load).toHaveBeenCalledTimes(2)
    expect(el.querySelector('.report-score')?.textContent).toContain('82')
    expect(el.textContent).not.toContain('正在自动重试')
  })
  it('continues polling through a transient read error without losing the saved report', async () => {
    vi.useFakeTimers()
    load.mockResolvedValueOnce({ ...ready(), status: 'generating' }).mockRejectedValueOnce(new Error('暂时不可用')).mockResolvedValue(ready())
    const el = await mount()
    await vi.advanceTimersByTimeAsync(2500); await flush()
    expect(el.textContent).toContain('项目经验'); expect(el.textContent).toContain('正在自动重试')
    await vi.advanceTimersByTimeAsync(2500); await flush()
    expect(load).toHaveBeenCalledTimes(3); expect(el.querySelector('.report-score')?.textContent).toContain('82')
  })
  it('retains the old report during regeneration and hides the old score', async () => {
    vi.useFakeTimers(); load.mockResolvedValue(ready()); request.mockResolvedValue({ ...ready(), status: 'pending' })
    const el = await mount()
    ;[...el.querySelectorAll('button')].find(b => b.textContent === '重新生成')!.click(); await flush()
    expect(el.textContent).toContain('项目经验')
    expect(el.querySelector('.report-score')?.textContent).toBe('待评分')
    expect(el.textContent).toContain('稍后查看结果')
  })
  it('prevents an older refresh response from overwriting a newly queued generation', async () => {
    vi.useFakeTimers()
    let resolve!: (value: InterviewSummaryView) => void
    load.mockResolvedValueOnce(ready()).mockReturnValueOnce(new Promise(r => { resolve = r }))
    request.mockResolvedValue({ ...ready(), status: 'pending' })
    const el = await mount()
    const regenerate = [...el.querySelectorAll('button')].find(b => b.textContent === '重新生成')!
    ;[...el.querySelectorAll('button')].find(b => b.textContent === '刷新')!.click()
    regenerate.click(); await flush()
    resolve(ready()); await flush()
    expect(el.textContent).toContain('总结生成中'); expect(el.querySelector('.report-score')?.textContent).toBe('待评分')
  })
  it('checks server status after a generation response is lost instead of submitting again', async () => {
    vi.useFakeTimers(); load.mockResolvedValueOnce(ready()).mockResolvedValue({ ...ready(), status: 'generating' })
    request.mockRejectedValue(new Error('响应连接中断'))
    const el = await mount()
    ;[...el.querySelectorAll('button')].find(b => b.textContent === '重新生成')!.click(); await flush()
    await vi.advanceTimersByTimeAsync(2500); await flush()
    expect(load).toHaveBeenCalledTimes(2); expect(request).toHaveBeenCalledTimes(1)
    expect(el.textContent).toContain('总结生成中')
  })
})
