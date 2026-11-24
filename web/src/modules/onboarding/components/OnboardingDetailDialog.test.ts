// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { readFileSync } from 'node:fs'
import OnboardingDetailDialog from './OnboardingDetailDialog.vue'
import * as onboardingApi from '../api'
import type { ApiOnboardingMaterial, ApiOnboardingTask, ApiOnboardingWorkbenchItem } from '../api'

const source = readFileSync('src/modules/onboarding/components/OnboardingDetailDialog.vue', 'utf-8')
const css = source.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1] ?? ''

function styleRules(): CSSStyleRule[] {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  const rules = Array.from(style.sheet!.cssRules)
    .filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
  style.remove()
  return rules
}

function ruleFor(selector: string): CSSStyleRule {
  const rule = styleRules().find((item) => item.selectorText === selector)
  expect(rule, selector).toBeDefined()
  return rule!
}

const item: ApiOnboardingWorkbenchItem = {
  onboarding: {
    id: 'onboarding-1',
    applicationId: 'application-1',
    offerId: 'offer-1',
    status: 'completed',
    plannedStartDate: '2026-11-10',
    plannedStartTime: '09:00',
    reportingMode: 'onsite',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
  },
  tasks: [],
  materials: [],
  reminders: [],
  integrations: [],
  candidateName: '测试候选人',
  jobTitle: '测试岗位',
  offerCode: 'OFF-TEST',
  department: '技术部',
  readiness: 80,
  requiredTasksRemaining: 0,
  overdueTasks: 0,
  highRiskReasons: [],
}

let app: App | undefined
let root: HTMLDivElement | undefined

afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
  root = undefined
})

describe('入职详情工作台布局', () => {
  const task = (id: string, status: ApiOnboardingTask['status'], isRequired = true): ApiOnboardingTask => ({
    id, onboardingId: 'onboarding-1', title: '任务-' + id, category: 'hr', status, isRequired,
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
  })
  const material = (id: string, status: ApiOnboardingMaterial['status']): ApiOnboardingMaterial => ({
    id, onboardingId: 'onboarding-1', code: id, label: '材料-' + id, status, isRequired: true,
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
  })
  async function mountItem(value: ApiOnboardingWorkbenchItem) {
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(OnboardingDetailDialog, { item: value }); app.mount(root)
    await nextTick()
    return root
  }
  it('待办只包含必选的未处理任务和未核验材料，排除选填及已处理项', async () => {
    const element = await mountItem({ ...item,
      tasks: [task('pending', 'pending'), task('progress', 'in_progress', false), task('blocked', 'blocked'), task('done', 'completed'), task('skip', 'not_required')],
      materials: [material('pending', 'pending'), material('collected', 'collected'), { ...material('optional', 'pending'), isRequired: false }, material('done', 'verified'), material('skip', 'waived')],
    })
    const section = element.querySelector('.pending-section')!
    expect(section.textContent).toContain('待办事项')
    expect(element.textContent).not.toContain('责任交接')
    expect(section.querySelectorAll('.pending-link')).toHaveLength(4)
    expect(section.textContent).not.toContain('任务-progress')
    expect(section.textContent).not.toContain('材料-optional')
    expect(section.textContent).not.toContain('指定 HR 负责人')
    expect(section.textContent).not.toContain('指定用人经理')
    expect(section.textContent).toContain('材料-collected')
    expect(section.textContent).not.toContain('任务-done')
    expect(section.textContent).not.toContain('任务-skip')
    expect(section.textContent).not.toContain('材料-done')
    expect(section.textContent).not.toContain('材料-skip')
  })
  it('点击任务和材料待办切换页签并聚焦到具体办理项', async () => {
    const element = await mountItem({ ...item, tasks: [task('first', 'completed'), task('target', 'blocked')], materials: [material('target', 'collected')] })
    element.querySelector<HTMLButtonElement>('[data-pending-key="task-target"]')!.click()
    await nextTick(); await nextTick()
    expect(element.querySelector('[aria-label="入职任务"]')).not.toBeNull()
    expect(document.activeElement?.getAttribute('data-pending-target')).toBe('task-target')
    expect(element.querySelector('.pending-target')?.textContent).toContain('任务-target')
    element.querySelector<HTMLButtonElement>('.workbench-tabs button')!.click(); await nextTick()
    element.querySelector<HTMLButtonElement>('[data-pending-key="material-target"]')!.click()
    await nextTick(); await nextTick()
    expect(element.querySelector('[aria-label="入职材料核验"]')).not.toBeNull()
    expect(document.activeElement?.getAttribute('data-pending-target')).toBe('material-target')
  })
  it('未确认报到仍提供必要操作，但不显示选填负责人待办或自动提交', async () => {
    const action = vi.spyOn(onboardingApi, 'actionOnboarding')
    const element = await mountItem({ ...item, onboarding: { ...item.onboarding, status: 'scheduled' } })
    expect(element.querySelector('[data-pending-key="hr-owner"]')).toBeNull()
    expect(element.querySelector('[data-pending-key="hiring-manager"]')).toBeNull()
    element.querySelector<HTMLButtonElement>('[data-pending-key="arrival-action"]')!.click()
    await nextTick(); await nextTick()
    expect(element.querySelector('[aria-label="报到安排"]')).not.toBeNull()
    expect(document.activeElement?.textContent).toBe('确认已报到')
    expect(action).not.toHaveBeenCalled()
    action.mockRestore()
  })
  it('任务保存完成后从待办中移除', async () => {
    const save = vi.spyOn(onboardingApi, 'updateOnboardingTask').mockResolvedValue(task('target', 'completed'))
    const element = await mountItem({ ...item, tasks: [task('target', 'pending')] })
    element.querySelector<HTMLButtonElement>('[data-pending-key="task-target"]')!.click(); await nextTick()
    const select = element.querySelector<HTMLSelectElement>('[data-pending-target="task-target"] select')!
    select.value = 'completed'; select.dispatchEvent(new Event('change')); await nextTick()
    element.querySelector<HTMLButtonElement>('.item-actions button')!.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    element.querySelector<HTMLButtonElement>('.workbench-tabs button')!.click(); await nextTick()
    expect(element.querySelector('[data-pending-key="task-target"]')).toBeNull()
    expect(save).toHaveBeenCalledWith('onboarding-1', 'target', expect.objectContaining({ status: 'completed' }))
    save.mockRestore()
  })
  it('就绪度百分之百且已报到时，选填任务、材料和未指定负责人不产生待办', async () => {
    const element = await mountItem({ ...item,
      tasks: [task('required', 'completed'), task('optional', 'pending', false)],
      materials: [material('required', 'verified'), { ...material('optional', 'collected'), isRequired: false }],
    })
    expect(element.querySelector('.readiness-score')?.textContent).toContain('100%')
    expect(element.querySelectorAll('.pending-link')).toHaveLength(0)
    expect(element.querySelector('.pending-section')?.textContent).toContain('暂无待办事项')
    element.querySelectorAll<HTMLButtonElement>('.workbench-tabs button')[2]!.click(); await nextTick()
    expect(element.querySelector('[data-pending-target="task-optional"]')).not.toBeNull()
    element.querySelectorAll<HTMLButtonElement>('.workbench-tabs button')[3]!.click(); await nextTick()
    expect(element.querySelector('[data-pending-target="material-optional"]')).not.toBeNull()
  })
  it('已全部处理显示空态，已取消和未报到记录不提供待办操作', async () => {
    for (const status of ['completed', 'cancelled', 'no_show'] as const) {
      const element = await mountItem({ ...item, onboarding: { ...item.onboarding, status, hrOwnerName: '张经理', hiringManagerName: '李经理' }, tasks: [task('done', status === 'completed' ? 'completed' : 'pending')] })
      expect(element.querySelectorAll('.pending-link')).toHaveLength(0)
      expect(element.querySelector('.pending-section')?.textContent).toContain(status === 'completed' ? '暂无待办事项' : '无可办理事项')
      app!.unmount(); app = undefined; root!.remove(); root = undefined
    }
  })
  it('固定头部、页签和底栏，只允许正文滚动并收缩', () => {
    const workbench = ruleFor('.onboarding-workbench')
    const fixedRegions = ruleFor('.onboarding-workbench > :not(.workbench-body)')
    const tabs = ruleFor('.workbench-tabs')
    const body = ruleFor('.workbench-body')

    expect(workbench.style.getPropertyValue('height')).toBe('min(920px, calc(100dvh - 36px))')
    expect(workbench.style.getPropertyValue('max-height')).toBe('calc(100dvh - 36px)')
    expect(fixedRegions.style.getPropertyValue('flex-shrink')).toBe('0')
    expect(tabs.style.getPropertyValue('min-height')).toBe('42px')
    expect(body.style.getPropertyValue('flex')).toBe('1 1 0')
    expect(body.style.getPropertyValue('min-height')).toBe('0')
    expect(body.style.getPropertyValue('overflow-y')).toBe('auto')
  })

  it('页签可以切换，关闭按钮保持可用', async () => {
    const onClose = vi.fn()
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OnboardingDetailDialog, { item, onClose })
    app.mount(root)
    await nextTick()

    const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('.workbench-tabs button'))
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      '概览',
      '报到',
      '任务0',
      '材料0',
      '操作记录',
    ])

    tabs.find((tab) => tab.textContent?.includes('材料'))!.click()
    await nextTick()
    expect(root.querySelector('[aria-label="入职材料核验"]')).not.toBeNull()
    expect(root.textContent).not.toContain('集成')
    expect(root.textContent).not.toContain('提醒')
    expect(root.querySelector('.workbench-footer')).not.toBeNull()

    root.querySelector<HTMLButtonElement>('[aria-label="关闭入职工作台"]')!.click()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('材料核验将内部编码映射为中文且不展示英文编码', async () => {
    const materials: ApiOnboardingMaterial[] = [
      {
        id: 'payroll', onboardingId: 'onboarding-1', code: 'previous_employment_payroll', label: 'previous_employment_payroll',
        status: 'pending', isRequired: true, createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
      },
      {
        id: 'medical', onboardingId: 'onboarding-1', code: 'medical_report', label: 'medical_report',
        status: 'pending', isRequired: true, createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
      },
    ]
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OnboardingDetailDialog, { item: { ...item, materials } })
    app.mount(root)
    await nextTick()

    root.querySelectorAll<HTMLButtonElement>('.workbench-tabs button')[3]!.click()
    await nextTick()

    expect(root.textContent).toContain('上家单位一年工资流水')
    expect(root.textContent).toContain('体检报告')
    expect(root.textContent).not.toContain('previous_employment_payroll')
    expect(root.textContent).not.toContain('medical_report')
  })

  it('已完成报到后仍可补录内部信息，但不允许再次取消入职', async () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(OnboardingDetailDialog, { item })
    app.mount(root)
    await nextTick()

    expect(root.textContent).toContain('仍可继续补录报到信息、任务和材料')
    expect(Array.from(root.querySelectorAll('button')).some((button) => button.textContent?.includes('取消入职'))).toBe(false)

    root.querySelectorAll<HTMLButtonElement>('.workbench-tabs button')[1]!.click()
    await nextTick()
    expect(root.querySelector<HTMLInputElement>('input[type="date"]')!.disabled).toBe(false)
    expect(root.querySelector<HTMLInputElement>('input[type="time"]')!.disabled).toBe(false)
  })

  it('已取消和未报到记录保持只读', async () => {
    for (const status of ['cancelled', 'no_show'] as const) {
      root = document.createElement('div')
      document.body.appendChild(root)
      app = createApp(OnboardingDetailDialog, { item: { ...item, onboarding: { ...item.onboarding, status } } })
      app.mount(root)
      await nextTick()

      expect(root.textContent).toContain('以下内容仅供查看，不允许继续编辑')
      expect(Array.from(root.querySelectorAll('button')).some((button) => button.textContent?.includes('取消入职'))).toBe(false)

      app.unmount()
      root.remove()
      app = undefined
      root = undefined
    }
  })

  it('新增任务时将日历所选日期提交给接口', async () => {
    const createTask = vi.spyOn(onboardingApi, 'createOnboardingTask').mockResolvedValue({
      id: 'task-new', onboardingId: 'onboarding-1', title: '准备账号', category: 'it', status: 'pending',
      isRequired: true, ownerRole: 'hr_admin', dueDate: '2026-11-20',
      createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
    })
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(OnboardingDetailDialog, { item: { ...item, onboarding: { ...item.onboarding, status: 'preparing' } } })
    app.mount(root); await nextTick()
    root.querySelectorAll<HTMLButtonElement>('.workbench-tabs button')[2]!.click(); await nextTick()
    root.querySelector<HTMLInputElement>('input[placeholder="例如：配置业务系统数据权限"]')!.value = '准备账号'
    root.querySelector<HTMLInputElement>('input[placeholder="例如：配置业务系统数据权限"]')!.dispatchEvent(new Event('input', { bubbles: true })); await nextTick()
    root.querySelector('[data-date-picker-trigger]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await nextTick()
    root.querySelector<HTMLButtonElement>('[data-date="2026-11-20"]')!.click(); await nextTick()
    root.querySelector<HTMLButtonElement>('.section-actions .btn-primary')!.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(createTask).toHaveBeenCalledWith('onboarding-1', expect.objectContaining({ dueDate: '2026-11-20' }))
    createTask.mockRestore()
  })
})
