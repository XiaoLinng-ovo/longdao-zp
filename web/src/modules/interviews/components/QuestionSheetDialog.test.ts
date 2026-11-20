// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App, type Ref } from 'vue'
import QuestionSheetDialog from './QuestionSheetDialog.vue'
import { loadQuestionSheets } from '../api/question-sheets'

vi.mock('../api/question-sheets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/question-sheets')>()
  return {
    ...actual,
    loadQuestionSheets: vi.fn().mockResolvedValue({ applicationId: 'app-1', sheets: [], reviews: [], stages: [] }),
  }
})

const mockedLoad = vi.mocked(loadQuestionSheets)

let app: App | undefined
let root: HTMLDivElement | undefined
let open: Ref<boolean>
let closeCount = 0

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function mount(initial = false): Promise<HTMLDivElement> {
  open = ref(initial)
  closeCount = 0
  root = document.createElement('div')
  document.body.appendChild(root)
  const Host = defineComponent({
    setup: () => () => h(QuestionSheetDialog, {
      open: open.value,
      applicationId: 'app-1',
      defaultStage: 'initial',
      onClose: () => { closeCount += 1; open.value = false },
    }),
  })
  app = createApp(Host)
  app.mount(root)
  await flush()
  return root
}

async function setOpen(value: boolean): Promise<void> {
  open.value = value
  await flush()
}

afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
  document.body.style.overflow = ''
  vi.resetAllMocks()
})

describe('QuestionSheetDialog', () => {
  it('关闭时不渲染，打开后以弹窗展示面试问题表', async () => {
    const element = await mount(false)
    expect(element.querySelector('.sheet-dialog')).toBeNull()
    expect(mockedLoad).not.toHaveBeenCalled()

    await setOpen(true)
    expect(element.querySelector('.sheet-dialog')).not.toBeNull()
    expect(element.querySelector('.sheet-panel')).not.toBeNull()
    expect(mockedLoad).toHaveBeenCalledWith('app-1')
  })

  it('弹窗主体可滚动，滚动容器有独立高度', async () => {
    const element = await mount(true)
    const body = element.querySelector('.sheet-dialog-body') as HTMLElement
    expect(body).not.toBeNull()
    expect(body.className).toContain('sheet-dialog-body')
    expect(element.querySelector('.sheet-dialog')?.className).toContain('sheet-dialog')
  })

  it('点「关闭」和按 Esc 都能关闭弹窗', async () => {
    const element = await mount(true)
    const closeButton = [...element.querySelectorAll('button')].find((button) => button.textContent?.includes('关闭'))
    closeButton?.click()
    await flush()
    expect(closeCount).toBe(1)

    await setOpen(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flush()
    expect(closeCount).toBe(2)
  })

  it('内层「确认阶段结论」弹窗打开时，Esc 只关内层', async () => {
    await mount(true)
    const inner = document.createElement('div')
    inner.setAttribute('data-sheet-confirm', '')
    document.body.appendChild(inner)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flush()
    expect(closeCount).toBe(0)
    inner.remove()
  })

  it('打开时锁定页面滚动，关闭后恢复', async () => {
    await mount(true)
    expect(document.body.style.overflow).toBe('hidden')
    await setOpen(false)
    expect(document.body.style.overflow).toBe('')
  })
})
