// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import CalendarDatePicker from './CalendarDatePicker.vue'

let app: App | undefined
let root: HTMLDivElement | undefined

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

afterEach(() => {
  app?.unmount()
  root?.remove()
})

it('renders a consistent month grid instead of a browser-native date input', async () => {
  const update = vi.fn()
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(CalendarDatePicker, { modelValue: '2026-11-04', ariaLabel: '开始日期', 'onUpdate:modelValue': update })
  app.mount(root)
  await flush()

  const trigger = root.querySelector<HTMLButtonElement>('[aria-label="开始日期"]')!
  expect(trigger.textContent).toContain('2026/11/04')
  expect(root.querySelector('input[type="date"]')).toBeNull()

  trigger.click()
  await flush()
  expect(root.querySelector('[role="dialog"]')?.textContent).toContain('2026年11月')
  expect(root.querySelectorAll('[role="gridcell"]')).toHaveLength(42)
  root.querySelector<HTMLButtonElement>('[data-date="2026-11-10"]')!.click()
  expect(update).toHaveBeenCalledWith('2026-11-10')
})

it('switches calendar months from the in-app navigation controls', async () => {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(CalendarDatePicker, { modelValue: '2026-11-04', ariaLabel: '结束日期' })
  app.mount(root)
  await flush()

  root.querySelector<HTMLButtonElement>('[aria-label="结束日期"]')!.click()
  await flush()
  root.querySelector<HTMLButtonElement>('[aria-label="上个月"]')!.click()
  await flush()
  expect(root.querySelector('[role="dialog"]')?.textContent).toContain('2026年10月')
})
