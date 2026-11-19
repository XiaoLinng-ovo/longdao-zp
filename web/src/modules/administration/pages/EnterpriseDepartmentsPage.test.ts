// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import EnterpriseDepartmentsPage from './EnterpriseDepartmentsPage.vue'
import {
  createEnterpriseDepartment,
  deleteEnterpriseDepartment,
  listEnterpriseDepartments,
  updateEnterpriseDepartment,
  type AdminDepartment,
} from '../api'

vi.mock('../api', () => ({
  createEnterpriseDepartment: vi.fn(),
  deleteEnterpriseDepartment: vi.fn(),
  listEnterpriseDepartments: vi.fn(),
  updateEnterpriseDepartment: vi.fn(),
}))
vi.mock('../../auth/session', async () => {
  const { reactive } = await import('vue')
  return {
    authSession: reactive({
      user: { id: 'member-1', name: '企业成员', email: 'member@example.com', role: 'recruiter', departmentId: 'dept-tech', workspaceId: 'workspace-1' },
      workspaces: [{ id: 'workspace-1', name: '龙道测试企业', kind: 'test', status: 'active', role: 'member', createdAt: '2026-11-05T00:00:00Z' }],
    }),
  }
})

const mockedList = vi.mocked(listEnterpriseDepartments)
const mockedCreate = vi.mocked(createEnterpriseDepartment)
const mockedUpdate = vi.mocked(updateEnterpriseDepartment)
const mockedDelete = vi.mocked(deleteEnterpriseDepartment)

const technicalDepartment: AdminDepartment = {
  id: 'dept-tech',
  code: 'dept-tech',
  name: '技术部',
  isActive: true,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
}
const operationsDepartment: AdminDepartment = {
  ...technicalDepartment,
  id: 'dept-operations',
  code: 'dept-operations',
  name: '运营部',
  isActive: false,
}

let app: App | undefined
let root: HTMLDivElement | undefined

async function flush() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function mount() {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp(EnterpriseDepartmentsPage)
  app.mount(root)
  await flush()
}

function button(label: string, within: ParentNode = root!): HTMLButtonElement {
  const match = [...within.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)
  if (!match) throw new Error(`未找到按钮：${label}`)
  return match
}

function row(name: string): HTMLTableRowElement {
  const match = [...root!.querySelectorAll<HTMLTableRowElement>('tbody tr')].find((item) => item.textContent?.includes(name))
  if (!match) throw new Error(`未找到部门行：${name}`)
  return match
}

function input(element: HTMLInputElement, value: string) {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  mockedList.mockResolvedValue([technicalDepartment, operationsDepartment])
  mockedCreate.mockResolvedValue({ ...operationsDepartment, id: 'dept-product', code: 'dept-product', name: '产品部', isActive: true })
  mockedUpdate.mockImplementation(async (id, patch) => {
    const current = [technicalDepartment, operationsDepartment].find((department) => department.id === id) ?? technicalDepartment
    return { ...current, ...patch }
  })
  mockedDelete.mockResolvedValue({ id: technicalDepartment.id, code: technicalDepartment.code, name: technicalDepartment.name, removedApprovalPolicies: 0 })
})

afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
  root = undefined
  vi.clearAllMocks()
})

describe('EnterpriseDepartmentsPage', () => {
  it('keeps creation available and focuses the name field when submitted empty', async () => {
    await mount()
    const nameInput = root!.querySelector<HTMLInputElement>('#new-department-name')!
    expect(button('新增部门').disabled).toBe(false)
    button('新增部门').click()
    await flush()
    expect(mockedCreate).not.toHaveBeenCalled()
    expect(root?.querySelector('[role="alert"]')?.textContent).toBe('请输入部门名称')
    expect(document.activeElement).toBe(nameInput)
    expect(nameInput.getAttribute('aria-invalid')).toBe('true')

    input(nameInput, '   ')
    await flush()
    button('新增部门').click()
    await flush()
    expect(mockedCreate).not.toHaveBeenCalled()
    expect(root?.querySelector('[role="alert"]')?.textContent).toBe('请输入部门名称')

    input(nameInput, '产品部')
    await flush()
    expect(root?.querySelector('[role="alert"]')).toBeNull()
    button('新增部门').click()
    await flush()
    expect(mockedCreate).toHaveBeenCalledWith({ name: '产品部' })
    expect(root?.textContent).toContain('已新增部门「产品部」')
  })

  it('disables creation only while saving and prevents duplicate submissions', async () => {
    let finish!: (department: AdminDepartment) => void
    mockedCreate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await mount()
    const nameInput = root!.querySelector<HTMLInputElement>('#new-department-name')!
    input(nameInput, '产品部')
    await flush()
    button('新增部门').click()
    await flush()
    expect(button('新增中...').disabled).toBe(true)
    expect(nameInput.disabled).toBe(true)
    root!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(mockedCreate).toHaveBeenCalledOnce()
    finish({ ...technicalDepartment, id: 'new-department', name: '产品部' })
    await flush()
    expect(button('新增部门').disabled).toBe(false)
    expect(nameInput.disabled).toBe(false)
  })

  it('loads the current enterprise departments and creates a department', async () => {
    await mount()

    expect(mockedList).toHaveBeenCalledOnce()
    expect(root?.textContent).toContain('龙道测试企业')
    expect(root?.textContent).toContain('1 个启用')
    expect(root?.textContent).toContain('1 个停用')

    input(root!.querySelector<HTMLInputElement>('#new-department-name')!, ' 产品部 ')
    await flush()
    button('新增部门').click()
    await flush()

    expect(mockedCreate).toHaveBeenCalledWith({ name: '产品部' })
    expect(root?.textContent).toContain('已新增部门「产品部」')
    expect(root?.querySelector<HTMLInputElement>('#new-department-name')?.value).toBe('')
  })

  it('renames and deactivates a department in place', async () => {
    await mount()

    button('重命名', row('技术部')).click()
    await flush()
    input(root!.querySelector<HTMLInputElement>('input[aria-label="新部门名称"]')!, '研发部')
    await flush()
    button('保存部门名称').click()
    await flush()

    expect(mockedUpdate).toHaveBeenNthCalledWith(1, 'dept-tech', { name: '研发部' })
    expect(root?.textContent).toContain('研发部')
    expect(root?.textContent).toContain('已更新部门名称为「研发部」')

    button('停用', row('研发部')).click()
    await flush()

    expect(mockedUpdate).toHaveBeenNthCalledWith(2, 'dept-tech', { isActive: false })
    expect(root?.textContent).toContain('已停用部门「技术部」')
    expect(row('技术部').textContent).toContain('已停用')
  })

  it('requires confirmation, retains the row on failure, and removes it after success', async () => {
    mockedDelete.mockRejectedValueOnce(new Error('仍有 2 个企业成员引用该部门'))
    await mount()

    button('删除', row('技术部')).click()
    await flush()
    expect(row('技术部').textContent).toContain('确认删除？')
    expect(mockedDelete).not.toHaveBeenCalled()

    button('确认删除').click()
    await flush()
    expect(mockedDelete).toHaveBeenCalledWith('dept-tech')
    expect(root?.querySelector('[role="alert"]')?.textContent).toContain('仍有 2 个企业成员引用该部门')
    expect(row('技术部')).toBeDefined()

    button('确认删除').click()
    await flush()
    expect(mockedDelete).toHaveBeenCalledTimes(2)
    expect(root?.querySelector('tbody')?.textContent).not.toContain('技术部')
    expect(root?.textContent).toContain('已删除部门「技术部」')
  })
})
