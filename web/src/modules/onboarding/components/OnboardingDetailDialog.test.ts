// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { readFileSync } from 'node:fs'
import OnboardingDetailDialog from './OnboardingDetailDialog.vue'
import type { ApiOnboardingMaterial, ApiOnboardingWorkbenchItem } from '../api'

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
})
