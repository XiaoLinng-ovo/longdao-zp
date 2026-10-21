// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App, type Ref } from 'vue'
import InterviewSummaryDialog from './InterviewSummaryDialog.vue'
import { loadInterviewSummary, requestInterviewSummary, type InterviewSummaryView } from '../api/summary'

vi.mock('../api/summary', () => ({ loadInterviewSummary: vi.fn(), requestInterviewSummary: vi.fn() }))
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
async function mount(initial = true) {
  open = ref(initial); root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(defineComponent({ setup: () => () => h(InterviewSummaryDialog, { open: open.value, interviewId: 'i', onClose: () => { open.value = false } }) }))
  app.mount(root); await flush(); return root
}
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.useRealTimers(); vi.resetAllMocks(); document.body.style.overflow = '' })

describe('InterviewSummaryDialog', () => {
  it('shows overall score, actual Q&A, evidence and the complete uncertain transcript', async () => {
    load.mockResolvedValue(ready()); const el = await mount()
    expect(el.querySelector('.report-score')?.textContent).toContain('82')
    expect(el.querySelectorAll('.report-pair')).toHaveLength(2)
    expect(el.textContent).toContain('介绍项目？'); expect(el.textContent).toContain('何时到岗？')
    expect(el.textContent).toContain('完整保留的混合发言。'); expect(el.textContent).toContain('管理经验未考察')
    expect(el.querySelector('blockquote a')?.getAttribute('href')).toBe('#pair-q')
  })
  it('opens complete transcript and locates the original candidate turn for whole-dialogue evidence', async () => {
    const view = ready()
    view.report!.version = 'whole-dialogue-v2'
    view.report!.dimensions[0]!.evidence = [{ turnId: 'a', quote: '我完成招聘项目' }]
    view.report!.transcript.push({ id: 'a', segmentIds: ['a'], role: 'candidate', text: '我完成招聘项目。', startMs: 2000, endMs: 5000, kind: 'assessment' })
    load.mockResolvedValue(view)
    const el = await mount()
    const details = el.querySelector('details')!
    expect(details.open).toBe(false)
    const link = el.querySelector<HTMLAnchorElement>('blockquote a')!
    expect(link.getAttribute('href')).toBe('#turn-a')
    link.click(); await flush()
    expect(details.open).toBe(true)
    expect(el.querySelector('#turn-a')?.textContent).toContain('我完成招聘项目')
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
  it('preserves the transcript after AI failure and permits retry without stale scores', async () => {
    vi.useFakeTimers(); load.mockResolvedValue({ ...ready(), status: 'failed', error: '模型超时' })
    request.mockResolvedValue({ ...ready(), status: 'pending', report: null })
    const el = await mount(); expect(el.textContent).toContain('模型超时'); expect(el.textContent).toContain('完整保留的混合发言。')
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
  it('continues polling through a transient read error without losing saved transcript', async () => {
    vi.useFakeTimers()
    load.mockResolvedValueOnce({ ...ready(), status: 'generating' }).mockRejectedValueOnce(new Error('暂时不可用')).mockResolvedValue(ready())
    const el = await mount()
    await vi.advanceTimersByTimeAsync(2500); await flush()
    expect(el.textContent).toContain('完整保留的混合发言。'); expect(el.textContent).toContain('正在自动重试')
    await vi.advanceTimersByTimeAsync(2500); await flush()
    expect(load).toHaveBeenCalledTimes(3); expect(el.querySelector('.report-score')?.textContent).toContain('82')
  })
  it('retains the old report during regeneration and hides the old score', async () => {
    vi.useFakeTimers(); load.mockResolvedValue(ready()); request.mockResolvedValue({ ...ready(), status: 'pending' })
    const el = await mount()
    ;[...el.querySelectorAll('button')].find(b => b.textContent === '重新生成')!.click(); await flush()
    expect(el.textContent).toContain('完整保留的混合发言。')
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
