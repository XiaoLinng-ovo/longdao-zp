// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import InterviewSummaryPanel from './InterviewSummaryPanel.vue'
import { loadInterviewSummary, requestInterviewSummary, type InterviewSummaryView } from '../api/summary'
vi.mock('../api/summary', () => ({ loadInterviewSummary: vi.fn(), requestInterviewSummary: vi.fn(), loadInterviewSummaryVersions: vi.fn().mockResolvedValue([]) }))
vi.mock('./TranscriptRoleCorrection.vue', () => ({ default: { emits: ['changed'], template: `<button class="mock-correction" @click="$emit('changed')">校正测试</button>` } }))
const load = vi.mocked(loadInterviewSummary), request = vi.mocked(requestInterviewSummary)
const ready = (): InterviewSummaryView => ({ sessionId: 's', status: 'ready', phase: 'ready', error: null, revision: 1, report: {
  version: 'whole-dialogue-v2', generatedAt: '2026-11-26T06:00:00Z', model: 'test', overallScore: 82, summary: '候选人有实际项目经验。', dimensions: [{ name: '项目实施', score: 82, text: '有原文依据。', evidence: [] }], strengths: [], concerns: [], unassessed: [], warnings: [], pairs: [], transcript: [], advisoryOnly: true, applicationStatusMutation: 'none',
} })
let app: App | undefined, root: HTMLDivElement
const id = ref('i')
async function flush() { for (let i = 0; i < 15; i++) { await Promise.resolve(); await nextTick() } }
async function mount(updated = vi.fn()) {
  id.value = 'i'; root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(defineComponent({ setup: () => () => h(InterviewSummaryPanel, { interviewId: id.value, onUpdated: updated }) }))
  app.mount(root); await flush(); return updated
}
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.useRealTimers(); vi.resetAllMocks(); document.body.style.overflow = '' })
describe('inline interview summary', () => {
  it('loads by default without a modal, duplicated details, a scroll lock or automatic generation', async () => {
    document.body.style.overflow = 'auto'; load.mockResolvedValue(ready()); await mount()
    expect(load).toHaveBeenCalledWith('i'); expect(request).not.toHaveBeenCalled()
    expect(root.querySelector('[role="region"]')).not.toBeNull(); expect(root.querySelector('[role="dialog"]')).toBeNull()
    expect(root.querySelector('.report-info')).toBeNull(); expect(root.querySelector('.report-close')).toBeNull()
    expect(document.body.style.overflow).toBe('auto')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await flush()
    expect(root.textContent).toContain('候选人有实际项目经验')
    expect(root.querySelector('.human-result')!.compareDocumentPosition(root.querySelector('.mock-correction')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('polls upstream transcription even before the summary becomes pending and stops on completion', async () => {
    vi.useFakeTimers(); load.mockResolvedValueOnce({ ...ready(), status: 'none', phase: 'transcribing', report: null }).mockResolvedValue(ready())
    await mount(); expect(root.textContent).toContain('录音转写中'); expect(root.textContent).not.toContain('尚无面试总结')
    await vi.advanceTimersByTimeAsync(2500); await flush()
    expect(root.querySelector('.report-score')?.textContent).toContain('82')
    await vi.advanceTimersByTimeAsync(15000); expect(load).toHaveBeenCalledTimes(2)
  })
  it('invalidates the displayed score and informs the page immediately after role correction even if refreshing fails', async () => {
    vi.useFakeTimers(); load.mockResolvedValueOnce(ready()).mockRejectedValue(new Error('网络中断'))
    const updated = await mount(); root.querySelector<HTMLButtonElement>('.mock-correction')!.click(); await flush()
    expect(root.querySelector('.report-score')?.textContent).toContain('待重新评分')
    expect(updated).toHaveBeenLastCalledWith(expect.objectContaining({ stale: true, status: 'none' }))
    expect(root.querySelector('.report-table')).toBeNull()
  })
  it('ignores an in-flight pre-correction refresh instead of restoring the old score', async () => {
    let finishOld!: (view: InterviewSummaryView) => void
    let finishNew!: (view: InterviewSummaryView) => void
    load.mockResolvedValueOnce(ready()).mockReturnValueOnce(new Promise(r => { finishOld = r })).mockReturnValueOnce(new Promise(r => { finishNew = r }))
    await mount()
    root.querySelector<HTMLButtonElement>('[title="刷新总结"]')!.click(); await flush()
    root.querySelector<HTMLButtonElement>('.mock-correction')!.click(); await flush()
    finishNew({ ...ready(), stale: true, status: 'none' }); await flush()
    finishOld(ready()); await flush()
    expect(root.querySelector('.report-score')?.textContent).toContain('待重新评分')
    expect(load).toHaveBeenCalledTimes(3)
  })
  it('does not allow a previous interview response to overwrite the newly opened interview', async () => {
    let resolve!: (view: InterviewSummaryView) => void
    load.mockReturnValueOnce(new Promise(r => { resolve = r })).mockResolvedValue({ ...ready(), report: { ...ready().report!, summary: '新面试的总结' } })
    await mount(); id.value = 'new'; await flush(); resolve(ready()); await flush()
    expect(root.textContent).toContain('新面试的总结'); expect(root.textContent).not.toContain('候选人有实际项目经验')
  })
  it('clears the polling timer on unmount', async () => {
    vi.useFakeTimers(); load.mockResolvedValue({ ...ready(), status: 'generating' }); await mount()
    app!.unmount(); app = undefined; await vi.advanceTimersByTimeAsync(10000)
    expect(load).toHaveBeenCalledTimes(1)
  })
})

