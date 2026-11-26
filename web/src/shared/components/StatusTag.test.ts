// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApp } from 'vue'
import StatusTag from './StatusTag.vue'

describe('状态标签', () => {
  it.each([['screening', '简历筛选中'], ['future_internal_status', '状态待确认']])('不向用户暴露状态 %s', (status, expected) => {
    const root = document.createElement('div')
    const app = createApp(StatusTag, { status })
    try { app.mount(root); expect(root.textContent?.trim()).toBe(expected) }
    finally { app.unmount() }
  })
})
