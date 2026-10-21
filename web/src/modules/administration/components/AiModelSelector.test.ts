// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import AiModelSelector from './AiModelSelector.vue'

let app: App | undefined
let root: HTMLDivElement | undefined
const models = ['gpt-4o', 'gpt-4o-mini', 'deepseek-chat', 'deepseek-reasoner', 'qwen-plus', 'qwen-turbo', 'custom-chat']
async function mount(options = models, initial = 'GPT', disabled = false) {
  const value = ref(initial)
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp({ render: () => h(AiModelSelector, { modelValue: value.value, options, disabled, 'onUpdate:modelValue': (next: string) => { value.value = next } }) })
  app.mount(root)
  await nextTick()
  return value
}
async function open() {
  root!.querySelector<HTMLButtonElement>('[aria-label="选择模型"]')!.click()
  await nextTick()
}
afterEach(() => { app?.unmount(); root?.remove(); app = undefined; root = undefined })

describe('AiModelSelector', () => {
  it('shows every returned model even when the input already contains GPT', async () => {
    const value = await mount()
    await open()
    expect(root!.querySelector('[role="combobox"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(Array.from(root!.querySelectorAll('[role="option"]')).map(option => option.textContent?.trim())).toEqual(models)
    expect(value.value).toBe('GPT') // Opening must not change the customer's draft.
    expect(root!.textContent).toContain('可选 7 个模型')
  })
  it('searches case-insensitively and selects the exact returned ID without saving', async () => {
    const value = await mount()
    await open()
    const search = root!.querySelector<HTMLInputElement>('[aria-label="搜索可用模型"]')!
    search.value = 'DEEPSEEK'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    const options = root!.querySelectorAll<HTMLButtonElement>('[role="option"]')
    expect(options.length).toBe(2)
    options[1]!.click()
    await nextTick()
    expect(value.value).toBe('deepseek-reasoner')
    expect(root!.querySelector('[role="listbox"]')).toBeNull()
    expect(document.activeElement).toBe(root!.querySelector('#ai-model'))
  })
  it('preserves manual input for providers with no model list', async () => {
    const value = await mount([], '')
    const input = root!.querySelector<HTMLInputElement>('#ai-model')!
    input.value = 'provider/private-model-v2'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    await open()
    expect(value.value).toBe('provider/private-model-v2')
    expect(root!.textContent).toContain('暂无模型列表')
    expect(root!.textContent).toContain('选择后需保存模型配置')
  })
  it('removes blank and duplicate options but preserves distinct model IDs', async () => {
    await mount([' ', 'gpt-4o', 'gpt-4o', ' GPT-4O '])
    await open()
    expect(root!.querySelectorAll('[role="option"]').length).toBe(2)
  })
  it('shows a helpful empty-search state without changing the selected model', async () => {
    const value = await mount()
    await open()
    const search = root!.querySelector<HTMLInputElement>('[aria-label="搜索可用模型"]')!
    search.value = 'not-returned-model'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(root!.querySelectorAll('[role="option"]').length).toBe(0)
    expect(root!.textContent).toContain('没有匹配的模型')
    expect(value.value).toBe('GPT')
  })
  it('supports keyboard opening, option focus and Escape dismissal', async () => {
    await mount()
    root!.querySelector('#ai-model')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await nextTick()
    const search = root!.querySelector<HTMLInputElement>('[aria-label="搜索可用模型"]')!
    expect(document.activeElement).toBe(search)
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(root!.querySelector('[role="option"]'))
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(root!.querySelector('[role="listbox"]')).toBeNull()
    expect(document.activeElement).toBe(root!.querySelector('#ai-model'))
  })
  it('does not allow selection while a connection test or save is in progress', async () => {
    await mount(models, 'GPT', true)
    expect(root!.querySelector<HTMLInputElement>('#ai-model')!.disabled).toBe(true)
    expect(root!.querySelector<HTMLButtonElement>('[aria-label="选择模型"]')!.disabled).toBe(true)
    await open()
    expect(root!.querySelector('[role="listbox"]')).toBeNull()
  })
  it('closes when focus moves outside the selector', async () => {
    await mount()
    await open()
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    try {
      outside.focus()
      await nextTick()
      expect(root!.querySelector('[role="listbox"]')).toBeNull()
    } finally { outside.remove() }
  })
})
