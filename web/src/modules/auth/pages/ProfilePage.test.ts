// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProfilePage from './ProfilePage.vue'
import { authSession, saveCurrentUserProfile } from '../session'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  saveCurrentUserProfile: vi.fn(),
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('../session', () => ({
  authSession: {
    ready: true,
    loading: false,
    method: 'session',
    sessionId: 'session-1',
    user: {
      id: 'user-1',
      name: '陈婉清',
      email: 'owner@example.com',
      phone: '13800000000',
      role: 'recruiter',
      departmentId: 'dept-hr',
      workspaceId: 'workspace-1',
      workspaceName: '龙道科技',
      workspaceKind: 'production',
      platformRole: 'viewer',
    },
    workspaces: [{ id: 'workspace-1', name: '龙道科技', kind: 'production', status: 'active', role: 'owner', createdAt: '2026-10-26' }],
  },
  saveCurrentUserProfile: mocks.saveCurrentUserProfile,
}))

let app: App
let root: HTMLDivElement

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function input(selector: string): HTMLInputElement {
  return root.querySelector<HTMLInputElement>(selector)!
}

function setInputValue(element: HTMLInputElement, value: string) {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  vi.clearAllMocks()
  authSession.user = {
    id: 'user-1',
    name: '陈婉清',
    email: 'owner@example.com',
    phone: '13800000000',
    role: 'recruiter',
    departmentId: 'dept-hr',
    workspaceId: 'workspace-1',
    workspaceName: '龙道科技',
    workspaceKind: 'production',
    platformRole: 'viewer',
  }
  authSession.workspaces = [{ id: 'workspace-1', name: '龙道科技', kind: 'production', status: 'active', role: 'owner', createdAt: '2026-10-26' }]
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(ProfilePage)
  app.mount(root)
})

afterEach(() => {
  app.unmount()
  root.remove()
})

describe('profile page', () => {
  it('shows editable contact fields and read-only account and workspace facts', async () => {
    await flush()

    expect(input('input[autocomplete="name"]').value).toBe('陈婉清')
    expect(input('input[autocomplete="tel"]').value).toBe('13800000000')
    expect(root.textContent).toContain('owner@example.com')
    expect(root.textContent).toContain('龙道科技')
    expect(root.textContent).toContain('企业所有者')
    expect(root.textContent).toContain('企业用户')
    expect(root.textContent).toContain('平台只读运营')
    expect(root.querySelectorAll('.profile-facts input')).toHaveLength(0)
  })

  it('saves edited contact details and leaves the page on screen', async () => {
    await flush()
    mocks.saveCurrentUserProfile.mockImplementation(async (updates: { name: string; phone: string }) => {
      authSession.user = { ...authSession.user!, ...updates }
      return authSession.user
    })

    setInputValue(input('input[autocomplete="name"]'), '陈婉清（更新）')
    setInputValue(input('input[autocomplete="tel"]'), '13900000000')
    await flush()
    root.querySelector<HTMLButtonElement>('.profile-save')!.click()
    await flush()

    expect(saveCurrentUserProfile).toHaveBeenCalledWith({ name: '陈婉清（更新）', phone: '13900000000' })
    expect(root.querySelector('[role="status"]')?.textContent).toContain('个人信息已更新')
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it('prevents saving a blank name and returns to workspace selection when no enterprise is active', async () => {
    await flush()
    setInputValue(input('input[autocomplete="name"]'), '   ')
    await flush()
    expect(root.querySelector<HTMLButtonElement>('.profile-save')?.disabled).toBe(true)

    authSession.user = { ...authSession.user!, workspaceId: undefined, workspaceName: undefined, workspaceKind: undefined }
    await flush()
    root.querySelector<HTMLButtonElement>('.profile-back')!.click()
    await flush()
    expect(mocks.push).toHaveBeenCalledWith('/workspaces')
  })
})
