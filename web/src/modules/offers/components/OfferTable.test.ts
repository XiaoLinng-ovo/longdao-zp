// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import OfferTable from './OfferTable.vue'

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

describe('OfferTable', () => {
  it('keeps an accepted offer with onboarding read-only', async () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferTable, {
      rows: [{
        id: 'offer-1',
        entityId: 'offer-1',
        code: 'OFF-1',
        applicationId: 'app-1',
        applicationCode: 'APP-1',
        candidate: '王思远',
        job: '高级后端工程师',
        status: 'accepted',
        onboardingStatus: 'pending',
        updatedAt: '2026-09-20',
      }],
    })
    app.mount(root)
    await flush()

    expect(root.textContent).toContain('待入职')
    expect(root.textContent).not.toContain('重新发送')
    expect(root.textContent).not.toContain('入职归档')
    expect(root.textContent).not.toContain('审批')
  })

  it('allows a draft offer to be sent without approval', async () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferTable, {
      rows: [{ id: 'offer-2', entityId: 'offer-2', code: 'OFF-2', applicationId: 'app-2', applicationCode: 'APP-2', candidate: '李青', job: '产品经理', status: 'draft', updatedAt: '2026-11-03' }],
    })
    app.mount(root)
    await flush()

    expect(root.textContent).toContain('发送 Offer')
    expect(root.textContent).not.toContain('提交审批')
    expect(root.textContent).not.toContain('审批人')
  })

  it('shows a resend action for a sent offer', async () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferTable, {
      rows: [{ id: 'offer-3', entityId: 'offer-3', code: 'OFF-3', applicationId: 'app-3', applicationCode: 'APP-3', candidate: '周宁', job: '测试工程师', status: 'sent', updatedAt: '2026-11-04' }],
    })
    app.mount(root)
    await flush()

    expect(root.textContent).toContain('重新发送')
  })

  it.each(['declined', 'expired'] as const)('does not allow resending a %s offer', async (status) => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferTable, {
      rows: [{ id: `offer-${status}`, entityId: `offer-${status}`, code: 'OFF-TERMINAL', applicationId: 'app-terminal', applicationCode: 'APP-TERMINAL', candidate: '终态候选人', job: '后端工程师', status, updatedAt: '2026-11-04' }],
    })
    app.mount(root)
    await flush()

    expect(root.textContent).not.toContain('重新发送')
  })

  it('allows a cancelled offer to be resent or recreated', async () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferTable, {
      rows: [{ id: 'offer-cancelled', entityId: 'offer-cancelled', code: 'OFF-CANCELLED', applicationId: 'app-cancelled', applicationCode: 'APP-CANCELLED', candidate: '取消候选人', job: '后端工程师', status: 'cancelled', updatedAt: '2026-11-04' }],
    })
    app.mount(root)
    await flush()

    expect(root.textContent).toContain('重新发送')
    expect(root.textContent).toContain('重新创建')
  })

  it('only allows an accepted offer without onboarding to be archived', async () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OfferTable, {
      rows: [{ id: 'offer-4', entityId: 'offer-4', code: 'OFF-4', applicationId: 'app-4', applicationCode: 'APP-4', candidate: '赵敏', job: '后端工程师', status: 'accepted', updatedAt: '2026-11-04' }],
    })
    app.mount(root)
    await flush()

    expect(root.textContent).not.toContain('重新发送')
    expect(root.textContent).toContain('入职归档')
  })
})
