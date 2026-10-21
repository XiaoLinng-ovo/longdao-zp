// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, type App } from 'vue'
import LiveDialogueAnalysisPanel from './LiveDialogueAnalysisPanel.vue'
import type { LiveAnswerAnalysis, LiveInterviewSegment } from '../api'
import { loadInterviewSummary, type InterviewSummaryView } from '../api/summary'

vi.mock('../api/summary', () => ({ loadInterviewSummary: vi.fn() }))
const load = vi.mocked(loadInterviewSummary)
const speech = (id: string, role: LiveInterviewSegment['role'], startMs: number): LiveInterviewSegment => ({ id, sessionId: 's', speakerId: role, role, confidence: .9, text: id, startMs, endMs: startMs + 1000, status: 'transcribed' })
const ready = (): InterviewSummaryView => ({ sessionId: 's', status: 'ready', error: null, revision: 1, report: {
  version: 'whole-dialogue-v2', generatedAt: '2026-10-21T01:00:00Z', model: 'model', overallScore: 82, summary: '总结内容',
  dimensions: [{ name: '项目经验', score: 82, text: '项目经验分析', evidence: [{ turnId: 'a', quote: '交付了项目' }] }], strengths: [], concerns: [], unassessed: ['管理能力未考察'], warnings: [],
  pairs: [{ id: 'q', question: '总结表实际提问', answer: '交付了项目', questionSegmentIds: ['q'], answerSegmentIds: ['a'], startMs: 0, endMs: 4000, kind: 'assessment' }], transcript: [], advisoryOnly: true, applicationStatusMutation: 'none',
} })
let app: App | undefined, root: HTMLDivElement | undefined
let props: { interviewId: string; sessionId: string; completed: boolean; segments: LiveInterviewSegment[]; analyses: Record<string, LiveAnswerAnalysis>; phaseScore: number | null; phaseFormula: string }
async function flush() { for (let i = 0; i < 15; i++) { await Promise.resolve(); await nextTick() } }
async function mount(completed = false) {
  props = reactive({ interviewId: 'i', sessionId: 's', completed, segments: [speech('q', 'interviewer', 0), speech('a', 'candidate', 3000)], analyses: {}, phaseScore: 74, phaseFormula: '阶段参考分' })
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(defineComponent({ setup: () => () => h(LiveDialogueAnalysisPanel, props) })); app.mount(root); await flush()
  return root
}
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.useRealTimers(); vi.resetAllMocks() })

describe('LiveDialogueAnalysisPanel', () => {
  it('shows and reactively extends all actual Q&A without waiting for AI or fetching a final summary', async () => {
    const el = await mount()
    expect(el.querySelector('.candidate-answer')?.textContent).toBe('a')
    expect(el.textContent).toContain('暂无分析')
    props.segments.push(speech('q2', 'interviewer', 8000)); await flush()
    expect(el.querySelectorAll('.dialogue-pair')).toHaveLength(2)
    expect(el.textContent).toContain('等待候选人回答')
    props.segments.push(speech('a2', 'candidate', 11000)); await flush()
    expect([...el.querySelectorAll('.candidate-answer')].map(node => node.textContent)).toEqual(['a', 'a2'])
    props.analyses.a = { summary: '第一组分析', scores: [], evidence: [], concerns: [], confidence: 0, nextQuestion: '', advisoryOnly: true, applicationStatusMutation: 'none' }; await flush()
    expect(el.querySelectorAll('.dialogue-pair')[0]!.textContent).toContain('第一组分析')
    expect(el.querySelectorAll('.dialogue-pair')[1]!.textContent).not.toContain('第一组分析')
    expect(load).not.toHaveBeenCalled()
  })
  it('keeps uncertain speech and excludes other recording sessions', async () => {
    const el = await mount()
    props.segments.push(speech('混合原文', 'unknown', 6000), { ...speech('其他场次', 'interviewer', 10000), sessionId: 'other' }); await flush()
    expect(el.querySelector('.unpaired-section')?.textContent).toContain('混合原文')
    expect(el.textContent).not.toContain('其他场次')
  })
  it('polls a pending summary and displays the same completed Q&A and evidence as the report', async () => {
    vi.useFakeTimers(); load.mockResolvedValueOnce({ ...ready(), status: 'pending', report: null }).mockResolvedValue(ready())
    const el = await mount(true)
    expect(el.textContent).toContain('总结生成中'); expect(el.querySelector('.candidate-answer')?.textContent).toBe('a')
    await vi.advanceTimersByTimeAsync(2500); await flush()
    expect(el.textContent).toContain('总结表实际提问'); expect(el.textContent).toContain('交付了项目')
    expect(el.querySelector('.overall-score')?.textContent).toContain('82/100')
    expect(el.textContent).toContain('管理能力未考察')
    await vi.advanceTimersByTimeAsync(30000); expect(load).toHaveBeenCalledTimes(2)
  })
  it('retains dialogue during temporary summary errors, bounds retries and permits manual recovery', async () => {
    vi.useFakeTimers(); load.mockRejectedValue(new Error('网络中断'))
    const el = await mount(true)
    for (const delay of [2500, 5000, 10000]) { await vi.advanceTimersByTimeAsync(delay); await flush() }
    expect(load).toHaveBeenCalledTimes(4)
    expect(el.textContent).toContain('自动刷新已暂停'); expect(el.querySelector('.candidate-answer')?.textContent).toBe('a')
    await vi.advanceTimersByTimeAsync(60000); expect(load).toHaveBeenCalledTimes(4)
    load.mockResolvedValue(ready()); el.querySelector<HTMLButtonElement>('.summary-status button')!.click(); await flush()
    expect(el.textContent).toContain('已同步面试总结表'); expect(el.textContent).not.toContain('自动刷新已暂停')
  })
  it('hides scores for a failed report but keeps its recorded dialogue', async () => {
    load.mockResolvedValue({ ...ready(), status: 'failed', error: '模型超时' })
    const el = await mount(true)
    expect(el.textContent).toContain('模型超时'); expect(el.textContent).toContain('交付了项目')
    expect(el.querySelector('.overall-score')?.textContent).toContain('待评分')
    expect(el.querySelector('.report-dimension')).toBeNull()
  })
  it('does not replace this room with a report from a different session and cleans up polling on unmount', async () => {
    vi.useFakeTimers(); load.mockResolvedValue({ ...ready(), sessionId: 'other' })
    const el = await mount(true)
    expect(el.textContent).not.toContain('总结表实际提问'); expect(el.querySelector('.candidate-answer')?.textContent).toBe('a')
    app!.unmount(); app = undefined; await vi.advanceTimersByTimeAsync(10000)
    expect(load).toHaveBeenCalledOnce()
  })
  it('ignores a late summary response after switching back to an active session', async () => {
    let resolve!: (value: InterviewSummaryView) => void
    load.mockReturnValue(new Promise(r => { resolve = r }))
    const el = await mount(true)
    props.sessionId = 'new'; props.completed = false; props.segments = [{ ...speech('新场次原文', 'candidate', 0), sessionId: 'new' }]; await flush()
    resolve(ready()); await flush()
    expect(el.textContent).toContain('新场次原文'); expect(el.textContent).not.toContain('总结表实际提问')
    expect(el.querySelector('.phase-score')).toBeNull()
  })
})
