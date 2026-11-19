// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import JobTable from './JobTable.vue'
import type { JobView } from '../api'

const flags = vi.hoisted(() => ({ externalJobPublishingEnabled: false, recruitmentRequestsEnabled: false }))
vi.mock('../../../shared/config/features', () => flags)
let app: App | undefined
let root: HTMLDivElement
const action = vi.fn()
const open = vi.fn()
const openDoc = vi.fn()
function row(status: string): JobView {
  return { id: 'JOB-1', entityId: 'job-1', title: '人事专员', department: '人事部', status, statusLabel: status, channels: ['外部招聘平台'], updatedAt: '2026-10-10', recruitmentRequestId: '', headcount: 1, filledCount: 0 }
}
async function mount(rows: JobView[]) {
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(JobTable, { rows, onAction: action, onOpen: open, onOpenDoc: openDoc }); app.mount(root); await nextTick()
}
function button(label: string) { return [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)! }
beforeEach(() => { flags.externalJobPublishingEnabled = false; vi.clearAllMocks() })
afterEach(() => { app?.unmount(); root?.remove() })

describe('岗位表发布入口可见性', () => {
  it.each(['draft', 'ready', 'published', 'paused', 'closed'])('默认隐藏 %s 的所有发布入口，保留详情和 AI 文档入口', async (status) => {
    const job = row(status)
    await mount([job])
    expect([...root.querySelectorAll('th')].map(item => item.textContent)).toEqual(['岗位名称', '部门', '更新时间', '操作'])
    expect([...root.querySelectorAll('button')].map(item => item.textContent?.trim())).toEqual(['详情', 'AI 生成说明书', 'AI 生成 JD'])
    expect(root.textContent).not.toContain('外部招聘平台')
    button('详情').click(); expect(open).toHaveBeenCalledWith(job)
    button('AI 生成说明书').click(); expect(openDoc).toHaveBeenCalledWith(job, 'spec')
    button('AI 生成 JD').click(); expect(openDoc).toHaveBeenCalledWith(job, 'jd')
    expect(action).not.toHaveBeenCalled()
  })
  it('说明书与 JD 确认不受隐藏影响', async () => {
    const job = { ...row('draft'), spec: { confirmed: false }, jd: { confirmed: false } } as JobView
    await mount([job])
    button('确认说明书').click(); expect(action).toHaveBeenCalledWith(job, 'confirm-spec')
    button('确认 JD').click(); expect(action).toHaveBeenCalledWith(job, 'confirm-jd')
  })
  it.each([['draft', '发布'], ['ready', '发布'], ['published', '暂停'], ['paused', '恢复']])('启用开关恢复 %s 的 %s 和渠道列', async (status, label) => {
    flags.externalJobPublishingEnabled = true
    await mount([row(status!)])
    expect(button(label!)).toBeDefined()
    expect(root.textContent).toContain('发布渠道')
    expect(root.textContent).toContain('外部招聘平台')
    if (status !== 'draft') expect(button('关闭')).toBeDefined()
  })
  it.each([false, true])('空表格正确适配开关 %s 的列数', async (enabled) => {
    flags.externalJobPublishingEnabled = enabled
    await mount([])
    expect(root.querySelector('td')?.getAttribute('colspan')).toBe(enabled ? '6' : '4')
  })
})
