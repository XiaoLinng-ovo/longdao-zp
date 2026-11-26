// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import CandidateAnalysisProgress from './CandidateAnalysisProgress.vue'

let app: App | undefined
let root: HTMLDivElement
const props = reactive<{ status: string; progress?: number; attempt?: number; error?: string }>({ status: 'processing', progress: 65, attempt: 1 })
async function mount() {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp({ render: () => h(CandidateAnalysisProgress, props) })
  app.mount(root)
  await nextTick()
}
const percentage = () => Number(root.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow'))
async function tick(milliseconds = 1200) { await vi.advanceTimersByTimeAsync(milliseconds); await nextTick() }
beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(props, { status: 'processing', progress: 65, attempt: 1, error: undefined })
})
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.useRealTimers() })

describe('candidate analysis progress', () => {
  it('shows the persisted processing stage without simulated progress', async () => {
    await mount()
    expect(percentage()).toBe(65)
    expect(root.querySelector('.status-processing.is-analyzing .status-bullet')).not.toBeNull()
    await tick()
    expect(percentage()).toBe(65)
    expect(root.querySelector<HTMLElement>('.progress-value')!.style.width).toBe('65%')
    expect(root.textContent).toContain('等待模型')
    expect(root.textContent).not.toContain('65%')
    await tick(4800)
    expect(percentage()).toBe(65)
  })
  it('follows server stages rather than preserving a fabricated local percentage', async () => {
    await mount(); await tick(6000)
    const before = percentage()
    props.progress = 64; await nextTick()
    expect(before).toBe(65)
    expect(percentage()).toBe(64)
    props.progress = 82; await nextTick()
    expect(percentage()).toBe(82)
    await tick(2400)
    expect(percentage()).toBe(82)
  })
  it('never finishes an active task locally, even when it runs for a long time', async () => {
    await mount(); await tick(10 * 60 * 1000)
    expect(percentage()).toBe(65)
    expect(root.textContent).toContain('分析中')
    expect(root.querySelector('.completed')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    props.progress = 100; await nextTick()
    expect(percentage()).toBe(95)
  })
  it('only shows 100% and stops pulsing after the real completed status arrives', async () => {
    await mount(); await tick(6000)
    props.status = 'completed'; props.progress = 100; await nextTick()
    expect(percentage()).toBe(100)
    expect(root.querySelector('.progress-value.completed')).not.toBeNull()
    expect(root.querySelector('.is-analyzing')).toBeNull()
    expect(root.querySelector('.analysis-progress')!.getAttribute('aria-busy')).toBe('false')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('stops on failure and preserves the server error instead of presenting success', async () => {
    await mount(); await tick()
    props.status = 'failed'; props.progress = 100; props.error = '分析失败，请重试'; await nextTick()
    expect(root.querySelector('.progress-value.failed')).not.toBeNull()
    expect(root.querySelector('.progress-error')!.textContent).toBe('分析失败，请重试')
    expect(root.querySelector('.is-analyzing')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('limits queued progress and starts processing at its own phase without stale completion', async () => {
    props.status = 'queued'; props.progress = 15
    await mount(); await tick(10 * 60 * 1000)
    expect(percentage()).toBe(15)
    expect(root.querySelector('.is-analyzing')).toBeNull()
    props.status = 'processing'; props.progress = 65; props.attempt = 2; await nextTick()
    expect(percentage()).toBe(65)
    await tick(); expect(percentage()).toBe(65)
    props.status = 'completed'; await nextTick(); expect(percentage()).toBe(100)
    props.status = 'queued'; props.progress = 15; props.attempt = 0; await nextTick()
    expect(percentage()).toBe(15)
  })
  it('resets the estimate on a retry and cleans up the timer when the row unmounts', async () => {
    await mount(); await tick(6000)
    expect(percentage()).toBe(65)
    props.attempt = 2; await nextTick(); expect(percentage()).toBe(65)
    app!.unmount(); app = undefined
    expect(vi.getTimerCount()).toBe(0)
  })
  it('handles missing/invalid progress and leaves idle rows without timers', async () => {
    props.progress = Number.NaN
    await mount(); expect(percentage()).toBe(65)
    props.status = 'pending'; props.progress = undefined; await nextTick()
    expect(percentage()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

