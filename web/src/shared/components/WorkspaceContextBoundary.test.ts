// @vitest-environment jsdom
import { createApp, nextTick, h } from 'vue'
import { describe, expect, it } from 'vitest'
import WorkspaceContextBoundary from './WorkspaceContextBoundary.vue'
import { WORKSPACE_CONTEXT_STORAGE_KEY } from '../api/workspace-context'
it('unmounts business controls after another tab changes context, and asks for explicit refresh', async () => {
  const root = document.createElement('div'); document.body.append(root)
  const app = createApp({ render: () => h(WorkspaceContextBoundary, {}, { default: () => '业务表单' }) })
  app.mount(root)
  try {
    expect(root.textContent).toContain('业务表单')
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: '1' }))
    await nextTick(); expect(root.textContent).toContain('业务表单')
    window.dispatchEvent(new StorageEvent('storage', { key: WORKSPACE_CONTEXT_STORAGE_KEY, newValue: 'changed' }))
    await nextTick()
    expect(root.textContent).not.toContain('业务表单')
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('当前页面已暂停操作')
    expect(root.querySelector('button')?.textContent).toContain('刷新并确认当前企业')
  } finally { app.unmount(); root.remove() }
})
