// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import InterviewQuestionReferenceDialog from './InterviewQuestionReferenceDialog.vue'

let app: App | undefined
let root: HTMLDivElement
let trigger: HTMLButtonElement
let closes = 0
function mount(messages: Array<{ role: 'user' | 'assistant'; content: string }> = [], toolbar = false) {
  closes = 0
  trigger = document.createElement('button'); document.body.appendChild(trigger); trigger.focus()
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp({ render: () => h(InterviewQuestionReferenceDialog, {
    group: 'hr', candidate: '测试候选人', job: '人事专员', questions: [], round: 1,
    engine: '', messages, disabled: false, onClose: () => { closes++ },
  }, toolbar ? { toolbar: () => h('button', { type: 'button' }, '重新生成当前表') } : {}) }); app.mount(root)
}
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); trigger?.remove(); document.body.style.overflow = '' })
describe('reference dialog lifecycle', () => {
  it('places toolbar and chat in the same grid so the chat can extend above the question bank', () => {
    mount([], true)
    const columns = root.querySelector('.reference-columns')!
    expect(columns.classList.contains('has-toolbar')).toBe(true)
    expect(root.querySelector('.reference-toolbar')?.parentElement).toBe(columns)
    expect(root.querySelector('.reference-conversation')?.parentElement).toBe(columns)
    expect(root.querySelector('.reference-bank-panel')?.parentElement).toBe(columns)
    expect(root.querySelector('.reference-toolbar')?.textContent).toContain('重新生成当前表')
  })

  it('keeps long AI replies complete with a compact two-line composer', async () => {
    const reply = Array.from({ length: 12 }, (_, index) => `${index + 1}. 请介绍你在项目中解决问题的过程。`).join('\n')
    mount([{ role: 'assistant', content: reply }]); await nextTick()
    expect(root.querySelector('.conversation-message.assistant p')?.textContent).toBe(reply)
    expect(root.querySelector<HTMLTextAreaElement>('#question-conversation-input')?.rows).toBe(2)
    expect(root.querySelector('.conversation-messages')!.contains(root.querySelector('.conversation-composer'))).toBe(false)
  })
  it('shows the start of a new reply when it exceeds the visible output area', async () => {
    const messages = reactive<Array<{ role: 'user' | 'assistant'; content: string }>>([])
    mount(messages); await nextTick()
    const list = root.querySelector<HTMLElement>('.conversation-messages')!
    const scrollTo = vi.fn()
    Object.defineProperties(list, { clientHeight: { value: 320 }, scrollHeight: { value: 1200 }, scrollTop: { value: 100, writable: true }, scrollTo: { value: scrollTo } })
    list.getBoundingClientRect = () => ({ top: 50 }) as DOMRect
    messages.push({ role: 'assistant', content: '完整的新题目'.repeat(120) })
    await nextTick()
    const reply = list.lastElementChild as HTMLElement
    Object.defineProperty(reply, 'offsetHeight', { value: 900 })
    reply.getBoundingClientRect = () => ({ top: 150 }) as DOMRect
    await nextTick()
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 188 })
  })

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

  it('supports the BOSS interview sheet reference label', async () => {
    app?.unmount()
    app = createApp(InterviewQuestionReferenceDialog, {
      group: 'boss', candidate: '测试候选人', job: '人事专员', questions: [], round: 2,
      engine: '', disabled: false, onClose: () => { closes++ },
    })
    app.mount(root)
    await nextTick()
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain('BOSS面试表')
    expect(root.querySelector('[data-group="boss"]')).not.toBeNull()
    expect(root.querySelector('[data-group="department"]')).toBeNull()
  })
})
