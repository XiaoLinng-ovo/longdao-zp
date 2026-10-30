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
  it('does not offer another archive action after onboarding exists', async () => {
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
        approvalStatus: 'approved',
        approver: '审批人',
        onboardingStatus: 'pending',
        updatedAt: '2026-09-20',
      }],
    })
    app.mount(root)
    await flush()

    expect(root.textContent).toContain('待入职')
    expect(root.textContent).not.toContain('入职归档')
  })
})
