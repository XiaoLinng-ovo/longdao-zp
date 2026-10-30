// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AccountCreation from './AccountCreation.vue'
import { authSession } from '../../auth/session'
import { createAdminUser, listAccountOrganizations } from '../api'

vi.mock('../api', () => ({ createAdminUser: vi.fn(), listAccountOrganizations: vi.fn() }))

const mockedCreate = vi.mocked(createAdminUser)
const mockedOrganizations = vi.mocked(listAccountOrganizations)
const roles = [
  { id: 'r1', code: 'platform_admin', name: '平台管理员' },
  { id: 'r2', code: 'recruiter', name: '招聘专员' },
]
const departments = [
  { id: 'd1', code: 'dept-tech', name: '技术部', isActive: true, createdAt: '', updatedAt: '' },
  { id: 'd2', code: 'dept-old', name: '历史部门', isActive: false, createdAt: '', updatedAt: '' },
]
const result = { user: { id: 'u2', email: 'new@example.com', displayName: '新同事', role: 'recruiter', departmentCode: 'dept-tech', isActive: true, lastLoginAt: null, createdAt: '2026-10-22T00:00:00Z' }, initialPassword: 'Auto!Pass123', generatedPassword: true }

let app: App | undefined
let root: HTMLDivElement | undefined
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }

beforeEach(() => {
  Object.assign(authSession, { user: { workspaceId: 'org-2' } })
  mockedOrganizations.mockResolvedValue([{ id: 'org-1', name: '其他企业' }, { id: 'org-2', name: '当前企业' }])
  mockedCreate.mockReset()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
})
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); root = undefined; vi.restoreAllMocks() })

async function mount() {
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(AccountCreation, { roles, departments }); app.mount(root); await flush()
}
function input(selector: string) { return root!.querySelector<HTMLInputElement>(selector)! }
function select(selector: string, value: string) { const element = root!.querySelector<HTMLSelectElement>(selector)!; element.value = value; element.dispatchEvent(new Event('change')); }

describe('账号创建组件', () => {
  it('默认选择当前企业，过滤平台角色和停用部门', async () => {
    await mount()
    expect(input('#account-email')).toBeTruthy()
    expect(root!.querySelector<HTMLSelectElement>('#account-organization')!.value).toBe('org-2')
    expect(root!.querySelectorAll('#account-role option')).toHaveLength(1)
    expect(root!.querySelector('#account-role option')?.textContent).toBe('招聘专员')
    expect(root!.querySelectorAll('#account-department option')).toHaveLength(2)
    expect(root!.textContent).not.toContain('历史部门')
  })

  it('自动生成密码时不把 password 发送给 API，自定义密码原样发送', async () => {
    await mount()
    input('#account-email').value = ' New@Example.com '; input('#account-email').dispatchEvent(new Event('input'))
    input('#account-name').value = ' 新同事 '; input('#account-name').dispatchEvent(new Event('input'))
    select('#account-department', 'dept-tech')
    mockedCreate.mockResolvedValue(result)
    root!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await flush()
    expect(mockedCreate).toHaveBeenCalledWith({ email: 'new@example.com', displayName: '新同事', organizationId: 'org-2', departmentCode: 'dept-tech', role: 'recruiter' })
    expect(root!.querySelector('[data-testid="created-password"]')?.textContent).toBe('Auto!Pass123')

    Array.from(root!.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '继续创建')!.click()
    await flush()
    root!.querySelector<HTMLInputElement>('input[value="custom"]')!.click(); await flush()
    input('#account-password').value = '  Custom!  '; input('#account-password').dispatchEvent(new Event('input'))
    input('#account-email').value = 'custom@example.com'; input('#account-email').dispatchEvent(new Event('input'))
    input('#account-name').value = '另一位同事'; input('#account-name').dispatchEvent(new Event('input'))
    mockedCreate.mockResolvedValue({ ...result, initialPassword: '  Custom!  ', generatedPassword: false })
    root!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await flush()
    expect(mockedCreate).toHaveBeenLastCalledWith({ email: 'custom@example.com', displayName: '另一位同事', organizationId: 'org-2', departmentCode: 'dept-tech', role: 'recruiter', password: '  Custom!  ' })
  })

  it('提交成功后只显示一次密码并支持复制，失败时保留输入', async () => {
    await mount()
    input('#account-email').value = 'new@example.com'; input('#account-email').dispatchEvent(new Event('input'))
    input('#account-name').value = '新同事'; input('#account-name').dispatchEvent(new Event('input'))
    select('#account-department', 'dept-tech')
    mockedCreate.mockRejectedValueOnce(new Error('邮箱已存在'))
    root!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await flush()
    expect(root!.textContent).toContain('邮箱已存在'); expect(input('#account-email').value).toBe('new@example.com')
    mockedCreate.mockResolvedValueOnce(result)
    root!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await flush()
    const writeText = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>)
    root!.querySelector<HTMLButtonElement>('button')!.click(); await flush()
    expect(writeText).toHaveBeenCalledWith('账号：new@example.com\n密码：Auto!Pass123')
    root!.querySelector<HTMLButtonElement>('button:last-child')!.click(); await flush()
    expect(root!.querySelector('[data-testid="created-password"]')).toBeNull()
    expect(input('#account-email').value).toBe('')
  })
})
