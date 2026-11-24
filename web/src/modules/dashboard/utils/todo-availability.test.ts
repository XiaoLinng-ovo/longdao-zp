import { describe, expect, it } from 'vitest'
import type { DashboardTodo } from '../api'
import { availableDashboardTodos } from './todo-availability'

function todo(overrides: Partial<DashboardTodo>): DashboardTodo {
  return {
    id: 'todo-1',
    category: 'job',
    title: '待确认岗位说明书',
    description: '测试岗位',
    actionLabel: '去处理',
    path: '/jobs/job-1',
    updatedAt: '2026-11-06T00:00:00Z',
    ...overrides,
  }
}

describe('首页待办功能可用性', () => {
  it('隐藏招聘需求，同时保留可执行的岗位文档待办', () => {
    const rows = [
      todo({ id: 'spec', actionKey: 'confirm-job-spec' }),
      todo({ id: 'request', category: 'requisition', title: '审批招聘需求', path: '/requisitions/req-1' }),
    ]

    expect(availableDashboardTodos(rows, { externalJobPublishingEnabled: false, recruitmentRequestsEnabled: false }).map(row => row.id))
      .toEqual(['spec'])
  })

  it('隐藏岗位发布待办及兼容旧接口文案，其他岗位待办不受影响', () => {
    const rows = [
      todo({ id: 'publish', actionKey: 'publish-job', title: '岗位待发布' }),
      todo({ id: 'legacy-publish', title: '岗位待发布' }),
      todo({ id: 'jd', actionKey: 'confirm-job-jd', title: '待确认岗位 JD' }),
      todo({ id: 'interview', category: 'interview', title: '待安排初试' }),
    ]

    expect(availableDashboardTodos(rows, { externalJobPublishingEnabled: false, recruitmentRequestsEnabled: false }).map(row => row.id))
      .toEqual(['jd', 'interview'])
  })

  it('恢复功能开关后重新展示对应待办', () => {
    const rows = [
      todo({ id: 'request', category: 'requisition', title: '审批招聘需求' }),
      todo({ id: 'publish', actionKey: 'publish-job', title: '岗位待发布' }),
    ]

    expect(availableDashboardTodos(rows, { externalJobPublishingEnabled: true, recruitmentRequestsEnabled: true }))
      .toEqual(rows)
  })
})
