// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../../shared/api'
import {
  actionOnboarding,
  createOnboardingMaterial,
  createOnboardingTask,
  getOnboarding,
  getOnboardingReport,
  listOnboardingIntegrations,
  listOnboardingMaterials,
  listOnboardingReminders,
  listOnboardingTasks,
  listOnboardingWorkbench,
  refreshOnboardingReminders,
  updateOnboarding,
  updateOnboardingIntegration,
  updateOnboardingMaterial,
  updateOnboardingTask,
  ONBOARDING_ACTION_LABEL,
  ONBOARDING_INTEGRATION_STATUS_LABEL,
  ONBOARDING_MATERIAL_STATUS_LABEL,
  ONBOARDING_REASON_LABEL,
  ONBOARDING_STATUS_LABEL,
  ONBOARDING_TASK_CATEGORY_LABEL,
} from './index'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn(), patchJson: vi.fn(), postJson: vi.fn() } }))
const getJson = vi.mocked(apiClient.getJson)
const patchJson = vi.mocked(apiClient.patchJson)
const postJson = vi.mocked(apiClient.postJson)

const onboarding = {
  id: 'onb-3',
  applicationId: 'app-1',
  offerId: 'offer-1',
  status: 'scheduled',
  plannedStartDate: '2026-10-21',
  plannedStartTime: '09:30',
  reportingMode: 'onsite',
  reportingLocation: 'A 座 12 层',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
}

const task = {
  id: 'task-1',
  onboardingId: 'onb-3',
  title: '开通 VPN',
  category: 'it',
  status: 'pending',
  isRequired: true,
  ownerRole: 'hr_admin',
  ownerName: 'IT 服务台',
  dueDate: '2026-10-20',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

const material = {
  id: 'material-1',
  onboardingId: 'onb-3',
  code: 'id_card',
  label: '身份证',
  status: 'pending',
  isRequired: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

const reminder = {
  id: 'reminder-1',
  onboardingId: 'onb-3',
  milestone: '3_days',
  audience: 'candidate',
  channel: 'email',
  status: 'scheduled',
  scheduledAt: '2026-10-18T01:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

const integration = {
  id: 'integration-1',
  onboardingId: 'onb-3',
  provider: 'oa',
  status: 'pending',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

describe('Onboarding API', () => {
  beforeEach(() => vi.clearAllMocks())

  it('读取入职工作台和聚合报表', async () => {
    const workbenchItem = {
      onboarding,
      tasks: [task],
      materials: [material],
      reminders: [reminder],
      integrations: [integration],
      candidateName: '王思远',
      jobTitle: '高级后端工程师',
      offerCode: 'OFF-1',
      department: '研发中心',
      readiness: 50,
      requiredTasksRemaining: 1,
      overdueTasks: 1,
      nextDueDate: '2026-10-20',
      highRiskReasons: ['1 项系统集成失败'],
    }
    const report = {
      totals: { all: 1, pending: 0, preparing: 0, scheduled: 1, completed: 0, no_show: 0, cancelled: 0 },
      arrivalRate: null,
      averagePreparationDays: null,
      medianPreparationDays: null,
      requiredTaskOnTimeRate: 0,
      overdueTasks: 1,
      blockedTasks: 0,
      reasonDistribution: [],
      integrationStatus: { not_configured: 0, pending: 1, syncing: 0, ready: 0, failed: 0 },
      highRiskItems: [],
    }
    getJson.mockImplementation((path: string) => {
      if (path === '/onboarding/workbench') return Promise.resolve({ ok: true, requestId: 'test', data: [workbenchItem] } as never)
      if (path === '/onboarding/reports') return Promise.resolve({ ok: true, requestId: 'test', data: report } as never)
      throw new Error(`unexpected path ${path}`)
    })

    const rows = await listOnboardingWorkbench()
    const summary = await getOnboardingReport()

    expect(rows[0]).toMatchObject({ candidateName: '王思远', readiness: 50, nextDueDate: '2026-10-20' })
    expect(summary.totals.scheduled).toBe(1)
    expect(getJson).toHaveBeenNthCalledWith(1, '/onboarding/workbench')
    expect(getJson).toHaveBeenNthCalledWith(2, '/onboarding/reports')
  })

  it('提供六种归档状态和完整的中文标签', () => {
    expect(Object.keys(ONBOARDING_STATUS_LABEL)).toEqual(['pending', 'preparing', 'scheduled', 'completed', 'no_show', 'cancelled'])
    expect(Object.values(ONBOARDING_STATUS_LABEL)).toEqual(['待准备', '准备中', '待报到', '已报到', '未报到', '已取消'])
    expect(ONBOARDING_TASK_CATEGORY_LABEL.candidate).toBe('候选人')
    expect(ONBOARDING_MATERIAL_STATUS_LABEL.verified).toBe('已核验')
    expect(ONBOARDING_INTEGRATION_STATUS_LABEL.ready).toBe('已就绪')
    expect(ONBOARDING_REASON_LABEL.another_offer).toBe('接受其他 Offer')
    expect(ONBOARDING_ACTION_LABEL.no_show).toBe('登记未报到')
  })

  it('调用归档详情、报到安排和六个状态动作接口', async () => {
    getJson.mockResolvedValue({ ok: true, requestId: 'test', data: onboarding } as never)
    await getOnboarding('onb-3')
    expect(getJson).toHaveBeenCalledWith('/onboarding/onb-3')

    patchJson.mockResolvedValue({ ok: true, requestId: 'test', data: onboarding } as never)
    await updateOnboarding('onb-3', { plannedStartDate: '2026-10-21', reportingMode: 'onsite', notes: '准备资料' })
    expect(patchJson).toHaveBeenCalledWith('/onboarding/onb-3', { plannedStartDate: '2026-10-21', reportingMode: 'onsite', notes: '准备资料' })

    postJson.mockResolvedValue({ ok: true, requestId: 'test', data: onboarding } as never)
    await actionOnboarding('onb-3', 'prepare')
    await actionOnboarding('onb-3', 'schedule')
    await actionOnboarding('onb-3', 'complete')
    await actionOnboarding('onb-3', 'no_show', { reasonCode: 'personal_reason', notes: '候选人已说明情况' })
    await actionOnboarding('onb-3', 'cancel', { reasonCode: 'candidate_declined', notes: '接受其他 Offer' })

    expect(postJson).toHaveBeenNthCalledWith(1, '/onboarding/onb-3/prepare', {})
    expect(postJson).toHaveBeenNthCalledWith(2, '/onboarding/onb-3/schedule', {})
    expect(postJson).toHaveBeenNthCalledWith(3, '/onboarding/onb-3/complete', {})
    expect(postJson).toHaveBeenNthCalledWith(4, '/onboarding/onb-3/no_show', { reasonCode: 'personal_reason', notes: '候选人已说明情况' })
    expect(postJson).toHaveBeenNthCalledWith(5, '/onboarding/onb-3/cancel', { reasonCode: 'candidate_declined', notes: '接受其他 Offer' })
  })

  it('调用任务、材料、提醒和集成子资源接口', async () => {
    getJson.mockImplementation((path: string) => {
      if (path === '/onboarding/onb-3/tasks') return Promise.resolve({ ok: true, requestId: 'test', data: [task] } as never)
      if (path === '/onboarding/onb-3/materials') return Promise.resolve({ ok: true, requestId: 'test', data: [material] } as never)
      if (path === '/onboarding/onb-3/reminders') return Promise.resolve({ ok: true, requestId: 'test', data: [reminder] } as never)
      if (path === '/onboarding/onb-3/integrations') return Promise.resolve({ ok: true, requestId: 'test', data: [integration] } as never)
      throw new Error(`unexpected path ${path}`)
    })
    expect((await listOnboardingTasks('onb-3'))[0]!.category).toBe('it')
    expect((await listOnboardingMaterials('onb-3'))[0]!.code).toBe('id_card')
    expect((await listOnboardingReminders('onb-3'))[0]!.milestone).toBe('3_days')
    expect((await listOnboardingIntegrations('onb-3'))[0]!.provider).toBe('oa')

    postJson.mockImplementation((path: string) => {
      if (path === '/onboarding/onb-3/tasks') return Promise.resolve({ ok: true, requestId: 'test', data: task } as never)
      if (path === '/onboarding/onb-3/materials') return Promise.resolve({ ok: true, requestId: 'test', data: material } as never)
      if (path === '/onboarding/onb-3/reminders/refresh') return Promise.resolve({ ok: true, requestId: 'test', data: [reminder] } as never)
      throw new Error(`unexpected path ${path}`)
    })
    await createOnboardingTask('onb-3', { title: '开通 VPN', category: 'it', ownerRole: 'hr_admin', ownerName: 'IT 服务台', dueDate: '2026-10-20' })
    await createOnboardingMaterial('onb-3', { code: 'degree', label: '学历证明', isRequired: false })
    await refreshOnboardingReminders('onb-3')
    expect(postJson).toHaveBeenNthCalledWith(1, '/onboarding/onb-3/tasks', { title: '开通 VPN', category: 'it', ownerRole: 'hr_admin', ownerName: 'IT 服务台', dueDate: '2026-10-20' })
    expect(postJson).toHaveBeenNthCalledWith(2, '/onboarding/onb-3/materials', { code: 'degree', label: '学历证明', isRequired: false })
    expect(postJson).toHaveBeenNthCalledWith(3, '/onboarding/onb-3/reminders/refresh', {})

    patchJson.mockImplementation((path: string) => {
      if (path === '/onboarding/onb-3/tasks/task-1') return Promise.resolve({ ok: true, requestId: 'test', data: { ...task, status: 'blocked' } } as never)
      if (path === '/onboarding/onb-3/materials/material-1') return Promise.resolve({ ok: true, requestId: 'test', data: { ...material, status: 'verified' } } as never)
      if (path === '/onboarding/onb-3/integrations/integration-1') return Promise.resolve({ ok: true, requestId: 'test', data: { ...integration, status: 'ready' } } as never)
      throw new Error(`unexpected path ${path}`)
    })
    await updateOnboardingTask('onb-3', 'task-1', { status: 'blocked', blockedReason: '等待网络审批', isRequired: true, ownerRole: 'admin' })
    await updateOnboardingMaterial('onb-3', 'material-1', { status: 'verified', isRequired: true, notes: '原件已核验' })
    await updateOnboardingIntegration('onb-3', 'integration-1', { status: 'ready', externalReference: 'OA-10086', lastError: '' })
    expect(patchJson).toHaveBeenNthCalledWith(1, '/onboarding/onb-3/tasks/task-1', { status: 'blocked', blockedReason: '等待网络审批', isRequired: true, ownerRole: 'admin' })
    expect(patchJson).toHaveBeenNthCalledWith(2, '/onboarding/onb-3/materials/material-1', { status: 'verified', isRequired: true, notes: '原件已核验' })
    expect(patchJson).toHaveBeenNthCalledWith(3, '/onboarding/onb-3/integrations/integration-1', { status: 'ready', externalReference: 'OA-10086', lastError: '' })
  })
})
