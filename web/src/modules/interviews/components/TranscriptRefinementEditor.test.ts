// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import TranscriptRefinementEditor from './TranscriptRefinementEditor.vue'
import { saveLiveTranscriptRefinement } from '../api'

vi.mock('../api', () => ({ saveLiveTranscriptRefinement: vi.fn() }))
let app: App | undefined
let root: HTMLDivElement
const refinement = { text: '模型整理的发言。', corrections: [], uncertainties: ['待核实内容'] }
const sources = [{ id: 'a', text: '原始转写', role: 'interviewer', speakerId: 'voice' }]
async function flush() { for (let i = 0; i < 10; i++) { await Promise.resolve(); await nextTick() } }
function button(text: string) { return [...root.querySelectorAll('button')].find(row => row.textContent === text)! }
async function mount(label = '整理后的发言') {
  root = document.createElement('div'); document.body.appendChild(root)
  const saved = vi.fn(), editing = vi.fn()
  app = createApp(TranscriptRefinementEditor, { segmentId: 'a', refinement, sourceSegments: sources, label, onSaved: saved, onEditingChange: editing })
  app.mount(root); await flush()
  return { saved, editing }
}
async function input(text: string) {
  const textarea = root.querySelector('textarea')!
  textarea.value = text; textarea.dispatchEvent(new Event('input')); await flush()
}
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks() })

describe('editable transcript refinement', () => {
  it.each(['整理后的发言', '整理后的回答'])('opens and cancels %s without changing the original', async label => {
    const { editing } = await mount(label)
    expect(root.textContent).not.toContain('待核实内容')
    button('编辑').click(); await flush()
    expect(root.querySelector('textarea')!.value).toBe(refinement.text)
    expect(document.activeElement).toBe(root.querySelector('textarea'))
    await input('微调后的文字')
    button('取消').click(); await flush()
    expect(root.querySelector('.refined-answer')!.textContent).toBe(refinement.text)
    expect(saveLiveTranscriptRefinement).not.toHaveBeenCalled()
    expect(editing.mock.calls).toEqual([[true], [false]])
  })
  it('saves the draft with the original version and source snapshot and prevents duplicate writes', async () => {
    const { saved } = await mount()
    let resolve!: (value: typeof refinement) => void
    vi.mocked(saveLiveTranscriptRefinement).mockReturnValue(new Promise(done => { resolve = done }))
    button('编辑').click(); await flush()
    await input('  手动微调。\n保留换行。  ')
    button('保存修改').click(); await flush()
    expect(root.querySelector('textarea')!.disabled).toBe(true)
    expect(button('取消').disabled).toBe(true)
    button('保存中…').click()
    expect(saveLiveTranscriptRefinement).toHaveBeenCalledTimes(1)
    expect(saveLiveTranscriptRefinement).toHaveBeenCalledWith('a', '手动微调。\n保留换行。', refinement.text, sources)
    const updated = { ...refinement, text: '手动微调。\n保留换行。', editedAt: '2026-10-23T00:00:00Z', editedBy: 'u' }
    resolve(updated); await flush()
    expect(saved).toHaveBeenCalledWith(updated)
    expect(root.querySelector('textarea')).toBeNull()
    expect(refinement.text).toBe('模型整理的发言。')
  })
  it('retains the draft and shows the API error on conflicts', async () => {
    await mount()
    vi.mocked(saveLiveTranscriptRefinement).mockRejectedValue(new Error('文本已更新，请刷新后重新编辑。'))
    button('编辑').click(); await flush(); await input('保留我的草稿')
    button('保存修改').click(); await flush()
    expect(root.querySelector('[role="alert"]')!.textContent).toContain('文本已更新')
    expect(root.querySelector('textarea')!.value).toBe('保留我的草稿')
    expect(button('保存修改').disabled).toBe(false)
  })
  it('does not submit an empty draft', async () => {
    await mount(); button('编辑').click(); await flush(); await input('  ')
    expect(button('保存修改').disabled).toBe(true)
    button('保存修改').click()
    expect(saveLiveTranscriptRefinement).not.toHaveBeenCalled()
  })
})
