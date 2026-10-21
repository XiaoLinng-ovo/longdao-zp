// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import InterviewQuestionReferenceDialog from './InterviewQuestionReferenceDialog.vue'

let app: App | undefined
let root: HTMLDivElement
let trigger: HTMLButtonElement
let closes = 0
function mount() {
  closes = 0
  trigger = document.createElement('button'); document.body.appendChild(trigger); trigger.focus()
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(InterviewQuestionReferenceDialog, {
    group: 'hr', candidate: '测试候选人', job: '人事专员', questions: [], currentQuestion: '', round: 1,
    engine: '', followUps: [], disabled: false, onClose: () => { closes++ },
  }); app.mount(root)
}
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); trigger?.remove(); document.body.style.overflow = '' })
describe('reference dialog lifecycle', () => {
  it('focuses close, locks background scroll and restores both on unmount', async () => {
    document.body.style.overflow = 'auto'; mount(); await nextTick()
    expect(document.activeElement).toBe(root.querySelector('[aria-label="关闭参考表"]'))
    expect(document.body.style.overflow).toBe('hidden')
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain('HR面试表')
    app!.unmount(); app = undefined
    expect(document.activeElement).toBe(trigger)
    expect(document.body.style.overflow).toBe('auto')
  })
  it('closes with Escape or backdrop, not when interacting with the reference content', () => {
    mount()
    root.querySelector<HTMLElement>('[role="dialog"]')!.click(); expect(closes).toBe(0)
    root.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(closes).toBe(1)
    root.querySelector<HTMLElement>('.reference-overlay')!.click(); expect(closes).toBe(2)
  })
})
