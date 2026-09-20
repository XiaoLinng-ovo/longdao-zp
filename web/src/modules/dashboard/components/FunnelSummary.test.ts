// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import FunnelSummary from './FunnelSummary.vue'

let app: App | undefined
let root: HTMLDivElement | undefined

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
})

describe('面试漏斗组件', () => {
  it('渲染横向漏斗图和精确数字表', async () => {
    const steps = [
      { label: '收到申请', value: 13, conversionRate: null },
      { label: '通过筛选', value: 8, conversionRate: 61.54 },
      { label: '进入面试', value: 7, conversionRate: 87.5 },
      { label: '发出 Offer', value: 5, conversionRate: 71.43 },
      { label: '已入职', value: 5, conversionRate: 100 },
    ]

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(FunnelSummary, { steps })
    app.mount(root)
    await flush()

    expect(root.querySelector('.funnel-chart')).not.toBeNull()
    expect(root.querySelectorAll('.funnel-chart .funnel-bar')).toHaveLength(5)
    expect(root.querySelector('.funnel-table')).not.toBeNull()
    expect(root.textContent).toContain('整体转化率')
    expect(root.textContent).toContain('61.54%')
    expect(root.textContent).toContain('53.85%')
    expect(root.textContent).toContain('38.46%')
    expect(root.textContent).not.toContain('87.5%')
  })
})
